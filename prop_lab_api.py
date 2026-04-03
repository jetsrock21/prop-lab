"""
PropLab NBA API Backend
Run: uvicorn prop_lab_api:app --reload --port 8000
Install: pip install fastapi uvicorn httpx nba_api

DATA SOURCE: balldontlie.io (server-friendly, no IP blocking)
Get a FREE API key at https://www.balldontlie.io → Sign Up
Set it as Railway environment variable: BDL_API_KEY=your_key_here
"""

import os
import re
import threading
from typing import Optional

import httpx
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from nba_api.stats.static import players as nba_players

app = FastAPI(title="PropLab NBA API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── balldontlie.io config ─────────────────────────────────────────
BDL_BASE    = "https://api.balldontlie.io/v1"
BDL_API_KEY = os.environ.get("BDL_API_KEY", "")   # set in Railway env vars

def bdl_headers():
    h = {"Accept": "application/json"}
    if BDL_API_KEY:
        h["Authorization"] = BDL_API_KEY
    return h

# ── Caches ────────────────────────────────────────────────────────
_player_cache  = None           # nba_api static list
_player_lock   = threading.Lock()
_bdl_id_cache  = {}             # nba_api_id → balldontlie_id
_gamelog_cache = {}             # (bdl_player_id, season_year) → raw stat rows
_gamelog_lock  = threading.Lock()

# ── Static player list from nba_api bundled JSON (no network) ────
def get_all_players():
    global _player_cache
    if _player_cache is not None:
        return _player_cache
    with _player_lock:
        if _player_cache is None:
            _player_cache = nba_players.get_players()
    return _player_cache

# ── Helpers ───────────────────────────────────────────────────────
def parse_min(v) -> float:
    if not v: return 0.0
    s = str(v).strip()
    m = re.match(r'^(\d+):(\d+)$', s)
    if m: return int(m.group(1)) + int(m.group(2)) / 60
    try: return float(s)
    except: return 0.0

def compute_stat(row: dict, stat_type: str) -> float:
    g = lambda k: float(row.get(k) or 0)
    pts, reb, ast = g("pts"), g("reb"), g("ast")
    if stat_type == "Points":     return pts
    if stat_type == "Rebounds":   return reb
    if stat_type == "Assists":    return ast
    if stat_type == "3-Pointers": return g("fg3m")
    if stat_type == "Blocks":     return g("blk")
    if stat_type == "Steals":     return g("stl")
    if stat_type == "PRA":        return pts + reb + ast
    if stat_type == "PR":         return pts + reb
    if stat_type == "PA":         return pts + ast
    if stat_type == "RA":         return reb + ast
    return 0.0

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

# ── balldontlie: find player ID by name ──────────────────────────
async def bdl_find_player(full_name: str) -> Optional[int]:
    """Search balldontlie for a player and return their bdl ID."""
    # Check cache first
    for k, v in _bdl_id_cache.items():
        if k.lower() == full_name.lower():
            return v

    parts = full_name.strip().split()
    search_q = parts[-1] if parts else full_name  # search by last name
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            f"{BDL_BASE}/players",
            params={"search": search_q, "per_page": 25},
            headers=bdl_headers(),
        )
        r.raise_for_status()
        data = r.json()

    # Find exact match
    for p in data.get("data", []):
        bdl_full = f"{p['first_name']} {p['last_name']}"
        if bdl_full.lower() == full_name.lower():
            _bdl_id_cache[full_name] = p["id"]
            return p["id"]
    # Fallback: first result
    if data.get("data"):
        p = data["data"][0]
        _bdl_id_cache[full_name] = p["id"]
        return p["id"]
    return None

