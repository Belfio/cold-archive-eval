import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageOps

from .base import PreviewFile, jpeg_fit

HEIC = {".heic", ".heif"}
MIN_EDGE = 320


def _open_source(src: Path, scratch: Path) -> Path:
    """Pillow cannot read HEIC/HEIF; convert with macOS sips into `scratch`."""
    if src.suffix.lower() not in HEIC:
        return src
    out = scratch / "converted.jpg"
    subprocess.run(["/usr/bin/sips", "-s", "format", "jpeg", str(src), "--out", str(out)],
                   check=True, capture_output=True, timeout=600)
    return out


def image_preview(src: Path, workdir: Path, budget: int) -> tuple[list[PreviewFile], dict]:
    scratch = Path(tempfile.mkdtemp(dir=workdir, prefix="img-"))
    try:
        with Image.open(_open_source(src, scratch)) as im:
            im = ImageOps.exif_transpose(im)
            data = jpeg_fit(im, budget, min_edge=MIN_EDGE)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    out = workdir / "preview.jpg"
    out.write_bytes(data)
    return [PreviewFile(out, "image/jpeg")], {}
