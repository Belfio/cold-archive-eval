"""S3 access: streamed multipart upload with full-object CRC64NVME, verify, manifests."""
import logging
import urllib.parse
from collections.abc import Iterable
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from coldarchive.config import Settings
from coldarchive.hashing import Hasher, crc64nvme_b64
from coldarchive.manifest import Record

log = logging.getLogger(__name__)

PART_SIZE = 64 * 1024 * 1024
CHUNK = 8 * 1024 * 1024

settings = Settings()
_client = None


def get_client():
    global _client
    if _client is None:
        session = boto3.Session(profile_name=settings.profile, region_name=settings.region)
        _client = session.client("s3")
    return _client


def set_client(client, new_settings: Settings | None = None) -> None:
    """Inject a client (tests) or None to reset to the default session client."""
    global _client, settings
    _client = client
    if new_settings is not None:
        settings = new_settings


def encode_meta(path: Path) -> str:
    return urllib.parse.quote(str(path))


def upload_stream(chunks: Iterable[bytes], key: str, metadata: dict[str, str], storage_class: str,
                  *, overwrite: bool = True) -> Hasher:
    """Stream chunks to S3, hashing as we go. Objects < PART_SIZE use put_object;
    larger ones multipart with per-part and full-object CRC64NVME. Any failure aborts.
    overwrite=False makes S3 itself refuse to replace an existing key (conditional write)."""
    s3, bucket = get_client(), settings.bucket
    cond = {} if overwrite else {"IfNoneMatch": "*"}
    h = Hasher()
    buf = bytearray()
    upload_id: str | None = None
    parts: list[dict] = []

    def flush(data: bytes) -> None:
        nonlocal upload_id
        if upload_id is None:
            upload_id = s3.create_multipart_upload(
                Bucket=bucket, Key=key, Metadata=metadata, StorageClass=storage_class,
                ChecksumAlgorithm="CRC64NVME", ChecksumType="FULL_OBJECT",
            )["UploadId"]
        crc = crc64nvme_b64(data)
        n = len(parts) + 1
        resp = s3.upload_part(Bucket=bucket, Key=key, UploadId=upload_id, PartNumber=n,
                              Body=data, ChecksumCRC64NVME=crc)
        parts.append({"PartNumber": n, "ETag": resp["ETag"], "ChecksumCRC64NVME": crc})

    try:
        for c in chunks:
            h.update(c)
            buf += c
            while len(buf) >= PART_SIZE:
                flush(bytes(buf[:PART_SIZE]))
                del buf[:PART_SIZE]
        if upload_id is None:
            s3.put_object(Bucket=bucket, Key=key, Body=bytes(buf), Metadata=metadata,
                          StorageClass=storage_class, ChecksumCRC64NVME=h.crc64nvme_b64, **cond)
        else:
            if buf:
                flush(bytes(buf))
            s3.complete_multipart_upload(
                Bucket=bucket, Key=key, UploadId=upload_id,
                MultipartUpload={"Parts": parts},
                ChecksumCRC64NVME=h.crc64nvme_b64, ChecksumType="FULL_OBJECT", **cond,
            )
    except BaseException:
        if upload_id is not None:
            s3.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
        raise
    return h


def verify(key: str, h: Hasher) -> dict:
    head = get_client().head_object(Bucket=settings.bucket, Key=key, ChecksumMode="ENABLED")
    ok_size = head["ContentLength"] == h.n
    server_crc = head.get("ChecksumCRC64NVME")
    ok_crc = server_crc == h.crc64nvme_b64 and head.get("ChecksumType") == "FULL_OBJECT"
    return {
        "size_match": ok_size, "crc64nvme_match": ok_crc, "server_crc64nvme": server_crc,
        "local_crc64nvme": h.crc64nvme_b64, "storage_class": head.get("StorageClass", "STANDARD"),
        "verified": ok_size and ok_crc,
    }


def put_file(path: Path, key: str, content_type: str) -> dict:
    data = Path(path).read_bytes()
    get_client().put_object(Bucket=settings.bucket, Key=key, Body=data, ContentType=content_type,
                            StorageClass="STANDARD")
    return {"key": key, "bytes": len(data), "content_type": content_type}


def _manifest_key(id_: str) -> str:
    return f"manifest/{id_}.json"


def put_manifest(r: Record, *, overwrite: bool = True) -> None:
    cond = {} if overwrite else {"IfNoneMatch": "*"}
    get_client().put_object(Bucket=settings.bucket, Key=_manifest_key(r.id),
                            Body=r.to_json().encode(), ContentType="application/json",
                            StorageClass="STANDARD", **cond)


def key_exists(key: str) -> bool:
    try:
        get_client().head_object(Bucket=settings.bucket, Key=key)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def manifest_exists(id_: str) -> bool:
    return key_exists(_manifest_key(id_))


def list_manifests() -> list[Record]:
    s3, out = get_client(), []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=settings.bucket, Prefix="manifest/"):
        for o in page.get("Contents", []):
            if o["Key"].endswith(".json"):
                body = s3.get_object(Bucket=settings.bucket, Key=o["Key"])["Body"].read()
                try:
                    out.append(Record.from_json(body.decode()))
                except (ValueError, TypeError, KeyError, AttributeError):
                    log.warning("skipping malformed manifest %s", o["Key"], exc_info=True)
    return out


def delete_item(r: Record) -> None:
    """Delete original, then previews, then manifest last (so a partial failure stays visible)."""
    s3 = get_client()
    keys = [r.s3["key"], *[p["key"] for p in r.previews], _manifest_key(r.id)]
    for k in keys:
        s3.delete_object(Bucket=settings.bucket, Key=k)


def delete_key(key: str) -> None:
    get_client().delete_object(Bucket=settings.bucket, Key=key)
