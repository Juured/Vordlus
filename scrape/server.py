"""vordlus scrape service.

A small FastAPI app that fronts the source adapters (kv.ee,
city24.ee, kinnisvara24.ee). The vordlus Next.js app calls this over
HTTP from its `/api/listing-photo` proxy or directly from
`/api/resolve`.

Endpoints:
    POST /scrape        body: { url, source? }      → { listing, blocked }
    GET  /health                                → { ok, cacheSize, llmReady }
    GET  /sources                               → ["kv.ee", "city24.ee", ...]

Env vars:
    PORT                 default 3000
    SCRAPE_TIMEOUT_MS    default 30000
    OPENAI_API_KEY       required for LLM extraction; service still runs without it
                         but returns 503 from /scrape
    ANTHROPIC_API_KEY    optional; used if OPENAI_API_KEY is not set and LLM_PROVIDER=anthropic
    LLM_PROVIDER         "openai" (default) or "anthropic"
    LLM_MODEL            override the model name (default: gpt-4o-mini / claude-3-5-sonnet-latest)

The service runs in two modes:

  - **No LLM key**: /scrape returns 503 (extraction can't run).
    /health and /sources still work. This is the "Vercel preview"
    fallback that lets the Next.js app boot without the scrape tier.

  - **With LLM key**: /scrape extracts a `NormalizedListing` from the
    page and returns it. Blocked responses (Cloudflare challenge
    detected) return `{ listing: null, blocked: true }`.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from adapters import get_adapter
from cache import LruTtl
from schema import NormalizedListing

log = logging.getLogger("vordlus.scrape")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)

PORT = int(os.environ.get("PORT", "3000"))
SCRAPE_TIMEOUT_MS = int(os.environ.get("SCRAPE_TIMEOUT_MS", "30000"))
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "3600"))
CACHE_MAX = int(os.environ.get("CACHE_MAX", "100"))

app = FastAPI(title="vordlus-scrape", version="0.2.0")
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
        "version": app.version,
    }


@app.get("/sources")
def sources() -> list[str]:
    return ["kv.ee", "city24.ee", "kinnisvara24.ee"]


@app.post("/scrape", response_model=ScrapeResponse)
async def scrape(req: ScrapeRequest) -> JSONResponse:
    import time

    t0 = time.monotonic()
    url = (req.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="missing url")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="invalid url")

    # Adapter lookup.
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
        # No LLM key — refuse the request but return a structured
        # response so the caller can fall back gracefully.
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


# ── Main ───────────────────────────────────────────────────────────

if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("scrape.server:app", host="0.0.0.0", port=PORT, log_level="info")
