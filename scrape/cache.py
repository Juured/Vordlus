"""In-process LRU cache with TTL.

Used by the scrape service to avoid re-fetching the same listing URL on
every request. Default size: 100 entries, 1 h TTL.

This is a minimal, dependency-free implementation: a doubly-linked list
of nodes ordered by recency, keyed by a `dict`. Each node stores the
insertion time; on `get`, stale entries are dropped. When the cache is
full and a new entry is inserted, the least-recently-used node is
evicted.

Why not `functools.lru_cache`: it has no TTL. Why not `cachetools`:
extra dep for ~40 lines of code.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Generic, TypeVar

T = TypeVar("T")


class LruTtl(Generic[T]):
    def __init__(self, max_entries: int = 100, ttl_seconds: float = 3600.0) -> None:
        if max_entries <= 0:
            raise ValueError("max_entries must be > 0")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be > 0")
        self._max = max_entries
        self._ttl = ttl_seconds
        self._store: OrderedDict[str, tuple[float, T]] = OrderedDict()

    def get(self, key: str) -> T | None:
        now = time.monotonic()
        node = self._store.get(key)
        if node is None:
            return None
        ts, value = node
        if now - ts > self._ttl:
            # expired
            del self._store[key]
            return None
        # mark as recently used
        self._store.move_to_end(key)
        return value

    def set(self, key: str, value: T) -> None:
        # If key already exists, refresh it.
        if key in self._store:
            self._store.move_to_end(key)
            self._store[key] = (time.monotonic(), value)
            return
        self._store[key] = (time.monotonic(), value)
        if len(self._store) > self._max:
            self._store.popitem(last=False)

    def size(self) -> int:
        return len(self._store)

    def clear(self) -> None:
        self._store.clear()
