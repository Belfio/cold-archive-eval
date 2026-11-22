const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KIB = 1024;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes >= GIB) {
    return `${(bytes / GIB).toFixed(2)} GB`;
  }
  if (bytes >= MIB) {
    return `${(bytes / MIB).toFixed(1)} MB`;
  }
  if (bytes >= KIB) {
    return `${(bytes / KIB).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function formatGib(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0.00 GB";
  }
  const gib = bytes / GIB;
  if (gib > 0 && gib < 0.01) {
    return `${gib.toFixed(4)} GB`;
  }
  return `${gib.toFixed(2)} GB`;
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0.0000";
  }
  return `$${usd.toFixed(4)}`;
}

export function formatDateShort(iso: string): string {
  if (!iso) {
    return "—";
  }
  const match = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) {
    return match[1];
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toISOString().slice(0, 10);
}
