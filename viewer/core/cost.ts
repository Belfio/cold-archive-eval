import type { ItemRow } from "./manifest.js";

export const GIB = 1024 ** 3;
export const DEEP_ARCHIVE_USD_PER_GIB_MONTH = 0.0018;
export const STANDARD_USD_PER_GIB_MONTH = 0.024;
const MS_PER_DAY = 86_400_000;

export function monthlyUsd(bytesOriginal: number, bytesPreview: number): number {
  return (
    (bytesOriginal / GIB) * DEEP_ARCHIVE_USD_PER_GIB_MONTH +
    (bytesPreview / GIB) * STANDARD_USD_PER_GIB_MONTH
  );
}

export function earlyDeleteCharge(row: ItemRow, now: Date): number {
  const untilMs = Date.parse(row.minStorageUntil);
  if (Number.isNaN(untilMs) || now.getTime() >= untilMs) {
    return 0;
  }
  const days = Math.max(0, Math.ceil((untilMs - now.getTime()) / MS_PER_DAY));
  return (days * (row.bytes / GIB) * DEEP_ARCHIVE_USD_PER_GIB_MONTH) / 30;
}
