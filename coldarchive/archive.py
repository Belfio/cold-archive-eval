"""Archive pipeline: preview -> streamed upload -> verify -> previews -> manifest -> index."""
import copy
import dataclasses
import datetime as dt
import hashlib
import logging
import shutil
import socket
import subprocess
import tempfile
import uuid
from collections.abc import Iterator
from pathlib import Path

from coldarchive import s3store
from coldarchive.ids import key_prefix, make_id
from coldarchive.index import Index
from coldarchive.manifest import Prices, Record, est_monthly_usd, min_storage_until
from coldarchive.previews import detect_kind, make_preview
from coldarchive.previews.folder import folder_size

log = logging.getLogger(__name__)

CHUNK = 8 * 1024 * 1024
PREHASH_MAX = 2 * 1024**3
DEFAULT_WORKDIR = Path("~/.coldarchive/work").expanduser()
_RECORD_FIELDS = {f.name for f in dataclasses.fields(Record)} - {"extra"}


class ArchiveNotVerified(RuntimeError):
    pass


def _file_chunks(path: Path) -> Iterator[bytes]:
    with open(path, "rb") as f:
        while b := f.read(CHUNK):
            yield b


def _tar_stream(root: Path) -> Iterator[bytes]:
    p = subprocess.Popen(["tar", "-cf", "-", "-C", str(root.parent), "--", root.name], stdout=subprocess.PIPE)
    try:
        while b := p.stdout.read(CHUNK):
            yield b
    finally:
        p.stdout.close()
        if p.poll() is None:
            p.kill()
        rc = p.wait()
    if rc:
        raise RuntimeError(f"tar failed for {root} (exit {rc})")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    for b in _file_chunks(path):
        h.update(b)
    return h.hexdigest()


def _preview_prefix(original_key: str) -> str:
    """originals/YYYY/MM/<id>/<name> -> previews/YYYY/MM/<id>"""
    return "previews/" + original_key.split("/", 1)[1].rsplit("/", 1)[0]


def _upload_previews(files, prefix: str) -> list[dict]:
    return [s3store.put_file(f.path, f"{prefix}/{f.path.name}", f.content_type) for f in files]


def _split_extra(extra: dict) -> tuple[dict, dict]:
    known = {k: v for k, v in extra.items() if k in _RECORD_FIELDS}
    return known, {k: v for k, v in extra.items() if k not in _RECORD_FIELDS}


def _new_workdir(workdir: Path | None) -> Path:
    root = Path(workdir) if workdir is not None else DEFAULT_WORKDIR
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(dir=root, prefix="archive-"))


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """(size, mtime_ns) via lstat for the root and every entry beneath it (files, dirs, symlinks)."""
    snap = {}
    for p in [root, *root.rglob("*")]:
        st = p.lstat()
        snap[str(p.relative_to(root))] = (st.st_size, st.st_mtime_ns)
    return snap


def _check_source_unchanged(src: Path, st, size: int, is_folder: bool, pre_sha: str | None, h,
                            snap: dict | None = None) -> None:
    """The uploaded bytes must be exactly the local file we recorded."""
    if is_folder:
        if folder_size(src) != size or _snapshot(src) != snap:
            raise ArchiveNotVerified(f"{src}: folder changed during upload")
        return
    after = src.stat()
    if h.n != size or after.st_size != size or after.st_mtime_ns != st.st_mtime_ns:
        raise ArchiveNotVerified(f"{src}: file changed during upload ({h.n} uploaded, {size} expected)")
    if pre_sha is not None and pre_sha != h.sha256_hex:
        raise ArchiveNotVerified(f"{src}: content changed between hashing and upload")


def _unique_id(base: str, now: dt.datetime, name: str, index: Index) -> tuple[str, str, str]:
    """(id, prefix, key) that collide with nothing in the index or S3 (never reuse an id/key)."""
    n = 1
    while True:
        id_ = base if n == 1 else f"{base}-{n}"
        prefix = key_prefix(id_, now.date())
        key = f"originals/{prefix}/{name}"
        if not (index.get(id_) or s3store.manifest_exists(id_) or s3store.key_exists(key)):
            return id_, prefix, key
        n += 1


