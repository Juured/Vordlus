"""Normalized listing schema for the vordlus scrape service.

All adapters return a `NormalizedListing`. The frontend (vordlus) gets
the same shape regardless of which portal the URL came from
(kv.ee, city24.ee, kinnisvara24.ee, …). Future Latvian/Lithuanian
portals slot in by adding a new `source` literal.
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
    fetched_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
