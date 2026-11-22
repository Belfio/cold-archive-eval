import email.mime.text
import mailbox
import subprocess
from pathlib import Path

import pytest
from PIL import Image

import coldarchive.previews as previews
from coldarchive.previews import detect_kind, make_preview
from coldarchive.previews.base import tool

FFMPEG = tool("ffmpeg")
FFPROBE = tool("ffprobe")


def total(files):
    return sum(f.path.stat().st_size for f in files)


def make_video(path: Path, seconds: int, size: str, audio: bool = False):
    cmd = [FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=5:duration={seconds}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=duration={seconds}", "-c:a", "aac"]
    subprocess.run(cmd + ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "35", str(path)], check=True)


@pytest.fixture(scope="module")
def video_60s(tmp_path_factory):
    p = tmp_path_factory.mktemp("v") / "long.mp4"
    make_video(p, 60, "1920x1080")
    return p


def test_video_preview_within_budget(video_60s, tmp_path, monkeypatch):
    monkeypatch.setattr("coldarchive.previews.preview_budget", lambda n: 200_000)
    files, extra = make_preview(video_60s, tmp_path / "w")
    assert total(files) <= 200_000
    assert extra["duration_s"] == pytest.approx(60, abs=1)
    assert {f.content_type for f in files} <= {"video/mp4", "image/jpeg"}


def test_long_video_falls_back_to_contact_sheet(video_60s, tmp_path, monkeypatch):
    # ~24 kbps total: below even the 144p minimum -> stills, no clip
    monkeypatch.setattr("coldarchive.previews.preview_budget", lambda n: 200_000)
    files, _ = make_preview(video_60s, tmp_path / "w")
    assert [f.path.name for f in files] == ["poster.jpg", "contact-sheet.jpg"]
    with Image.open(files[1].path) as sheet:
        assert sheet.format == "JPEG"
        assert sheet.width > sheet.height * 0.9  # 4x4 grid


def test_short_video_gets_clip(tmp_path, monkeypatch):
    src = tmp_path / "short.mp4"
    make_video(src, 10, "1280x720", audio=True)
    monkeypatch.setattr("coldarchive.previews.preview_budget", lambda n: 300_000)
    files, _ = make_preview(src, tmp_path / "w")
    assert any(f.content_type == "video/mp4" for f in files)
    assert total(files) <= min(300_000, src.stat().st_size)


def test_image_preview_within_budget(tmp_path):
    src = tmp_path / "big.png"
    Image.effect_noise((2000, 1500), 80).convert("RGB").save(src)
    size = src.stat().st_size
    files, _ = make_preview(src, tmp_path / "w")
    assert files[0].content_type == "image/jpeg"
    assert total(files) <= max(size // 100, 65_536)
    assert total(files) <= size


def test_audio_preview(tmp_path):
    src = tmp_path / "t.wav"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "sine=duration=20", str(src)], check=True)
    files, extra = make_preview(src, tmp_path / "w")
    assert files[0].content_type == "audio/mpeg"
    assert total(files) <= 65_536
    assert extra["duration_s"] == pytest.approx(20, abs=1)


def test_pdf_preview(tmp_path):
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument.new()
    for _ in range(7):
        pdf.new_page(300, 400)
    src = tmp_path / "d.pdf"
    pdf.save(str(src))
    with open(src, "ab") as f:  # real PDFs are bigger than the 64 KB budget floor
        f.write(b"\n%" + b"padding" * 40_000)
    files, extra = make_preview(src, tmp_path / "w")
    assert extra["pages"] == 7
    assert len(files) == 5
    assert all(f.content_type == "image/jpeg" for f in files)


def test_mbox_index_rows(tmp_path):
    src = tmp_path / "m.mbox"
    mb = mailbox.mbox(src)
    for i, subj in enumerate(["=?utf-8?q?Caf=C3=A9_menu?=", "plain", "third"]):
        m = email.mime.text.MIMEText("body\nFrom me to you\n")
        m["From"], m["To"], m["Subject"] = "a@x.com", "b@x.com", subj
        m["Date"] = f"Mon, 0{i + 1} Jan 2026 10:00:00 +0000"
        m["X-Gmail-Labels"] = "Inbox"
        mb.add(m)
    mb.close()
    files, extra = make_preview(src, tmp_path / "w")
    import gzip
    lines = gzip.open(files[0].path, "rt", encoding="utf-8").read().splitlines()
    assert extra["messages"] == 3
    assert len(lines) == 4  # header + 3 rows
    assert "Café menu" in lines[1]


def test_mbox_trimmed_to_budget(tmp_path, monkeypatch):
    src = tmp_path / "m.mbox"
    mb = mailbox.mbox(src)
    for i in range(400):
        m = email.mime.text.MIMEText("x")
        m["From"], m["To"], m["Subject"] = f"a{i}@x.com", "b@x.com", f"subject number {i} {i * 7919}"
        mb.add(m)
    mb.close()
    monkeypatch.setattr("coldarchive.previews.preview_budget", lambda n: 2_000)
    files, extra = make_preview(src, tmp_path / "w")
    assert total(files) <= 2_000
    assert extra["messages"] == 400


