"""Local sqlite index of manifest records (rebuildable from S3 via sync_from_s3)."""
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path

from coldarchive import s3store
from coldarchive.manifest import Record

DEFAULT_DB = Path("~/.coldarchive/index.sqlite").expanduser()


class Index:
    def __init__(self, db: Path | None = None) -> None:
        self.db = Path(db) if db is not None else DEFAULT_DB
        self.db.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.execute("CREATE TABLE IF NOT EXISTS records ("
                      "id TEXT PRIMARY KEY, sha256 TEXT, path TEXT, json TEXT NOT NULL)")
            c.execute("CREATE INDEX IF NOT EXISTS records_sha256 ON records(sha256)")

    @contextmanager
    def _conn(self):
        """Transaction that commits/rolls back AND closes the connection."""
        with closing(sqlite3.connect(self.db)) as conn, conn:
            yield conn

    def upsert(self, r: Record) -> None:
        with self._conn() as c:
            c.execute("INSERT OR REPLACE INTO records (id, sha256, path, json) VALUES (?, ?, ?, ?)",
                      (r.id, r.sha256, r.original.get("path"), r.to_json()))

    def get(self, id: str) -> Record | None:
        with self._conn() as c:
            row = c.execute("SELECT json FROM records WHERE id = ?", (id,)).fetchone()
        return Record.from_json(row[0]) if row else None

    def by_sha256(self, h: str) -> Record | None:
        """First *verified* record with this sha256 (unverified records never count as duplicates)."""
        with self._conn() as c:
            rows = c.execute("SELECT json FROM records WHERE sha256 = ? ORDER BY id", (h,)).fetchall()
        for (j,) in rows:
            r = Record.from_json(j)
            if r.verification.get("verified") is True:
                return r
        return None

    def by_path(self, path: str) -> Record | None:
        """A verified record of this exact original path whose local copy has not been deleted."""
        with self._conn() as c:
            rows = c.execute("SELECT json FROM records WHERE path = ? ORDER BY id", (path,)).fetchall()
        for (j,) in rows:
            r = Record.from_json(j)
            if r.verification.get("verified") is True and not r.local_deleted:
                return r
        return None

    def remove(self, id: str) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM records WHERE id = ?", (id,))

    def all(self) -> list[Record]:
        with self._conn() as c:
            rows = c.execute("SELECT json FROM records ORDER BY id").fetchall()
        return [Record.from_json(r[0]) for r in rows]

    def sync_from_s3(self) -> int:
        records = s3store.list_manifests()
        for r in records:
            self.upsert(r)
        return len(records)
