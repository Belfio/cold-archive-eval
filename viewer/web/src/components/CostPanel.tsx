import type { CostSummary } from "../types";
import { formatBytes, formatGib, formatUsd } from "../utils/format";

export type CostPanelProps = {
  costs: CostSummary | null;
  loading?: boolean;
};

export function CostPanel({ costs, loading }: CostPanelProps) {
  return (
    <section className="cost-panel" aria-label="Archive cost summary">
      <div className="cost-card">
        <span className="cost-label">Stored (Deep Archive)</span>
        <strong className="cost-value">
          {loading || !costs ? "—" : formatGib(costs.storedBytes)}
        </strong>
      </div>
      <div className="cost-card">
        <span className="cost-label">Previews (Standard)</span>
        <strong className="cost-value">
          {loading || !costs ? "—" : formatGib(costs.previewBytes)}
        </strong>
      </div>
      <div className="cost-card">
        <span className="cost-label">Est. Monthly Cost</span>
        <strong className="cost-value">
          {loading || !costs ? "—" : `${formatUsd(costs.monthlyUsd)}/mo`}
        </strong>
      </div>
      <div className="cost-card">
        <span className="cost-label">Local Space Freed</span>
        <strong className="cost-value">
          {loading || !costs ? "—" : formatBytes(costs.bytesFreed)}
        </strong>
      </div>
    </section>
  );
}
