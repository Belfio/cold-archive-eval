import mimetypes
from pathlib import Path

from .base import PreviewFile


def other_preview(src: Path, workdir: Path, budget: int, size: int | None = None) -> tuple[list[PreviewFile], dict]:
    """Type, size and the first 4 KB when it looks like text; truncated to budget."""
    if size is None:
        size = src.stat().st_size
    ctype = mimetypes.guess_type(src.name)[0] or "application/octet-stream"
    head = b""
    if src.is_file():
        with open(src, "rb") as f:
            head = f.read(4096)
    text = f"name: {src.name}\ntype: {ctype}\nsize: {size}\n"
    if head and b"\x00" not in head:
        text += "\n" + head.decode("utf-8", errors="replace")
    out = workdir / "preview.txt"
    out.write_bytes(text.encode("utf-8")[:budget])
    return [PreviewFile(out, "text/plain")], {}
