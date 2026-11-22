import { useEffect, useState } from "react";
import type { ItemSummary } from "../types";
import { formatDateShort, formatUsd } from "../utils/format";

export type DeleteDialogProps = {
  item: ItemSummary;
  onDryRunDelete: (id: string) => Promise<{ charge: number }>;
  onConfirmDelete: (id: string) => Promise<{ deleted: string; charge: number }>;
  onDeleted: (id: string) => void;
  onClose: () => void;
};

export function DeleteDialog({
  item,
  onDryRunDelete,
  onConfirmDelete,
  onDeleted,
  onClose,
}: DeleteDialogProps) {
  const [charge, setCharge] = useState<number | null>(null);
  const [loadingCharge, setLoadingCharge] = useState<boolean>(true);
  const [typedValue, setTypedValue] = useState<string>("");
  const [deleting, setDeleting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingCharge(true);
    setCharge(null);
    setError(null);

    onDryRunDelete(item.id)
      .then((res) => {
        if (!cancelled) {
          setCharge(res.charge);
          setLoadingCharge(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to calculate early-delete charge");
          setLoadingCharge(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [item.id, onDryRunDelete]);

  const matchesTarget = Boolean(item.id) && typedValue === item.id;
  const canConfirm = !loadingCharge && charge !== null && matchesTarget && !deleting;

  async function handleConfirm() {
    if (!canConfirm) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await onConfirmDelete(item.id);
      onDeleted(item.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete item");
      setDeleting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
      <div className="dialog-card">
        <h3 id="delete-dialog-title">Delete from Cold Archive</h3>
        <p className="dialog-warning">
          This permanently deletes the original object in S3 Glacier Deep Archive, all preview
          files, and the manifest record for <strong>{item.name}</strong> (<code>{item.id}</code>).
        </p>

        <div className="charge-box">
          <div className="charge-row">
            <span>Free-to-delete date (180d minimum):</span>
            <strong className="mono">{formatDateShort(item.minStorageUntil)}</strong>
          </div>
          <div className="charge-row">
            <span>AWS early-delete prorated charge:</span>
            <strong className="mono" data-testid="early-delete-charge">
              {loadingCharge ? "Calculating…" : charge !== null ? formatUsd(charge) : "—"}
            </strong>
          </div>
        </div>

        <label className="confirm-input-label">
          Type <code>{item.id}</code> to confirm permanent deletion:
          <input
            type="text"
            className="control-input confirm-input"
            value={typedValue}
            onChange={(e) => setTypedValue(e.target.value)}
            placeholder={item.id}
            disabled={deleting}
          />
        </label>

        {error && <div className="dialog-error">{error}</div>}

        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            {deleting ? "Deleting…" : "Confirm delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
