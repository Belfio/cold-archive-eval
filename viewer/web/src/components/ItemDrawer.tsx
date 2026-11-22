import { useEffect, useState } from "react";
import type { ApiClient } from "../api";
import type { ItemDetail, ItemSummary, RestoreState } from "../types";
import { formatBytes, formatDateShort, formatUsd } from "../utils/format";
import { TsvPreview } from "./TsvPreview";
import { TarPreview } from "./TarPreview";
import { DeleteDialog } from "./DeleteDialog";

export type ItemDrawerProps = {
  item: ItemSummary;
  api: ApiClient;
  onClose: () => void;
  onItemUpdated: (id: string, restore: RestoreState) => void;
  onItemDeleted: (id: string) => void;
};

export function ItemDrawer({
  item,
  api,
  onClose,
  onItemUpdated,
  onItemDeleted,
}: ItemDrawerProps) {
  const [detail, setDetail] = useState<ItemDetail>(item);
  const [previewUrls, setPreviewUrls] = useState<Record<number, string>>({});
  const [loadingDetail, setLoadingDetail] = useState<boolean>(true);
  const [tier, setTier] = useState<"Bulk" | "Standard">("Bulk");
  const [restoring, setRestoring] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(item);
    setPreviewUrls({});
    setLoadingDetail(true);
    setActionMessage(null);

    async function load() {
      try {
        const full = await api.getItem(item.id);
        if (cancelled) {
          return;
        }
        setDetail(full);
        setLoadingDetail(false);

        const urls: Record<number, string> = {};
        await Promise.all(
          (full.previews || []).map(async (_, idx) => {
            try {
              const res = await api.getPreviewUrl(item.id, idx);
              urls[idx] = res.url;
            } catch {
              // ignore individual preview error
            }
          }),
        );
        if (!cancelled) {
          setPreviewUrls(urls);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setLoadingDetail(false);
          setActionMessage(err instanceof Error ? err.message : "Failed to load item details");
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
    // Key on item.id so restore/download updates do not re-run drawer load or clear actionMessage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, api]);

  const restoreState = detail.restore ?? { status: "none" };

  async function handleRestore() {
    setRestoring(true);
    setActionMessage(null);
    try {
      const res = await api.restoreItem(detail.id, tier);
      setDetail((prev) => ({ ...prev, restore: res.restore }));
      onItemUpdated(detail.id, res.restore);
      setActionMessage(`Restore requested (${tier} tier).`);
    } catch (err: unknown) {
      setActionMessage(err instanceof Error ? err.message : "Failed to initiate restore");
    } finally {
      setRestoring(false);
    }
  }

  async function handleDownload() {
    setDownloading(true);
    setActionMessage(null);
    try {
      const res = await api.getDownloadUrl(detail.id);
      setDetail((prev) => ({ ...prev, restore: res.restore }));
      onItemUpdated(detail.id, res.restore);
      if (res.status === "ready") {
        window.open(res.url, "_blank", "noopener,noreferrer");
      } else {
        setActionMessage("Item is not yet restored from Glacier Deep Archive.");
      }
    } catch (err: unknown) {
      setActionMessage(err instanceof Error ? err.message : "Failed to get download URL");
    } finally {
      setDownloading(false);
    }
  }

  const m = detail.manifest;
  const previews = detail.previews || [];
  const hasVideoPreview = previews.some((p) => p.contentType.toLowerCase().startsWith("video/"));
  const posterIdx = previews.findIndex((p) => p.contentType.toLowerCase().startsWith("image/"));
  const posterUrl = posterIdx >= 0 ? previewUrls[posterIdx] : undefined;

  return (
    <aside className="item-drawer" aria-label={`Details for ${detail.name}`}>
      <div className="drawer-header">
        <div>
          <span className={`kind-badge kind-${detail.kind}`}>{detail.kind}</span>
          <h2 className="drawer-title">{detail.name}</h2>
          <div className="drawer-id mono">{detail.id}</div>
        </div>
        <button type="button" className="btn btn-icon" aria-label="Close drawer" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="drawer-body">
        <section className="drawer-section">
          <h3>Previews</h3>
          {loadingDetail && (detail.previews || []).length === 0 ? (
            <div className="preview-status">Loading previews…</div>
          ) : (detail.previews || []).length === 0 ? (
            <div className="preview-status">No previews generated for this item.</div>
          ) : (
            <div className="previews-stack">
              {detail.previews.map((p, idx) => {
                const url = previewUrls[idx];
                const fileName = p.key.split("/").pop() || p.key;
                const ct = p.contentType.toLowerCase();

                if (ct.startsWith("video/")) {
                  return (
                    <div key={p.key} className="preview-block">
                      <div className="preview-meta">
                        <span>{fileName}</span>
                        <span className="mono">{formatBytes(p.bytes)}</span>
                      </div>
                      {url ? (
                        <video
                          className="preview-video"
                          controls
                          preload="metadata"
                          src={url}
                          poster={posterUrl}
                        />
                      ) : (
                        <div className="preview-status">Loading video URL…</div>
                      )}
                    </div>
                  );
                }

                if (ct.startsWith("image/")) {
                  if (hasVideoPreview && idx === posterIdx) {
                    return null;
                  }
                  return (
                    <div key={p.key} className="preview-block">
                      <div className="preview-meta">
                        <span>{fileName}</span>
                        <span className="mono">{formatBytes(p.bytes)}</span>
                      </div>
                      {url ? (
                        <img className="preview-image" src={url} alt={fileName} loading="lazy" />
                      ) : (
                        <div className="preview-status">Loading image URL…</div>
                      )}
                    </div>
                  );
                }

                if (ct.includes("tab-separated-values") || p.key.endsWith(".tsv.gz")) {
                  return (
                    <div key={p.key} className="preview-block">
                      <div className="preview-meta">
                        <span>{fileName}</span>
                        <span className="mono">{formatBytes(p.bytes)}</span>
                      </div>
                      {url ? (
                        <TsvPreview url={url} />
                      ) : (
                        <div className="preview-status">Loading TSV preview URL…</div>
                      )}
                    </div>
                  );
                }

                if (ct.includes("x-tar") || p.key.endsWith(".tar")) {
                  return (
                    <div key={p.key} className="preview-block">
                      <div className="preview-meta">
                        <span>{fileName}</span>
                        <span className="mono">{formatBytes(p.bytes)}</span>
                      </div>
                      {url ? (
                        <TarPreview url={url} />
                      ) : (
                        <div className="preview-status">Loading tar preview URL…</div>
                      )}
                    </div>
                  );
                }

                return (
                  <div key={p.key} className="preview-block">
                    <div className="preview-meta">
                      <span>{fileName}</span>
                      <span className="mono">{formatBytes(p.bytes)}</span>
                    </div>
                    {url && (
                      <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
                        Open preview ({p.contentType})
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="drawer-section">
          <h3>Glacier Deep Archive Restore &amp; Actions</h3>
          <div className="restore-box">
            <div className="restore-status-line">
              <span>Restore status:</span>
              <strong className={`restore-badge restore-${restoreState.status}`}>
                {restoreState.status === "ready"
                  ? `Ready${restoreState.expiresAt ? ` (expires ${formatDateShort(restoreState.expiresAt)})` : ""}`
                  : restoreState.status === "in-progress"
                    ? "Restore in progress (12–48h)"
                    : "In Deep Archive (not restored)"}
              </strong>
            </div>

            <div className="restore-controls">
              <label className="control-label">
                Retrieval tier
                <select
                  className="control-select"
                  value={tier}
                  onChange={(e) => setTier(e.target.value as "Bulk" | "Standard")}
                  disabled={restoring || restoreState.status === "in-progress"}
                >
                  <option value="Bulk">Bulk (up to 48h, lowest cost)</option>
                  <option value="Standard">Standard (within 12h)</option>
                </select>
              </label>

              <button
                type="button"
                className="btn btn-primary"
                onClick={handleRestore}
                disabled={restoring || restoreState.status === "in-progress"}
              >
                {restoring ? "Requesting…" : "Initiate restore"}
              </button>

              {restoreState.status === "ready" && (
                <button
                  type="button"
                  className="btn btn-success"
                  onClick={handleDownload}
                  disabled={downloading}
                >
                  {downloading ? "Preparing URL…" : "Download original"}
                </button>
              )}
            </div>

            {actionMessage && <div className="action-feedback">{actionMessage}</div>}
          </div>

          <div className="danger-zone">
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => setShowDeleteDialog(true)}
            >
              Delete from archive…
            </button>
          </div>
        </section>

        <section className="drawer-section">
          <h3>Manifest &amp; Checksums</h3>
          <dl className="manifest-grid">
            <dt>Size</dt>
            <dd className="mono">
              {formatBytes(detail.bytes)} ({detail.bytes.toLocaleString("en-US")} B)
            </dd>
            <dt>Uploaded</dt>
            <dd className="mono">{detail.uploadedAt}</dd>
            <dt>Free-to-delete (180d)</dt>
            <dd className="mono">{detail.minStorageUntil}</dd>
            <dt>Est. monthly cost</dt>
            <dd className="mono">{formatUsd(detail.estMonthlyUsd)}/mo</dd>
            <dt>Verified</dt>
            <dd>{detail.verified ? "✓ Verified (CRC64NVME + size match)" : "Unverified"}</dd>
            <dt>Local deleted</dt>
            <dd>
              {detail.localDeleted
                ? `✓ Deleted${m?.local_deleted_at ? ` (${m.local_deleted_at})` : ""}`
                : "Still on disk"}
            </dd>
            <dt>Original S3 key</dt>
            <dd className="mono break-all">{detail.originalKey}</dd>
            {m && (
              <>
                <dt>SHA-256</dt>
                <dd className="mono break-all">{m.sha256}</dd>
                <dt>CRC64NVME</dt>
                <dd className="mono">{m.crc64nvme}</dd>
                <dt>Original path</dt>
                <dd className="mono break-all">
                  {m.original?.host}:{m.original?.path}
                </dd>
                <dt>Storage class</dt>
                <dd className="mono">{m.s3?.storage_class} ({m.s3?.region})</dd>
              </>
            )}
          </dl>
        </section>
      </div>

      {showDeleteDialog && (
        <DeleteDialog
          item={detail}
          onDryRunDelete={(id) => api.dryRunDelete(id)}
          onConfirmDelete={(id) => api.confirmDelete(id)}
          onDeleted={(id) => {
            setShowDeleteDialog(false);
            onItemDeleted(id);
          }}
          onClose={() => setShowDeleteDialog(false)}
        />
      )}
    </aside>
  );
}
