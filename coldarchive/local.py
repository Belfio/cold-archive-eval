"""Guarded PERMANENT local delete of archived originals, and stale-file suggestions.

delete_local refuses (RefuseDelete) whenever there is any doubt. Order: all checks -> delete ->
manifest re-put -> index upsert. If the manifest update fails after the delete, ManifestUpdateFailed
says the local copy IS gone (data is safe in S3) and the manifest needs a retry.
"""
import datetime as dt
import os
import shutil
import socket
import stat
import time
from pathlib import Path

from coldarchive import s3store
from coldarchive.index import Index
from coldarchive.manifest import Record
from coldarchive.previews import detect_kind
from coldarchive.previews.folder import folder_size


class RefuseDelete(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class ManifestUpdateFailed(Exception):
    """Local data WAS deleted, but the manifest/index update failed. Recover: `coldarchive mark-local-deleted <id>`."""


class PartialDelete(Exception):
    """Deletion started but did not finish. The S3 copy is intact; the local remainder must be removed by hand."""


PACKAGE_SUFFIXES = (".photoslibrary", ".photolibrary", ".app", ".fcpbundle", ".lrdata",
                    ".musiclibrary", ".tvlibrary")


def _local_iso(st_mtime: float) -> str:
    return dt.datetime.fromtimestamp(st_mtime).isoformat(timespec="seconds")


def _is_protected(resolved: Path) -> bool:
    home = Path.home().resolve()
    if resolved == Path(resolved.anchor) or resolved == home or resolved in home.parents:
        return True
    if resolved == home / "Library" or (home / "Library") in resolved.parents:
        return True
    return any(part.lower().endswith(PACKAGE_SUFFIXES) for part in resolved.parts)


def _check_folder(path: Path, r: Record) -> int:
    root = path.resolve()
    total, newest = 0, path.lstat().st_mtime
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        for name in dirnames + filenames:
            p = Path(dirpath) / name
            st = p.lstat()
            newest = max(newest, st.st_mtime)
            if stat.S_ISLNK(st.st_mode):
                target = p.resolve()
                if target != root and root not in target.parents:
                    raise RefuseDelete(f"folder contains a symlink pointing outside it: {p}")
            elif stat.S_ISREG(st.st_mode):
                total += st.st_size
    if total != r.original["bytes_on_disk"]:
        raise RefuseDelete(f"folder size changed since upload ({total} != {r.original['bytes_on_disk']})")
    uploaded = dt.datetime.fromisoformat(r.uploaded_at)
    if uploaded.tzinfo is None:
        raise RefuseDelete("uploaded_at has no timezone")
    # uploaded_at is truncated to whole seconds, so compare mtimes at second precision
    if int(newest) > int(uploaded.timestamp()):
        raise RefuseDelete("folder has entries modified after upload")
    return total


def _check_s3_copy(r: Record) -> None:
    """Fresh S3 check right before a permanent delete: the archived object must exist and match the record."""
    s3 = r.s3 or {}
    if s3.get("bucket") != s3store.settings.bucket:
        raise RefuseDelete(f"record bucket {s3.get('bucket')!r} is not the configured bucket "
                           f"{s3store.settings.bucket!r}")
    try:
        head = s3store.get_client().head_object(Bucket=s3["bucket"], Key=s3["key"], ChecksumMode="ENABLED")
    except Exception as e:
        raise RefuseDelete(f"cannot confirm the S3 copy right now ({type(e).__name__}: {e})") from e
    if head.get("ContentLength") != s3.get("bytes"):
        raise RefuseDelete(f"S3 size {head.get('ContentLength')} != recorded {s3.get('bytes')}")
    if not r.crc64nvme or head.get("ChecksumCRC64NVME") != r.crc64nvme or head.get("ChecksumType") != "FULL_OBJECT":
        raise RefuseDelete("S3 full-object CRC64NVME does not match the record")
    if head.get("StorageClass") != "DEEP_ARCHIVE":
        raise RefuseDelete(f"S3 storage class is {head.get('StorageClass')!r}, expected DEEP_ARCHIVE")


def delete_local(r: Record, *, index: Index | None = None) -> int:
    """Permanently delete the local original described by r. Returns bytes freed."""
    if r.verification.get("verified") is not True:
        raise RefuseDelete("record is not verified")
    if r.local_deleted:
        raise RefuseDelete("record already marked local_deleted")
    if r.original.get("host") != socket.gethostname():
        raise RefuseDelete(f"record is from another host ({r.original.get('host')!r})")
    raw = r.original.get("path")
    if not raw or not Path(raw).is_absolute():
        raise RefuseDelete("record path missing or not absolute")
    path = Path(raw)
    try:
        st = path.lstat()
    except OSError:
        raise RefuseDelete(f"path missing: {path}")
    if stat.S_ISLNK(st.st_mode):
        raise RefuseDelete("path is a symlink")
    if _is_protected(path.resolve()):
        raise RefuseDelete(f"path is protected: {path}")

    want_dir = r.kind == "folder"
    if stat.S_ISDIR(st.st_mode) != want_dir:
        raise RefuseDelete(f"type mismatch: record kind {r.kind!r} but path is "
                           f"{'a directory' if stat.S_ISDIR(st.st_mode) else 'not a directory'}")
    if stat.S_ISDIR(st.st_mode):
        freed = _check_folder(path, r)
    elif stat.S_ISREG(st.st_mode):
        if st.st_size != r.original["bytes_on_disk"]:
            raise RefuseDelete(f"size changed since upload ({st.st_size} != {r.original['bytes_on_disk']})")
        if _local_iso(st.st_mtime) != r.original["mtime"]:
            raise RefuseDelete(f"mtime changed since upload ({_local_iso(st.st_mtime)} != {r.original['mtime']})")
        freed = st.st_size
    else:
        raise RefuseDelete("path is not a regular file or folder")

    _check_s3_copy(r)  # last check before the permanent delete
    try:
        if want_dir:
            shutil.rmtree(path)
        else:
            path.unlink()
    except OSError as e:
        r.extra["local_delete_partial"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        try:
            s3store.put_manifest(r, overwrite=True)
            (index or Index()).upsert(r)
        except Exception:
            pass  # best effort; the PartialDelete below is the loud signal
        raise PartialDelete(
            f"{path}: deletion FAILED part-way ({e!r}); the S3 copy ({r.id}) is intact. Remove the remainder "
            f"manually, then call local.mark_local_deleted(record) (local_deleted stays False until then).") from e

    r.local_deleted = True
    r.local_deleted_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    r.bytes_freed = freed
    try:
        s3store.put_manifest(r, overwrite=True)
        (index or Index()).upsert(r)
    except Exception as e:
        raise ManifestUpdateFailed(
            f"{path} HAS been deleted locally (data is safe in S3 as {r.id}), but updating the manifest/index "
            f"failed: {e!r}. Recover with: coldarchive mark-local-deleted {r.id}") from e
    return freed


def mark_local_deleted(r: Record, *, index: Index | None = None) -> None:
    """After finishing a PartialDelete by hand: record the (now gone) original as deleted."""
    if r.verification.get("verified") is not True:
        raise RefuseDelete("record is not verified")
    if os.path.lexists(r.original["path"]):
        raise RefuseDelete(f"path still exists: {r.original['path']}")
    r.local_deleted = True
    r.local_deleted_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    r.bytes_freed = r.original["bytes_on_disk"]
    r.extra.pop("local_delete_partial", None)
    s3store.put_manifest(r, overwrite=True)
    (index or Index()).upsert(r)


SKIP_NAMES = {"node_modules", ".git", ".venv", "__pycache__", ".cache"}
SKIP_SUFFIXES = (("Library", "Containers"), ("Library", "Caches"))


def _skip_dir(p: Path, name: str, home: Path) -> bool:
    if name in SKIP_NAMES:
        return True
    if p.parent == home and (name.startswith(".") or name == "Library"):
        return True
    if name.lower().endswith(PACKAGE_SUFFIXES):
        return True
    return p.parts[-2:] in SKIP_SUFFIXES


def _protected_root(root: Path, home: Path) -> bool:
    lib = home / "Library"
    return (root == lib or lib in root.parents
            or any(part.lower().endswith(PACKAGE_SUFFIXES) for part in root.parts))


def suggest_stale(roots: list[Path], min_bytes: int = 500_000_000, untouched_days: int = 60,
                  *, index: Index | None = None) -> list[dict]:
    home = Path.home()
    archived = {r.original.get("path") for r in (index or Index()).all()}
    cutoff = time.time() - untouched_days * 86400
    out: list[dict] = []

    def walk(d: Path) -> None:
        if str(d) in archived:
            return
        try:
            it = list(os.scandir(d))
        except OSError:
            return
        for e in it:
            p = Path(e.path)
            try:
                if e.is_symlink():
                    continue
                if e.is_dir(follow_symlinks=False):
                    if not _skip_dir(p, e.name, home):
                        walk(p)
                elif e.is_file(follow_symlinks=False):
                    st = e.stat(follow_symlinks=False)
                    if st.st_size >= min_bytes and st.st_mtime <= cutoff and str(p) not in archived:
                        out.append({"path": str(p), "bytes": st.st_size, "mtime": _local_iso(st.st_mtime),
                                    "kind_hint": detect_kind(p)})
            except OSError:
                continue

    for root in roots:
        root = Path(root).expanduser().absolute()
        if _protected_root(root, home):
            continue
        if not any(str(a) in archived for a in root.parents):
            walk(root)
    return sorted(out, key=lambda s: -s["bytes"])


def default_roots() -> list[Path]:
    return [Path.home()]
