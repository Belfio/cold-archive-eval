import json
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from coldarchive import archive, s3store
from coldarchive.archive import ArchiveNotVerified, archive_path, import_existing, regenerate_preview
from coldarchive.config import Settings
from coldarchive.index import Index
from coldarchive.manifest import Record

FIXTURE = Path(__file__).parent / "fixtures" / "manifest_2026-11-14_screen.json"


@pytest.fixture
def s3(monkeypatch):
    with mock_aws():
        c = boto3.client("s3", region_name="eu-west-2")
        c.create_bucket(Bucket="tbucket", CreateBucketConfiguration={"LocationConstraint": "eu-west-2"})
        s3store.set_client(c, Settings(bucket="tbucket"))
        # moto does not model the full-object CRC; make verification deterministic
        monkeypatch.setattr(s3store, "verify", lambda key, h: {
            "size_match": True, "crc64nvme_match": True, "server_crc64nvme": h.crc64nvme_b64,
            "local_crc64nvme": h.crc64nvme_b64, "storage_class": "DEEP_ARCHIVE", "verified": True})
        yield c
        s3store.set_client(None, Settings())


@pytest.fixture
def idx(tmp_path):
    return Index(tmp_path / "index.sqlite")


def keys(c, prefix):
    return sorted(o["Key"] for o in c.list_objects_v2(Bucket="tbucket", Prefix=prefix).get("Contents", []))


def kw(tmp_path, idx):
    return dict(index=idx, workdir=tmp_path / "work")


