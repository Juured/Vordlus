"""Base adapter — abstract interface every source adapter implements.

The scrape service is registry-driven: `get_adapter(url)` walks the
adapter list and returns the first one whose `matches(url)` returns
True. Adapters encapsulate the per-portal logic (URL → listing ID,
listing ID → fetched HTML, HTML → `NormalizedListing`).
"""

from __future__ import annotations

import abc
import re
from typing import ClassVar

from schema import NormalizedListing, Source


class BaseAdapter(abc.ABC):
    # The portal this adapter handles. Subclasses set this.
    source: ClassVar[Source]

    # Subclasses provide a compiled regex (or list of them) for
    # extracting a listing ID from a URL. Must include at least one
    # capture group with the ID.
    url_patterns: ClassVar[tuple[re.Pattern[str], ...]] = ()

    @classmethod
    @abc.abstractmethod
    def matches(cls, url: str) -> bool: ...

    @abc.abstractmethod
    async def fetch(self, listing_id: str, url: str) -> NormalizedListing: ...

    def extract_id(self, url: str) -> str | None:
        """Pull the listing ID out of a full URL. Returns None if no
        pattern matches (caller should treat as a 400)."""
        for pat in self.url_patterns:
            m = pat.search(url)
            if m:
                return m.group(1)
        return None
