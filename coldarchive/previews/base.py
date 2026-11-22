"""Shared helpers for preview generators."""
import io
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from PIL import Image


@dataclass
class PreviewFile:
    path: Path
    content_type: str


def tool(name: str) -> str:
    """Locate ffmpeg/ffprobe (Homebrew path is not always on PATH)."""
    return shutil.which(name) or f"/opt/homebrew/bin/{name}"


def run(cmd: list[str], timeout: int = 3600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, check=True, timeout=timeout)


def to_rgb(img: Image.Image) -> Image.Image:
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, "white")
        bg.paste(img, mask=img.getchannel("A"))
        return bg
    return img.convert("RGB")


def jpeg_fit(img: Image.Image, max_bytes: int, start_edge: int = 1600, min_edge: int = 16) -> bytes:
    """Encode `img` as JPEG of at most `max_bytes`, shrinking size/quality as needed.

    The long edge never goes below `min_edge` (or the image's own size if smaller)."""
    img = to_rgb(img)
    floor = min(min_edge, max(img.size))
    edge = min(max(img.size), start_edge)
    while True:
        scaled = img.copy()
        scaled.thumbnail((edge, edge))
        for q in (80, 65, 50, 35, 20, 10):
            buf = io.BytesIO()
            scaled.save(buf, "JPEG", quality=q, optimize=True)
            if buf.tell() <= max_bytes:
                return buf.getvalue()
        if edge <= floor:
            break
        edge = max(floor, int(edge * 0.75))
    raise ValueError(f"cannot fit JPEG in {max_bytes} bytes")
