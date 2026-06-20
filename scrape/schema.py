"""Normalized listing schema for the vordlus scrape service.

All adapters return a `NormalizedListing`. The frontend (vordlus) gets
the same shape regardless of which portal the URL came from
(kv.ee, city24.ee, kinnisvara24.ee, …). Future Latvian/Lithuanian
portals slot in by adding a new `source` literal.

Enrichment fields (energy_class, build_year, photo_count, etc.) are
populated by the LLM extraction step alongside the core fields. The
`/scrape/listing` and `/scrape/search` endpoints (server.py) persist
this to SQLite and surface it to the Next.js `/api/enrich` orchestrator.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field

Source = Literal["kv.ee", "city24.ee", "kinnisvara24.ee", "city24.lv", "aruodas.lt"]


class NormalizedListing(BaseModel):
    source: Source
    source_id: str
    url: str
    title: str
    address: str
    price: float | None = None  # EUR
    area_m2: float | None = None
    rooms: int | None = None
    photos: list[str] = Field(default_factory=list)  # first is primary
    description: str | None = None
    agent_name: str | None = None
    agent_phone: str | None = None
    # ── enrichment fields (added in the enrichment layer) ─────────
    # The LLM extraction prompt asks for these alongside the core
    # fields; if a portal doesn't expose them we leave them as null
    # and the panel shows "Andmed puuduvad".
    energy_class: str | None = None       # A-H
    build_year: int | None = None
    has_floor_plan: bool | None = None
    fetched_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
