import datetime as dt
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from coldarchive import archive, cli, local, s3store, web
from coldarchive.index import Index
from coldarchive.manifest import GIB, Record


def make(id="a1", *, verified=True, until=None, nbytes=GIB, local_deleted=False, freed=0):
    until = until or (dt.date.today() + dt.timedelta(days=90)).isoformat()
    return Record(
        id=id, kind="video", original={"path": f"/x/{id}.mov", "host": "h", "bytes_on_disk": nbytes, "mtime": "t"},
        s3={"key": f"originals/2026/11/{id}/{id}.mov", "bytes": nbytes}, sha256="s" + id, crc64nvme="c",
        verification={"verified": verified}, uploaded_at="2026-11-01T00:00:00+00:00", min_storage_until=until,
        previews=[{"key": f"previews/2026/11/{id}/p.jpg", "bytes": 10, "content_type": "image/jpeg"}],
        est_monthly_usd=0.0018, local_deleted=local_deleted, bytes_freed=freed)


BASE = "http://127.0.0.1:8765"


def mk(app):
    return TestClient(app, base_url=BASE, headers={web.TOKEN_HEADER: app.state.token})


@pytest.fixture
def idx(tmp_path):
    return Index(tmp_path / "i.sqlite")


@pytest.fixture
def client(idx):
    idx.upsert(make("a1"))
    idx.upsert(make("b2", local_deleted=True, freed=500))
    return mk(web.create_app(idx))


def test_list_items(client):
    d = client.get("/api/items").json()
    assert [i["id"] for i in d["items"]] == ["a1", "b2"]
    a = d["items"][0]
    assert a["verified"] is True and a["size"] == GIB and a["name"] == "a1.mov"
    assert d["totals"]["stored_gb"] == 2.0
    assert d["totals"]["space_freed_bytes"] == 500
    assert d["totals"]["est_monthly_usd"] == pytest.approx(0.0036)


def test_delete_local_refusal_returns_409_with_reason(client, monkeypatch):
    def boom(r, index=None):
        raise local.RefuseDelete("record is not verified")
    monkeypatch.setattr(local, "delete_local", boom)
    r = client.post("/api/items/a1/delete-local", json={"confirm": True})
    assert r.status_code == 409 and r.json()["reason"] == "record is not verified"


def test_delete_local_requires_confirm(client, monkeypatch):
    monkeypatch.setattr(local, "delete_local", lambda r, index=None: pytest.fail("must not run"))
    assert client.post("/api/items/a1/delete-local", json={}).status_code == 400
    assert client.post("/api/items/a1/delete-local").status_code == 400


def test_delete_local_success_and_failures(client, monkeypatch):
    monkeypatch.setattr(local, "delete_local", lambda r, index=None: 123)
    assert client.post("/api/items/a1/delete-local", json={"confirm": True}).json() == {"bytes_freed": 123}
    for exc in (local.PartialDelete("half"), local.ManifestUpdateFailed("mf")):
        def boom(r, index=None, exc=exc):
            raise exc
        monkeypatch.setattr(local, "delete_local", boom)
        r = client.post("/api/items/a1/delete-local", json={"confirm": True})
        assert r.status_code == 500 and r.json()["message"] == str(exc)
    assert client.post("/api/items/zzz/delete-local", json={"confirm": True}).status_code == 404


def test_cloud_delete_requires_confirm_and_reports_early_charge(client, idx, monkeypatch):
    deleted = []
    monkeypatch.setattr(s3store, "delete_item", lambda r: deleted.append(r.id))
    r = client.delete("/api/items/a1")
    assert r.status_code == 409 and not deleted and idx.get("a1")
    # 1 GiB, 90 days left (+/-1 for midnight) at 0.0018/GB-mo
    assert r.json()["early_delete_charge_usd"] == pytest.approx(90 * 0.0018 / 30, abs=0.0001)
    r = client.delete("/api/items/a1?confirm=true")
    assert r.status_code == 200 and deleted == ["a1"] and idx.get("a1") is None


