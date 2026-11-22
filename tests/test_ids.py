import re
from datetime import date
from pathlib import Path

from coldarchive.ids import key_prefix, make_id


def test_make_id_unicode_and_spaces():
    i = make_id(Path("/x/Tutti i messaggi compresi Spam e Cestino-002.mbox"), date(2026, 11, 15))
    assert re.fullmatch(r"[a-z0-9-]{1,67}", i) and i.startswith("tutti-i-messaggi")


def test_make_id_stable_and_path_dependent():
    d = date(2026, 11, 15)
    assert make_id(Path("/a/x.mbox"), d) == make_id(Path("/a/x.mbox"), date(2030, 1, 1))
    assert make_id(Path("/a/x.mbox"), d) != make_id(Path("/b/x.mbox"), d)


def test_make_id_long_and_accents():
    i = make_id(Path("/x/" + "Città é" * 40 + ".mbox"), date(2026, 11, 15))
    assert len(i) <= 67 and i.startswith("citta-e")


def test_key_prefix():
    assert key_prefix("abc-123456", date(2026, 3, 9)) == "2026/03/abc-123456"
