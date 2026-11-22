import { monthlyUsd } from "./cost.js";

export const VALID_KINDS = [
  "video",
  "image",
  "audio",
  "pdf",
  "mbox",
  "folder",
  "zip",
  "other",
] as const;

export type ItemKind = (typeof VALID_KINDS)[number];

export type RestoreStatus = "none" | "in-progress" | "ready";

export type RestoreState = {
  status: RestoreStatus;
  expiresAt?: string;
};

export type ManifestPreview = {
  key: string;
  bytes: number;
  content_type: string;
};

export type Manifest = {
  id: string;
  kind: ItemKind;
  note: string;
  tags: string[];
  original: {
    path: string;
    host: string;
    bytes_on_disk: number;
    mtime: string;
  };
  s3: {
    bucket: string;
    key: string;
    bytes: number;
    storage_class: string;
    region: string;
  };
  sha256: string;
  crc64nvme: string;
  verification: {
    size_match: boolean;
    crc64nvme_match: boolean;
    verified: boolean;
    server_crc64nvme?: string;
    local_crc64nvme?: string;
    storage_class?: string;
  };
  previews: ManifestPreview[];
  preview_ratio: number;
  uploaded_at: string;
  min_storage_until: string;
  est_monthly_usd: number;
  local_deleted: boolean;
  local_deleted_at?: string | null;
  bytes_freed?: number;
  restore?: {
    status: RestoreStatus;
    expires_at?: string;
    expiresAt?: string;
  } | null;
  duration_s?: number;
  messages?: number;
  files?: number;
  est_monthly_usd_legacy?: number;
  preview_fallback?: boolean;
  preview_error?: string;
  extra: Record<string, unknown>;
  [key: string]: unknown;
};

export type ItemRow = {
  id: string;
  kind: ItemKind;
  name: string;
  bytes: number;
  uploadedAt: string;
  minStorageUntil: string;
  estMonthlyUsd: number;
  verified: boolean;
  localDeleted: boolean;
  previews: {
    key: string;
    bytes: number;
    contentType: string;
  }[];
  originalKey: string;
  manifestKey?: string;
  restore?: RestoreState;
  notifiedExpiresAt?: string;
  tags: string[];
  note: string;
  manifest: Manifest;
};

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

export function decodeS3Key(rawKey: string): string {
  return decodeURIComponent(rawKey.replace(/\+/g, " "));
}

export function idFromManifestKey(key: string): string | null {
  if (!key.startsWith("manifest/") || !key.endsWith(".json")) {
    return null;
  }
  const id = key.slice("manifest/".length, -".json".length);
  return id.length > 0 && !id.includes("/") ? id : null;
}

export function parseRestoreHeader(restoreHeader?: string): RestoreState {
  if (!restoreHeader) {
    return { status: "none" };
  }
  if (restoreHeader.includes('ongoing-request="true"')) {
    return { status: "in-progress" };
  }
  if (restoreHeader.includes('ongoing-request="false"')) {
    const match = restoreHeader.match(/expiry-date="([^"]+)"/);
    if (match?.[1]) {
      const parsed = new Date(match[1]);
      const expiresAt = Number.isNaN(parsed.getTime()) ? match[1] : parsed.toISOString();
      return { status: "ready", expiresAt };
    }
    return { status: "ready" };
  }
  return { status: "none" };
}

function hasPositionalItemKey(key: string, prefix: "originals" | "previews", id: string): boolean {
  const parts = key.split("/");
  return (
    parts[0] === prefix &&
    parts.length >= 5 &&
    Boolean(parts[1]) &&
    Boolean(parts[2]) &&
    parts[3] === id &&
    parts.slice(4).every((part) => part.length > 0)
  );
}

export function validateItemKeys(
  id: string,
  originalKey: string,
  previewKeys: string[],
  manifestKey?: string,
): void {
  if (!id || typeof id !== "string" || id.includes("/")) {
    throw new ManifestValidationError(`Invalid item id: ${String(id)}`);
  }
  if (typeof originalKey !== "string" || !hasPositionalItemKey(originalKey, "originals", id)) {
    throw new ManifestValidationError(
      `Invalid originalKey "${String(originalKey)}": must match "originals/<YYYY>/<MM>/${id}/<file>"`,
    );
  }
  for (let i = 0; i < previewKeys.length; i++) {
    const pk = previewKeys[i];
    if (typeof pk !== "string" || !hasPositionalItemKey(pk, "previews", id)) {
      throw new ManifestValidationError(
        `Invalid preview[${i}] key "${String(pk)}": must match "previews/<YYYY>/<MM>/${id}/<file>"`,
      );
    }
  }
  if (manifestKey !== undefined && manifestKey !== `manifest/${id}.json`) {
    throw new ManifestValidationError(
      `Manifest key "${manifestKey}" does not match expected "manifest/${id}.json"`,
    );
  }
}

export function validateRow(row: Pick<ItemRow, "id" | "originalKey" | "previews" | "manifestKey">): void {
  validateItemKeys(
    row.id,
    row.originalKey,
    (row.previews ?? []).map((p) => p.key),
    row.manifestKey,
  );
}

