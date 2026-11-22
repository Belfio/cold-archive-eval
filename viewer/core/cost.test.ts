import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { earlyDeleteCharge, monthlyUsd } from "./cost.js";
import { parseManifest, toRow } from "./manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureJson = readFileSync(join(__dirname, "fixtures", "screen.json"), "utf8");

describe("cost calculations", () => {
  it("computes monthlyUsd using GiB math (0.0018 Deep Archive, 0.024 Standard)", () => {
    const gib = 1024 ** 3;
    expect(monthlyUsd(gib, 0)).toBeCloseTo(0.0018, 10);
    expect(monthlyUsd(0, gib)).toBeCloseTo(0.024, 10);
    expect(monthlyUsd(10 * gib, 0.5 * gib)).toBeCloseTo(10 * 0.0018 + 0.5 * 0.024, 10);
  });

  it("computes earlyDeleteCharge = days * GiB * 0.0018 / 30 before minStorageUntil and 0 on/after", () => {
    const row = toRow(parseManifest(fixtureJson));
    const gib = row.bytes / 1024 ** 3;

    // 30 days before 2027-05-14
    const before30d = new Date("2027-04-14T00:00:00Z");
    expect(earlyDeleteCharge(row, before30d)).toBeCloseTo((30 * gib * 0.0018) / 30, 10);

    // 90 days before 2027-05-14
    const before90d = new Date("2027-02-13T00:00:00Z");
    expect(earlyDeleteCharge(row, before90d)).toBeCloseTo((90 * gib * 0.0018) / 30, 10);

    // Exactly on minStorageUntil
    const onDate = new Date("2027-05-14T00:00:00Z");
    expect(earlyDeleteCharge(row, onDate)).toBe(0);

    // After minStorageUntil
    const afterDate = new Date("2027-06-01T12:00:00Z");
    expect(earlyDeleteCharge(row, afterDate)).toBe(0);
  });
});
