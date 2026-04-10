"""
PropLab NBA API Backend
Install: pip install fastapi uvicorn httpx nba_api
Run: uvicorn prop_lab_api:app --reload --port 8000

Scrapes basketball-reference.com for game logs — works from any server,
no API key needed, no IP blocking.
"""

import os
import re
import threading
import asyncio
from typing import Optional

import httpx
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from nba_api.stats.static import players as nba_players

app = FastAPI(title="PropLab NBA API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Caches ─────────────────────────────────────────────────────────────────
_player_cache  = None
_player_lock   = threading.Lock()
_gamelog_cache = {}   # (player_id, season) → processed logs
_gamelog_lock  = threading.Lock()
_slug_cache    = {}
_tank01_id_cache = {}   # tank01 playerID → {name, position}
_tank01_id_lock  = threading.Lock()   # player_id → bbref slug

BBREF_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

# ── Player list: always from bbref live page ─────────────────────────────
# No static fallback for search — bbref is reliable and includes rookies.
# nba_api static used only for slug generation when bbref lookup fails.

from html.parser import HTMLParser

class _RosterParser(HTMLParser):
    """Parses bbref per-game stats page to get current season player list."""
    def __init__(self):
        super().__init__()
        self.in_table = False
        self.in_td    = False
        self.cur_stat = None
        self.cur_row  = {}
        self.players  = []
        self.depth    = 0
        self.seen     = set()

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == "table" and d.get("id") == "per_game_stats":
            self.in_table = True; self.depth = 1
        elif tag == "table" and self.in_table:
            self.depth += 1
        elif tag == "tr" and self.in_table:
            self.cur_row = {}
        elif tag in ("td","th") and self.in_table:
            self.cur_stat = d.get("data-stat")
            self.in_td = True
            # Slug is in data-append-csv on the name_display <td>
            if self.cur_stat == "name_display" and d.get("data-append-csv"):
                self.cur_row["slug"] = d["data-append-csv"]
        elif tag == "a" and self.in_table and self.cur_stat == "name_display":
            href = d.get("href","")
            m = re.search(r"/players/[a-z]/([a-z0-9]+)\.html", href)
            if m: self.cur_row["slug"] = m.group(1)

    def handle_endtag(self, tag):
        if tag == "table" and self.in_table:
            self.depth -= 1
            if self.depth == 0: self.in_table = False
        elif tag == "tr" and self.in_table:
            name = self.cur_row.get("player","").strip()
            slug = self.cur_row.get("slug","")
            if name and slug and slug not in self.seen:
                self.seen.add(slug)
                # Stable ID: map known players via nba_api, else hash-based
                pid = abs(hash(slug)) % 9000000 + 1000000
                self.players.append({
                    "id": pid, "full_name": name,
                    "is_active": True, "slug": slug
                })
            self.cur_row = {}
        elif tag in ("td","th") and self.in_table:
            self.in_td = False; self.cur_stat = None

    def handle_data(self, data):
        if self.in_table and self.in_td and self.cur_stat == "name_display":
            if data.strip(): self.cur_row["player"] = data.strip()


async def get_player_list() -> list:
    """
    Always fetch the current NBA season player list from bbref.
    Cached after first successful fetch.
    """
    global _player_cache
    if _player_cache is not None:
        return _player_cache

    url = "https://www.basketball-reference.com/leagues/NBA_2026_per_game.html"
    try:
        async with httpx.AsyncClient(headers=BBREF_HEADERS, timeout=15, follow_redirects=True) as client:
            r = await client.get(url)
            r.raise_for_status()
        parser = _RosterParser()
        parser.feed(r.text)
        if parser.players:
            # Also cross-ref with nba_api for canonical IDs on known players
            static = {p["full_name"].lower(): p["id"] for p in nba_players.get_players()}
            for p in parser.players:
                known_id = static.get(p["full_name"].lower())
                if known_id:
                    p["id"] = known_id
            with _player_lock:
                _player_cache = parser.players
            return parser.players
    except Exception as e:
        pass

    # Hard fallback: nba_api static (won't have rookies but won't crash)
    fallback = [
        {"id": p["id"], "full_name": p["full_name"],
         "is_active": p["is_active"], "slug": ""}
        for p in nba_players.get_players()
        if p["is_active"]   # only active players in fallback
    ]
    with _player_lock:
        _player_cache = fallback
    return fallback


# sync shim used by gamelogs endpoint (player name lookup only)
def get_all_players():
    global _player_cache
    if _player_cache is not None:
        return _player_cache
    # Cache not ready yet — return active static players temporarily
    return [
        {"id": p["id"], "full_name": p["full_name"], "is_active": True, "slug": ""}
        for p in nba_players.get_players() if p["is_active"]
    ]

# ── Helpers ────────────────────────────────────────────────────────────────
# Team abbreviation mapping: Tank01/NBA → bbref
# Tank01 uses NBA standard abbrs, bbref uses different ones for some teams
TANK01_TO_BBREF_TEAM = {
    "CHA": "CHO",   # Charlotte Hornets
    "BKN": "BRK",   # Brooklyn Nets
    "GS":  "GSW",   # Golden State Warriors
    "NO":  "NOP",   # New Orleans Pelicans
    "NY":  "NYK",   # New York Knicks
    "SA":  "SAS",   # San Antonio Spurs
    "PHO": "PHX",   # Phoenix Suns (bbref uses PHO actually, but just in case)
    "UTAH":"UTA",   # Utah Jazz
}

# Reverse mapping: bbref → Tank01
BBREF_TO_TANK01_TEAM = {v: k for k, v in TANK01_TO_BBREF_TEAM.items()}


def normalize_name(name: str) -> str:
    """Remove accents/diacritics for search matching. Jokić → Jokic, Šengün → Sengun."""
    import unicodedata
    return "".join(
        c for c in unicodedata.normalize("NFD", name)
        if unicodedata.category(c) != "Mn"
    )


def parse_min(v) -> float:
    if not v: return 0.0
    s = str(v).strip()
    m = re.match(r'^(\d+):(\d+)$', s)
    if m: return int(m.group(1)) + int(m.group(2)) / 60
    try: return float(s)
    except: return 0.0


def parse_margin(game_result: str) -> Optional[int]:
    """
    Parse score margin from bbref game_result field.
    Format: 'W, 130-120' → +10  (won by 10)
            'L, 96-139'  → -43  (lost by 43)
            'L, 128-134' → -6   (lost by 6)
    Positive = player's team won by that amount.
    Negative = player's team lost by that amount.
    """
    if not game_result:
        return None
    try:
        # Format: "W, 130-120" or "L, 96-139"
        parts = game_result.strip().split(",")
        outcome = parts[0].strip()  # "W" or "L"
        scores  = parts[1].strip()  # "130-120"
        s1, s2  = scores.split("-")
        team_score = int(s1.strip())
        opp_score  = int(s2.strip())
        margin = team_score - opp_score  # positive if won, negative if lost
        return margin
    except Exception:
        return None

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

def stat_col_name(stat_type: str) -> str:
    """Map stat type to basketball-reference table column header."""
    return {
        "Points":     "PTS",
        "Rebounds":   "TRB",
        "Assists":    "AST",
        "3-Pointers": "3P",
        "Blocks":     "BLK",
        "Steals":     "STL",
        "PRA":        "_PRA",   # computed
        "PR":         "_PR",
        "PA":         "_PA",
        "RA":         "_RA",
    }.get(stat_type, "PTS")

def extract_stat(row_data: dict, stat_type: str) -> float:
    g = lambda k: float(row_data.get(k) or 0)
    # bbref lowercase keys: pts, trb, ast, fg3, blk, stl
    pts = g("pts"); reb = g("trb"); ast = g("ast")
    if stat_type == "Points":     return pts
    if stat_type == "Rebounds":   return reb
    if stat_type == "Assists":    return ast
    if stat_type == "3-Pointers": return g("fg3")
    if stat_type == "Blocks":     return g("blk")
    if stat_type == "Steals":     return g("stl")
    if stat_type == "PRA":        return pts + reb + ast
    if stat_type == "PR":         return pts + reb
    if stat_type == "PA":         return pts + ast
    if stat_type == "RA":         return reb + ast
    return pts

# ── Basketball-reference slug lookup ──────────────────────────────────────
def make_bbref_slug(full_name: str) -> str:
    """Generate basketball-reference player slug from full name."""
    parts = full_name.strip().split()
    if len(parts) < 2:
        return ""
    first = re.sub(r'[^a-z]', '', parts[0].lower())
    last  = re.sub(r'[^a-z]', '', ' '.join(parts[1:]).lower())
    # bbref format: first 5 of last + first 2 of first + 01
    slug = (last[:5] + first[:2] + "01").lower()
    return slug

async def find_bbref_slug(player_id: int, full_name: str, season_year: int) -> str:
    """Try generated slug, fall back to search if 404."""
    if player_id in _slug_cache:
        return _slug_cache[player_id]
    # Check if we have a slug from the player list
    if _player_cache:
        for p in _player_cache:
            if p["id"] == player_id and p.get("slug"):
                _slug_cache[player_id] = p["slug"]
                return p["slug"]

    slug = make_bbref_slug(full_name)
    url  = f"https://www.basketball-reference.com/players/{slug[0]}/{slug}/gamelog/{season_year}/"

    async with httpx.AsyncClient(headers=BBREF_HEADERS, timeout=15, follow_redirects=True) as client:
        r = await client.get(url)
        if r.status_code == 200:
            _slug_cache[player_id] = slug
            return slug

        # Try slug with "02" suffix (duplicate names)
        slug2 = slug[:-2] + "02"
        r2 = await client.get(
            f"https://www.basketball-reference.com/players/{slug2[0]}/{slug2}/gamelog/{season_year}/"
        )
        if r2.status_code == 200:
            _slug_cache[player_id] = slug2
            return slug2

        # Fall back to search
        r3 = await client.get(
            "https://www.basketball-reference.com/search/search.fcgi",
            params={"search": full_name}
        )
        # Extract first player link from search results
        match = re.search(r'/players/\w/(\w+)\.html', r3.text)
        if match:
            found = match.group(1)
            _slug_cache[player_id] = found
            return found

    return ""

async def fetch_bbref_gamelog(slug: str, season_year: int) -> list:
    """
    Fetch and parse the basketball-reference game log page.
    Uses html.parser via stdlib — no extra deps needed.
    """
    from html.parser import HTMLParser

    url = f"https://www.basketball-reference.com/players/{slug[0]}/{slug}/gamelog/{season_year}/"
    async with httpx.AsyncClient(headers=BBREF_HEADERS, timeout=20, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
    html = r.text

    class GameLogParser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.in_target_table = False
            self.depth           = 0      # table nesting depth
            self.in_td           = False
            self.current_stat    = None
            self.current_row     = {}
            self.rows            = []

        def handle_starttag(self, tag, attrs):
            attr_dict = dict(attrs)
            if tag == "table":
                if attr_dict.get("id") == "player_game_log_reg":
                    self.in_target_table = True
                    self.depth = 1
                elif self.in_target_table:
                    self.depth += 1
            elif tag == "tr" and self.in_target_table:
                self.current_row = {}
            elif tag in ("td", "th") and self.in_target_table:
                self.current_stat = attr_dict.get("data-stat")
                self.in_td = True

        def handle_endtag(self, tag):
            if tag == "table" and self.in_target_table:
                self.depth -= 1
                if self.depth == 0:
                    self.in_target_table = False
            elif tag == "tr" and self.in_target_table:
                row = self.current_row
                if row.get("date") and row.get("mp"):
                    mp = row["mp"].strip()
                    skip = ("", "Inactive", "Did Not Play", "Did Not Dress",
                            "Not With Team", "Player Suspended")
                    if mp not in skip:
                        self.rows.append(dict(row))
                self.current_row = {}
            elif tag in ("td", "th") and self.in_target_table:
                self.in_td = False
                self.current_stat = None

        def handle_data(self, data):
            if self.in_target_table and self.in_td and self.current_stat:
                existing = self.current_row.get(self.current_stat, "")
                self.current_row[self.current_stat] = (existing + data).strip()

    parser = GameLogParser()
    parser.feed(html)
    return list(reversed(parser.rows))  # newest first


# ── Routes ─────────────────────────────────────────────────────────────────
@app.get("/players/refresh")
async def refresh_players():
    """Force-refresh + debug: shows count and searches for specific rookies."""
    global _player_cache
    with _player_lock:
        _player_cache = None
    players = await get_player_list()
    names = [p["full_name"] for p in players]
    rookies_check = ["Cooper Flagg", "Dylan Harper", "Zaccharie Risacher", "Alexandre Sarr"]
    return {
        "refreshed": True,
        "count": len(players),
        "first_10": names[:10],
        "last_10": names[-10:],
        "rookies_found": {r: r in names for r in rookies_check},
        "f_players": [n for n in names if n.startswith("F")],
        "h_players": [n for n in names if n.startswith("H")],
    }


@app.get("/players/debug-page")
async def debug_page():
    """Fetch the bbref page and show raw parse info."""
    url = "https://www.basketball-reference.com/leagues/NBA_2026_per_game.html"
    async with httpx.AsyncClient(headers=BBREF_HEADERS, timeout=15, follow_redirects=True) as client:
        r = await client.get(url)
    html = r.text
    # Count table occurrences
    tables = re.findall(r'<table[^>]+id="([^"]+)"', html)
    # Look for Cooper Flagg specifically
    flagg_idx = html.find("Flagg")
    flagg_ctx = html[max(0,flagg_idx-100):flagg_idx+200] if flagg_idx >= 0 else "NOT FOUND"
    harper_idx = html.find("Harper")
    harper_ctx = html[max(0,harper_idx-50):harper_idx+150] if harper_idx >= 0 else "NOT FOUND"
    return {
        "table_ids": tables,
        "flagg_in_html": flagg_idx >= 0,
        "flagg_context": flagg_ctx,
        "harper_context": harper_ctx,
        "html_length": len(html),
    }


@app.get("/players/search")
async def search_players(q: str = Query(..., min_length=2)):
    players = await get_player_list()
    q_lower  = normalize_name(q.lower().strip())
    matches = [
        {"id": p["id"], "full_name": p["full_name"], "is_active": p.get("is_active", True)}
        for p in players if q_lower in normalize_name(p["full_name"].lower())
    ]
    matches.sort(key=lambda x: (not x["is_active"], x["full_name"]))
    return matches[:25]


@app.get("/players/{player_id}/gamelogs")
async def get_gamelogs(
    player_id: int,
    stat_type: str = Query("Points"),
    season:    str = Query("2025-26"),
    opponent:  Optional[str] = Query(None),
):
    # Check cache
    cache_key = (player_id, season)
    with _gamelog_lock:
        cached = _gamelog_cache.get(cache_key)
    if cached is not None:
        raw_rows = cached
    else:
        # Get player name
        all_p  = get_all_players()
        player = next((p for p in all_p if p["id"] == player_id), None)
        if not player:
            raise HTTPException(status_code=404, detail="Player not found.")

        # Season year: "2025-26" → 2026 (bbref uses END year)
        try:
            season_year = int(season.split("-")[0]) + 1
        except Exception:
            season_year = 2026

        # Find bbref slug
        try:
            slug = await find_bbref_slug(player_id, player["full_name"], season_year)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Could not find player on basketball-reference: {e}")

        if not slug:
            raise HTTPException(
                status_code=404,
                detail=f"Could not find '{player['full_name']}' on basketball-reference.com."
            )

        # Fetch game log
        try:
            raw_rows = await fetch_bbref_gamelog(slug, season_year)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Failed to load game log: {e}")

        if not raw_rows:
            raise HTTPException(
                status_code=404,
                detail="No games found — player may not have played this season yet."
            )

        with _gamelog_lock:
            _gamelog_cache[cache_key] = raw_rows

    # Process rows with requested stat type
    logs = []
    for row in raw_rows:
        min_val  = parse_min(row.get("mp", ""))
        if min_val < 1:
            continue
        stat_val    = extract_stat(row, stat_type)
        opp         = row.get("opp_name_abbr", "").strip()
        date        = row.get("date", "")[:10]
        game_result = row.get("game_result", "")
        margin      = parse_margin(game_result)
        logs.append({
            "date":     date,
            "min":      round(min_val, 1),
            "stat":     round(stat_val, 1),
            "opponent": opp,
            "margin":   margin,   # +N = won by N, -N = lost by N, None = unknown
        })

    # H2H filter — normalize opponent abbr (Tank01 vs bbref differences)
    h2h = []
    if opponent:
        opp_up = opponent.upper().strip()
        # Map Tank01 abbr to bbref abbr if needed
        opp_bbref = TANK01_TO_BBREF_TEAM.get(opp_up, opp_up)
        # Also check reverse (if bbref abbr passed in)
        h2h = [
            {"date": g["date"], "min": g["min"], "stat": g["stat"]}
            for g in logs if g["opponent"].upper() in {opp_up, opp_bbref}
        ]

    def to_pl(gl): return [{
        "date":     str(g.get("date","")),
        "min":      str(g["min"]),
        "stat":     str(g["stat"]),
        "opponent": str(g.get("opponent","")),
        "margin":   g.get("margin"),  # int or None
    } for g in gl]

    # Blowout/garbage time stats
    # Positive margin = player's team won (garbage time risk for role players)
    # Negative margin = player's team lost (blowout risk)
    def margin_stats(margin_logs):
        if not margin_logs: return None
        mins  = [g["min"] for g in margin_logs]
        stats = [g["stat"] for g in margin_logs]
        return {
            "games":    len(margin_logs),
            "avg_min":  round(sum(mins)/len(mins), 1),
            "avg_stat": round(sum(stats)/len(stats), 1),
        }

    # Games where team lost by 8+ (blowout loss)
    blowout_loss = [g for g in logs if g.get("margin") is not None and g["margin"] <= -8]
    # Games where team won by 12+ (garbage time / resting starters)
    blowout_win  = [g for g in logs if g.get("margin") is not None and g["margin"] >= 12]
    # Season avg minutes (all games)
    season_avg_min = round(sum(g["min"] for g in logs) / len(logs), 1) if logs else 0

    return {
        "recent_logs": to_pl(logs),
        "h2h_logs":    to_pl(h2h),
        "l5":          window_stats(logs, 5),
        "l10":         window_stats(logs, 10),
        "l20":         window_stats(logs, 20),
        "season_avg_min":   season_avg_min,
        "blowout_loss_stats": margin_stats(blowout_loss),  # team lost by 8+
        "blowout_win_stats":  margin_stats(blowout_win),   # team won by 12+
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
    return {"status": "ok", "parser": "HTMLParser-v3"}


@app.get("/debug/version")
def version():
    return {"version": "HTMLParser-v4", "uses_gamelog_parser": True}


@app.get("/debug/raw-row/{player_id}")
async def debug_raw_row(player_id: int, season: str = Query("2025-26")):
    """Show first 3 raw rows with ALL fields to check game_result field name."""
    all_p  = get_all_players()
    player = next((p for p in all_p if p["id"] == player_id), None)
    if not player:
        return {"error": "not found"}
    season_year = int(season.split("-")[0]) + 1
    try:
        slug = await find_bbref_slug(player_id, player["full_name"], season_year)
        rows = await fetch_bbref_gamelog(slug, season_year)
        if rows:
            return {
                "first_row_all_keys": list(rows[0].keys()),
                "first_row": rows[0],
                "second_row": rows[1] if len(rows)>1 else {},
                "game_result_val": rows[0].get("game_result","NOT FOUND"),
                "game_season_val": rows[0].get("game_season","NOT FOUND"),
                "game_date_val": rows[0].get("date","NOT FOUND"),
            }
        return {"error": "no rows"}
    except Exception as e:
        return {"error": str(e)}


@app.get("/debug/rows/{player_id}")
async def debug_rows(player_id: int, season: str = Query("2025-26")):
    """Show raw parsed row data from first 3 rows."""
    from html.parser import HTMLParser

    all_p  = get_all_players()
    player = next((p for p in all_p if p["id"] == player_id), None)
    if not player:
        return {"error": "not found"}

    season_year = int(season.split("-")[0]) + 1
    slug = make_bbref_slug(player["full_name"])
    url  = f"https://www.basketball-reference.com/players/{slug[0]}/{slug}/gamelog/{season_year}/"

    async with httpx.AsyncClient(headers=BBREF_HEADERS, timeout=20, follow_redirects=True) as client:
        r = await client.get(url)
    html = r.text

    class AllRowParser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.in_table = False
            self.depth    = 0
            self.in_cell  = False
            self.cur_stat = None
            self.cur_row  = {}
            self.all_rows = []
        def handle_starttag(self, tag, attrs):
            d = dict(attrs)
            if tag == "table" and d.get("id") == "player_game_log_reg":
                self.in_table = True; self.depth = 1
            elif tag == "table" and self.in_table:
                self.depth += 1
            elif tag == "tr" and self.in_table:
                self.cur_row = {}
            elif tag in ("td","th") and self.in_table:
                self.cur_stat = d.get("data-stat")
                self.in_cell  = True
        def handle_endtag(self, tag):
            if tag == "table" and self.in_table:
                self.depth -= 1
                if self.depth == 0: self.in_table = False
            elif tag == "tr" and self.in_table:
                if self.cur_row:
                    self.all_rows.append(dict(self.cur_row))
                self.cur_row = {}
            elif tag in ("td","th") and self.in_table:
                self.in_cell = False; self.cur_stat = None
        def handle_data(self, data):
            if self.in_table and self.in_cell and self.cur_stat:
                self.cur_row[self.cur_stat] = (self.cur_row.get(self.cur_stat,"") + data).strip()

    p = AllRowParser()
    p.feed(html)

    return {
        "total_rows_collected": len(p.all_rows),
        "first_3_rows": p.all_rows[:3],
        "all_keys_seen": sorted(set(k for r in p.all_rows for k in r.keys())),
    }


@app.get("/debug/parse/{player_id}")
async def debug_parse(player_id: int, season: str = Query("2025-26")):
    """Shows exactly what the HTMLParser sees."""
    from html.parser import HTMLParser

    all_p  = get_all_players()
    player = next((p for p in all_p if p["id"] == player_id), None)
    if not player:
        return {"error": "not found"}

    season_year = int(season.split("-")[0]) + 1
    slug = make_bbref_slug(player["full_name"])
    url  = f"https://www.basketball-reference.com/players/{slug[0]}/{slug}/gamelog/{season_year}/"

    async with httpx.AsyncClient(headers=BBREF_HEADERS, timeout=20, follow_redirects=True) as client:
        r = await client.get(url)
    html = r.text

    # Count how many times the table id appears
    target_id = "player_game_log_reg"
    occurrences = html.count(target_id)

    # Show 300 chars around each occurrence
    snippets = []
    pos = 0
    while True:
        idx = html.find(target_id, pos)
        if idx == -1: break
        snippets.append(html[max(0,idx-50):idx+150])
        pos = idx + 1

    # Run the actual parser and count events
    class DebugParser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.table_starts = 0
            self.in_table = False
            self.tr_count = 0
            self.td_count = 0
            self.date_vals = []
            self.mp_vals = []
            self.depth = 0
        def handle_starttag(self, tag, attrs):
            attr_dict = dict(attrs)
            if tag == "table":
                if attr_dict.get("id") == "player_game_log_reg":
                    self.table_starts += 1
                    self.in_table = True
                    self.depth = 1
                elif self.in_table:
                    self.depth += 1
            elif self.in_table:
                if tag == "tr": self.tr_count += 1
                if tag == "td": self.td_count += 1
        def handle_endtag(self, tag):
            if tag == "table" and self.in_table:
                self.depth -= 1
                if self.depth == 0: self.in_table = False
        def handle_data(self, data):
            pass

    dp = DebugParser()
    dp.feed(html)

    return {
        "slug": slug,
        "url": url,
        "target_id_occurrences": occurrences,
        "snippets_around_id": snippets,
        "parser_table_starts": dp.table_starts,
        "parser_in_table_trs": dp.tr_count,
        "parser_in_table_tds": dp.td_count,
    }


@app.get("/debug/player/{player_id}")
async def debug_player(player_id: int, season: str = Query("2025-26")):
    """Debug endpoint — shows slug, raw row count, and first 2 rows."""
    all_p  = get_all_players()
    player = next((p for p in all_p if p["id"] == player_id), None)
    if not player:
        return {"error": "player not found in static list"}

    try:
        season_year = int(season.split("-")[0]) + 1
    except Exception:
        season_year = 2026

    slug = make_bbref_slug(player["full_name"])
    url  = f"https://www.basketball-reference.com/players/{slug[0]}/{slug}/gamelog/{season_year}/"

    try:
        async with httpx.AsyncClient(headers=BBREF_HEADERS, timeout=20, follow_redirects=True) as client:
            r = await client.get(url)
            status = r.status_code
            html_len = len(r.text)
            # Check if player_game_log_reg table exists
            has_table = "player_game_log_reg" in r.text
            # Get first 500 chars after player_game_log_reg
            idx = r.text.find("player_game_log_reg")
            snippet = r.text[idx:idx+300] if idx >= 0 else "NOT FOUND"
            # Try parsing
            rows = await fetch_bbref_gamelog(slug, season_year)
    except Exception as e:
        return {"error": str(e), "slug": slug, "url": url}

    return {
        "player": player["full_name"],
        "slug": slug,
        "url": url,
        "http_status": status,
        "html_length": html_len,
        "has_gamelog_table": has_table,
        "rows_parsed": len(rows),
        "first_2_rows": rows[:2] if rows else [],
        "table_snippet": snippet[:300],
        "all_table_tags": re.findall("<table[^>]*id=[^>]*>", r.text)[:10],
        "sample_trs": re.findall(r"<tr[^>]*>", r.text)[20:30],
        "table_html_first_500": (lambda m: m.group(0)[:500] if m else "NO MATCH")(
            re.search(r'id="player_game_log_reg"[^>]*>(.*?)</table>', r.text, re.DOTALL)
        ),
    }


# ═══════════════════════════════════════════════════════════════
# EDGE FINDER — Tank01 / RapidAPI endpoints
# ═══════════════════════════════════════════════════════════════

RAPIDAPI_KEY  = os.environ.get("RAPIDAPI_KEY", "")
TANK01_HOST   = "tank01-fantasy-stats.p.rapidapi.com"
TANK01_BASE   = f"https://{TANK01_HOST}"

def tank01_headers():
    return {
        "x-rapidapi-key":  RAPIDAPI_KEY,
        "x-rapidapi-host": TANK01_HOST,
        "Accept":          "application/json",
    }


async def resolve_tank01_player(player_id: str) -> dict:
    """Resolve a Tank01 playerID to name+position using getPlayerInfo."""
    pid = str(player_id)
    with _tank01_id_lock:
        if pid in _tank01_id_cache:
            return _tank01_id_cache[pid]

    pos_norm = {"PG":"PG","SG":"SG","SF":"SF","PF":"PF","C":"C",
                "G":"PG","F":"SF","G-F":"SG","F-G":"SF","F-C":"PF","C-F":"C"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{TANK01_BASE}/getNBAPlayerInfo",
                                 params={"playerID": pid},
                                 headers=tank01_headers())
            if not r.ok:
                return {}
            data = r.json()
            body = data.get("body", {})
            # body can be a dict or list
            if isinstance(body, list):
                body = body[0] if body else {}
            name = body.get("longName") or body.get("name") or ""
            pos  = pos_norm.get(body.get("pos",""), "SF")
            result = {"name": name, "position": pos}
            with _tank01_id_lock:
                _tank01_id_cache[pid] = result
            return result
    except Exception:
        return {}

# ── Cache ────────────────────────────────────────────────────────
_schedule_cache = {}   # date → games list
_odds_cache     = {}   # gameID → odds
_roster_cache   = {}   # teamAbv → roster


@app.get("/edge/schedule")
async def get_schedule(gameDate: str = Query(...)):
    """
    Get NBA games for a date using getNBABettingOdds so gameIDs match the odds endpoint.
    Returns list of {gameID, away, home, gameTime}.
    """
    if gameDate in _schedule_cache:
        return _schedule_cache[gameDate]

    if not RAPIDAPI_KEY:
        raise HTTPException(status_code=500, detail="RAPIDAPI_KEY not set in environment.")

    # Use getNBABettingOdds with playerProps=true to get gameIDs that match odds endpoint
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{TANK01_BASE}/getNBABettingOdds",
                             params={"gameDate": gameDate, "playerProps": "true", "itemFormat": "list"},
                             headers=tank01_headers())
        r.raise_for_status()
        data = r.json()

    games = []
    body = data.get("body", [])
    game_list = body if isinstance(body, list) else list(body.values())
    for g in game_list:
        if not isinstance(g, dict): continue
        if not g.get("gameID"): continue
        games.append({
            "gameID":     g.get("gameID", ""),
            "away":       g.get("awayTeam", ""),
            "home":       g.get("homeTeam", ""),
            "gameTime":   g.get("gameTime", ""),
            "gameStatus": g.get("gameStatus", ""),
        })

    games.sort(key=lambda x: x.get("gameTime",""))
    _schedule_cache[gameDate] = games
    return games


# Stat key mapping for Tank01 propBets keys
TANK01_STAT_MAP = {
    "pts":        "Points",
    "reb":        "Rebounds",
    "ast":        "Assists",
    "threes":     "3-Pointers",
    "blk":        "Blocks",
    "stl":        "Steals",
    "ptsrebast":  "PRA",
    "ptsreb":     "PR",
    "ptsast":     "PA",
    "rebast":     "RA",
}

# Stats we care about (skip turnovers, stlblk combos etc)
WANTED_STATS = set(TANK01_STAT_MAP.keys())


async def get_roster_id_map(team_abv: str) -> dict:
    """Returns {tank01_playerID: {name, position}} for a team."""
    if team_abv in _roster_cache:
        return _roster_cache[team_abv]

    url = f"{TANK01_BASE}/getNBATeamRoster"
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(url, params={"teamAbv": team_abv}, headers=tank01_headers())
        if not r.ok:
            return {}
        data = r.json()

    pos_map = {"PG":"PG","SG":"SG","SF":"SF","PF":"PF","C":"C",
               "G":"PG","F":"SF","G-F":"SG","F-G":"SF","F-C":"PF","C-F":"C"}
    result = {}
    roster = data.get("body", {}).get("roster", [])
    if isinstance(roster, list):
        for p in roster:
            pid  = str(p.get("playerID",""))
            name = p.get("longName") or p.get("name") or ""
            pos  = pos_map.get(p.get("pos",""), "SF")
            if pid and name:
                result[pid] = {"name": name, "position": pos}

    _roster_cache[team_abv] = result
    return result


@app.get("/edge/odds")
async def get_odds(gameID: str = Query(...)):
    """
    Get player props for a game using getNBABettingOdds with gameDate.
    gameID format: YYYYMMDD_AWAY@HOME
    """
    if gameID in _odds_cache:
        return _odds_cache[gameID]

    if not RAPIDAPI_KEY:
        raise HTTPException(status_code=500, detail="RAPIDAPI_KEY not set.")

    # Extract date and teams from gameID
    try:
        date_part = gameID.split("_")[0]       # YYYYMMDD
        game_part = gameID.split("_")[1]       # AWAY@HOME
        away_team, home_team = game_part.split("@")
    except Exception:
        raise HTTPException(status_code=400, detail=f"Invalid gameID format: {gameID}")

    # Fetch betting odds (contains playerProps when called with gameDate)
    # and team rosters in parallel for player name lookup
    async with httpx.AsyncClient(timeout=20) as client:
        odds_r, away_r, home_r = await asyncio.gather(
            client.get(f"{TANK01_BASE}/getNBABettingOdds",
                      params={"gameDate": date_part, "playerProps": "true", "itemFormat": "list"}, headers=tank01_headers()),
            client.get(f"{TANK01_BASE}/getNBATeamRoster",
                      params={"teamAbv": away_team}, headers=tank01_headers()),
            client.get(f"{TANK01_BASE}/getNBATeamRoster",
                      params={"teamAbv": home_team}, headers=tank01_headers()),
            return_exceptions=True
        )

    # Build playerID → {name, position} map from rosters
    id_map = {}
    pos_norm = {"PG":"PG","SG":"SG","SF":"SF","PF":"PF","C":"C",
                "G":"PG","F":"SF","G-F":"SG","F-G":"SF","F-C":"PF","C-F":"C"}
    for roster_r, ta in [(away_r, away_team.upper()), (home_r, home_team.upper())]:
        if isinstance(roster_r, Exception): continue
        try:
            roster = roster_r.json().get("body", {}).get("roster", [])
            for p in (roster if isinstance(roster, list) else []):
                pid  = str(p.get("playerID",""))
                name = p.get("longName") or p.get("name") or ""
                pos  = pos_norm.get(p.get("pos",""), "SF")
                if pid and name:
                    id_map[pid] = {"name": name, "position": pos, "team": ta}
                    with _tank01_id_lock:
                        _tank01_id_cache[pid] = {"name": name, "position": pos, "team": ta}
        except Exception:
            pass

    # Parse props — find the matching game in the response
    props = []
    try:
        body = odds_r.json().get("body", [])
        games = body if isinstance(body, list) else list(body.values())
        # Match by team abbreviations (away/home order can differ between endpoints)
        target = next((g for g in games
                       if isinstance(g, dict) and g.get("gameID") == gameID), None)
        if not target:
            teams = {away_team.upper(), home_team.upper()}
            target = next((g for g in games
                           if isinstance(g, dict) and {
                               g.get("awayTeam","").upper(),
                               g.get("homeTeam","").upper()
                           } == teams), None)

        if target:
            # Extract consensus spread for blowout risk
            # Spread convention: negative = home team favored
            # We store it from the perspective of the AWAY team
            spread_vals = []
            for sb in target.get("sportsBooks", []):
                odds = sb.get("odds", {})
                try:
                    away_spread = float(odds.get("awayTeamSpread", "").replace("+","") or 0)
                    spread_vals.append(away_spread)
                except Exception:
                    pass
            # Consensus: median of available spreads
            game_away_spread = None
            if spread_vals:
                spread_vals.sort()
                mid = len(spread_vals) // 2
                game_away_spread = spread_vals[mid]

            for player_entry in target.get("playerProps", []):
                pid       = str(player_entry.get("playerID",""))
                prop_bets = player_entry.get("propBets", {})
                info      = id_map.get(pid, {})
                name      = info.get("name","")
                position  = info.get("position","SF")
                if not name:
                    # Fallback: resolve via Tank01 playerInfo API
                    fallback = await resolve_tank01_player(pid)
                    name     = fallback.get("name","")
                    position = fallback.get("position","SF")
                if not name:
                    continue
                for stat_key, line_val in prop_bets.items():
                    stat_type = TANK01_STAT_MAP.get(stat_key)
                    if not stat_type:
                        continue
                    try:
                        line = float(line_val)
                    except Exception:
                        continue
                    player_team = info.get("team", "").upper()
                    # Spread from player's team perspective
                    # positive = player's team is underdog, negative = favored
                    if game_away_spread is not None and player_team:
                        if player_team == away_team.upper():
                            player_spread = game_away_spread
                        else:
                            player_spread = -game_away_spread
                    else:
                        player_spread = None

                    props.append({
                        "playerName": name,
                        "statType":   stat_type,
                        "line":       line,
                        "position":   position,
                        "team":       info.get("team", ""),
                        "spread":     player_spread,
                    })
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to parse props: {e}")

    stat_order = ["Points","Rebounds","Assists","3-Pointers","PRA","PR","PA","RA","Blocks","Steals"]
    props.sort(key=lambda x: (x["playerName"],
               stat_order.index(x["statType"]) if x["statType"] in stat_order else 99))

    _odds_cache[gameID] = props
    return props

@app.get("/edge/odds/raw")
async def get_odds_raw(gameID: str = Query(...)):
    """Debug: show exactly what odds + roster returns for a game."""
    if not RAPIDAPI_KEY:
        return {"error": "RAPIDAPI_KEY not set"}
    try:
        date_part = gameID.split("_")[0]
        game_part = gameID.split("_")[1]
        away_team, home_team = game_part.split("@")
    except Exception:
        return {"error": f"bad gameID: {gameID}"}

    async with httpx.AsyncClient(timeout=20) as client:
        odds_r   = await client.get(f"{TANK01_BASE}/getNBABettingOdds",
                     params={"gameDate": date_part, "playerProps": "true", "itemFormat": "list"},
                     headers=tank01_headers())
        roster_r = await client.get(f"{TANK01_BASE}/getNBATeamRoster",
                     params={"teamAbv": away_team}, headers=tank01_headers())

    odds_body  = odds_r.json().get("body", [])
    games      = odds_body if isinstance(odds_body, list) else list(odds_body.values())
    target     = next((g for g in games if isinstance(g,dict) and g.get("gameID")==gameID), None)

    roster_body = roster_r.json().get("body", {})
    roster      = roster_body.get("roster", []) if isinstance(roster_body, dict) else []
    sample_player = roster[0] if roster else {}

    # Check if prop playerIDs match roster playerIDs
    prop_pid = str(target.get("playerProps",[{}])[0].get("playerID","")) if target else ""
    roster_pids = [str(p.get("playerID","")) for p in roster]
    id_match = prop_pid in roster_pids

    # Try getNBAPlayerInfo for the first prop player
    player_info_result = {}
    if prop_pid and not id_match:
        async with httpx.AsyncClient(timeout=10) as client:
            pi_r = await client.get(f"{TANK01_BASE}/getNBAPlayerInfo",
                                    params={"playerID": prop_pid},
                                    headers=tank01_headers())
            player_info_result = {"status": pi_r.status_code, "body_preview": str(pi_r.text[:300])}

    actual_game_ids = [g.get("gameID","") for g in games if isinstance(g,dict)]
    return {
        "odds_status":        odds_r.status_code,
        "games_count":        len(games),
        "gameID_searched":    gameID,
        "actual_gameIDs":     actual_game_ids,
        "game_found":         target is not None,
        "playerProps_count":  len(target.get("playerProps",[])) if target else 0,
        "first_prop":         target.get("playerProps",[{}])[0] if target else {},
        "roster_status":      roster_r.status_code,
        "roster_count":       len(roster),
        "first_prop_playerID": prop_pid,
        "prop_id_in_roster":  id_match,
        "roster_sample_ids":  roster_pids[:5],
        "player_info_lookup": player_info_result,
    }


@app.get("/edge/odds/raw2")
async def get_odds_raw2(gameID: str = Query(...)):
    """Debug: trace full prop parsing step by step."""
    if not RAPIDAPI_KEY:
        return {"error": "no key"}
    try:
        date_part = gameID.split("_")[0]
        game_part = gameID.split("_")[1]
        away_team, home_team = game_part.split("@")
    except Exception as e:
        return {"error": f"bad gameID: {e}"}

    async with httpx.AsyncClient(timeout=20) as client:
        odds_r, away_r, home_r = await asyncio.gather(
            client.get(f"{TANK01_BASE}/getNBABettingOdds",
                      params={"gameDate": date_part, "playerProps": "true", "itemFormat": "list"},
                      headers=tank01_headers()),
            client.get(f"{TANK01_BASE}/getNBATeamRoster",
                      params={"teamAbv": away_team}, headers=tank01_headers()),
            client.get(f"{TANK01_BASE}/getNBATeamRoster",
                      params={"teamAbv": home_team}, headers=tank01_headers()),
            return_exceptions=True
        )

    # Build id_map
    id_map = {}
    pos_norm = {"PG":"PG","SG":"SG","SF":"SF","PF":"PF","C":"C",
                "G":"PG","F":"SF","G-F":"SG","F-G":"SF","F-C":"PF","C-F":"C"}
    for roster_r in [away_r, home_r]:
        if isinstance(roster_r, Exception): continue
        try:
            roster = roster_r.json().get("body", {}).get("roster", [])
            for p in (roster if isinstance(roster, list) else []):
                pid = str(p.get("playerID",""))
                name = p.get("longName") or ""
                pos = pos_norm.get(p.get("pos",""), "SF")
                if pid and name:
                    id_map[pid] = {"name": name, "position": pos}
        except: pass

    # Find game
    body = odds_r.json().get("body", [])
    games = body if isinstance(body, list) else list(body.values())
    teams = {away_team.upper(), home_team.upper()}
    target = next((g for g in games if isinstance(g,dict) and
                   {g.get("awayTeam","").upper(), g.get("homeTeam","").upper()} == teams), None)

    if not target:
        return {"error": "game not found", "available": [g.get("gameID") for g in games if isinstance(g,dict)]}

    props_raw = target.get("playerProps", [])
    
    # Try playerInfo for first unknown player
    first_unknown_pid = next((str(p.get("playerID","")) for p in props_raw
                              if str(p.get("playerID","")) not in id_map), None)
    player_info_test = {}
    if first_unknown_pid:
        async with httpx.AsyncClient(timeout=10) as client:
            pi = await client.get(f"{TANK01_BASE}/getNBAPlayerInfo",
                                  params={"playerID": first_unknown_pid},
                                  headers=tank01_headers())
            player_info_test = {"status": pi.status_code, "body": pi.json().get("body",{})}

    return {
        "game_found": True,
        "props_count": len(props_raw),
        "id_map_size": len(id_map),
        "id_map_sample": list(id_map.items())[:3],
        "first_prop_pid": str(props_raw[0].get("playerID","")) if props_raw else "",
        "first_prop_in_map": str(props_raw[0].get("playerID","")) in id_map if props_raw else False,
        "first_unknown_pid": first_unknown_pid,
        "player_info_test": player_info_test,
        "props_raw_sample": props_raw[:2],
    }

@app.get("/edge/cache/clear")
async def clear_edge_cache():
    """Clear all edge finder caches."""
    _schedule_cache.clear()
    _odds_cache.clear()
    _roster_cache.clear()
    _tank01_id_cache.clear()
    _gamelog_cache.clear()
    return {"cleared": True, "note": "gamelog cache cleared — margins will re-parse on next load"}


@app.get("/edge/positions")
async def get_positions(teamAbv: str = Query(...)):
    """
    Get player positions for a team roster.
    Returns {playerName: position} dict.
    """
    ta = teamAbv.upper()
    if ta in _roster_cache:
        return _roster_cache[ta]

    if not RAPIDAPI_KEY:
        raise HTTPException(status_code=500, detail="RAPIDAPI_KEY not set.")

    url = f"{TANK01_BASE}/getNBATeamRoster"
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(url, params={"teamAbv": ta}, headers=tank01_headers())
        r.raise_for_status()
        data = r.json()

    positions = {}
    roster = data.get("body", {}).get("roster", [])
    if isinstance(roster, list):
        for p in roster:
            name = p.get("longName") or p.get("name") or ""
            pos  = p.get("pos") or p.get("position") or ""
            # Normalize to our position tabs: PG, SG, SF, PF, C
            pos_map = {
                "PG": "PG", "SG": "SG", "SF": "SF", "PF": "PF", "C": "C",
                "G": "PG", "F": "SF", "G-F": "SG", "F-G": "SF", "F-C": "PF", "C-F": "C",
            }
            positions[name] = pos_map.get(pos, pos or "SF")

    _roster_cache[ta] = positions
    return positions