const SPEC_KEYS = new Set([
  "id",
  "kind",
  "note",
  "tags",
  "original",
  "s3",
  "sha256",
  "crc64nvme",
  "verification",
  "previews",
  "preview_ratio",
  "uploaded_at",
  "min_storage_until",
  "est_monthly_usd",
  "local_deleted",
  "restore",
  "extra",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseManifest(json: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new ManifestValidationError(
      err instanceof Error ? err.message : "Invalid manifest JSON",
    );
  }
  if (!isRecord(parsed)) {
    throw new ManifestValidationError("Manifest must be a JSON object");
  }

  const id = parsed.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new ManifestValidationError("Manifest missing valid string id");
  }

  const kind = parsed.kind;
  if (typeof kind !== "string" || !VALID_KINDS.includes(kind as ItemKind)) {
    throw new ManifestValidationError(`Manifest has invalid kind: ${String(kind)}`);
  }

  if (!isRecord(parsed.original) || typeof parsed.original.path !== "string") {
    throw new ManifestValidationError("Manifest missing valid original.path");
  }

  if (
    !isRecord(parsed.s3) ||
    typeof parsed.s3.key !== "string" ||
    typeof parsed.s3.bytes !== "number"
  ) {
    throw new ManifestValidationError("Manifest missing valid s3.key or s3.bytes");
  }

  if (!isRecord(parsed.verification) || typeof parsed.verification.verified !== "boolean") {
    throw new ManifestValidationError("Manifest missing valid verification.verified");
  }

  if (!Array.isArray(parsed.previews)) {
    throw new ManifestValidationError("Manifest missing previews array");
  }

  const previews: ManifestPreview[] = parsed.previews.map((p, idx) => {
    if (
      !isRecord(p) ||
      typeof p.key !== "string" ||
      typeof p.bytes !== "number" ||
      typeof p.content_type !== "string"
    ) {
      throw new ManifestValidationError(`Manifest preview[${idx}] is invalid`);
    }
    return {
      key: p.key,
      bytes: p.bytes,
      content_type: p.content_type,
    };
  });

  if (typeof parsed.uploaded_at !== "string" || typeof parsed.min_storage_until !== "string") {
    throw new ManifestValidationError("Manifest missing uploaded_at or min_storage_until");
  }

  validateItemKeys(
    id,
    parsed.s3.key,
    previews.map((p) => p.key),
  );

  const extra: Record<string, unknown> = isRecord(parsed.extra) ? { ...parsed.extra } : {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!SPEC_KEYS.has(k)) {
      extra[k] = v;
    }
  }

  const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t)) : [];
  const note = typeof parsed.note === "string" ? parsed.note : "";
  const previewBytes = previews.reduce((sum, p) => sum + p.bytes, 0);
  const estMonthlyUsd =
    typeof parsed.est_monthly_usd === "number"
      ? parsed.est_monthly_usd
      : monthlyUsd(parsed.s3.bytes, previewBytes);

  return {
    ...parsed,
    id,
    kind: kind as ItemKind,
    note,
    tags,
    original: {
      path: parsed.original.path,
      host: typeof parsed.original.host === "string" ? parsed.original.host : "",
      bytes_on_disk:
        typeof parsed.original.bytes_on_disk === "number"
          ? parsed.original.bytes_on_disk
          : parsed.s3.bytes,
      mtime: typeof parsed.original.mtime === "string" ? parsed.original.mtime : "",
    },
    s3: {
      bucket: typeof parsed.s3.bucket === "string" ? parsed.s3.bucket : "",
      key: parsed.s3.key,
      bytes: parsed.s3.bytes,
      storage_class:
        typeof parsed.s3.storage_class === "string" ? parsed.s3.storage_class : "DEEP_ARCHIVE",
      region: typeof parsed.s3.region === "string" ? parsed.s3.region : "eu-west-2",
    },
    sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : "",
    crc64nvme: typeof parsed.crc64nvme === "string" ? parsed.crc64nvme : "",
    verification: {
      ...parsed.verification,
      size_match: Boolean(parsed.verification.size_match),
      crc64nvme_match: Boolean(parsed.verification.crc64nvme_match),
      verified: parsed.verification.verified,
    },
    previews,
    preview_ratio: typeof parsed.preview_ratio === "number" ? parsed.preview_ratio : 0,
    uploaded_at: parsed.uploaded_at,
    min_storage_until: parsed.min_storage_until,
    est_monthly_usd: estMonthlyUsd,
    local_deleted: Boolean(parsed.local_deleted),
    extra,
  };
}

function basenameOfPath(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function toRow(m: Manifest, manifestKey = `manifest/${m.id}.json`): ItemRow {
  const previews = m.previews.map((p) => ({
    key: p.key,
    bytes: p.bytes,
    contentType: p.content_type,
  }));
  const previewBytes = previews.reduce((sum, p) => sum + p.bytes, 0);

  const row: ItemRow = {
    id: m.id,
    kind: m.kind,
    name: basenameOfPath(m.original.path),
    bytes: m.s3.bytes,
    uploadedAt: m.uploaded_at,
    minStorageUntil: m.min_storage_until,
    estMonthlyUsd: monthlyUsd(m.s3.bytes, previewBytes),
    verified: m.verification.verified,
    localDeleted: m.local_deleted,
    previews,
    originalKey: m.s3.key,
    manifestKey,
    tags: m.tags ?? [],
    note: m.note ?? "",
    manifest: m,
  };

  validateRow(row);

  if (m.restore && typeof m.restore === "object" && typeof m.restore.status === "string") {
    const expiresAt = m.restore.expiresAt ?? m.restore.expires_at;
    row.restore = expiresAt
      ? { status: m.restore.status, expiresAt }
      : { status: m.restore.status };
  }

  return row;
}
