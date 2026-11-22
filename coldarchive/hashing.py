import base64
import hashlib

from awscrt.checksums import crc64nvme


def _b64(crc: int) -> str:
    return base64.b64encode(crc.to_bytes(8, "big")).decode()


def crc64nvme_b64(data: bytes) -> str:
    return _b64(crc64nvme(data))


class Hasher:
    """Incremental SHA-256 + CRC64NVME over a byte stream."""

    def __init__(self) -> None:
        self._sha = hashlib.sha256()
        self._crc = 0
        self.n = 0

    def update(self, b: bytes) -> None:
        self._sha.update(b)
        self._crc = crc64nvme(b, self._crc)
        self.n += len(b)

    @property
    def sha256_hex(self) -> str:
        return self._sha.hexdigest()

    @property
    def crc64nvme_b64(self) -> str:
        return _b64(self._crc)
