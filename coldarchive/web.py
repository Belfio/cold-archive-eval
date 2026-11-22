"""Localhost-only FastAPI app: JSON API + one static page."""
import secrets
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from coldarchive import archive, local, s3store
from coldarchive.index import Index
from coldarchive.manifest import GIB, Prices, Record, early_delete_charge

HOST = "127.0.0.1"
PORT = 8765
PREVIEW_URL_TTL = 900
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]
ALLOWED_ORIGINS = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
TOKEN_HEADER = "X-Coldarchive-Token"
STATIC = Path(__file__).resolve().parent / "static"


def item_view(r: Record) -> dict:
    return {
        "id": r.id, "name": Path(r.original.get("path", r.id)).name, "kind": r.kind,
        "size": r.s3.get("bytes", 0), "uploaded_at": r.uploaded_at,
        "free_to_delete": r.min_storage_until, "est_monthly_usd": r.est_monthly_usd,
        "verified": r.verification.get("verified") is True, "local_deleted": r.local_deleted,
        "bytes_freed": r.bytes_freed, "previews": len(r.previews), "note": r.note, "tags": r.tags,
    }


def create_app(index: Index | None = None) -> FastAPI:
    app = FastAPI(title="coldarchive")
    token = secrets.token_urlsafe(32)
    app.state.token = token
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            return JSONResponse({"message": "bad origin"}, status_code=403)
        if request.url.path.startswith("/api/"):
            sent = request.headers.get(TOKEN_HEADER)
            if sent is None and request.url.path.count("/preview/") == 1 and request.method == "GET":
                sent = request.query_params.get("token")  # window.open cannot set headers
            if sent is None or not secrets.compare_digest(sent, token):
                return JSONResponse({"message": "missing or wrong token"}, status_code=403)
        return await call_next(request)

    idx = index or Index()
    executor = ThreadPoolExecutor(max_workers=1)
    app.state.executor = executor
    jobs: dict[str, dict] = {}
    lock = threading.Lock()

    def get_rec(id: str) -> Record:
        r = idx.get(id)
        if r is None:
            raise HTTPException(404, f"unknown item: {id}")
        return r

    @app.get("/")
    def page():
        html = (STATIC / "index.html").read_text().replace("__TOKEN__", token)
        return HTMLResponse(html)

    @app.get("/api/items")
    def items():
        recs = idx.all()
        return {
            "items": [item_view(r) for r in recs],
            "totals": {
                "stored_gb": round(sum(r.s3.get("bytes", 0) for r in recs) / GIB, 4),
                "est_monthly_usd": round(sum(r.est_monthly_usd for r in recs), 4),
                "space_freed_bytes": sum(r.bytes_freed for r in recs if r.local_deleted),
            },
        }

    def run_job(job: dict) -> None:
        job["status"] = "running"
        try:
            for p in job["paths"]:
                rec = archive.archive_path(Path(p), index=idx)
                with lock:
                    job["records"].append(rec.id)
                    job["done"] += 1
            job["status"] = "done"
        except Exception as e:  # surfaced to the UI, never swallowed
            job["error"] = f"{type(e).__name__}: {e}"
            job["status"] = "error"

    @app.post("/api/archive")
    def start_archive(body: dict = Body(...)):
        paths = body.get("paths")
        if not isinstance(paths, list) or not paths or not all(isinstance(p, str) and p for p in paths):
            raise HTTPException(400, "paths must be a non-empty list of strings")
        bad = [p for p in paths if not archivable(p)]
        if bad:
            raise HTTPException(400, {"message": "paths must be existing, absolute, under home and not in "
                                      "Library or package dirs", "bad_paths": bad})
        paths = [str(Path(p).resolve()) for p in paths]  # exactly what archivable() validated
        job = {"id": uuid.uuid4().hex[:12], "paths": paths, "status": "queued", "done": 0,
               "error": None, "records": []}
        jobs[job["id"]] = job
        executor.submit(run_job, job)
        return job

    @app.get("/api/jobs/{job_id}")
    def job_status(job_id: str):
        if job_id not in jobs:
            raise HTTPException(404, "unknown job")
        return jobs[job_id]

    @app.post("/api/items/{id}/delete-local")
    def delete_local_route(id: str, body: dict | None = Body(None)):
        r = get_rec(id)
        if not body or body.get("confirm") is not True:
            raise HTTPException(400, 'permanent deletion needs {"confirm": true}')
        try:
            freed = local.delete_local(r, index=idx)
        except local.RefuseDelete as e:
            return JSONResponse({"reason": e.reason}, status_code=409)
        except (local.PartialDelete, local.ManifestUpdateFailed) as e:
            return JSONResponse({"message": str(e)}, status_code=500)
        return {"bytes_freed": freed}

    @app.delete("/api/items/{id}")
    def delete_cloud(id: str, confirm: bool = False):
        r = get_rec(id)
        charge = early_delete_charge(r, Prices.load())
        if not confirm:
            return JSONResponse({"message": "confirm=true required; this deletes the S3 copy permanently",
                                 "early_delete_charge_usd": charge,
                                 "min_storage_until": r.min_storage_until}, status_code=409)
        try:
            s3store.delete_item(r)
        except Exception as e:
            return JSONResponse({"message": f"{type(e).__name__}: {e}"}, status_code=500)
        idx.remove(id)
        return {"deleted": id, "early_delete_charge_usd": charge}

    @app.get("/api/items/{id}/preview/{n}")
    def preview(id: str, n: int):
        r = get_rec(id)
        if not 0 <= n < len(r.previews):
            raise HTTPException(404, "no such preview")
        url = s3store.get_client().generate_presigned_url(
            "get_object", Params={"Bucket": s3store.settings.bucket, "Key": r.previews[n]["key"]},
            ExpiresIn=PREVIEW_URL_TTL)
        return RedirectResponse(url, status_code=302)

    @app.get("/api/suggest")
    def suggest():
        return local.suggest_stale(local.default_roots(), index=idx)

    return app


def archivable(p: str) -> bool:
    path = Path(p)
    if not path.is_absolute() or not path.exists() or path.is_symlink():
        return False
    home = Path.home().resolve()
    resolved = path.resolve()
    return home in resolved.parents and not local._protected_root(resolved, home)


def serve() -> None:
    import uvicorn
    if HOST != "127.0.0.1":
        raise RuntimeError("coldarchive must only bind to localhost")
    app = create_app()
    print(f"coldarchive UI: http://{HOST}:{PORT}/", flush=True)
    uvicorn.run(app, host=HOST, port=PORT)
