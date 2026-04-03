"""
PropLab NBA API Backend
Run: uvicorn prop_lab_api:app --reload --port 8000
Install: pip install fastapi uvicorn httpx nba_api
"""

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
import re
import threading
import httpx

# nba_api.stats.static uses a LOCAL bundled JSON file — no network call, always fast
from nba_api.stats.static import players as nba_players

app = FastAPI(title="PropLab NBA API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Static player list (loaded once from bundled JSON, no network) ────────────
_ALL_PLAYERS = None
_PLAYER_LOCK  = threading.Lock()

def get_all_players():
    global _ALL_PLAYERS
    if _ALL_PLAYERS is not None:
        return _ALL_PLAYERS
    with _PLAYER_LOCK:
        if _ALL_PLAYERS is None:
            _ALL_PLAYERS = nba_players.get_players()
    return _ALL_PLAYERS

# ── Game log cache ────────────────────────────────────────────────────────────
_GAMELOG_CACHE = {}
_GAMELOG_LOCK  = threading.Lock()

# ── Headers required by stats.nba.com ────────────────────────────────────────
NBA_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer":            "https://www.nba.com/",
    "Origin":             "https://www.nba.com",
    "Accept":             "application/json, text/plain, */*",
    "Accept-Language":    "en-US,en;q=0.9",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token":  "true",
    "Connection":         "keep-alive",
}

# ── Stat helpers ──────────────────────────────────────────────────────────────
def compute_stat(row: dict, stat_type: str) -> float:
    g = lambda k: float(row.get(k) or 0)
    pts, reb, ast = g("PTS"), g("REB"), g("AST")
    if stat_type == "Points":     return pts
    if stat_type == "Rebounds":   return reb
    if stat_type == "Assists":    return ast
    if stat_type == "3-Pointers": return g("FG3M")
    if stat_type == "Blocks":     return g("BLK")
    if stat_type == "Steals":     return g("STL")
    if stat_type == "PRA":        return pts + reb + ast
    if stat_type == "PR":         return pts + reb
    if stat_type == "PA":         return pts + ast
    if stat_type == "RA":         return reb + ast
    return 0.0

def parse_min(v) -> float:
    if not v: return 0.0
    s = str(v).strip()
    m = re.match(r'^(\d+):(\d+)$', s)
    if m: return int(m.group(1)) + int(m.group(2)) / 60
    try: return float(s)
    except: return 0.0

def window_stats(logs, n):
    w = logs[:n]
    if not w: return None
    mins  = [g["min"]  for g in w]
    stats = [g["stat"] for g in w]
    return {
        "avg":    round(sum(stats) / len(stats), 1),
        "mpg":    round(sum(mins)  / len(mins),  1),
        "median": round(sorted(stats)[len(stats) // 2], 1),
        "n":      len(w),
    }

# ── Direct stats.nba.com game log fetch ──────────────────────────────────────
async def fetch_gamelogs_direct(player_id: int, season: str) -> list:
    url = "https://stats.nba.com/stats/playergamelog"
    params = {
        "PlayerID":   player_id,
        "Season":     season,
        "SeasonType": "Regular Season",
        "LeagueID":   "00",
    }
    async with httpx.AsyncClient(
        headers=NBA_HEADERS, timeout=30, follow_redirects=True
    ) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        data = r.json()

    result      = data["resultSets"][0]
    col_headers = result["headers"]
    rows        = result["rowSet"]
    return [dict(zip(col_headers, row)) for row in rows]

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/players/search")
def search_players(q: str = Query(..., min_length=2)):
    """
    Search using nba_api's BUNDLED static JSON — no network call, always instant.
    """
    q_lower = q.lower().strip()
    all_p   = get_all_players()
    matches = [
        {"id": p["id"], "full_name": p["full_name"], "is_active": p["is_active"]}
        for p in all_p
        if q_lower in p["full_name"].lower()
    ]
    matches.sort(key=lambda x: (not x["is_active"], x["full_name"]))
    return matches[:20]


@app.get("/players/{player_id}/gamelogs")
async def get_gamelogs(
    player_id: int,
    stat_type: str = Query("Points"),
    season:    str = Query("2025-26"),
    opponent:  Optional[str] = Query(None),
):
    # Cache by player + season (stat_type filtering done in memory)
    cache_key = (player_id, season)
    with _GAMELOG_LOCK:
        raw_rows = _GAMELOG_CACHE.get(cache_key)

    if raw_rows is None:
        try:
            raw_rows = await fetch_gamelogs_direct(player_id, season)
        except httpx.TimeoutException:
            raise HTTPException(
                status_code=502,
                detail="stats.nba.com timed out — please try again."
            )
        except httpx.HTTPStatusError as e:
            raise HTTPException(
                status_code=502,
                detail=f"stats.nba.com returned {e.response.status_code} — try again."
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"NBA data error: {e}")

        with _GAMELOG_LOCK:
            _GAMELOG_CACHE[cache_key] = raw_rows

    if not raw_rows:
        raise HTTPException(
            status_code=404,
            detail="No games found — player may not have played this season yet."
        )

    # Process: apply stat_type filter here so cache can serve multiple stat types
    logs = []
    for row in raw_rows:
        min_val = parse_min(row.get("MIN"))
        if min_val < 1:
            continue
        matchup = str(row.get("MATCHUP", ""))
        opp     = matchup.replace("vs. ", "").replace("@ ", "").strip().split()[-1]
        logs.append({
            "date": row.get("GAME_DATE", ""),
            "min":  round(min_val, 1),
            "stat": round(compute_stat(row, stat_type), 1),
            "opponent": opp,
        })

    h2h = []
    if opponent:
        opp_up = opponent.upper().strip()
        h2h = [
            {"date": g["date"], "min": g["min"], "stat": g["stat"]}
            for g in logs if g["opponent"].upper() == opp_up
        ]

    def to_pl(gl): return [{"min": str(g["min"]), "stat": str(g["stat"])} for g in gl]

    return {
        "recent_logs": to_pl(logs),
        "h2h_logs":    to_pl(h2h),
        "l5":          window_stats(logs, 5),
        "l10":         window_stats(logs, 10),
        "l20":         window_stats(logs, 20),
        "total_games": len(logs),
        "season":      season,
        "opponents":   sorted(set(g["opponent"] for g in logs)),
    }


@app.get("/seasons")
def get_seasons():
    return ["2025-26", "2024-25", "2023-24", "2022-23", "2021-22"]


@app.get("/dvp")
async def get_dvp(position: str = Query("SG"), season: str = Query("2025-26")):
    url = f"https://app.unjuiced.bet/api/nba/dvp-rankings?position={position}&season={season}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
            return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DvP API unavailable: {e}")


@app.get("/health")
def health():
    return {"status": "ok"}
