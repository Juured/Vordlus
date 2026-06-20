"""city24.ee adapter.

city24.ee is the Baltic portal of City24 (Alfa Group). Listing URLs
look like:

    https://www.city24.ee/et/kinnisvara/korterid/tallinn/12345
    https://www.city24.ee/en/real-estate/apartments-for-sale/tallinn/12345
    https://www.city24.ee/et/kinnisvara/6497887

The listing ID is the trailing number. The site is also behind
Cloudflare. We use the same Crawl4AI + LLM extraction pattern as the
kv.ee adapter.
"""

from __future__ import annotations

import re
from typing import ClassVar

from adapters.kv_ee import EXTRACTION_PROMPT, _build_extraction_strategy
from schema import NormalizedListing, Source, now_iso
from adapters.base import BaseAdapter

# city24.ee puts the ID either at the end of the path
# (`/.../city/12345`) or as a path-segment
# (`/et/kinnisvara/6497887`). Both are captured.
URL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"city24\.ee/.+?/(\d+)(?:[/?#]|$)", re.IGNORECASE),
)


class City24Adapter(BaseAdapter):
    source: ClassVar[Source] = "city24.ee"
    url_patterns: ClassVar[tuple[re.Pattern[str], ...]] = URL_PATTERNS
    _HOST_RE: ClassVar[re.Pattern[str]] = re.compile(
        r"^(?:www\.)?city24\.ee$", re.IGNORECASE
    )

    @classmethod
    def matches(cls, url: str) -> bool:
        try:
            host = re.match(r"https?://([^/]+)/?", url, re.IGNORECASE)
            if not host:
                return False
            return bool(cls._HOST_RE.match(host.group(1).lower()))
        except Exception:
            return False

    async def fetch(self, listing_id: str, url: str) -> NormalizedListing:
        import os

        from crawl4ai import AsyncWebCrawler, CrawlerRunConfig

        llm_key = os.environ.get("OPENAI_API_KEY", "")
        config = CrawlerRunConfig(
            extraction_strategy=_build_extraction_strategy(llm_key) if llm_key else None,
            page_timeout=45000,
        )
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url, config=config)
        extracted: dict | None = None
        if result.extracted_content:
            try:
                data = result.extracted_content
                if isinstance(data, str):
                    import json

                    data = json.loads(data)
                if isinstance(data, list) and data:
                    extracted = data[0]
                elif isinstance(data, dict):
                    extracted = data
            except Exception:
                extracted = None

        title = (extracted or {}).get("title") or listing_id
        address = (extracted or {}).get("address") or ""
        photos = (extracted or {}).get("photos") or []

        return NormalizedListing(
            source=self.source,
            source_id=listing_id,
            url=url,
            title=str(title),
            address=str(address),
            price=(extracted or {}).get("price"),
            area_m2=(extracted or {}).get("area_m2"),
            rooms=(extracted or {}).get("rooms"),
            photos=list(photos) if isinstance(photos, list) else [],
            description=(extracted or {}).get("description"),
            agent_name=(extracted or {}).get("agent_name"),
            agent_phone=(extracted or {}).get("agent_phone"),
            fetched_at=now_iso(),
        )
