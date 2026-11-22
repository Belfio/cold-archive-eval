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

export type PreviewEntry = {
  key: string;
  bytes: number;
  contentType: string;
};

export type ManifestRecord = {
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
  previews: {
    key: string;
    bytes: number;
    content_type: string;
  }[];
  preview_ratio: number;
  uploaded_at: string;
  min_storage_until: string;
  est_monthly_usd: number;
  local_deleted: boolean;
  local_deleted_at?: string | null;
  bytes_freed?: number;
  duration_s?: number;
  messages?: number;
  files?: number;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ItemSummary = {
  id: string;
  kind: ItemKind;
  name: string;
  bytes: number;
  uploadedAt: string;
  minStorageUntil: string;
  estMonthlyUsd: number;
  verified: boolean;
  localDeleted: boolean;
  previews: PreviewEntry[];
  originalKey: string;
  restore?: RestoreState;
  tags: string[];
  note: string;
};

export type ItemDetail = ItemSummary & {
  manifest?: ManifestRecord;
};

export type CostSummary = {
  items: number;
  storedBytes: number;
  previewBytes: number;
  monthlyUsd: number;
  bytesFreed: number;
};
