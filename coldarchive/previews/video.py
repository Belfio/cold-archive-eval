import json
from pathlib import Path

from PIL import Image

from .base import PreviewFile, jpeg_fit, run, tool

TIERS = [480, 360, 240, 144]
MIN_VIDEO_KBPS = {480: 400, 360: 200, 240: 100, 144: 40}
AUDIO_KBPS = 32
NO_AUDIO_BELOW_KBPS = 72


def probe(src: Path) -> tuple[float, bool]:
    r = run([tool("ffprobe"), "-v", "error", "-show_entries",
             "format=duration:stream=codec_type", "-of", "json", str(src)])
    info = json.loads(r.stdout)
    dur = float(info["format"]["duration"])
    kinds = [s["codec_type"] for s in info.get("streams", [])]
    if dur <= 0 or "video" not in kinds:
        raise ValueError("no usable video stream")
    return dur, "audio" in kinds


def _frame(src: Path, t: float, workdir: Path, name: str) -> Image.Image:
    out = workdir / name
    run([tool("ffmpeg"), "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", str(src),
         "-frames:v", "1", "-vf", "scale=-2:'trunc(min(360,ih)/2)*2'", str(out)])
    with Image.open(out) as im:
        img = im.convert("RGB")
    out.unlink()
    return img


def _stills(src: Path, dur: float, workdir: Path, budget: int) -> list[PreviewFile]:
    """Poster + 4x4 contact sheet of evenly spaced frames, both JPEG, within budget."""
    frames = [_frame(src, dur * (i + 0.5) / 16, workdir, "_f.png") for i in range(16)]
    poster = jpeg_fit(frames[1], budget // 4, start_edge=640)
    tw, th = frames[0].size
    sheet = Image.new("RGB", (tw * 4, th * 4))
    for i, f in enumerate(frames):
        sheet.paste(f.resize((tw, th)), ((i % 4) * tw, (i // 4) * th))
    sheet_b = jpeg_fit(sheet, budget - len(poster), start_edge=1280)
    p, s = workdir / "poster.jpg", workdir / "contact-sheet.jpg"
    p.write_bytes(poster)
    s.write_bytes(sheet_b)
    return [PreviewFile(p, "image/jpeg"), PreviewFile(s, "image/jpeg")]


def video_preview(src: Path, workdir: Path, budget: int) -> tuple[list[PreviewFile], dict]:
    dur, has_audio = probe(src)
    extra = {"duration_s": round(dur, 1)}
    # the poster counts against the budget; the clip gets what is left
    poster_b = jpeg_fit(_frame(src, min(5.0, dur / 2), workdir, "_p.png"), budget // 10, start_edge=480)
    clip_budget = budget - len(poster_b)
    total_kbps = clip_budget * 8 / dur / 1000 * 0.9
    audio_kbps = AUDIO_KBPS if has_audio and total_kbps >= NO_AUDIO_BELOW_KBPS else 0
    v_kbps = total_kbps - audio_kbps

    start = next((i for i, h in enumerate(TIERS) if MIN_VIDEO_KBPS[h] <= v_kbps), None)
    if start is not None:
        clip = workdir / "preview.mp4"
        tier, kb = start, int(v_kbps)
        for _ in range(4):
            h = TIERS[tier]
            cmd = [tool("ffmpeg"), "-y", "-v", "error", "-i", str(src),
                   "-vf", f"scale=-2:'trunc(min({h},ih)/2)*2'", "-c:v", "libx264",
                   "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "veryfast",
                   "-b:v", f"{kb}k", "-maxrate", f"{kb}k", "-bufsize", f"{kb * 2}k"]
            if audio_kbps:
                cmd += ["-c:a", "aac", "-b:a", f"{audio_kbps}k", "-ac", "1"]
            else:
                cmd += ["-an"]
            run(cmd + ["-movflags", "+faststart", str(clip)])
            size = clip.stat().st_size
            if size <= clip_budget:
                poster = workdir / "poster.jpg"
                poster.write_bytes(poster_b)
                return [PreviewFile(clip, "video/mp4"), PreviewFile(poster, "image/jpeg")], extra
            kb = int(kb * clip_budget / size * 0.95)  # scale by the measured overshoot
            while tier + 1 < len(TIERS) and kb < MIN_VIDEO_KBPS[TIERS[tier]]:
                tier += 1
            if kb < MIN_VIDEO_KBPS[TIERS[-1]]:
                break
        clip.unlink(missing_ok=True)
    return _stills(src, dur, workdir, budget), extra
