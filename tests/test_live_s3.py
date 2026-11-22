import os

import pytest

from coldarchive import s3store

pytestmark = pytest.mark.live
MIB = 1024 * 1024


@pytest.fixture
def live():
    s3store.set_client(None)  # real session: profile personal, eu-west-2
    assert s3store.settings.profile == "personal"
    c = s3store.get_client()
    keys = []
    yield c, keys
    try:
        for k in keys:
            c.delete_object(Bucket=s3store.settings.bucket, Key=k)
        ups = c.list_multipart_uploads(Bucket=s3store.settings.bucket, Prefix="_test/")
        assert ups.get("Uploads", []) == []
    finally:
        s3store.set_client(None)


def test_live_full_object_crc_verified(live):
    c, keys = live
    key = "_test/live-full-object-crc.bin"
    keys.append(key)
    h = s3store.upload_stream((os.urandom(MIB) for _ in range(70)), key, {"test": "1"}, "STANDARD")
    v = s3store.verify(key, h)
    assert v["verified"] is True, v
    assert h.n == 70 * MIB


def test_live_put_object_path_crc_verified(live):
    c, keys = live
    key = "_test/live-put-object-crc.bin"
    keys.append(key)
    h = s3store.upload_stream((os.urandom(MIB) for _ in range(3)), key, {"test": "1"}, "STANDARD")
    v = s3store.verify(key, h)
    assert v["verified"] is True, v
    assert h.n == 3 * MIB
