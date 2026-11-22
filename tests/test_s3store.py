import pytest
from moto import mock_aws
import boto3

from coldarchive import s3store
from coldarchive.config import Settings
from coldarchive.hashing import Hasher
from coldarchive.manifest import Record

MIB = 1024 * 1024


@pytest.fixture
def s3(monkeypatch):
    with mock_aws():
        c = boto3.client("s3", region_name="eu-west-2")
        c.create_bucket(Bucket="tbucket", CreateBucketConfiguration={"LocationConstraint": "eu-west-2"})
        monkeypatch.setattr(s3store, "PART_SIZE", 5 * MIB)  # S3 minimum part size, keeps tests fast
        s3store.set_client(c, Settings(bucket="tbucket"))
        yield c
        s3store.set_client(None, Settings())


def _chunks(total, step=MIB):
    left = total
    while left:
        n = min(step, left)
        yield bytes([n % 251]) * n
        left -= n


def test_upload_and_verify_roundtrip(s3):
    h = s3store.upload_stream(_chunks(12 * MIB), "k/big", {"a": "b"}, "STANDARD")
    assert s3.head_object(Bucket="tbucket", Key="k/big")["ContentLength"] == 12 * MIB == h.n
    v = s3store.verify("k/big", h)
    assert v["size_match"] is True
    assert set(v) == {"size_match", "crc64nvme_match", "server_crc64nvme", "local_crc64nvme",
                      "storage_class", "verified"}
    if v["server_crc64nvme"] is not None:  # moto may not model FULL_OBJECT CRC
        assert v["crc64nvme_match"] is True and v["verified"] is True


def test_small_object_uses_put_object(s3):
    h = s3store.upload_stream(iter([b"hello"]), "k/small", {}, "STANDARD")
    assert s3.get_object(Bucket="tbucket", Key="k/small")["Body"].read() == b"hello"
    assert h.n == 5


def test_verify_detects_size_mismatch(s3):
    s3store.upload_stream(iter([b"hello"]), "k/s", {}, "STANDARD")
    h = Hasher()
    h.update(b"hellox")
    assert s3store.verify("k/s", h)["verified"] is False


def test_exception_mid_stream_aborts_multipart(s3):
    def gen():
        yield from _chunks(11 * MIB)  # 2 full parts flushed, then fail
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        s3store.upload_stream(gen(), "k/fail", {}, "STANDARD")
    assert s3.list_multipart_uploads(Bucket="tbucket").get("Uploads", []) == []
    assert s3.list_objects_v2(Bucket="tbucket").get("Contents", []) == []


def test_unicode_path_metadata_roundtrip(s3):
    from pathlib import Path
    from urllib.parse import unquote

    p = Path("/Users/x/Pellicole è più/città – 日本.mov")
    enc = s3store.encode_meta(p)
    assert enc.isascii()
    s3store.upload_stream(iter([b"x"]), "k/u", {"original-path": enc}, "STANDARD")
    got = s3.head_object(Bucket="tbucket", Key="k/u")["Metadata"]["original-path"]
    assert unquote(got) == str(p)


def _record(id_="item1"):
    return Record(
        id=id_, kind="video",
        original={"path": "/x", "host": "h", "bytes_on_disk": 5, "mtime": "2026-01-01T00:00:00"},
        s3={"bucket": "tbucket", "key": f"originals/2026/11/{id_}/x.mov", "bytes": 5,
            "storage_class": "STANDARD", "region": "eu-west-2"},
        sha256="s", crc64nvme="c", verification={"verified": True},
        uploaded_at="2026-11-15T00:00:00+00:00", min_storage_until="2027-05-14",
        previews=[{"key": f"previews/2026/11/{id_}/p.jpg", "bytes": 1, "content_type": "image/jpeg"}],
    )


def test_manifest_roundtrip_and_delete_item_removes_all_keys(s3):
    r = _record()
    for k in [r.s3["key"], r.previews[0]["key"]]:
        s3.put_object(Bucket="tbucket", Key=k, Body=b"x")
    s3store.put_manifest(r)
    assert [m.id for m in s3store.list_manifests()] == ["item1"]
    s3store.delete_item(r)
    assert s3.list_objects_v2(Bucket="tbucket").get("Contents", []) == []
    assert s3store.list_manifests() == []


def test_delete_item_removes_manifest_last(s3, monkeypatch):
    r = _record()
    s3store.put_manifest(r)
    order = []
    orig = s3.delete_object
    monkeypatch.setattr(s3, "delete_object", lambda **kw: (order.append(kw["Key"]), orig(**kw))[1])
    s3store.delete_item(r)
    assert order == [r.s3["key"], r.previews[0]["key"], "manifest/item1.json"]


def test_put_file(s3, tmp_path):
    f = tmp_path / "p.jpg"
    f.write_bytes(b"abc")
    assert s3store.put_file(f, "previews/p.jpg", "image/jpeg") == {
        "key": "previews/p.jpg", "bytes": 3, "content_type": "image/jpeg"}
    assert s3.head_object(Bucket="tbucket", Key="previews/p.jpg")["ContentType"] == "image/jpeg"


class _StubClient:
    def __init__(self, head):
        self._head = head

    def head_object(self, **kw):
        return self._head


def _verify_with(head, data=b"hello"):
    h = Hasher()
    h.update(data)
    s3store.set_client(_StubClient(head), Settings(bucket="tbucket"))
    try:
        return s3store.verify("k", h), h
    finally:
        s3store.set_client(None, Settings())


def _good_head(h):
    return {"ContentLength": h.n, "ChecksumCRC64NVME": h.crc64nvme_b64, "ChecksumType": "FULL_OBJECT"}


def test_verify_true_on_matching_full_object_crc():
    h = Hasher()
    h.update(b"hello")
    v, _ = _verify_with(_good_head(h))
    assert v["verified"] is True and v["crc64nvme_match"] is True


def test_verify_false_same_size_different_crc():
    h = Hasher()
    h.update(b"hello")
    head = {**_good_head(h), "ChecksumCRC64NVME": "AAAAAAAAAAA="}
    v, _ = _verify_with(head)
    assert v["size_match"] is True and v["crc64nvme_match"] is False and v["verified"] is False


def test_verify_false_composite_checksum_type():
    h = Hasher()
    h.update(b"hello")
    v, _ = _verify_with({**_good_head(h), "ChecksumType": "COMPOSITE"})
    assert v["verified"] is False


def test_verify_false_missing_server_crc():
    h = Hasher()
    h.update(b"hello")
    head = {"ContentLength": h.n, "ChecksumType": "FULL_OBJECT"}
    v, _ = _verify_with(head)
    assert v["verified"] is False and v["server_crc64nvme"] is None
