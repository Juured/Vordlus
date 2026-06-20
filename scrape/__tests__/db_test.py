"""Tests for the SQLite persistence layer.

Run from the repo root:
    cd scrape && pip install -r requirements-dev.txt && python -m pytest __tests__/db_test.py -v

Or with the system pytest:
    python -m pytest __tests__/db_test.py -v
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

# Allow `import db` from the parent dir
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402


def _fresh_db() -> str:
    """Return a path to a fresh DB file (and ensure module-level state
    is reset so a previous test's connection isn't reused)."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    # Force a fresh connection
    db._conn = None
    db.DB_PATH = path
    return path


class TestDb(unittest.TestCase):
    def setUp(self) -> None:
        _fresh_db()

    def tearDown(self) -> None:
        try:
            os.unlink(db.DB_PATH)
        except FileNotFoundError:
            pass
        # Close + drop the cached connection so the next test gets a
        # fresh one (sqlite3 won't reopen a file we just deleted).
        if db._conn is not None:
            try:
                db._conn.close()
            except Exception:
                pass
        db._conn = None

    def test_creates_schema(self) -> None:
        conn = db.get_conn()
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        self.assertIn("listings", tables)
        self.assertIn("price_history", tables)

    def test_upsert_and_read_by_address(self) -> None:
        db.upsert_listing({
            "id": "kv.ee:1",
            "source": "kv.ee",
            "source_id": "1",
            "url": "https://www.kv.ee/1",
            "address_norm": "viljandi-mnt-47-tallinn",
            "address_display": "Viljandi mnt 47, Tallinn",
            "first_seen_at": 1_715_000_000_000,
            "last_seen_at": 1_715_000_000_000,
            "last_price_eur": 449_000,
            "area_m2": 199.0,
            "rooms": 5,
            "energy_class": "D",
            "build_year": 1970,
            "photo_count": 12,
            "description_len": 1450,
            "has_floor_plan": 1,
            "photo_url": "https://example.com/photo.jpg",
        })
        rows = db.get_listings_by_address("viljandi-mnt-47-tallinn")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["last_price_eur"], 449_000)
        self.assertEqual(rows[0]["energy_class"], "D")

    def test_upsert_preserves_first_seen_at(self) -> None:
        record = {
            "id": "kv.ee:1",
            "source": "kv.ee",
            "source_id": "1",
            "url": "https://www.kv.ee/1",
            "address_norm": "x",
            "address_display": "X",
            "first_seen_at": 1_000,
            "last_seen_at": 1_000,
            "last_price_eur": 100,
            "area_m2": 50.0,
            "rooms": 2,
            "energy_class": None,
            "build_year": None,
            "photo_count": 0,
            "description_len": 0,
            "has_floor_plan": 0,
            "photo_url": None,
        }
        db.upsert_listing(record)
        # Update with a newer last_seen_at and lower price
        record.update({"last_seen_at": 2_000, "last_price_eur": 90})
        db.upsert_listing(record)
        first_seen = db.get_first_seen_at("kv.ee:1")
        self.assertEqual(first_seen, 1_000)  # preserved

    def test_price_history_appends_only_on_change(self) -> None:
        db.append_price_history("kv.ee:1", 1_000, 100)
        db.append_price_history("kv.ee:1", 1_000, 100)  # same price → skip
        db.append_price_history("kv.ee:1", 2_000, 90)   # changed → append
        history = db.get_price_history("kv.ee:1")
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["price"], 100)
        self.assertEqual(history[1]["price"], 90)


class TestNormalizeAddress(unittest.TestCase):
    def test_strips_diacritics_and_district(self) -> None:
        self.assertEqual(
            db.normalize_address("Viljandi mnt 47, Nõmme, Tallinn"),
            "viljandi-mnt-47-tallinn",
        )

    def test_keeps_house_number(self) -> None:
        self.assertEqual(
            db.normalize_address("Pärnu mnt 28, Tallinn"),
            "parnu-mnt-28-tallinn",
        )


if __name__ == "__main__":
    unittest.main()