def test_cloud_delete_failure_keeps_index(client, idx, monkeypatch):
    def boom(r):
        raise RuntimeError("s3 down")
    monkeypatch.setattr(s3store, "delete_item", boom)
    r = client.delete("/api/items/a1?confirm=true")
    assert r.status_code == 500 and idx.get("a1") is not None


def test_no_charge_after_min_storage(client, idx):
    idx.upsert(make("old", until="2020-01-01"))
    assert client.delete("/api/items/old").json()["early_delete_charge_usd"] == 0.0


def test_preview_redirects_to_presigned_url(client, monkeypatch):
    class C:
        def generate_presigned_url(self, op, Params, ExpiresIn):
            assert op == "get_object" and ExpiresIn == 900 and Params["Key"] == "previews/2026/11/a1/p.jpg"
            return "https://signed.example/x"
    monkeypatch.setattr(s3store, "get_client", lambda: C())
    r = client.get("/api/items/a1/preview/0", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "https://signed.example/x"
    assert client.get("/api/items/a1/preview/5", follow_redirects=False).status_code == 404


@pytest.fixture
def homefiles(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / "Library").mkdir(parents=True)
    (home / "Docs").mkdir()
    for f in ("Docs/a", "Docs/b", "Library/x"):
        (home / f).write_text("x")
    monkeypatch.setattr(Path, "home", lambda: home)
    return home


def test_archive_job_runs_in_background(idx, monkeypatch, homefiles):
    def fake(p, *, index=None, **kw):
        return make("n1")
    monkeypatch.setattr(archive, "archive_path", fake)
    c = mk(web.create_app(idx))
    jid = c.post("/api/archive", json={"paths": [str(homefiles / "Docs/a"), str(homefiles / "Docs/b")]}).json()["id"]
    web_jobs = c.app.state.executor
    web_jobs.shutdown(wait=True)
    j = c.get(f"/api/jobs/{jid}").json()
    assert j["status"] == "done" and j["done"] == 2 and j["error"] is None
    assert c.get("/api/jobs/nope").status_code == 404
    assert c.post("/api/archive", json={"paths": []}).status_code == 400


def test_archive_job_error(idx, monkeypatch, homefiles):
    def fake(p, *, index=None, **kw):
        raise archive.ArchiveNotVerified("bad")
    monkeypatch.setattr(archive, "archive_path", fake)
    c = mk(web.create_app(idx))
    jid = c.post("/api/archive", json={"paths": [str(homefiles / "Docs/a")]}).json()["id"]
    c.app.state.executor.shutdown(wait=True)
    j = c.get(f"/api/jobs/{jid}").json()
    assert j["status"] == "error" and "bad" in j["error"]


def test_suggest(client, monkeypatch):
    monkeypatch.setattr(local, "suggest_stale", lambda roots, index=None, **kw: [{"path": "/big", "bytes": 9}])
    assert client.get("/api/suggest").json() == [{"path": "/big", "bytes": 9}]


def test_index_page(client):
    r = client.get("/")
    assert r.status_code == 200 and "<html" in r.text.lower() and "<script src" not in r.text and "https://" not in r.text


def test_server_binds_localhost_only(monkeypatch):
    seen = {}
    import uvicorn
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: seen.update(kw))
    web.serve()
    assert seen["host"] == "127.0.0.1" and seen["port"] == 8765
    monkeypatch.setattr(web, "HOST", "0.0.0.0")
    with pytest.raises(RuntimeError):
        web.serve()


def test_cli_delete_requires_yes_and_prints_charge(idx, monkeypatch):
    from typer.testing import CliRunner
    idx.upsert(make("a1"))
    monkeypatch.setattr(cli, "_index", lambda: idx)
    deleted = []
    monkeypatch.setattr(s3store, "delete_item", lambda r: deleted.append(r.id))
    run = CliRunner()
    res = run.invoke(cli.app, ["delete", "a1"])
    assert res.exit_code != 0 and "charge" in res.output.lower() and not deleted
    res = run.invoke(cli.app, ["delete", "a1", "--yes"])
    assert res.exit_code == 0 and deleted == ["a1"] and idx.get("a1") is None


