import json
from dataclasses import asdict, dataclass, field, fields
from datetime import date, datetime, timedelta
from pathlib import Path

GIB = 1024**3
MIN_STORAGE_DAYS = 180
PRICES_PATH = Path(__file__).resolve().parent.parent / "prices.json"


@dataclass
class Prices:
    deep_archive_gb_month: float
    standard_gb_month: float

    @classmethod
    def load(cls, path: Path = PRICES_PATH) -> "Prices":
        d = json.loads(Path(path).read_text())
        return cls(d["deep_archive_gb_month"], d["standard_gb_month"])


def min_storage_until(uploaded: datetime) -> date:
    return (uploaded + timedelta(days=MIN_STORAGE_DAYS)).date()


def est_monthly_usd(original_bytes: int, preview_bytes: int, prices: Prices) -> float:
    return round(
        original_bytes / GIB * prices.deep_archive_gb_month
        + preview_bytes / GIB * prices.standard_gb_month,
        4,
    )


@dataclass
class Record:
    id: str
    kind: str
    original: dict
    s3: dict
    sha256: str
    crc64nvme: str
    verification: dict
    uploaded_at: str
    min_storage_until: str
    note: str = ""
    tags: list[str] = field(default_factory=list)
    previews: list[dict] = field(default_factory=list)
    preview_ratio: float = 0.0
    est_monthly_usd: float = 0.0
    local_deleted: bool = False
    restore: dict | None = None
    preview_fallback: bool = False
    local_deleted_at: str | None = None
    bytes_freed: int = 0
    extra: dict = field(default_factory=dict)  # unknown top-level keys, kept for round-trip

    @classmethod
    def from_json(cls, s: str) -> "Record":
        d = json.loads(s)
        names = {f.name for f in fields(cls)} - {"extra"}
        known = {k: v for k, v in d.items() if k in names}
        extra = {k: v for k, v in d.items() if k not in names}
        return cls(**known, extra=extra)

    def to_json(self) -> str:
        d = asdict(self)
        d.update(d.pop("extra"))
        return json.dumps(d, indent=2)


def early_delete_charge(r: Record, prices: Prices, today: date | None = None) -> float:
    """USD early-deletion charge: remaining min-storage days x daily Deep Archive cost of the original."""
    today = today or date.today()
    remaining = (date.fromisoformat(r.min_storage_until) - today).days
    if remaining <= 0:
        return 0.0
    return round(remaining * (r.s3["bytes"] / GIB * prices.deep_archive_gb_month / 30), 4)
