import hashlib
import re
import unicodedata
from datetime import date
from pathlib import Path


def make_id(path: Path, today: date) -> str:
    """Stable id from the path alone (`today` kept for interface stability)."""
    stem = unicodedata.normalize("NFKD", path.stem).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")[:60].strip("-") or "file"
    return f"{slug}-{hashlib.sha1(str(path).encode()).hexdigest()[:6]}"


def key_prefix(id: str, when: date) -> str:
    return f"{when:%Y/%m}/{id}"
