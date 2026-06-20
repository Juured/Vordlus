"""kinnisvara24.ee adapter.

kinnisvara24.ee is the legacy domain of kv.ee (BCG rebrand). It serves
the same backend and uses the same URL shape:

    https://www.kinnisvara24.ee/3995056
    https://www.kinnisvara24.ee/en/3995056-tartu-mnt-47-nomme-tallinn

The fetch logic is identical to kv.ee — we reuse `KvEeAdapter.fetch`
but override the `source` field so the `NormalizedListing` carries
the correct portal label.
"""

from __future__ import annotations

import re
from typing import ClassVar

from .kv_ee import KvEeAdapter


class Kinnisvara24Adapter(KvEeAdapter):
    source: ClassVar[str] = "kinnisvara24.ee"  # type: ignore[assignment]
    _HOST_RE: ClassVar[re.Pattern[str]] = re.compile(
        r"^(?:www\.)?kinnisvara24\.ee$", re.IGNORECASE
    )
