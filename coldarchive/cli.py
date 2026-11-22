"""coldarchive command line."""
from datetime import date
from pathlib import Path

import typer

from coldarchive import archive, local, s3store
from coldarchive.index import Index
from coldarchive.manifest import Prices, early_delete_charge

app = typer.Typer(no_args_is_help=True, add_completion=False)


def _index() -> Index:
    return Index()


def _get(id: str):
    r = _index().get(id)
    if r is None:
        typer.echo(f"unknown item: {id}", err=True)
        raise typer.Exit(1)
    return r


@app.command()
def add(paths: list[Path], note: str = "", tag: list[str] = typer.Option([], "--tag")) -> None:
    """Archive files/folders to S3 Deep Archive."""
    idx = _index()
    for p in paths:
        r = archive.archive_path(p.expanduser().absolute(), note=note, tags=list(tag), index=idx)
        typer.echo(f"archived {r.id}  free to delete {r.min_storage_until}")


@app.command("list")
def list_() -> None:
    """List archived items."""
    for r in _index().all():
        typer.echo(f"{r.id}\t{r.kind}\t{r.s3.get('bytes', 0)}\t{r.min_storage_until}\t"
                   f"${r.est_monthly_usd}/mo\tverified={r.verification.get('verified') is True}\t"
                   f"local_deleted={r.local_deleted}")


@app.command("import")
def import_() -> None:
    """Rebuild the local index from S3 manifests."""
    typer.echo(f"imported {archive.import_existing(_index())} records")


@app.command("delete-local")
def delete_local(id: str, yes: bool = typer.Option(False, "--yes", help="confirm PERMANENT local deletion")) -> None:
    """Permanently delete the local original (S3 copy must be verified)."""
    r = _get(id)
    if not yes:
        typer.echo(f"This PERMANENTLY deletes {r.original.get('path')} from this Mac. Re-run with --yes.", err=True)
        raise typer.Exit(1)
    try:
        freed = local.delete_local(r, index=_index())
    except local.RefuseDelete as e:
        typer.echo(f"refused: {e.reason}", err=True)
        raise typer.Exit(1)
    except (local.PartialDelete, local.ManifestUpdateFailed) as e:
        typer.echo(f"FAILED: {e}", err=True)
        raise typer.Exit(2)
    typer.echo(f"deleted; freed {freed} bytes")


@app.command("mark-local-deleted")
def mark_local_deleted(id: str) -> None:
    """After finishing a partial delete by hand, record the original as gone."""
    try:
        local.mark_local_deleted(_get(id), index=_index())
    except local.RefuseDelete as e:
        typer.echo(f"refused: {e.reason}", err=True)
        raise typer.Exit(1)
    typer.echo("marked")


@app.command("regenerate-preview")
def regenerate_preview(id: str) -> None:
    """Rebuild the preview from the local original."""
    r = archive.regenerate_preview(id, index=_index())
    typer.echo(f"{r.id}: {len(r.previews)} preview file(s)")


@app.command()
def delete(id: str, yes: bool = typer.Option(False, "--yes", help="confirm cloud deletion")) -> None:
    """Delete the item from S3 (original, previews, manifest)."""
    r = _get(id)
    charge = early_delete_charge(r, Prices.load(), date.today())
    if not yes:
        typer.echo(f"Early-delete charge: ${charge:.4f} (min storage until {r.min_storage_until}). "
                   "Re-run with --yes to delete from S3 permanently.", err=True)
        raise typer.Exit(1)
    s3store.delete_item(r)
    _index().remove(id)
    typer.echo(f"deleted {id} from S3 (early-delete charge ${charge:.4f})")


@app.command()
def suggest() -> None:
    """Suggest stale big files worth archiving."""
    for s in local.suggest_stale(local.default_roots(), index=_index()):
        typer.echo(f"{s['bytes']}\t{s['mtime']}\t{s['path']}")


@app.command()
def serve() -> None:
    """Run the localhost UI on 127.0.0.1:8765."""
    from coldarchive.web import serve as run
    run()
