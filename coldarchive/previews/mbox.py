import email.header
import email.parser
import gzip
from pathlib import Path

from .base import PreviewFile

HEADER = "date\tfrom\tto\tsubject\tgmail_labels\tbytes\n"


def _dec(v: str | None) -> str:
    try:
        return str(email.header.make_header(email.header.decode_header(v or "")))
    except Exception:
        return v or ""


def _clean(x: str) -> str:
    return x.replace("\t", " ").replace("\n", " ").replace("\r", "")[:300]


def read_rows(src: Path) -> list[str]:
    parser = email.parser.BytesHeaderParser()
    rows: list[str] = []
    hdr: list[bytes] = []
    in_hdr = False
    msg_bytes = 0
    prev_blank = True

    def flush():
        if not hdr:
            return
        m = parser.parsebytes(b"".join(hdr))
        cols = [_clean(_dec(m.get(k))) for k in ("Date", "From", "To", "Subject", "X-Gmail-Labels")]
        rows.append("\t".join(cols) + f"\t{msg_bytes}\n")

    with open(src, "rb") as f:
        for line in f:
            if line.startswith(b"From ") and prev_blank:
                flush()
                hdr, in_hdr, msg_bytes = [], True, len(line)
                prev_blank = False
                continue
            msg_bytes += len(line)
            prev_blank = line in (b"\n", b"\r\n")
            if in_hdr:
                if prev_blank:
                    in_hdr = False
                else:
                    hdr.append(line)
        flush()
    return rows


def _gz(rows: list[str]) -> bytes:
    return gzip.compress((HEADER + "".join(rows)).encode("utf-8"), mtime=0)


def mbox_preview(src: Path, workdir: Path, budget: int) -> tuple[list[PreviewFile], dict]:
    """Header index as gzip TSV, rows trimmed from the tail to fit the budget."""
    rows = read_rows(src)
    total = len(rows)
    data = _gz(rows)
    if len(data) > budget:
        lo, hi = 0, total  # largest row count that fits
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if len(_gz(rows[:mid])) <= budget:
                lo = mid
            else:
                hi = mid - 1
        data = _gz(rows[:lo])
        if len(data) > budget:
            raise ValueError("header alone exceeds budget")
    out = workdir / "index.tsv.gz"
    out.write_bytes(data)
    return [PreviewFile(out, "text/tab-separated-values")], {"messages": total}
