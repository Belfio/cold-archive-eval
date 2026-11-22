import datetime as dt
import json
import os
import socket
import time
from pathlib import Path

import pytest

from coldarchive import local, s3store
from coldarchive.config import Settings
from coldarchive.index import Index
from coldarchive.local import ManifestUpdateFailed, PartialDelete, mark_local_deleted, RefuseDelete, delete_local, suggest_stale
from coldarchive.manifest import Record


def iso(p: Path) -> str:
    return dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")


def rec(path: Path, *, verified=True, host=None, size=None, mtime=None, uploaded=None, id="r1") -> Record:
    folder = path.is_dir()
    return Record(
        id=id, kind="folder" if folder else "other",
        original={"path": str(path), "host": host or socket.gethostname(),
                  "bytes_on_disk": size if size is not None else (
                      sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) if folder else path.stat().st_size),
                  "mtime": mtime or iso(path)},
        s3={"bucket": "tbucket", "key": "originals/k", "bytes": 12345, "storage_class": "DEEP_ARCHIVE"},
        sha256="x", crc64nvme="y", verification={"verified": verified},
        uploaded_at=uploaded or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        min_storage_until="2027-01-01")


GOOD_HEAD = {"ContentLength": 12345, "ChecksumCRC64NVME": "y", "ChecksumType": "FULL_OBJECT",
             "StorageClass": "DEEP_ARCHIVE"}


class StubS3:
    def __init__(self, head=None, exc=None):
        self.head, self.exc, self.calls = dict(GOOD_HEAD) if head is None else head, exc, []

    def head_object(self, **kw):
        self.calls.append(kw)
        if self.exc:
            raise self.exc
        return self.head


@pytest.fixture(autouse=True)
def s3stub():
    stub = StubS3()
    s3store.set_client(stub, Settings(bucket="tbucket"))
    yield stub
    s3store.set_client(None, Settings())


@pytest.fixture
def idx(tmp_path):
    return Index(tmp_path / "idx" / "index.sqlite")


@pytest.fixture
def puts(monkeypatch):
    calls = []
    monkeypatch.setattr(s3store, "put_manifest", lambda r, overwrite=True: calls.append((r.id, overwrite)))
    return calls


@pytest.fixture
def f(tmp_path):
    p = tmp_path / "data" / "big.bin"
    p.parent.mkdir()
    p.write_bytes(b"x" * 1000)
    return p


def test_refuses_unverified(f, idx, puts):
    with pytest.raises(RefuseDelete, match="not verified"):
        delete_local(rec(f, verified=False), index=idx)
    assert f.exists() and not puts


def test_refuses_if_file_changed_after_upload(f, idx, puts):
    r = rec(f)
    f.write_bytes(b"x" * 999)
    with pytest.raises(RefuseDelete, match="size"):
        delete_local(r, index=idx)
    r = rec(f)
    os.utime(f, (1_000_000_000, 1_000_000_000))
    with pytest.raises(RefuseDelete, match="mtime"):
        delete_local(r, index=idx)
    assert f.exists() and not puts


def test_refuses_other_host(f, idx, puts):
    with pytest.raises(RefuseDelete, match="another host"):
        delete_local(rec(f, host="elsewhere"), index=idx)
    assert f.exists()


def test_refuses_missing_already_deleted_symlink_protected(f, idx, puts, tmp_path, monkeypatch):
    with pytest.raises(RefuseDelete, match="missing"):
        delete_local(rec(tmp_path / "nope", size=1, mtime="2026-01-01T00:00:00"), index=idx)
    r = rec(f)
    r.local_deleted = True
    with pytest.raises(RefuseDelete, match="already"):
        delete_local(r, index=idx)
    link = tmp_path / "link"
    link.symlink_to(f)
    with pytest.raises(RefuseDelete, match="symlink"):
        delete_local(rec(link, size=1000, mtime=iso(f)), index=idx)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    d = tmp_path / "data"
    with pytest.raises(RefuseDelete, match="protected"):
        delete_local(rec(tmp_path, size=0), index=idx)
    with pytest.raises(RefuseDelete, match="protected"):
        delete_local(rec(Path("/"), size=0, mtime="x"), index=idx)
    assert f.exists() and d.exists() and not puts


