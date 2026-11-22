PREVIEW_CAP = 50_000_000
PREVIEW_FLOOR = 65_536


def preview_budget(original_bytes: int) -> int:
    """1% of the original, capped at 50 MB, with a 64 KB floor."""
    return max(min(original_bytes // 100, PREVIEW_CAP), PREVIEW_FLOOR)
