"""kv.ee adapter.

kv.ee (and its legacy sister kinnisvara24.ee) is owned by Baltic
Classifieds Group. Listing URLs look like:

    https://www.kv.ee/3995056
    https://www.kv.ee/3995056-tartu-mnt-47-nomme-tallinn
    https://kv.ee/en/3995056-tartu-mnt-47-nomme-tallinn

The listing ID is the leading number. We pull the page with Crawl4AI
(LLM extraction against a `NormalizedListing` schema) and rely on
Crawl4AI's stealth-mode browser to bypass Cloudflare's anti-bot layer.
"""

from __future__ import annotations

import re
from typing import ClassVar

from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, LLMConfig, LLMExtractionStrategy

from schema import NormalizedListing, Source, now_iso
from adapters.base import BaseAdapter

# kv.ee and kinnisvara24.ee both use the same BCG backend. We share
# the fetch logic. The kinnisvara24 subclass only overrides the
# `source` literal and `matches()` to keep URLs partitioned cleanly.
URL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"kv\.ee/(?:[a-z]{2}/)?(\d+)", re.IGNORECASE),
    re.compile(r"kinnisvara24\.ee/(?:[a-z]{2}/)?(\d+)", re.IGNORECASE),
)

EXTRACTION_PROMPT = (
    "Extract the real estate listing details from this page. "
    "Return a JSON object with these fields:\n"
    "  - title: short listing headline (e.g. '3-toaline korter, 56 m²')\n"
    "  - address: full street address (street + number + city/district/county)\n"
    "  - price: numeric total price in EUR (no currency symbol, no thousands separators)\n"
    "  - area_m2: numeric living area in square meters\n"
    "  - rooms: integer room count\n"
    "  - photos: list of full absolute image URLs of the listing photos, "
    "in the order they appear on the page (first is the primary photo). "
    "Skip icons, logos, agent photos, and floor-plan thumbnails. "
    "Only return real http(s) URLs.\n"
    "  - description: short description (1-3 sentences) in the original language\n"
    "  - agent_name: listing agent / brokerage name if shown\n"
    "  - agent_phone: contact phone number if shown\n"
    "If a field is not present, omit it (or set to null). "
    "Do not invent values."
)


def _build_extraction_strategy(llm_api_key: str) -> LLMExtractionStrategy:
    """Build the LLM extraction strategy from the OPENAI_API_KEY env.

    Crawl4AI uses litellm under the hood, so we can specify any
    provider; we default to OpenAI gpt-4o-mini (cheap, fast, good
    structured extraction). If the user provides an Anthropic key
    instead, they can set `LLM_PROVIDER=anthropic` and the server
    will swap it in.
    """
    return LLMExtractionStrategy(
        llm_config=LLMConfig(
            provider="openai/gpt-4o-mini",
            api_token=llm_api_key,
        ),
        schema=NormalizedListing.model_json_schema(),
        extraction_type="schema",
        instruction=EXTRACTION_PROMPT,
    )


class KvEeAdapter(BaseAdapter):
    source: ClassVar[Source] = "kv.ee"
    url_patterns: ClassVar[tuple[re.Pattern[str], ...]] = URL_PATTERNS
    # Only match the kv.ee domain (not kinnisvara24.ee — that has its
    # own adapter for clean source labelling).
    _HOST_RE: ClassVar[re.Pattern[str]] = re.compile(r"^(?:www\.)?kv\.ee$", re.IGNORECASE)

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

        llm_key = os.environ.get("OPENAI_API_KEY", "")
        # Build the extraction strategy. Crawl4AI's chromium is launched
        # lazily by AsyncWebCrawler and reused across calls.
        config = CrawlerRunConfig(
            extraction_strategy=_build_extraction_strategy(llm_key) if llm_key else None,
            # Don't let the browser get hung on ad-network requests.
            page_timeout=45000,
        )
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url, config=config)
        extracted: dict | None = None
        if result.extracted_content:
            # Crawl4AI returns a list of dicts matching the schema.
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