def test_folder_listing_contains_all_files(tmp_path):
    root = tmp_path / "f"
    (root / "sub").mkdir(parents=True)
    names = []
    for i in range(30):
        p = root / "sub" / f"img{i}.jpg"
        Image.effect_noise((400, 300), 60).convert("RGB").save(p)
        names.append(f"sub/img{i}.jpg")
    (root / "notes.txt").write_text("hello " * 20000)
    names.append("notes.txt")
    files, extra = make_preview(root, tmp_path / "w")
    import gzip, tarfile
    listing = gzip.open(files[0].path, "rt").read()
    assert extra["files"] == 31
    for n in names:
        assert n in listing
    size = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
    assert total(files) <= min(max(size // 100, 65_536), size)
    thumbs = [f for f in files if f.content_type == "application/x-tar"]
    if thumbs:
        with tarfile.open(thumbs[0].path) as tf:
            assert len(tf.getnames()) <= 120


def test_corrupt_video_falls_back_to_other(tmp_path):
    src = tmp_path / "bad.mp4"
    src.write_bytes(b"not a video at all" * 1000)
    files, extra = make_preview(src, tmp_path / "w")
    assert extra["preview_fallback"] is True
    assert extra["preview_error"]
    assert files[0].content_type == "text/plain"
    assert total(files) <= src.stat().st_size


def test_other_preview_text(tmp_path):
    src = tmp_path / "a.xyz"
    src.write_text("hello world" * 100)
    files, extra = make_preview(src, tmp_path / "w")
    assert "hello world" in files[0].path.read_text()
    assert "preview_fallback" not in extra


def test_detect_kind(tmp_path):
    assert detect_kind(tmp_path) == "folder"
    assert detect_kind(Path("a.MOV")) == "video"
    assert detect_kind(Path("a.pdf")) == "pdf"
    assert detect_kind(Path("a.mbox")) == "mbox"
    wav = tmp_path / "noext"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", "-f", "wav", str(wav)], check=True)
    assert detect_kind(wav) == "audio"


def test_fallback_never_deletes_source_or_neighbours(tmp_path):
    work = tmp_path / "w"
    work.mkdir()
    src = work / "bad.mp4"
    src.write_bytes(b"garbage" * 1000)
    neighbour = work / "unrelated.txt"
    neighbour.write_text("keep")
    files, extra = make_preview(src, work)
    assert extra["preview_fallback"] is True
    assert src.exists() and neighbour.exists()
    assert files[0].path.exists()


def test_heic_preview(tmp_path):
    jpg = tmp_path / "in.jpg"
    Image.effect_noise((1600, 1200), 80).convert("RGB").save(jpg, quality=95)
    heic = tmp_path / "x.heic"
    subprocess.run(["/usr/bin/sips", "-s", "format", "heic", str(jpg), "--out", str(heic)],
                   check=True, capture_output=True)
    files, extra = make_preview(heic, tmp_path / "w")
    assert "preview_fallback" not in extra
    assert files[0].content_type == "image/jpeg"
    assert total(files) <= heic.stat().st_size
    assert [p.name for p in files[0].path.parent.iterdir()] == ["preview.jpg"]


def test_image_keeps_min_320_edge(tmp_path, monkeypatch):
    src = tmp_path / "n.png"
    Image.effect_noise((1200, 900), 90).convert("RGB").save(src)
    monkeypatch.setattr("coldarchive.previews.preview_budget", lambda n: 40_000)
    files, _ = make_preview(src, tmp_path / "w")
    with Image.open(files[0].path) as im:
        assert max(im.size) >= 320


def test_video_preview_is_yuv420p(tmp_path, monkeypatch):
    src = tmp_path / "ten.mkv"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=5:duration=6",
                    "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-preset", "ultrafast", "-crf", "8", str(src)], check=True)
    monkeypatch.setattr("coldarchive.previews.preview_budget", lambda n: 300_000)
    files, _ = make_preview(src, tmp_path / "w")
    clip = next(f for f in files if f.content_type == "video/mp4")
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=pix_fmt", "-of", "csv=p=0", str(clip.path)], capture_output=True, text=True)
    assert out.stdout.strip() == "yuv420p"


def test_zip_gets_listing(tmp_path):
    import gzip, zipfile
    src = tmp_path / "a.zip"
    with zipfile.ZipFile(src, "w") as z:
        z.writestr("d/one.txt", "x" * 200_000)
        z.writestr("two.txt", "y" * 100_000)
    assert detect_kind(src) == "zip"
    files, extra = make_preview(src, tmp_path / "w")
    listing = gzip.open(files[0].path, "rt").read()
    assert "d/one.txt" in listing and "two.txt" in listing
    assert extra["files"] == 2


def test_text_files_are_other_not_video(tmp_path):
    for name in ("a.txt", "b.md", "c.log", "d.ans"):
        p = tmp_path / name
        p.write_text("hello world\n" * 50)
        assert detect_kind(p) == "other"
    q = tmp_path / "noext"  # no suffix: ffprobe's tty demuxer must not make this a video
    q.write_text("hello world\n" * 50)
    assert detect_kind(q) == "other"