def test_archive_file_writes_verified_manifest(s3, idx, tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("hello cold archive " * 1000)
    r = archive_path(f, note="n", tags=["a"], **kw(tmp_path, idx))
    assert r.verification["verified"] is True
    assert r.s3["storage_class"] == "DEEP_ARCHIVE" and r.s3["region"] == "eu-west-2"
    assert r.s3["key"].startswith("originals/") and r.s3["key"].endswith("/notes.txt")
    assert r.original["bytes_on_disk"] == f.stat().st_size == r.s3["bytes"]
    assert r.local_deleted is False and r.note == "n" and r.tags == ["a"]
    stored = Record.from_json(s3.get_object(Bucket="tbucket", Key=f"manifest/{r.id}.json")["Body"].read().decode())
    assert stored == r
    assert r.previews and all(keys(s3, p["key"]) == [p["key"]] for p in r.previews)
    assert all(p["key"].startswith("previews/") for p in r.previews)
    assert idx.by_sha256(r.sha256).id == r.id
    assert not list((tmp_path / "work").iterdir())  # workdir cleaned


def test_duplicate_sha_is_skipped(s3, idx, tmp_path):
    a, b = tmp_path / "a.txt", tmp_path / "b.txt"
    a.write_text("same bytes " * 500)
    b.write_text("same bytes " * 500)
    r1 = archive_path(a, **kw(tmp_path, idx))
    before = keys(s3, "")
    r2 = archive_path(b, **kw(tmp_path, idx))
    assert r2.id == r1.id
    assert keys(s3, "") == before
    assert len(idx.all()) == 1


def test_duplicate_found_after_upload_deletes_new_original(s3, idx, tmp_path, monkeypatch):
    monkeypatch.setattr(archive, "PREHASH_MAX", 0)  # force the post-upload dedupe path
    a, b = tmp_path / "a.txt", tmp_path / "b.txt"
    a.write_text("same bytes " * 500)
    b.write_text("same bytes " * 500)
    r1 = archive_path(a, **kw(tmp_path, idx))
    before = keys(s3, "")
    r2 = archive_path(b, **kw(tmp_path, idx))
    assert r2.id == r1.id
    assert keys(s3, "") == before  # b's original deleted, no manifest, no previews
    assert len(idx.all()) == 1


def test_folder_archived_as_single_tar(s3, idx, tmp_path):
    d = tmp_path / "proj"
    (d / "sub").mkdir(parents=True)
    (d / "one.txt").write_text("1" * 3000)
    (d / "sub" / "two.txt").write_text("2" * 3000)
    r = archive_path(d, **kw(tmp_path, idx))
    assert r.kind == "folder"
    assert r.s3["key"].endswith("/proj.tar")
    assert [k for k in keys(s3, "originals/")] == [r.s3["key"]]
    assert r.original["bytes_on_disk"] == 6000
    assert s3.head_object(Bucket="tbucket", Key=r.s3["key"])["ContentLength"] == r.s3["bytes"]
    assert r.s3["bytes"] > 6000  # tar of both files, not a single member
    # the stream is a real tar of the folder
    import io, subprocess
    listing = subprocess.run(["tar", "-tf", "-"], input=b"".join(archive._tar_stream(d)),
                             capture_output=True, check=True).stdout.decode().split()
    assert "proj/one.txt" in listing and "proj/sub/two.txt" in listing


def test_no_manifest_when_verify_fails(s3, idx, tmp_path, monkeypatch):
    monkeypatch.setattr(s3store, "verify", lambda key, h: {"verified": False})
    f = tmp_path / "x.txt"
    f.write_text("data " * 1000)
    with pytest.raises(ArchiveNotVerified):
        archive_path(f, **kw(tmp_path, idx))
    assert keys(s3, "") == []  # original deleted, no manifest
    assert idx.all() == []


def test_import_existing_loads_fixture_records(s3, idx):
    s3.put_object(Bucket="tbucket", Key="manifest/screen-recording-2026-06-14.json",
                  Body=FIXTURE.read_bytes())
    assert import_existing(idx) == 1
    r = idx.get("screen-recording-2026-06-14")
    assert r.verification["verified"] is True
    orig = json.loads(FIXTURE.read_text())
    got = json.loads(r.to_json())
    assert {k: got[k] for k in orig if k != "est_monthly_usd"} == {k: v for k, v in orig.items() if k != "est_monthly_usd"}
    assert idx.by_sha256(r.sha256).id == r.id


def test_import_recomputes_stale_estimate_index_only(s3, idx):
    key = "manifest/screen-recording-2026-06-14.json"
    s3.put_object(Bucket="tbucket", Key=key, Body=FIXTURE.read_bytes())
    import_existing(idx)
    r = idx.get("screen-recording-2026-06-14")
    legacy = json.loads(FIXTURE.read_text())
    assert r.extra["est_monthly_usd_legacy"] == legacy["est_monthly_usd"] == 0.0059
    assert r.est_monthly_usd == 0.0087  # 3.8GB deep archive + 105MB standard at prices.json
    got = json.loads(r.to_json())
    for k, v in legacy.items():  # nothing else changed
        assert k == "est_monthly_usd" or got[k] == v
    assert s3.get_object(Bucket="tbucket", Key=key)["Body"].read() == FIXTURE.read_bytes()  # no write-back
    # a record whose estimate already matches is left alone
    import_existing(idx)
    assert idx.get("screen-recording-2026-06-14").extra["est_monthly_usd_legacy"] == 0.0059


def test_import_skips_malformed_manifests(s3, idx, caplog):
    s3.put_object(Bucket="tbucket", Key="manifest/good.json", Body=FIXTURE.read_bytes())
    s3.put_object(Bucket="tbucket", Key="manifest/bad1.json", Body=b"not json{")
    s3.put_object(Bucket="tbucket", Key="manifest/bad2.json", Body=b'{"id": "x"}')
    s3.put_object(Bucket="tbucket", Key="manifest/bad3.json", Body=b"[1, 2]")
    with caplog.at_level("WARNING"):
        assert import_existing(idx) == 1
    assert [r.id for r in idx.all()] == ["screen-recording-2026-06-14"]
    assert sum("skipping malformed manifest" in m for m in caplog.messages) == 3


def test_symlink_source_refused_nothing_uploaded(s3, idx, tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    (real / "a.txt").write_text("x" * 100)
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        archive_path(link, **kw(tmp_path, idx))
    flink = tmp_path / "flink"
    flink.symlink_to(real / "a.txt")
    with pytest.raises(ValueError, match="symlink"):
        archive_path(flink, **kw(tmp_path, idx))
    assert keys(s3, "") == [] and idx.all() == []


def test_already_archived_same_path_returns_record_without_upload(s3, idx, tmp_path, caplog):
    f = tmp_path / "doc.txt"
    f.write_text("hello " * 500)
    r1 = archive_path(f, **kw(tmp_path, idx))
    before = keys(s3, "")
    with caplog.at_level("INFO"):
        r2 = archive_path(f, **kw(tmp_path, idx))
    assert r2.id == r1.id and keys(s3, "") == before
    assert any("already archived" in m for m in caplog.messages)
    # but a local_deleted record does not short-circuit
    r1.local_deleted = True
    idx.upsert(r1)
    assert idx.by_path(str(f.resolve())) is None


def test_regenerate_preview_replaces_old_keys(s3, idx, tmp_path, monkeypatch):
    f = tmp_path / "doc.txt"
    f.write_text("hello " * 5000)
    r = archive_path(f, **kw(tmp_path, idx))
    old = r.previews[0]["key"]
    # plant a stale preview key that the new set will not reuse
    stale = old.rsplit("/", 1)[0] + "/stale.txt"
    s3.put_object(Bucket="tbucket", Key=stale, Body=b"x")
    r.previews.append({"key": stale, "bytes": 1, "content_type": "text/plain"})
    idx.upsert(r)
    r2 = regenerate_preview(r.id, **kw(tmp_path, idx))
    assert stale not in {p["key"] for p in r2.previews}
    assert old not in {p["key"] for p in r2.previews}  # fresh keys; old ones removed after the switch
    assert keys(s3, "previews/") == sorted(p["key"] for p in r2.previews)
    assert idx.get(r.id).previews == r2.previews
    assert r2.preview_ratio == round(sum(p["bytes"] for p in r2.previews) / r2.s3["bytes"], 4)
    stored = Record.from_json(s3.get_object(Bucket="tbucket", Key=f"manifest/{r.id}.json")["Body"].read().decode())
    assert stored.previews == r2.previews


def test_regenerate_refuses_changed_original(s3, idx, tmp_path):
    f = tmp_path / "doc.txt"
    f.write_text("hello " * 5000)
    r = archive_path(f, **kw(tmp_path, idx))
    f.write_text("changed")
    with pytest.raises(ValueError):
        regenerate_preview(r.id, **kw(tmp_path, idx))
    f.unlink()
    with pytest.raises(FileNotFoundError):
        regenerate_preview(r.id, **kw(tmp_path, idx))


def _edit(f, text):
    f.write_text(text)
    import os
    st = f.stat()
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))


