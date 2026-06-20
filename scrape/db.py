"""SQLite persistence for the scrape service.

Two tables:
  - listings:    one row per (source, source_id). Upserted on every
                 /scrape call. first_seen_at preserved across re-scrapes.
  - price_history: append-only. Rows only inserted when price_eur
                   changes since the last observation.

Uses Python's stdlib `sqlite3` (no SQLAlchemy). The DB file lives
at `DB_PATH` (env var) — default `/data/vordlus.db`. Mount a Coolify
volume there so the database persists across container restarts.

Why stdlib sqlite3:
  - no native build deps (the Crawl4AI image already has Python 3.12,
    sqlite3 is part of the stdlib)
  - works across restarts when DB_PATH is a Coolify volume
  - synchronous — the scrape path is already I/O-bound on Crawl4AI

The connection is opened lazily on first use and held for the
lifetime of the process. `conn.execute()` is thread-safe under
SQLite's default `check_same_thread=False` plus our `isolation_level`
config. The scrape server is FastAPI async, so we wrap blocking
DB calls in `asyncio.to_thread` at the call site.
"""

from __future__ import annotations

import os
import re
import sqlite3
import threading
import time
from typing import Any, Iterable

DB_PATH = os.environ.get("DB_PATH", "/data/vordlus.db")


# ── Address normalization (shared with server.py) ──────────────────

ESTONIAN_MAP: dict[str, str] = {
    "tallinn": "tallinn", "tartu": "tartu", "parnu": "parnu", "narva": "narva",
    "haapsalu": "haapsalu", "rakvere": "rakvere", "viljandi": "viljandi",
    "kuressaare": "kuressaare", "voru": "voru", "valga": "valga", "johvi": "johvi",
    "paide": "paide", "rapla": "rapla", "viimsi": "viimsi", "saue": "saue", "keila": "keila",
    "nomme": "nomme", "kesklinn": "kesklinn", "kristiine": "kristiine", "mustamae": "mustamae",
    "pirita": "pirita", "lasnamae": "lasnamae",
}
CITIES = {
    "tallinn", "tartu", "parnu", "narva", "haapsalu", "rakvere", "viljandi",
    "kuressaare", "voru", "valga", "johvi", "paide", "rapla", "viimsi",
    "saue", "keila", "tap", "polva", "elva", "kunda", "kardla", "paldiski",
    "maardu", "turi", "kose", "tabasalu", "laagri", "saku", "harku",
    "joelachtme", "raasiku", "anija",
}


def _strip_diacritics(s: str) -> str:
    table = str.maketrans({
        "õ": "o", "ö": "o", "ä": "a", "ü": "u",
        "Õ": "o", "Ö": "o", "Ä": "a", "Ü": "u",
    })
    return s.translate(table).lower()


def normalize_address(addr: str | None) -> str:
    if not addr:
        return ""
    tokens = [
        ESTONIAN_MAP.get(w, w)
        for w in re.findall(r"[a-zA-Z0-9õöäüÕÖÄÜ]+", _strip_diacritics(addr))
    ]
    if not tokens:
        return ""
    if (
        len(tokens) >= 3
        and tokens[-1] in CITIES
        and not re.match(r"^\d+[a-z]?$", tokens[-2] or "")
        and tokens[-2] not in CITIES
    ):
        tokens = tokens[:-2] + [tokens[-1]]
    return "-".join(tokens)

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _connect() -> sqlite3.Connection:
    """Open the DB, run schema, return a connection held for the process."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.executescript(SCHEMA)
    return conn


def get_conn() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            _conn = _connect()
    return _conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,             -- "{source}:{source_id}" e.g. "kv.ee:3995056"
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  address_norm TEXT NOT NULL,     -- lowercase, hyphenated, no commas
  address_display TEXT,
  first_seen_at INTEGER NOT NULL, -- unix ms
  last_seen_at INTEGER NOT NULL,
  last_price_eur INTEGER,
  area_m2 REAL,
  rooms INTEGER,
  energy_class TEXT,
  build_year INTEGER,
  photo_count INTEGER DEFAULT 0,
  description_len INTEGER DEFAULT 0,
  has_floor_plan INTEGER DEFAULT 0,
  photo_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_address_norm ON listings(address_norm);
CREATE INDEX IF NOT EXISTS idx_source_listing ON listings(source, source_id);
CREATE INDEX IF NOT EXISTS idx_first_seen ON listings(first_seen_at);

CREATE TABLE IF NOT EXISTS price_history (
  listing_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  price_eur INTEGER NOT NULL,
  PRIMARY KEY (listing_id, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_history_listing ON price_history(listing_id, observed_at DESC);
"""