def test_deletes_and_records_bytes_freed(f, idx, puts):
    r = rec(f)
    assert delete_local(r, index=idx) == 1000
    assert not f.exists()
    assert r.local_deleted and r.bytes_freed == 1000 and r.local_deleted_at
    assert puts == [("r1", True)]
    assert idx.get("r1").local_deleted is True


def test_folder_delete_and_refusals(tmp_path, idx, puts):
    d = tmp_path / "proj"
    (d / "sub").mkdir(parents=True)
    (d / "a.txt").write_bytes(b"a" * 10)
    (d / "sub" / "b.txt").write_bytes(b"b" * 20)
    old = time.time() - 1000
    for p in [d / "a.txt", d / "sub" / "b.txt", d / "sub", d]:
        os.utime(p, (old, old))
    r = rec(d)
    (d / "c.txt").write_bytes(b"c")
    with pytest.raises(RefuseDelete, match="size"):
        delete_local(r, index=idx)
    (d / "c.txt").unlink()
    for p in [d / "sub", d]:
        os.utime(p, (old, old))
    stale = rec(d, uploaded=(dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).isoformat(timespec="seconds"))
    os.utime(d / "a.txt", None)  # modified after upload
    with pytest.raises(RefuseDelete, match="after upload"):
        delete_local(stale, index=idx)
    os.utime(d / "a.txt", (old, old))
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    (d / "sub" / "ln").symlink_to(outside)
    with pytest.raises(RefuseDelete, match="symlink"):
        delete_local(rec(d), index=idx)
    (d / "sub" / "ln").unlink()
    assert d.exists() and not puts
    for p in [d / "sub", d]:
        os.utime(p, (old, old))
    assert delete_local(rec(d), index=idx) == 30
    assert not d.exists() and outside.exists()


def test_manifest_failure_after_delete_is_loud(f, idx, monkeypatch):
    def boom(r, overwrite=True):
        raise RuntimeError("s3 down")
    monkeypatch.setattr(s3store, "put_manifest", boom)
    with pytest.raises(ManifestUpdateFailed, match="HAS been deleted"):
        delete_local(rec(f), index=idx)
    assert not f.exists()


def test_suggest_skips_archived_and_node_modules(tmp_path, idx, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    old = time.time() - 90 * 86400

    def big(p: Path, age=old):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"z" * 100)
        os.utime(p, (age, age))
        return p

    keep = big(tmp_path / "Movies" / "keep.mov")
    archived = big(tmp_path / "Movies" / "archived.mov")
    big(tmp_path / "proj" / "node_modules" / "x.bin")
    big(tmp_path / "proj" / ".git" / "x.bin")
    big(tmp_path / "Library" / "Caches" / "c.bin")
    big(tmp_path / ".hidden" / "h.bin")
    big(tmp_path / "Movies" / "recent.mov", age=time.time())
    big(tmp_path / "Movies" / "tiny.mov").write_bytes(b"z")
    (tmp_path / "Movies" / "ln.mov").symlink_to(keep)
    idx.upsert(rec(archived, id="a1"))
    out = suggest_stale([tmp_path], min_bytes=50, untouched_days=60, index=idx)
    assert [s["path"] for s in out] == [str(keep)]
    assert out[0]["bytes"] == 100 and out[0]["kind_hint"] == "video"


def test_refuses_type_mismatch(tmp_path, idx, puts):
    d = tmp_path / "a.mbox"
    d.mkdir()
    (d / "x").write_bytes(b"y" * 10)
    r = rec(d, size=10)
    r.kind = "other"  # file record, directory on disk
    with pytest.raises(RefuseDelete, match="type mismatch"):
        delete_local(r, index=idx)
    f = tmp_path / "f.bin"
    f.write_bytes(b"y" * 10)
    r = rec(f)
    r.kind = "folder"  # folder record, file on disk
    with pytest.raises(RefuseDelete, match="type mismatch"):
        delete_local(r, index=idx)
    assert d.exists() and (d / "x").exists() and f.exists() and not puts