def test_rearchive_same_path_with_failing_verify_keeps_first_intact(s3, idx, tmp_path, monkeypatch):
    f = tmp_path / "doc.txt"
    f.write_text("first version " * 500)
    r1 = archive_path(f, **kw(tmp_path, idx))
    before = keys(s3, "")
    _edit(f, "second version " * 500)
    monkeypatch.setattr(s3store, "verify", lambda key, h: {"verified": False})
    with pytest.raises(ArchiveNotVerified):
        archive_path(f, **kw(tmp_path, idx))
    assert keys(s3, "") == before
    assert idx.get(r1.id) == r1
    assert s3.head_object(Bucket="tbucket", Key=r1.s3["key"])["ContentLength"] == r1.s3["bytes"]


def test_rearchive_same_path_changed_content_makes_second_record(s3, idx, tmp_path):
    f = tmp_path / "doc.txt"
    f.write_text("first version " * 500)
    r1 = archive_path(f, **kw(tmp_path, idx))
    _edit(f, "second version " * 600)
    r2 = archive_path(f, **kw(tmp_path, idx))
    assert r2.id != r1.id and r2.s3["key"] != r1.s3["key"]
    assert {r.id for r in idx.all()} == {r1.id, r2.id}
    for r in (r1, r2):
        s3.head_object(Bucket="tbucket", Key=r.s3["key"])
        s3.head_object(Bucket="tbucket", Key=f"manifest/{r.id}.json")


