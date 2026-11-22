import datetime as dt
import gzip
import io
import tarfile
import zipfile
from pathlib import Path

from PIL import Image, ImageOps

from .base import PreviewFile, jpeg_fit

IMG_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
MAX_THUMBS = 120
TAR_TRAILER = 10240  # tarfile pads the archive to a full record


def _walk(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file() and not p.is_symlink())


def _gz(lines: list[str]) -> bytes:
    return gzip.compress(("path\tbytes\tmtime\n" + "".join(lines)).encode("utf-8"), mtime=0)


def folder_size(root: Path) -> int:
    return sum(p.stat().st_size for p in _walk(root))


def _thumb(p: Path, edge: int, max_bytes: int) -> bytes | None:
    try:
        with Image.open(p) as im:
            im = ImageOps.exif_transpose(im)
            return jpeg_fit(im, max_bytes, start_edge=edge)
    except Exception:
        return None


def _tar_cost(n: int) -> int:
    return 512 + -(-n // 512) * 512


def folder_preview(src: Path, workdir: Path, budget: int) -> tuple[list[PreviewFile], dict]:
    files = _walk(src)
    lines, imgs = [], []
    for p in files:
        try:
            st = p.stat()
        except OSError:
            continue
        lines.append(f"{p.relative_to(src)}\t{st.st_size}\t"
                     f"{dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec='seconds')}\n")
        if p.suffix.lower() in IMG_SUFFIXES:
            imgs.append(p)

    listing_cap = budget if not imgs else budget // 2
    data = _gz(lines)
    if len(data) > listing_cap:
        lo, hi = 0, len(lines)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if len(_gz(lines[:mid])) <= listing_cap:
                lo = mid
            else:
                hi = mid - 1
        data = _gz(lines[:lo])
        if len(data) > listing_cap:
            raise ValueError("listing header alone exceeds budget")
    listing = workdir / "files.tsv.gz"
    listing.write_bytes(data)
    out = [PreviewFile(listing, "text/tab-separated-values")]

    remaining = budget - len(data) - TAR_TRAILER
    if imgs and remaining > 0:
        step = max(1, len(imgs) // MAX_THUMBS)
        picked = imgs[::step][:MAX_THUMBS]
        edge = 320 if remaining // len(picked) > 12_000 else 160
        entries, used = [], 0
        for p in picked:
            b = _thumb(p, edge, 40_000)
            if b is None:
                continue
            cost = _tar_cost(len(b))
            if used + cost > remaining:
                break
            entries.append((str(p.relative_to(src)).rsplit(".", 1)[0] + ".jpg", b))
            used += cost
        if entries:
            thumbs = workdir / "thumbs.tar"
            with tarfile.open(thumbs, "w", format=tarfile.USTAR_FORMAT) as t:
                for name, b in entries:
                    ti = tarfile.TarInfo(name)
                    ti.size = len(b)
                    t.addfile(ti, io.BytesIO(b))
            out.append(PreviewFile(thumbs, "application/x-tar"))
    return out, {"files": len(files)}


def zip_preview(src: Path, workdir: Path, budget: int) -> tuple[list[PreviewFile], dict]:
    """File listing of a zip archive (no thumbnails)."""
    lines = []
    with zipfile.ZipFile(src) as z:
        for i in z.infolist():
            if i.is_dir():
                continue
            mtime = dt.datetime(*i.date_time).isoformat(timespec="seconds")
            lines.append(f"{i.filename}\t{i.file_size}\t{mtime}\n".replace("\r", ""))
    data = _gz(lines)
    if len(data) > budget:
        lo, hi = 0, len(lines)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if len(_gz(lines[:mid])) <= budget:
                lo = mid
            else:
                hi = mid - 1
        data = _gz(lines[:lo])
        if len(data) > budget:
            raise ValueError("listing header alone exceeds budget")
    out = workdir / "files.tsv.gz"
    out.write_bytes(data)
    return [PreviewFile(out, "text/tab-separated-values")], {"files": len(lines)}
