"""Preview generation with a hard size budget (`min(1%, 50 MB)`, never above the original)."""
import shutil
import tempfile
from pathlib import Path
from typing import Literal

from coldarchive.budget import preview_budget

from .audio import audio_preview
from .base import PreviewFile, run, tool
from .folder import folder_preview, folder_size, zip_preview
from .image import image_preview
from .mbox import mbox_preview
from .other import other_preview
from .pdf import pdf_preview
from .video import video_preview

Kind = Literal["video", "image", "audio", "pdf", "mbox", "folder", "zip", "other"]

VIDEO = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".mts", ".m2ts", ".wmv", ".mpg", ".mpeg"}
IMAGE = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".heic", ".heif"}
TEXT = {".txt", ".md", ".csv", ".json", ".log", ".tsv", ".xml", ".html", ".ans", ".nfo"}
AUDIO = {".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".opus", ".aiff", ".wma"}

GENERATORS = {"video": video_preview, "image": image_preview, "audio": audio_preview,
              "pdf": pdf_preview, "mbox": mbox_preview, "folder": folder_preview, "zip": zip_preview}
RETRY_FACTORS = (1.0, 0.7, 0.5, 0.35)


def detect_kind(path: Path) -> Kind:
    path = Path(path)
    if path.is_dir():
        return "folder"
    suffix = path.suffix.lower()
    for kind, suffixes in (("video", VIDEO), ("image", IMAGE), ("audio", AUDIO)):
        if suffix in suffixes:
            return kind
    if suffix in TEXT:
        return "other"
    if suffix == ".pdf":
        return "pdf"
    if suffix == ".zip":
        return "zip"
    if suffix == ".mbox":
        return "mbox"
    try:
        r = run([tool("ffprobe"), "-v", "error", "-show_entries", "stream=codec_type:format=format_name",
                 "-of", "csv=p=0", str(path)], timeout=60)
        kinds = set(r.stdout.decode().replace(",", " ").split())
        if "tty" in kinds:  # ffprobe's tty demuxer matches plain text
            return "other"
        if "video" in kinds:
            return "video"
        if "audio" in kinds:
            return "audio"
    except Exception:
        pass
    return "other"


def _total(files: list[PreviewFile]) -> int:
    return sum(f.path.stat().st_size for f in files)


def make_preview(src: Path, workdir: Path) -> tuple[list[PreviewFile], dict]:
    """Each attempt runs in its own temp dir under `workdir`; only those dirs are ever removed."""
    src, workdir = Path(src), Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    kind = detect_kind(src)
    size = folder_size(src) if src.is_dir() else src.stat().st_size
    budget = min(preview_budget(size), size)

    result: tuple[list[PreviewFile], dict] | None = None
    error = ""
    gen = GENERATORS.get(kind)
    if gen:
        for factor in RETRY_FACTORS:
            tmp = Path(tempfile.mkdtemp(dir=workdir, prefix="preview-"))
            try:
                files, extra = gen(src, tmp, int(budget * factor))
                if _total(files) <= budget:
                    result = files, extra
                    break
                error = f"BudgetExceeded: {_total(files)} > {budget}"
            except Exception as e:
                error = f"{type(e).__name__}: {e}"
                shutil.rmtree(tmp, ignore_errors=True)
                break
            shutil.rmtree(tmp, ignore_errors=True)
    if result is None:
        tmp = Path(tempfile.mkdtemp(dir=workdir, prefix="preview-"))
        files, extra = other_preview(src, tmp, budget, size)
        if gen:
            extra = {"preview_fallback": True, "preview_error": error[:500]}
        result = files, extra
    if _total(result[0]) > budget:
        raise RuntimeError(f"preview exceeds budget: {_total(result[0])} > {budget}")
    return result
