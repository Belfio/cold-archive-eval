from datetime import date, datetime
from pathlib import Path

from coldarchive.manifest import Prices, Record, est_monthly_usd, min_storage_until

FIXTURE = Path(__file__).parent / "fixtures" / "manifest_2026-11-14_screen.json"


def test_loads_2026_11_14_record_unchanged():
    raw = FIXTURE.read_text()
    rec = Record.from_json(raw)
    assert rec.verification["verified"] is True
    again = Record.from_json(rec.to_json())
    assert again == rec
    assert again.verification["verified"] is True
    assert rec.tags == [] and rec.restore is None and rec.bytes_freed == 0
    assert rec.local_deleted_at is None and rec.preview_fallback is False
    assert rec.extra["duration_s"] == 4874.0
    assert rec.est_monthly_usd == 0.0059  # as recorded, not recomputed


def test_min_storage_until():
    assert min_storage_until(datetime(2026, 11, 15, 0, 9, 1)) == date(2027, 5, 14)


def test_cost_estimate():
    assert est_monthly_usd(1024**3, 0, Prices(0.002, 0.024)) == 0.002


def test_prices_load():
    p = Prices.load()
    assert p.deep_archive_gb_month == 0.0018 and p.standard_gb_month == 0.024
