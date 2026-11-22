import base64

from coldarchive.hashing import Hasher, crc64nvme_b64


def test_crc_matches_known_vector():
    assert crc64nvme_b64(b"123456789") == base64.b64encode(bytes.fromhex("ae8b14860a799888")).decode()


def test_hasher_incremental_equals_oneshot():
    h = Hasher()
    h.update(b"abc")
    h.update(b"def")
    assert h.crc64nvme_b64 == crc64nvme_b64(b"abcdef") and h.n == 6


def test_hasher_sha256():
    h = Hasher()
    h.update(b"abc")
    assert h.sha256_hex == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