def archive_path(src: Path, *, note: str = "", tags: list[str] | None = None,
                 index: Index | None = None, workdir: Path | None = None) -> Record:
    src = Path(src).expanduser().absolute()
    if src.is_symlink():
        raise ValueError("refusing to archive a symlink; archive its target path instead")
    src = src.resolve()
    index = index or Index()
    is_folder = src.is_dir()
    st = src.stat()
    size = folder_size(src) if is_folder else st.st_size
    prior = index.by_path(str(src))
    # only if unchanged since that archive: a modified file at the same path is a new version
    if prior and prior.original.get("bytes_on_disk") == size and (
            is_folder or prior.original.get("mtime") == dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")):
        log.info("already archived: %s is %s", src, prior.id)
        return prior

    pre_sha = None
    if not is_folder and size <= PREHASH_MAX:
        pre_sha = _sha256_file(src)
        dup = index.by_sha256(pre_sha)
        if dup:
            log.info("duplicate: %s already archived as %s", src, dup.id)
            return dup

    work = _new_workdir(workdir)
    created: list[str] = []
    keep = False
    try:
        kind = detect_kind(src)
        files, extra = make_preview(src, work)
        now = dt.datetime.now(dt.timezone.utc)
        id_, prefix, key = _unique_id(make_id(src, now.date()), now,
                                      src.name + (".tar" if is_folder else ""), index)
        mtime = dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")
        meta = {"original-path": s3store.encode_meta(src), "source-host": socket.gethostname(),
                "original-mtime": mtime, "archive-id": id_}

        snap = _snapshot(src) if is_folder else None
        # conditional write: S3 refuses to overwrite. Only keys this call created are ever cleaned up.
        h = s3store.upload_stream(_tar_stream(src) if is_folder else _file_chunks(src),
                                  key, meta, "DEEP_ARCHIVE", overwrite=False)
        created.append(key)
        _check_source_unchanged(src, st, size, is_folder, pre_sha, h, snap)
        v = s3store.verify(key, h)
        if not v["verified"]:
            raise ArchiveNotVerified(f"{src}: verification failed: {v}")

        dup = index.by_sha256(h.sha256_hex)
        if dup:
            log.info("duplicate (post-upload): %s already archived as %s", src, dup.id)
            return dup  # finally-block cleanup deletes the just-created original

        prev_recs = _upload_previews(files, f"previews/{prefix}")
        created += [p["key"] for p in prev_recs]
        known, rest = _split_extra(extra)
        prev_bytes = sum(p["bytes"] for p in prev_recs)
        rec = Record(
            id=id_, kind=kind, note=note, tags=list(tags or []),
            original={"path": str(src), "host": socket.gethostname(), "bytes_on_disk": size, "mtime": mtime},
            s3={"bucket": s3store.settings.bucket, "key": key, "bytes": h.n,
                "storage_class": "DEEP_ARCHIVE", "region": "eu-west-2"},
            sha256=h.sha256_hex, crc64nvme=h.crc64nvme_b64, verification=v,
            previews=prev_recs, preview_ratio=round(prev_bytes / h.n, 4) if h.n else 0.0,
            est_monthly_usd=est_monthly_usd(h.n, prev_bytes, Prices.load()),
            uploaded_at=now.isoformat(timespec="seconds"),
            min_storage_until=min_storage_until(now).isoformat(),
            local_deleted=False, extra=rest, **known,
        )
        s3store.put_manifest(rec, overwrite=False)
        keep = True  # manifest exists: everything created is now referenced
        index.upsert(rec)
        return rec
    finally:
        if not keep:  # never leave an unrecorded object behind (only keys created by this call)
            for k in created:
                try:
                    s3store.delete_key(k)
                except Exception:
                    log.exception("cleanup failed for %s", k)
        shutil.rmtree(work, ignore_errors=True)


def import_existing(index: Index | None = None) -> int:
    """Rebuild the local index from S3 manifests. Index only: nothing is written back to S3.
    est_monthly_usd is recomputed with current prices when it differs (old value kept in extra)."""
    index, prices = index or Index(), Prices.load()
    records = s3store.list_manifests()
    for r in records:
        est = est_monthly_usd(r.s3.get("bytes", 0), sum(p.get("bytes", 0) for p in r.previews), prices)
        if abs(est - r.est_monthly_usd) > 1e-9:
            r.extra["est_monthly_usd_legacy"] = r.est_monthly_usd
            r.est_monthly_usd = est
        index.upsert(r)
    return len(records)


def regenerate_preview(id: str, *, index: Index | None = None, workdir: Path | None = None) -> Record:
    index = index or Index()
    rec = index.get(id)
    if rec is None:
        raise KeyError(f"unknown record: {id}")
    src = Path(rec.original["path"])
    if not src.exists():
        raise FileNotFoundError(f"original no longer on disk: {src}")
    size = folder_size(src) if src.is_dir() else src.stat().st_size
    if size != rec.original["bytes_on_disk"]:
        raise ValueError(f"{src} changed since archive ({size} != {rec.original['bytes_on_disk']} bytes)")

    work = _new_workdir(workdir)
    try:
        files, extra = make_preview(src, work)
        # fresh key names: live preview keys are never overwritten before the manifest switches
        token = uuid.uuid4().hex[:6]
        prefix = _preview_prefix(rec.s3["key"])
        new = []
        old_rec = copy.deepcopy(rec)
        try:
            for f in files:
                new.append(s3store.put_file(f.path, f"{prefix}/{token}-{f.path.name}", f.content_type))
            old_keys = {p["key"] for p in rec.previews}
            known, rest = _split_extra(extra)
            prev_bytes = sum(p["bytes"] for p in new)
            rec.extra = {k: v for k, v in rec.extra.items() if k != "preview_error"} | rest
            rec.preview_fallback = known.get("preview_fallback", False)
            rec.previews = new
            rec.preview_ratio = round(prev_bytes / rec.s3["bytes"], 4) if rec.s3["bytes"] else 0.0
            rec.est_monthly_usd = est_monthly_usd(rec.s3["bytes"], prev_bytes, Prices.load())
            index.upsert(rec)
            s3store.put_manifest(rec)  # last step that can fail; after it the new previews are live
        except BaseException:
            index.upsert(old_rec)
            for p in new:
                try:
                    s3store.delete_key(p["key"])
                except Exception:
                    log.exception("cleanup failed for %s", p["key"])
            raise
        for k in old_keys - {p["key"] for p in new}:
            s3store.delete_key(k)
        return rec
    finally:
        shutil.rmtree(work, ignore_errors=True)
