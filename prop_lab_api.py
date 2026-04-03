"""
PropLab NBA API Backend
Run: uvicorn prop_lab_api:app --reload --port 8000

Install deps:
  pip install fastapi uvicorn nba_api
"""

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
import re
import httpx

app = FastAPI(title="PropLab NBA API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── nba_api imports ─────────────────────────────────────────────
from nba_api.stats.static import players, teams
from nba_api.stats.endpoints import playergamelog

# Stat type → nba_api GameLog column mapping
STAT_MAP = {
    "Points":     "PTS",
    "Rebounds":   "REB",
    "Assists":    "AST",
    "3-Pointers": "FG3M",
    "Blocks":     "BLK",
    "Steals":     "STL",
    "PRA":        None,   # computed: PTS + REB + AST
    "PR":         None,   # computed: PTS + REB
    "PA":         None,   # computed: PTS + AST
    "RA":         None,   # computed: REB + AST
}

TEAM_ABBREVS = [t["abbreviation"] for t in teams.get_teams()]


def compute_stat(row: dict, stat_type: str) -> float:
    """Extract or compute the requested stat from a game log row."""
    pts = float(row.get("PTS", 0) or 0)
    reb = float(row.get("REB", 0) or 0)
    ast = float(row.get("AST", 0) or 0)
    if stat_type == "Points":     return pts
    if stat_type == "Rebounds":   return reb
    if stat_type == "Assists":    return ast
    if stat_type == "3-Pointers": return float(row.get("FG3M", 0) or 0)
    if stat_type == "Blocks":     return float(row.get("BLK", 0) or 0)
    if stat_type == "Steals":     return float(row.get("STL", 0) or 0)
    if stat_type == "PRA":        return pts + reb + ast
    if stat_type == "PR":         return pts + reb
    if stat_type == "PA":         return pts + ast
    if stat_type == "RA":         return reb + ast
    return 0.0


def parse_min(min_str) -> float:
    """Parse minutes string like '34:12' or '34.2' into float."""
    if not min_str:
        return 0.0
    s = str(min_str).strip()
    m = re.match(r'^(\d+):(\d+)$', s)
    if m:
        return int(m.group(1)) + int(m.group(2)) / 60
    try:
        return float(s)
    except Exception:
        return 0.0


# ── Routes ──────────────────────────────────────────────────────

@app.get("/players/search")
def search_players(q: str = Query(..., min_length=2)):
    """
    Return NBA players whose full_name starts with or contains q.
    Returns: [{id, full_name, is_active}]
    """
    q_lower = q.lower().strip()
    all_players = players.get_players()
    # Prioritize active players, sorted by name
    matches = [
        {"id": p["id"], "full_name": p["full_name"], "is_active": p["is_active"]}
        for p in all_players
        if q_lower in p["full_name"].lower()
    ]
    # Active players first, then alphabetical
    matches.sort(key=lambda x: (not x["is_active"], x["full_name"]))
    return matches[:20]


@app.get("/players/{player_id}/gamelogs")
def get_gamelogs(
    player_id: int,
    stat_type: str = Query("Points"),
    season: str = Query("2025-26"),
    opponent: Optional[str] = Query(None),
):
    """
    Fetch game logs for a player.
    Returns:
      recent_logs:  [{date, min, stat, opponent}]  — full season, newest first
      h2h_logs:     [{date, min, stat}]             — vs specified opponent only
      l5/l10/l20:   summary stats
    """
    try:
        gl = playergamelog.PlayerGameLog(
            player_id=player_id,
            season=season,
            season_type_all_star="Regular Season",
            timeout=30,
        )
        rows = gl.get_normalized_dict()["PlayerGameLog"]
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"nba_api error: {exc}")

    if not rows:
        raise HTTPException(status_code=404, detail="No game logs found for this player/season.")

    # rows are newest-first from nba_api
    logs = []
    for row in rows:
        min_val = parse_min(row.get("MIN"))
        if min_val < 1:
            continue  # skip DNP / very short appearances
        stat_val = compute_stat(row, stat_type)
        opp = str(row.get("MATCHUP", "")).replace("vs. ", "").replace("@ ", "").strip()
        logs.append({
            "date": row.get("GAME_DATE", ""),
            "min": round(min_val, 1),
            "stat": round(stat_val, 1),
            "opponent": opp,
        })

    # H2H filter
    h2h_logs = []
    if opponent:
        opp_upper = opponent.upper().strip()
        h2h_logs = [
            {"date": g["date"], "min": g["min"], "stat": g["stat"]}
            for g in logs
            if g["opponent"].upper() == opp_upper
        ]

    # Build prop-lab format: [{min: "34.2", stat: "28"}]
    def to_proplab(game_list):
        return [{"min": str(g["min"]), "stat": str(g["stat"])} for g in game_list]

    recent = to_proplab(logs)
    h2h    = to_proplab(h2h_logs)

    # L5 / L10 / L20 summaries (from the most recent N games)
    def window_stats(n):
        w = logs[:n]
        if not w:
            return None
        mins  = [g["min"] for g in w]
        stats = [g["stat"] for g in w]
        avg_min  = round(sum(mins)  / len(mins),  1)
        avg_stat = round(sum(stats) / len(stats), 1)
        med_stat = round(sorted(stats)[len(stats) // 2], 1)
        return {"avg": avg_stat, "mpg": avg_min, "median": med_stat, "n": len(w)}

    return {
        "recent_logs": recent,
        "h2h_logs":    h2h,
        "l5":          window_stats(5),
        "l10":         window_stats(10),
        "l20":         window_stats(20),
        "total_games": len(logs),
        "season":      season,
        "opponents":   sorted(set(g["opponent"] for g in logs)),
    }


@app.get("/seasons")
def get_seasons():
    """Return a list of recent seasons."""
    return ["2025-26", "2024-25", "2023-24", "2022-23", "2021-22"]


@app.get("/dvp")
async def get_dvp(
    position: str = Query("SG"),
    season: str = Query("2025-26"),
):
    """
    Proxy for https://app.unjuiced.bet/api/nba/dvp-rankings
    Fetches server-side (no CORS issues) and passes data through.
    """
    url = f"https://app.unjuiced.bet/api/nba/dvp-rankings?position={position}&season={season}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
            })
            r.raise_for_status()
            return r.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"DvP API error: {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to reach DvP API: {e}")


@app.get("/health")
def health():
    return {"status": "ok"}