def test_s3_refuses_to_overwrite_existing_original(s3):
    s3store.upload_stream(iter([b"one"]), "k/x", {}, "STANDARD", overwrite=False)
    with pytest.raises(Exception):
        s3store.upload_stream(iter([b"two"]), "k/x", {}, "STANDARD", overwrite=False)
    assert s3.get_object(Bucket="tbucket", Key="k/x")["Body"].read() == b"one"


def test_file_modified_during_upload_raises_and_cleans(s3, idx, tmp_path, monkeypatch):
    f = tmp_path / "doc.txt"
    f.write_text("original " * 500)
    real = s3store.upload_stream

    def racing(chunks, *a, **k):
        h = real(chunks, *a, **k)
        f.write_text("modified " * 700)  # changes after the bytes were read
        return h

    monkeypatch.setattr(s3store, "upload_stream", racing)
    with pytest.raises(ArchiveNotVerified):
        archive_path(f, **kw(tmp_path, idx))
    assert keys(s3, "") == [] and idx.all() == []


def test_content_changed_between_hash_and_upload_raises(s3, idx, tmp_path, monkeypatch):
    f = tmp_path / "doc.txt"
    f.write_text("original " * 500)
    real_sha = archive._sha256_file
    monkeypatch.setattr(archive, "_sha256_file", lambda p: real_sha(p)[::-1])  # stale pre-hash
    with pytest.raises(ArchiveNotVerified):
        archive_path(f, **kw(tmp_path, idx))
    assert keys(s3, "") == []


def test_regenerate_cleans_new_previews_when_manifest_write_fails(s3, idx, tmp_path, monkeypatch):
    f = tmp_path / "doc.txt"
    f.write_text("hello " * 5000)
    r = archive_path(f, **kw(tmp_path, idx))
    before = keys(s3, "previews/")
    monkeypatch.setattr(s3store, "put_manifest", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError):
        regenerate_preview(r.id, **kw(tmp_path, idx))
    assert keys(s3, "previews/") == before
    assert idx.get(r.id) == r


def test_folder_named_like_tar_option(s3, idx, tmp_path):
    d = tmp_path / "-x"
    d.mkdir()
    (d / "a.txt").write_text("a" * 2000)
    r = archive_path(d, **kw(tmp_path, idx))
    assert r.s3["key"].endswith("/-x.tar") and r.verification["verified"]


def test_unverified_record_is_not_a_duplicate(s3, idx, tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("same bytes " * 500)
    r1 = archive_path(f, **kw(tmp_path, idx))
    r1.verification = {**r1.verification, "verified": False}
    idx.upsert(r1)
    assert idx.by_sha256(r1.sha256) is None
    r2 = archive_path(f, **kw(tmp_path, idx))
    assert r2.id != r1.id


def test_index_remove(idx, s3):
    s3.put_object(Bucket="tbucket", Key="manifest/screen-recording-2026-06-14.json", Body=FIXTURE.read_bytes())
    import_existing(idx)
    idx.remove("screen-recording-2026-06-14")
    assert idx.all() == []


def test_folder_same_size_edit_during_stream_raises(s3, idx, tmp_path, monkeypatch):
    d = tmp_path / "proj"
    d.mkdir()
    victim = d / "a.txt"
    victim.write_text("A" * 3000)
    (d / "b.txt").write_text("B" * 3000)
    real = archive._tar_stream

    def racing(root):
        for i, chunk in enumerate(real(root)):
            yield chunk
        _edit(victim, "Z" * 3000)  # same length, bumped mtime, after bytes were read

    monkeypatch.setattr(archive, "_tar_stream", racing)
    with pytest.raises(ArchiveNotVerified):
        archive_path(d, **kw(tmp_path, idx))
    assert keys(s3, "") == [] and idx.all() == []
