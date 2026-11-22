from pathlib import Path

import pypdfium2 as pdfium

from .base import PreviewFile, jpeg_fit

MAX_PAGES = 5


def pdf_preview(src: Path, workdir: Path, budget: int) -> tuple[list[PreviewFile], dict]:
    pdf = pdfium.PdfDocument(str(src))
    try:
        total = len(pdf)
        n = min(MAX_PAGES, total)
        if n == 0:
            raise ValueError("empty pdf")
        share = budget // n
        files = []
        for i in range(n):
            img = pdf[i].render(scale=1.5).to_pil()
            out = workdir / f"page-{i + 1}.jpg"
            out.write_bytes(jpeg_fit(img, share))
            files.append(PreviewFile(out, "image/jpeg"))
    finally:
        pdf.close()
    return files, {"pages": total}