# ── balldontlie: fetch all game stats for a season ───────────────
async def bdl_fetch_gamelogs(bdl_player_id: int, season_year: int) -> list:
    """
    Fetch all per-game stats for a player in a season from balldontlie.
    Handles pagination automatically.
    """
    cache_key = (bdl_player_id, season_year)
    with _gamelog_lock:
        if cache_key in _gamelog_cache:
            return _gamelog_cache[cache_key]

    all_stats = []
    cursor    = None

    async with httpx.AsyncClient(timeout=20) as client:
        while True:
            params = {
                "player_ids[]": bdl_player_id,
                "seasons[]":    season_year,
                "per_page":     100,
            }
            if cursor:
                params["cursor"] = cursor

            r = await client.get(
                f"{BDL_BASE}/stats",
                params=params,
                headers=bdl_headers(),
            )
            r.raise_for_status()
            data = r.json()

            all_stats.extend(data.get("data", []))

            # Pagination
            meta   = data.get("meta", {})
            cursor = meta.get("next_cursor")
            if not cursor:
                break

    # Sort newest first (balldontlie returns oldest first)
    all_stats.sort(key=lambda x: x.get("date", ""), reverse=True)

    with _gamelog_lock:
        _gamelog_cache[cache_key] = all_stats
    return all_stats

# ── Routes ────────────────────────────────────────────────────────

@app.get("/players/search")
def search_players(q: str = Query(..., min_length=2)):
    """Uses nba_api bundled static JSON — instant, no network call."""
    q_lower = q.lower().strip()
    all_p   = get_all_players()
    matches = [
        {"id": p["id"], "full_name": p["full_name"], "is_active": p["is_active"]}
        for p in all_p if q_lower in p["full_name"].lower()
    ]
    matches.sort(key=lambda x: (not x["is_active"], x["full_name"]))
    return matches[:20]


@app.get("/players/{player_id}/gamelogs")
async def get_gamelogs(
    player_id: int,          # this is the nba_api / NBA official ID
    stat_type: str  = Query("Points"),
    season:    str  = Query("2025-26"),
    opponent:  Optional[str] = Query(None),
):
    """
    Fetches game logs from balldontlie.io — works from cloud servers.
    Steps: 1) find player name from static list, 2) find bdl ID by name,
           3) fetch stats for the season year.
    """
    # 1. Get player name from static list
    all_p = get_all_players()
    player = next((p for p in all_p if p["id"] == player_id), None)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found in static list.")

    # 2. Convert season "2025-26" → year 2025 (bdl uses start year)
    try:
        season_year = int(season.split("-")[0])
    except Exception:
        season_year = 2025

    # 3. Find balldontlie player ID
    try:
        bdl_id = await bdl_find_player(player["full_name"])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not find player on balldontlie: {e}")

    if not bdl_id:
        raise HTTPException(
            status_code=404,
            detail=f"'{player['full_name']}' not found on balldontlie.io. "
                   f"Try searching a different spelling."
        )

    # 4. Fetch game stats
    try:
        raw_stats = await bdl_fetch_gamelogs(bdl_id, season_year)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 401:
            raise HTTPException(
                status_code=401,
                detail="balldontlie API key missing or invalid. "
                       "Get a free key at balldontlie.io and set BDL_API_KEY in Railway."
            )
        raise HTTPException(status_code=502, detail=f"balldontlie error: {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch game logs: {e}")

    if not raw_stats:
        raise HTTPException(
            status_code=404,
            detail="No games found — player may not have played this season yet."
        )

    # 5. Process into our format
    logs = []
    for row in raw_stats:
        min_val = parse_min(row.get("min"))
        if min_val < 1:
            continue
        stat_val = compute_stat(row, stat_type)

        # Get opponent abbreviation from the game object
        game = row.get("game", {})
        team_abbr = (row.get("team") or {}).get("abbreviation", "")
        home_abbr = (game.get("home_team") or {}).get("abbreviation", "")
        away_abbr = (game.get("visitor_team") or {}).get("abbreviation", "")
        # Opponent is whichever team the player is NOT on
        if team_abbr == home_abbr:
            opp = away_abbr
        else:
            opp = home_abbr

        logs.append({
            "date": row.get("date", "")[:10],
            "min":  round(min_val, 1),
            "stat": round(stat_val, 1),
            "opponent": opp,
        })

    # H2H filter
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
        "opponents":   sorted(set(g["opponent"] for g in logs if g["opponent"])),
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
    return {"status": "ok", "bdl_key_set": bool(BDL_API_KEY)}