def test_cli_delete_local_requires_yes(idx, monkeypatch):
    from typer.testing import CliRunner
    idx.upsert(make("a1"))
    monkeypatch.setattr(cli, "_index", lambda: idx)
    monkeypatch.setattr(local, "delete_local", lambda r, index=None: pytest.fail("no"))
    res = CliRunner().invoke(cli.app, ["delete-local", "a1"])
    assert res.exit_code != 0


def test_cli_list_and_mark(idx, monkeypatch):
    from typer.testing import CliRunner
    idx.upsert(make("a1"))
    monkeypatch.setattr(cli, "_index", lambda: idx)
    assert "a1" in CliRunner().invoke(cli.app, ["list"]).output
    called = []
    monkeypatch.setattr(local, "mark_local_deleted", lambda r, index=None: called.append(r.id))
    assert CliRunner().invoke(cli.app, ["mark-local-deleted", "a1"]).exit_code == 0 and called == ["a1"]


def test_archive_rejects_bad_paths(idx, monkeypatch, homefiles, tmp_path):
    monkeypatch.setattr(archive, "archive_path", lambda *a, **k: pytest.fail("must not run"))
    c = mk(web.create_app(idx))
    bad = ["relative/p", "/etc/hosts", str(tmp_path / "outside"), str(homefiles / "Library/x"),
           str(homefiles / "Docs/missing"), str(homefiles / "Docs/a") + "/../../../etc"]
    r = c.post("/api/archive", json={"paths": [str(homefiles / "Docs/a"), *bad]})
    assert r.status_code == 400
    assert set(r.json()["detail"]["bad_paths"]) == set(bad)


def test_default_roots_is_home(homefiles):
    assert local.default_roots() == [homefiles]


def test_foreign_host_rejected(client):
    r = client.get("/api/items", headers={"Host": "rebind.evil.example:8765"})
    assert r.status_code == 400
    assert client.get("/", headers={"Host": "rebind.evil.example:8765"}).status_code == 400


def test_token_required(idx, monkeypatch):
    monkeypatch.setattr(local, "delete_local", lambda r, index=None: pytest.fail("must not run"))
    monkeypatch.setattr(s3store, "delete_item", lambda r: pytest.fail("must not run"))
    monkeypatch.setattr(archive, "archive_path", lambda *a, **k: pytest.fail("must not run"))
    idx.upsert(make("a1"))
    app = web.create_app(idx)
    for hdrs in ({}, {web.TOKEN_HEADER: "wrong"}):
        c = TestClient(app, base_url=BASE, headers=hdrs)
        assert c.get("/api/items").status_code == 403
        assert c.get("/api/suggest").status_code == 403
        assert c.post("/api/items/a1/delete-local", json={"confirm": True}).status_code == 403
        assert c.delete("/api/items/a1?confirm=true").status_code == 403
        assert c.post("/api/archive", json={"paths": ["/x"]}).status_code == 403
        assert c.get("/api/items/a1/preview/0").status_code == 403


def test_bad_origin_rejected(client):
    assert client.get("/api/items", headers={"Origin": "http://evil.example"}).status_code == 403
    assert client.get("/api/items", headers={"Origin": "http://127.0.0.1:8765"}).status_code == 200
    assert client.get("/api/items", headers={"Origin": "http://localhost:8765"}).status_code == 200


def test_post_without_content_type_never_deletes(client, monkeypatch):
    monkeypatch.setattr(local, "delete_local", lambda r, index=None: pytest.fail("must not run"))
    r = client.post("/api/items/a1/delete-local", content='{"confirm": true}', headers={"Content-Type": "text/plain"})
    assert r.status_code in (400, 422)


def test_page_embeds_token_and_preview_accepts_query_token(client, monkeypatch):
    assert client.app.state.token in client.get("/").text

    class C:
        def generate_presigned_url(self, op, Params, ExpiresIn):
            return "https://signed.example/x"
    monkeypatch.setattr(s3store, "get_client", lambda: C())
    bare = TestClient(client.app, base_url=BASE)
    t = client.app.state.token
    assert bare.get(f"/api/items/a1/preview/0?token={t}", follow_redirects=False).status_code == 302


def test_archivable_rejects_symlinks(tmp_path, monkeypatch):
    from coldarchive import web
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    assert web.archivable(str(real)) and not web.archivable(str(link))
