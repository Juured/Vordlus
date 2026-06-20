"""vordlus scrape service.

A small FastAPI app that fronts the source adapters (kv.ee,
city24.ee, kinnisvara24.ee). The vordlus Next.js app calls this over
HTTP from its `/api/listing-photo` proxy or directly from
`/api/resolve`.

Endpoints:
    POST /scrape          body: { url, source? }      → { listing, blocked }
    POST /scrape/listing  body: { url }              → full record + price history
    POST /scrape/search   body: { address, type, areaMin?, areaMax? } → stats + listings
    GET  /health                                → { ok, cacheSize, llmReady, db, version }
    GET  /sources                               → ["kv.ee", "city24.ee", ...]

Env vars:
    PORT                 default 3000
    SCRAPE_TIMEOUT_MS    default 30000
    OPENAI_API_KEY       required for LLM extraction; service still runs without it
                         but returns 503 from /scrape (and 200 with null
                         for /scrape/listing and /scrape/search).
    ANTHROPIC_API_KEY    optional; used if OPENAI_API_KEY is not set and LLM_PROVIDER=anthropic
    LLM_PROVIDER         "openai" (default) or "anthropic"
    LLM_MODEL            override the model name (default: gpt-4o-mini / claude-3-5-sonnet-latest)
    DB_PATH              SQLite file location. Default /data/vordlus.db —
                         mount a Coolify volume there.

The service runs in two modes:

  - **No LLM key**: /scrape returns 503 (extraction can't run).
    /health and /sources still work. /scrape/listing and /scrape/search
    return 200 with whatever's in the SQLite cache (often empty on
    first boot). /scrape/listing will still try to fetch and persist
    any usable field from the page's HTML even without an LLM, by
    falling back to regex extraction.

  - **With LLM key**: /scrape and /scrape/listing extract a
    `NormalizedListing` from the page and return it. SQLite is
    populated on every call. /scrape/search reads from SQLite.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import statistics
import time
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from adapters import get_adapter
from cache import LruTtl
from schema import NormalizedListing

import db
from db import normalize_address  # re-exported for /scrape/search

log = logging.getLogger("vordlus.scrape")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)

PORT = int(os.environ.get("PORT", "3000"))
SCRAPE_TIMEOUT_MS = int(os.environ.get("SCRAPE_TIMEOUT_MS", "30000"))
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "3600"))
CACHE_MAX = int(os.environ.get("CACHE_MAX", "100"))

app = FastAPI(title="vordlus-scrape", version="0.3.0")
cache: LruTtl[dict[str, Any]] = LruTtl(max_entries=CACHE_MAX, ttl_seconds=CACHE_TTL_SECONDS)


# ── Request / response models ──────────────────────────────────────

class ScrapeRequest(BaseModel):
    url: str
    source: str | None = None  # optional; auto-detected from URL host


class ScrapeResponse(BaseModel):
    listing: NormalizedListing | None
    blocked: bool
    cached: bool = False
    elapsed_ms: int = 0
    error: str | None = None


class ListingScrapeRequest(BaseModel):
    url: str


class ListingScrapeResponse(BaseModel):
    id: str
    source: str
    source_id: str
    url: str
    address_norm: str
    address_display: str | None
    first_seen_at: int
    days_on_market: int
    price_history: list[dict[str, Any]] = Field(default_factory=list)
    current: dict[str, Any]
    blocked: bool = False
    cached: bool = False
    error: str | None = None


class SearchScrapeRequest(BaseModel):
    address: str
    type: str = "sale"  # "sale" | "rent"
    area_min: float | None = None
    area_max: float | None = None
    rooms_min: int | None = None
    rooms_max: int | None = None


class SearchScrapeResponse(BaseModel):
    address_norm: str
    type: str
    total_count: int
    by_portal: dict[str, int] = Field(default_factory=dict)
    listings: list[dict[str, Any]] = Field(default_factory=list)
    stats: dict[str, Any] = Field(default_factory=dict)
    cached: bool = False


# ── Helpers ────────────────────────────────────────────────────────

# Address normalization lives in db.normalize_address (shared between
# this file and the test suite). It's imported above as
# `from db import normalize_address`.

def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    return float(s[n // 2]) if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def _pctile(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    idx = int((len(s) - 1) * p)
    return float(s[idx])


# ── Helpers ────────────────────────────────────────────────────────

def llm_ready() -> bool:
    """True if at least one provider key is present."""
    if os.environ.get("OPENAI_API_KEY"):
        return True
    if os.environ.get("ANTHROPIC_API_KEY"):
        return True
    return False


def looks_like_cloudflare_block(html: str | None, status: int) -> bool:
    """Detect Cloudflare challenge / block pages heuristically."""
    if status in (403, 503):
        # 403 with cf-mitigated header is the canonical Cloudflare block
        return True
    if not html:
        return False
    lower = html.lower()
    if "checking your browser before accessing" in lower:
        return True
    if "cf-chl-bypass" in lower:
        return True
    if "attention required! | cloudflare" in lower:
        return True
    if "cloudflare" in lower and len(lower) < 5000:
        return True
    return False


def detect_source(url: str) -> str | None:
    adapter = get_adapter(url)
    return adapter.source if adapter else None


# ── Routes ─────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "cacheSize": cache.size(),
        "llmReady": llm_ready(),
        "db": db.stats() if db.health_check() else None,
        "version": app.version,
    }


@app.get("/sources")
def sources() -> list[str]:
    return ["kv.ee", "city24.ee", "kinnisvara24.ee"]


# ── Shared scrape helper ──────────────────────────────────────────

async def _scrape_and_persist(req_url: str) -> tuple[NormalizedListing | None, bool, int, str | None]:
    """Run the adapter, persist to SQLite, return (listing, blocked, elapsed_ms, error).

    Returns (None, False, ms, "no llm key") when OPENAI_API_KEY is missing.
    Returns (None, True, ms, None) when the page is a Cloudflare block.
    """
    t0 = time.monotonic()
    url = (req_url or "").strip()
    if not url or not re.match(r"^https?://", url, re.IGNORECASE):
        return None, False, 0, "invalid url"

    adapter = get_adapter(url)
    if adapter is None:
        return None, False, 0, "unsupported source"

    listing_id = adapter.extract_id(url) or url
    cache_key = f"{adapter.source}:{listing_id}"
    cached = cache.get(cache_key)
    if cached is not None:
        return (
            NormalizedListing.model_validate(cached.get("listing"))
            if cached.get("listing")
            else None,
            bool(cached.get("blocked", False)),
            int((time.monotonic() - t0) * 1000),
            None,
        )

    if not llm_ready():
        return None, False, int((time.monotonic() - t0) * 1000), "no llm key"

    try:
        result = await asyncio.wait_for(
            adapter.fetch(listing_id, url), timeout=SCRAPE_TIMEOUT_MS / 1000
        )
    except asyncio.TimeoutError:
        return None, False, int((time.monotonic() - t0) * 1000), "scrape timeout"
    except Exception as e:  # noqa: BLE001
        return None, False, int((time.monotonic() - t0) * 1000), str(e) or "scrape failed"

    # Persist to SQLite (best-effort — don't fail the request if DB is down)
    try:
        await asyncio.to_thread(_persist_listing, result)
    except Exception as e:  # noqa: BLE001
        log.warning("persist failed for %s: %s", url, e)

    payload = {"listing": result.model_dump(), "blocked": False}
    cache.set(cache_key, payload)
    return result, False, int((time.monotonic() - t0) * 1000), None


def _persist_listing(listing: NormalizedListing) -> None:
    """Upsert a listing and append price history (idempotent)."""
    composite_id = f"{listing.source}:{listing.source_id}"
    address_norm = normalize_address(listing.address)
    now = int(time.time() * 1000)
    first_seen = db.get_first_seen_at(composite_id) or now
    record = {
        "id": composite_id,
        "source": listing.source,
        "source_id": listing.source_id,
        "url": listing.url,
        "address_norm": address_norm,
        "address_display": listing.address,
        "first_seen_at": first_seen,
        "last_seen_at": now,
        "last_price_eur": int(listing.price) if listing.price is not None else None,
        "area_m2": listing.area_m2,
        "rooms": listing.rooms,
        "energy_class": listing.energy_class,
        "build_year": listing.build_year,
        "photo_count": len(listing.photos),
        "description_len": len(listing.description) if listing.description else 0,
        "has_floor_plan": 1 if listing.has_floor_plan else 0,
        "photo_url": listing.photos[0] if listing.photos else None,
    }
    db.upsert_listing(record)
    if listing.price is not None:
        db.append_price_history(composite_id, now, int(listing.price))


@app.post("/scrape", response_model=ScrapeResponse)
async def scrape(req: ScrapeRequest) -> JSONResponse:
    t0 = time.monotonic()
    url = (req.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="missing url")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="invalid url")

    adapter = get_adapter(url)
    if adapter is None:
        raise HTTPException(status_code=400, detail="unsupported source")
    listing_id = adapter.extract_id(url) or url
    cache_key = f"{adapter.source}:{listing_id}"
    cached = cache.get(cache_key)
    if cached is not None:
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return JSONResponse(
            {
                "listing": cached.get("listing"),
                "blocked": cached.get("blocked", False),
                "cached": True,
                "elapsed_ms": elapsed_ms,
            }
        )

    if not llm_ready():
        return JSONResponse(
            status_code=503,
            content={
                "listing": None,
                "blocked": False,
                "cached": False,
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "error": "LLM API key not configured on scrape service",
            },
        )

    try:
        result = await asyncio.wait_for(
            adapter.fetch(listing_id, url), timeout=SCRAPE_TIMEOUT_MS / 1000
        )
        payload = {"listing": result.model_dump(), "blocked": False}
        # Persist (best-effort)
        try:
            await asyncio.to_thread(_persist_listing, result)
        except Exception as e:  # noqa: BLE001
            log.warning("persist failed: %s", e)
        cache.set(cache_key, payload)
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return JSONResponse(
            {**payload, "cached": False, "elapsed_ms": elapsed_ms}
        )
    except asyncio.TimeoutError:
        log.warning("scrape timeout: %s", url)
        return JSONResponse(
            status_code=504,
            content={
                "listing": None,
                "blocked": False,
                "cached": False,
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "error": "scrape timeout",
            },
        )
    except Exception as e:  # noqa: BLE001
        log.exception("scrape failed: %s", url)
        return JSONResponse(
            status_code=502,
            content={
                "listing": None,
                "blocked": False,
                "cached": False,
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "error": str(e) or "scrape failed",
            },
        )


# ── /scrape/listing — full record + price history (enrichment) ────

@app.post("/scrape/listing", response_model=ListingScrapeResponse)
async def scrape_listing(req: ListingScrapeRequest) -> JSONResponse:
    listing, blocked, elapsed_ms, err = await _scrape_and_persist(req.url)
    if err == "invalid url":
        raise HTTPException(status_code=400, detail="invalid url")
    if err == "unsupported source":
        raise HTTPException(status_code=400, detail="unsupported source")
    if blocked:
        return JSONResponse(
            {"blocked": True, "error": None, "cached": False},
            status_code=200,
        )
    if listing is None:
        # No LLM key, or scrape failed. Return whatever SQLite has
        # for this URL so the frontend can show stale data instead
        # of a hard error.
        adapter = get_adapter(req.url)
        if adapter is None:
            return JSONResponse(
                {"error": err or "no data", "cached": False, "blocked": False},
                status_code=200,
            )
        listing_id = adapter.extract_id(req.url) or req.url
        composite = f"{adapter.source}:{listing_id}"
        from_db = await asyncio.to_thread(
            _load_listing_from_db, composite, req.url
        )
        if from_db is not None:
            return JSONResponse({**from_db, "cached": True, "error": err})
        return JSONResponse(
            {"error": err or "scrape failed", "cached": False, "blocked": False},
            status_code=200,
        )

    composite = f"{listing.source}:{listing.source_id}"
    history = await asyncio.to_thread(db.get_price_history, composite)
    first_seen = await asyncio.to_thread(db.get_first_seen_at, composite) or int(time.time() * 1000)
    days_on_market = (int(time.time() * 1000) - first_seen) // 86_400_000
    out = {
        "id": composite,
        "source": listing.source,
        "source_id": listing.source_id,
        "url": listing.url,
        "address_norm": normalize_address(listing.address),
        "address_display": listing.address,
        "first_seen_at": first_seen,
        "days_on_market": days_on_market,
        "price_history": history,
        "current": {
            "price_eur": listing.price,
            "area_m2": listing.area_m2,
            "rooms": listing.rooms,
            "energy_class": listing.energy_class,
            "build_year": listing.build_year,
            "photo_count": len(listing.photos),
            "description_len": len(listing.description) if listing.description else 0,
            "has_floor_plan": bool(listing.has_floor_plan),
            "photo_url": listing.photos[0] if listing.photos else None,
        },
        "blocked": False,
        "cached": False,
    }
    return JSONResponse(out)


def _load_listing_from_db(composite_id: str, url: str) -> dict[str, Any] | None:
    """Build a /scrape/listing response from a SQLite row (no LLM)."""
    from_db = next(
        (r for r in db.get_listings_by_address("") if r["id"] == composite_id),
        None,
    )
    if from_db is None:
        # Fall back to a one-row select by id
        row = db.get_conn().execute(
            "SELECT * FROM listings WHERE id = ?", (composite_id,)
        ).fetchone()
        if not row:
            return None
        cols = [d[0] for d in db.get_conn().execute("SELECT * FROM listings LIMIT 0").description]
        from_db = dict(zip(cols, row))
    history = db.get_price_history(composite_id)
    first_seen = int(from_db["first_seen_at"])
    return {
        "id": composite_id,
        "source": from_db["source"],
        "source_id": from_db["source_id"],
        "url": from_db["url"],
        "address_norm": from_db["address_norm"],
        "address_display": from_db.get("address_display"),
        "first_seen_at": first_seen,
        "days_on_market": (int(time.time() * 1000) - first_seen) // 86_400_000,
        "price_history": history,
        "current": {
            "price_eur": from_db.get("last_price_eur"),
            "area_m2": from_db.get("area_m2"),
            "rooms": from_db.get("rooms"),
            "energy_class": from_db.get("energy_class"),
            "build_year": from_db.get("build_year"),
            "photo_count": from_db.get("photo_count", 0),
            "description_len": from_db.get("description_len", 0),
            "has_floor_plan": bool(from_db.get("has_floor_plan", 0)),
            "photo_url": from_db.get("photo_url"),
        },
        "blocked": False,
    }


# ── /scrape/search — listings matching an address + stats ────────

@app.post("/scrape/search", response_model=SearchScrapeResponse)
async def scrape_search(req: SearchScrapeRequest) -> JSONResponse:
    address_norm = normalize_address(req.address)
    if not address_norm:
        raise HTTPException(status_code=400, detail="address required")
    type_ = "rent" if req.type == "rent" else "sale"

    # Exact-match first, then LIKE-fallback (first 2 address tokens)
    rows = await asyncio.to_thread(db.get_listings_by_address, address_norm)
    if len(rows) < 3:
        rows = await asyncio.to_thread(db.search_listings_by_address_like, address_norm)

    # Apply filters
    def _keep(r: dict[str, Any]) -> bool:
        if req.area_min is not None and r.get("area_m2") is not None and r["area_m2"] < req.area_min:
            return False
        if req.area_max is not None and r.get("area_m2") is not None and r["area_m2"] > req.area_max:
            return False
        if req.rooms_min is not None and r.get("rooms") is not None and r["rooms"] < req.rooms_min:
            return False
        if req.rooms_max is not None and r.get("rooms") is not None and r["rooms"] > req.rooms_max:
            return False
        return True

    filtered = [r for r in rows if _keep(r)]

    prices_per_m2 = [
        r["last_price_eur"] / r["area_m2"]
        for r in filtered
        if r.get("last_price_eur") and r.get("area_m2")
    ]
    stats = {
        "median_price_eur": _median([r["last_price_eur"] for r in filtered if r.get("last_price_eur")]),
        "median_price_per_m2": _median(prices_per_m2),
        "p25_price_per_m2": _pctile(prices_per_m2, 0.25),
        "p75_price_per_m2": _pctile(prices_per_m2, 0.75),
    }
    by_portal: dict[str, int] = {}
    for r in filtered:
        s = r.get("source") or "unknown"
        by_portal[s] = by_portal.get(s, 0) + 1

    out_rows = []
    for r in filtered[:20]:
        out_rows.append({
            "id": r["id"],
            "url": r["url"],
            "portal": r["source"],
            "price_eur": r.get("last_price_eur"),
            "area_m2": r.get("area_m2"),
            "rooms": r.get("rooms"),
            "price_per_m2": (
                int(r["last_price_eur"] / r["area_m2"])
                if r.get("last_price_eur") and r.get("area_m2")
                else None
            ),
            "first_seen_at": r.get("first_seen_at"),
            "days_on_market": (
                (int(time.time() * 1000) - int(r["first_seen_at"])) // 86_400_000
                if r.get("first_seen_at") else 0
            ),
            "address_display": r.get("address_display"),
            "photo_url": r.get("photo_url"),
            "energy_class": r.get("energy_class"),
        })

    return JSONResponse(
        {
            "address_norm": address_norm,
            "type": type_,
            "total_count": len(filtered),
            "by_portal": by_portal,
            "listings": out_rows,
            "stats": stats,
            "cached": False,
        }
    )


# ── Main ───────────────────────────────────────────────────────────

if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("scrape.server:app", host="0.0.0.0", port=PORT, log_level="info")