# ── Listings ──────────────────────────────────────────────────────

def upsert_listing(record: dict[str, Any]) -> None:
    """Insert or update a listings row. Preserves first_seen_at."""
    conn = get_conn()
    conn.execute(
        """
        INSERT INTO listings (
          id, source, source_id, url, address_norm, address_display,
          first_seen_at, last_seen_at, last_price_eur, area_m2, rooms,
          energy_class, build_year, photo_count, description_len,
          has_floor_plan, photo_url
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          last_price_eur = excluded.last_price_eur,
          area_m2 = excluded.area_m2,
          rooms = excluded.rooms,
          energy_class = excluded.energy_class,
          build_year = excluded.build_year,
          photo_count = excluded.photo_count,
          description_len = excluded.description_len,
          has_floor_plan = excluded.has_floor_plan,
          photo_url = excluded.photo_url
        """,
        [
            record["id"], record["source"], record["source_id"], record["url"],
            record["address_norm"], record.get("address_display"),
            record["first_seen_at"], record["last_seen_at"],
            record.get("last_price_eur"), record.get("area_m2"),
            record.get("rooms"), record.get("energy_class"),
            record.get("build_year"), record.get("photo_count", 0),
            record.get("description_len", 0),
            record.get("has_floor_plan", 0), record.get("photo_url"),
        ],
    )
    conn.commit()


def get_first_seen_at(listing_id: str) -> int | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT first_seen_at FROM listings WHERE id = ?", (listing_id,)
    ).fetchone()
    return int(row[0]) if row else None


def get_listings_by_address(address_norm: str) -> list[dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM listings WHERE address_norm = ? ORDER BY last_seen_at DESC",
        (address_norm,),
    ).fetchall()
    cols = [d[0] for d in conn.execute("SELECT * FROM listings LIMIT 0").description]
    return [dict(zip(cols, r)) for r in rows]


def search_listings_by_address_like(address_norm: str, limit: int = 50) -> list[dict[str, Any]]:
    """LIKE-fallback: match the first 2 tokens of the normalized address."""
    conn = get_conn()
    first_tokens = "-".join(address_norm.split("-")[:2]) if address_norm else ""
    like = f"%{first_tokens}%"
    rows = conn.execute(
        "SELECT * FROM listings WHERE address_norm LIKE ? ORDER BY last_seen_at DESC LIMIT ?",
        (like, limit),
    ).fetchall()
    cols = [d[0] for d in conn.execute("SELECT * FROM listings LIMIT 0").description]
    return [dict(zip(cols, r)) for r in rows]


# ── Price history ────────────────────────────────────────────────

def append_price_history(listing_id: str, observed_at: int, price_eur: int) -> None:
    """Append a price observation. Skips if the same price is already
    recorded at the same timestamp (idempotent re-scrape protection)."""
    conn = get_conn()
    row = conn.execute(
        "SELECT price_eur FROM price_history WHERE listing_id = ? AND observed_at = ?",
        (listing_id, observed_at),
    ).fetchone()
    if row is not None and int(row[0]) == price_eur:
        return
    conn.execute(
        "INSERT INTO price_history (listing_id, observed_at, price_eur) VALUES (?, ?, ?)",
        (listing_id, observed_at, price_eur),
    )
    conn.commit()


def get_price_history(listing_id: str) -> list[dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT observed_at, price_eur FROM price_history WHERE listing_id = ? ORDER BY observed_at ASC",
        (listing_id,),
    ).fetchall()
    return [{"date": int(r[0]), "price": int(r[1])} for r in rows]


# ── Maintenance ──────────────────────────────────────────────────

def stats() -> dict[str, int]:
    conn = get_conn()
    listings = conn.execute("SELECT COUNT(*) FROM listings").fetchone()[0]
    history = conn.execute("SELECT COUNT(*) FROM price_history").fetchone()[0]
    return {"listings": int(listings), "price_history_rows": int(history)}


def health_check() -> bool:
    """Used by /health. Returns True if the DB is reachable."""
    try:
        get_conn().execute("SELECT 1").fetchone()
        return True
    except Exception:  # noqa: BLE001
        return False
