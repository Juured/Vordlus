"""Adapter registry. `get_adapter(url)` returns the first registered
adapter whose `matches(url)` is True. Adapters are imported here
side-effect-fully so they self-register."""

from __future__ import annotations

from typing import Type

from .base import BaseAdapter
from .city24 import City24Adapter
from .kinnisvara24 import Kinnisvara24Adapter
from .kv_ee import KvEeAdapter

_REGISTRY: list[Type[BaseAdapter]] = [
    KvEeAdapter,
    Kinnisvara24Adapter,
    City24Adapter,
]


def get_adapter(url: str) -> BaseAdapter | None:
    for cls in _REGISTRY:
        if cls.matches(url):
            return cls()
    return None


__all__ = ["get_adapter", "BaseAdapter", "City24Adapter", "Kinnisvara24Adapter", "KvEeAdapter"]
