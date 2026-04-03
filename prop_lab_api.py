"""
PropLab NBA API Backend
Run: uvicorn prop_lab_api:app --reload --port 8000

Install deps:
  pip install fastapi uvicorn nba_api httpx
"""

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
import re
import time
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
    "PRA":        None,
    "PR":         None,
    "PA":         None,
    "RA":         None,
}

TEAM_ABBREVS = [t["abbreviation"] for t in teams.get_teams()]

# ── In-memory cache ─────────────────────────────────────────────
# Caches player search results and game logs in memory.
# Cache survives for the lifetime of the server process.
# On Railway this means fast responses for repeat lookups until next deploy.
from functools import lru_cache
import threading

_gamelog_cache = {}          # key: (player_id, season, stat_type) → response dict
_gamelog_cache_lock = threading.Lock()
_player_list_cache = None    # cached once on first search

# ── NBA API headers — stats.nba.com requires these or it blocks ──
NBA_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true",
}


def compute_stat(row: dict, stat_type: str) -> float:
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


def fetch_gamelogs_with_retry(player_id: int, season: str, max_attempts: int = 3) -> list:
    """
    Fetch game logs from nba_api with retry logic and increasing timeouts.
    stats.nba.com is slow and flaky — retry is essential on Railway/Render.
    """
    last_exc = None
    timeouts = [30, 45, 60]  # increase timeout on each retry

    for attempt, timeout in enumerate(timeouts[:max_attempts], 1):
        try:
            gl = playergamelog.PlayerGameLog(
                player_id=player_id,
                season=season,
                season_type_all_star="Regular Season",
                timeout=timeout,
                headers=NBA_HEADERS,
            )
            rows = gl.get_normalized_dict()["PlayerGameLog"]
            return rows  # success
        except Exception as exc:
            last_exc = exc
            if attempt < max_attempts:
                time.sleep(2)  # brief pause before retry

    raise last_exc  # all attempts failed


# ── Routes ──────────────────────────────────────────────────────

@app.get("/players/search")
def search_players(q: str = Query(..., min_length=2)):
    """Return NBA players whose name contains q. Active players first."""
    global _player_list_cache
    q_lower = q.lower().strip()
    if _player_list_cache is None:
        _player_list_cache = players.get_players()  # cached after first call
    all_players = _player_list_cache
    matches = [
        {"id": p["id"], "full_name": p["full_name"], "is_active": p["is_active"]}
        for p in all_players
        if q_lower in p["full_name"].lower()
    ]
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
    Fetch game logs for a player with retry logic.
    stats.nba.com is rate-limited and slow — we retry up to 3 times.
    """
    # Check cache first — avoids hitting stats.nba.com for repeat lookups
    cache_key = (player_id, season, stat_type)
    with _gamelog_cache_lock:
        if cache_key in _gamelog_cache:
            cached = _gamelog_cache[cache_key]
            # Re-filter H2H if opponent differs
            if opponent:
                opp_upper = opponent.upper().strip()
                h2h = [
                    {"date": g["date"], "min": g["min"], "stat": g["stat"]}
                    for g in cached["_raw_logs"]
                    if g["opponent"].upper() == opp_upper
                ]
                return {**cached["_response"], "h2h_logs": [{"min": str(g["min"]), "stat": str(g["stat"])} for g in h2h]}
            return cached["_response"]

    try:
        rows = fetch_gamelogs_with_retry(player_id, season)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                f"NBA API timed out after 3 attempts — stats.nba.com is slow. "
                f"Try again in a few seconds. ({exc})"
            ),
        )

    if not rows:
        raise HTTPException(
            status_code=404,
            detail="No game logs found. Player may not have played this season yet."
        )

    logs = []
    for row in rows:
        min_val = parse_min(row.get("MIN"))
        if min_val < 1:
            continue
        stat_val = compute_stat(row, stat_type)
        opp = str(row.get("MATCHUP", "")).replace("vs. ", "").replace("@ ", "").strip()
        logs.append({
            "date": row.get("GAME_DATE", ""),
            "min": round(min_val, 1),
            "stat": round(stat_val, 1),
            "opponent": opp,
        })

    h2h_logs = []
    if opponent:
        opp_upper = opponent.upper().strip()
        h2h_logs = [
            {"date": g["date"], "min": g["min"], "stat": g["stat"]}
            for g in logs
            if g["opponent"].upper() == opp_upper
        ]

    def to_proplab(game_list):
        return [{"min": str(g["min"]), "stat": str(g["stat"])} for g in game_list]

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

    response = {
        "recent_logs": to_proplab(logs),
        "h2h_logs":    to_proplab(h2h_logs),
        "l5":          window_stats(5),
        "l10":         window_stats(10),
        "l20":         window_stats(20),
        "total_games": len(logs),
        "season":      season,
        "opponents":   sorted(set(g["opponent"] for g in logs)),
    }

    # Store in cache for future requests
    with _gamelog_cache_lock:
        _gamelog_cache[cache_key] = {"_raw_logs": logs, "_response": response}

    return response


@app.get("/seasons")
def get_seasons():
    return ["2025-26", "2024-25", "2023-24", "2022-23", "2021-22"]


@app.get("/dvp")
async def get_dvp(
    position: str = Query("SG"),
    season: str = Query("2025-26"),
):
    """Proxy for DvP rankings — fetches server-side to avoid CORS."""
    url = f"https://app.unjuiced.bet/api/nba/dvp-rankings?position={position}&season={season}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
            r.raise_for_status()
            return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to reach DvP API: {e}")


@app.get("/health")
def health():
    return {"status": "ok"}
