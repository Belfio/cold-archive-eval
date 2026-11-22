import { useMemo, useState } from "react";
import { VALID_KINDS, type ItemKind, type ItemSummary } from "../types";
import { formatBytes, formatDateShort, formatUsd } from "../utils/format";

export type SortOption = "date-desc" | "date-asc" | "size-desc" | "size-asc";

export type ArchiveTableProps = {
  items: ItemSummary[];
  selectedId: string | null;
  onSelectItem: (item: ItemSummary) => void;
};

function formatRestoreStatus(restore?: ItemSummary["restore"]): string {
  const status = restore?.status ?? "none";
  if (status === "ready") {
    return restore?.expiresAt ? `Ready (until ${formatDateShort(restore.expiresAt)})` : "Ready";
  }
  if (status === "in-progress") {
    return "Restoring…";
  }
  return "—";
}

export function ArchiveTable({ items, selectedId, onSelectItem }: ArchiveTableProps) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | ItemKind>("all");
  const [sortBy, setSortBy] = useState<SortOption>("date-desc");

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = items.filter((item) => {
      if (kindFilter !== "all" && item.kind !== kindFilter) {
        return false;
      }
      if (!q) {
        return true;
      }
      const inName = item.name.toLowerCase().includes(q);
      const inId = item.id.toLowerCase().includes(q);
      const inNote = (item.note || "").toLowerCase().includes(q);
      const inTags = (item.tags || []).some((t) => t.toLowerCase().includes(q));
      return inName || inId || inNote || inTags;
    });

    list.sort((a, b) => {
      if (sortBy === "size-desc") {
        return b.bytes - a.bytes;
      }
      if (sortBy === "size-asc") {
        return a.bytes - b.bytes;
      }
      const tA = Date.parse(a.uploadedAt) || 0;
      const tB = Date.parse(b.uploadedAt) || 0;
      return sortBy === "date-asc" ? tA - tB : tB - tA;
    });

    return list;
  }, [items, search, kindFilter, sortBy]);

  return (
    <section className="archive-section" aria-label="Archived items">
      <div className="archive-controls">
        <input
          type="search"
          className="control-input search-input"
          placeholder="Search by name, tag, or note…"
          aria-label="Search archived items"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="control-group">
          <label className="control-label">
            Kind
            <select
              className="control-select"
              aria-label="Filter by kind"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as "all" | ItemKind)}
            >
              <option value="all">All kinds</option>
              {VALID_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="control-label">
            Sort
            <select
              className="control-select"
              aria-label="Sort items"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
            >
              <option value="date-desc">Uploaded (newest)</option>
              <option value="date-asc">Uploaded (oldest)</option>
              <option value="size-desc">Size (largest)</option>
              <option value="size-asc">Size (smallest)</option>
            </select>
          </label>
        </div>
      </div>

      <div className="table-scroll">
        <table className="archive-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th>Free-to-delete</th>
              <th>$/mo</th>
              <th className="col-center">Verified</th>
              <th className="col-center">Local deleted</th>
              <th>Restore status</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty-cell">
                  {items.length === 0 ? "No archived items found." : "No items match your filter."}
                </td>
              </tr>
            ) : (
              filteredItems.map((item) => {
                const isSelected = item.id === selectedId;
                return (
                  <tr
                    key={item.id}
                    className={`archive-row${isSelected ? " selected" : ""}`}
                    onClick={() => onSelectItem(item)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectItem(item);
                      }
                    }}
                  >
                    <td className="cell-name">
                      <div className="item-title">{item.name}</div>
                      {(item.tags?.length > 0 || item.note) && (
                        <div className="item-sub">
                          {item.tags?.map((tag) => (
                            <span key={tag} className="tag-badge">
                              {tag}
                            </span>
                          ))}
                          {item.note && <span className="item-note">{item.note}</span>}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`kind-badge kind-${item.kind}`}>{item.kind}</span>
                    </td>
                    <td className="mono">{formatBytes(item.bytes)}</td>
                    <td className="mono">{formatDateShort(item.uploadedAt)}</td>
                    <td className="mono">{formatDateShort(item.minStorageUntil)}</td>
                    <td className="mono">{formatUsd(item.estMonthlyUsd)}</td>
                    <td className="col-center">{item.verified ? "✓" : "—"}</td>
                    <td className="col-center">{item.localDeleted ? "✓" : "—"}</td>
                    <td>
                      <span className={`restore-badge restore-${item.restore?.status ?? "none"}`}>
                        {formatRestoreStatus(item.restore)}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
