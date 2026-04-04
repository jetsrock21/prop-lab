"""
PropLab NBA API Backend
Install: pip install fastapi uvicorn httpx nba_api
Run: uvicorn prop_lab_api:app --reload --port 8000

Scrapes basketball-reference.com for game logs — works from any server,
no API key needed, no IP blocking.
"""

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
_slug_cache    = {}   # player_id → bbref slug

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
    q_lower = q.lower().strip()
    matches = [
        {"id": p["id"], "full_name": p["full_name"], "is_active": p.get("is_active", True)}
        for p in players if q_lower in p["full_name"].lower()
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
        stat_val = extract_stat(row, stat_type)
        opp      = row.get("opp_name_abbr", "").strip()
        date     = row.get("date", "")[:10]
        logs.append({"date": date, "min": round(min_val, 1), "stat": round(stat_val, 1), "opponent": opp})

    # H2H filter
    h2h = []
    if opponent:
        opp_up = opponent.upper().strip()
        h2h = [
            {"date": g["date"], "min": g["min"], "stat": g["stat"]}
            for g in logs if g["opponent"].upper() == opp_up
        ]

    def to_pl(gl): return [{"date": str(g.get("date","")),"min": str(g["min"]), "stat": str(g["stat"])} for g in gl]

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
    return {"status": "ok", "parser": "HTMLParser-v3"}


@app.get("/debug/version")
def version():
    return {"version": "HTMLParser-v4", "uses_gamelog_parser": True}


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
