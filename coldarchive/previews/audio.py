import json
from pathlib import Path

from .base import PreviewFile, run, tool

MP3_KBPS = [128, 96, 80, 64, 48, 40, 32, 24, 16, 8]


def audio_preview(src: Path, workdir: Path, budget: int) -> tuple[list[PreviewFile], dict]:
    probe = run([tool("ffprobe"), "-v", "error", "-show_entries", "format=duration",
                 "-of", "json", str(src)])
    dur = float(json.loads(probe.stdout)["format"]["duration"])
    if dur <= 0:
        raise ValueError("no duration")
    want = budget * 8 / dur / 1000 * 0.9
    kbps = next((k for k in MP3_KBPS if k <= want), MP3_KBPS[-1])
    out = workdir / "preview.mp3"
    cmd = [tool("ffmpeg"), "-y", "-v", "error", "-i", str(src), "-vn", "-ac", "1",
           "-ar", "16000" if kbps <= 48 else "44100", "-c:a", "libmp3lame", "-b:a", f"{kbps}k"]
    if want < kbps:  # even the lowest rate overshoots: truncate the clip instead
        cmd += ["-t", f"{max(0.5, budget * 8 / (kbps * 1000) * 0.85):.2f}"]
    run(cmd + [str(out)])
    return [PreviewFile(out, "audio/mpeg")], {"duration_s": round(dur, 1)}
