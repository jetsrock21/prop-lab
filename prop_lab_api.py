"""
PropLab NBA API Backend
Run: uvicorn prop_lab_api:app --reload --port 8000
Install: pip install fastapi uvicorn httpx
NOTE: Does NOT use nba_api library — calls stats.nba.com directly via httpx
      to avoid cloud IP blocking issues.
"""

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
import re
import threading
import httpx

app = FastAPI(title="PropLab NBA API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Cache ────────────────────────────────────────────────────────
_gamelog_cache = {}
_gamelog_lock  = threading.Lock()
_player_cache  = None
_player_lock   = threading.Lock()

# ── Headers that stats.nba.com requires ─────────────────────────
NBA_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer":             "https://www.nba.com/",
    "Origin":              "https://www.nba.com",
    "Accept":              "application/json, text/plain, */*",
    "Accept-Language":     "en-US,en;q=0.9",
    "Accept-Encoding":     "gzip, deflate, br",
    "x-nba-stats-origin":  "stats",
    "x-nba-stats-token":   "true",
    "Connection":          "keep-alive",
}

# ── Stat helpers ─────────────────────────────────────────────────
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

# ── Direct stats.nba.com calls via httpx ────────────────────────

async def fetch_player_list() -> list:
    """Fetch all NBA players from stats.nba.com."""
    global _player_cache
    with _player_lock:
        if _player_cache is not None:
            return _player_cache

    url = "https://stats.nba.com/stats/commonallplayers"
    params = {
        "LeagueID": "00",
        "Season": "2025-26",
        "IsOnlyCurrentSeason": "0",
    }
    async with httpx.AsyncClient(headers=NBA_HEADERS, timeout=20, follow_redirects=True) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        data = r.json()

    headers = data["resultSets"][0]["headers"]
    rows    = data["resultSets"][0]["rowSet"]
    pid_i   = headers.index("PERSON_ID")
    name_i  = headers.index("DISPLAY_FIRST_LAST")
    # active flag: ROSTERSTATUS 1 = active
    try:    active_i = headers.index("ROSTERSTATUS")
    except: active_i = None

    players = []
    for row in rows:
        players.append({
            "id":        row[pid_i],
            "full_name": row[name_i],
            "is_active": bool(row[active_i]) if active_i is not None else True,
        })

    with _player_lock:
        _player_cache = players
    return players


async def fetch_gamelogs_direct(player_id: int, season: str) -> list:
    """
    Call stats.nba.com/stats/playergamelog directly.
    Returns the raw rowSet list.
    """
    url = "https://stats.nba.com/stats/playergamelog"
    params = {
        "PlayerID":   player_id,
        "Season":     season,
        "SeasonType": "Regular Season",
        "LeagueID":   "00",
    }
    async with httpx.AsyncClient(headers=NBA_HEADERS, timeout=25, follow_redirects=True) as client:
        r = await client.get(url, params=params)
        r.raise_for_status()
        data = r.json()

    result = data["resultSets"][0]
    col_headers = result["headers"]
    rows        = result["rowSet"]

    # Convert to list of dicts
    return [dict(zip(col_headers, row)) for row in rows]


# ── Routes ───────────────────────────────────────────────────────

@app.get("/players/search")
async def search_players(q: str = Query(..., min_length=2)):
    q_lower = q.lower().strip()
    try:
        all_players = await fetch_player_list()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not load player list: {e}")

    matches = [
        p for p in all_players
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
    # ── Cache hit ────────────────────────────────────────────────
    cache_key = (player_id, season)
    with _gamelog_lock:
        cached_rows = _gamelog_cache.get(cache_key)

    if cached_rows is None:
        try:
            cached_rows = await fetch_gamelogs_direct(player_id, season)
        except httpx.TimeoutException:
            raise HTTPException(
                status_code=502,
                detail="stats.nba.com timed out — try again in a few seconds."
            )
        except httpx.HTTPStatusError as e:
            raise HTTPException(
                status_code=502,
                detail=f"stats.nba.com returned {e.response.status_code} — try again shortly."
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"NBA data error: {e}")

        with _gamelog_lock:
            _gamelog_cache[cache_key] = cached_rows

    if not cached_rows:
        raise HTTPException(
            status_code=404,
            detail="No games found — player may not have played this season yet."
        )

    # ── Process rows ─────────────────────────────────────────────
    logs = []
    for row in cached_rows:
        min_val = parse_min(row.get("MIN"))
        if min_val < 1:
            continue
        stat_val = compute_stat(row, stat_type)
        matchup  = str(row.get("MATCHUP", ""))
        opp      = matchup.replace("vs. ", "").replace("@ ", "").strip().split()[-1]
        logs.append({
            "date": row.get("GAME_DATE", ""),
            "min":  round(min_val, 1),
            "stat": round(stat_val, 1),
            "opponent": opp,
        })

    # ── H2H filter ───────────────────────────────────────────────
    h2h_logs = []
    if opponent:
        opp_up = opponent.upper().strip()
        h2h_logs = [
            {"date": g["date"], "min": g["min"], "stat": g["stat"]}
            for g in logs if g["opponent"].upper() == opp_up
        ]

    def to_pl(gl): return [{"min": str(g["min"]), "stat": str(g["stat"])} for g in gl]

    return {
        "recent_logs": to_pl(logs),
        "h2h_logs":    to_pl(h2h_logs),
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
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
            r.raise_for_status()
            return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"DvP API unavailable: {e}")


@app.get("/health")
def health():
    return {"status": "ok"}