def test_refuses_inside_library_and_packages(tmp_path, idx, puts, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    a = tmp_path / "Library" / "x.bin"
    b = tmp_path / "Pictures" / "My.photoslibrary" / "o.bin"
    for p in (a, b):
        p.parent.mkdir(parents=True)
        p.write_bytes(b"z" * 5)
        with pytest.raises(RefuseDelete, match="protected"):
            delete_local(rec(p), index=idx)
        assert p.exists()


def test_partial_delete(tmp_path, idx, puts, monkeypatch):
    d = tmp_path / "proj"
    d.mkdir()
    (d / "a").write_bytes(b"a")
    (d / "b").write_bytes(b"b")
    old = time.time() - 1000
    for p in (d / "a", d / "b", d):
        os.utime(p, (old, old))

    def bad_rmtree(path):
        (Path(path) / "a").unlink()
        raise PermissionError("locked")
    monkeypatch.setattr(local.shutil, "rmtree", bad_rmtree)
    r = rec(d)
    with pytest.raises(PartialDelete, match="S3 copy"):
        delete_local(r, index=idx)
    assert (d / "b").exists() and not r.local_deleted
    assert "local_delete_partial" in idx.get("r1").extra


def test_suggest_skips_archived_folders_library_packages(tmp_path, idx, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    old = time.time() - 90 * 86400
    for rel in ("proj/big.bin", "proj/sub/big2.bin", "Library/L.bin", "P/x.photoslibrary/o.bin",
                "P/Z.app/o.bin", "P/ok.bin"):
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"z" * 100)
        os.utime(p, (old, old))
    d = tmp_path / "proj"
    idx.upsert(rec(d, size=200, mtime="2026-01-01T00:00:00", id="f1"))
    out = suggest_stale([tmp_path], min_bytes=50, index=idx)
    assert [s["path"] for s in out] == [str(tmp_path / "P" / "ok.bin")]
    assert suggest_stale([d / "sub"], min_bytes=50, index=idx) == []


def test_suggest_skips_protected_roots_and_relative_roots(tmp_path, idx, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    old = time.time() - 90 * 86400
    for rel in ("Library/Mail/m.bin", "Pictures/X.photoslibrary/o.bin", "proj/big.bin"):
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"z" * 100)
        os.utime(p, (old, old))
    for root in (tmp_path / "Library", tmp_path / "Library" / "Mail", tmp_path / "Pictures" / "X.photoslibrary"):
        assert suggest_stale([root], min_bytes=50, index=idx) == []
    idx.upsert(rec(tmp_path / "proj", size=100, mtime="2026-01-01T00:00:00", id="f1"))
    monkeypatch.chdir(tmp_path)
    assert suggest_stale([Path("proj")], min_bytes=50, index=idx) == []


def test_mark_local_deleted(tmp_path, idx, puts):
    f = tmp_path / "gone.bin"
    f.write_bytes(b"q" * 7)
    r = rec(f)
    r.extra["local_delete_partial"] = "x"
    with pytest.raises(RefuseDelete, match="still exists"):
        mark_local_deleted(r, index=idx)
    f.unlink()
    mark_local_deleted(r, index=idx)
    assert r.local_deleted and r.bytes_freed == 7 and r.local_deleted_at and "local_delete_partial" not in r.extra
    assert puts == [("r1", True)] and idx.get("r1").local_deleted
    r2 = rec(tmp_path / "x", size=1, mtime="m", verified=False)
    with pytest.raises(RefuseDelete, match="not verified"):
        mark_local_deleted(r2, index=idx)


@pytest.mark.parametrize("head,match", [
    ({"ContentLength": 1}, "size"),
    ({"ChecksumCRC64NVME": "zzz"}, "CRC64NVME"),
    ({"ChecksumCRC64NVME": None}, "CRC64NVME"),
    ({"ChecksumType": "COMPOSITE"}, "CRC64NVME"),
    ({"StorageClass": "STANDARD"}, "storage class"),
    ({"StorageClass": None}, "storage class"),
])
def test_refuses_when_s3_head_mismatches(f, idx, puts, s3stub, head, match):
    s3stub.head = {**GOOD_HEAD, **head}
    with pytest.raises(RefuseDelete, match=match):
        delete_local(rec(f), index=idx)
    assert f.exists() and not puts


def test_refuses_wrong_bucket_without_calling_s3(f, idx, puts, s3stub):
    r = rec(f)
    r.s3["bucket"] = "other-bucket"
    with pytest.raises(RefuseDelete, match="bucket"):
        delete_local(r, index=idx)
    assert f.exists() and not s3stub.calls


@pytest.mark.parametrize("code", ["404", "403"])
def test_refuses_on_s3_client_error(f, idx, puts, s3stub, code):
    from botocore.exceptions import ClientError
    s3stub.exc = ClientError({"Error": {"Code": code, "Message": "x"}}, "HeadObject")
    with pytest.raises(RefuseDelete, match="cannot confirm"):
        delete_local(rec(f), index=idx)
    assert f.exists() and not puts


def test_refuses_on_network_error(f, idx, puts, s3stub):
    s3stub.exc = ConnectionError("down")
    with pytest.raises(RefuseDelete, match="cannot confirm"):
        delete_local(rec(f), index=idx)
    assert f.exists()


def test_s3_check_uses_record_key_and_checksum_mode(f, idx, puts, s3stub):
    delete_local(rec(f), index=idx)
    assert s3stub.calls == [{"Bucket": "tbucket", "Key": "originals/k", "ChecksumMode": "ENABLED"}]


def test_manifest_update_failed_names_recovery_command(f, idx, monkeypatch):
    monkeypatch.setattr(s3store, "put_manifest", lambda r, overwrite=True: (_ for _ in ()).throw(RuntimeError("x")))
    with pytest.raises(ManifestUpdateFailed, match="coldarchive mark-local-deleted r1"):
        delete_local(rec(f), index=idx)


FIXTURE = Path(__file__).parent / "fixtures" / "manifest_2026-11-14_photos_folder.json"


def test_legacy_folder_fixture_round_trips():
    raw = FIXTURE.read_text()
    r = Record.from_json(raw)
    out, orig = json.loads(r.to_json()), json.loads(raw)
    assert {k: out[k] for k in orig} == orig  # every stored field survives; only defaults are added
    assert r.kind == "folder" and r.verification["verified"] is True


def test_legacy_folder_record_can_be_deleted_locally(tmp_path, idx, puts, s3stub):
    r = Record.from_json(FIXTURE.read_text())
    d = tmp_path / "photos-backup" / "20261025-1859"
    (d / "sub").mkdir(parents=True)
    (d / "a.bin").write_bytes(b"a" * 700)
    (d / "sub" / "b.bin").write_bytes(b"b" * 300)
    old = dt.datetime(2026, 10, 25, 20, 9).timestamp()
    for p in (d / "a.bin", d / "sub" / "b.bin", d / "sub", d):
        os.utime(p, (old, old))
    r.original = {**r.original, "path": str(d), "bytes_on_disk": 1000, "host": socket.gethostname()}
    s3store.set_client(s3stub, Settings(bucket=r.s3["bucket"]))
    s3stub.head = {"ContentLength": r.s3["bytes"], "ChecksumCRC64NVME": r.crc64nvme,
                   "ChecksumType": "FULL_OBJECT", "StorageClass": "DEEP_ARCHIVE"}
    assert delete_local(r, index=idx) == 1000
    assert not d.exists() and r.local_deleted and puts == [(r.id, True)]
