import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { monthlyUsd } from "./cost.js";
import {
  decodeS3Key,
  parseManifest,
  parseRestoreHeader,
  toRow,
  validateRow,
} from "./manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureJson = readFileSync(join(__dirname, "fixtures", "screen.json"), "utf8");

describe("manifest core", () => {
  it("parses the real screen.json fixture and preserves extra keys", () => {
    const m = parseManifest(fixtureJson);
    expect(m.id).toBe("screen-recording-2026-06-14");
    expect(m.kind).toBe("video");
    expect(m.s3.bytes).toBe(3800970978);
    expect(m.verification.verified).toBe(true);
    expect(m.duration_s).toBe(4874.0);
    expect(m.extra.duration_s).toBe(4874.0);
    expect(m.tags).toEqual([]);
    expect(m.note).toBe("");
  });

  it("preserves arbitrary unknown and legacy keys without failing", () => {
    const raw = JSON.parse(fixtureJson);
    raw.kind = "zip";
    raw.messages = 107000;
    raw.files = 420;
    raw.est_monthly_usd_legacy = 0.0059;
    raw.preview_fallback = true;
    raw.preview_error = "ffmpeg exited 1";
    raw.custom_future_field = { nested: true };

    const m = parseManifest(JSON.stringify(raw));
    expect(m.kind).toBe("zip");
    expect(m.messages).toBe(107000);
    expect(m.files).toBe(420);
    expect(m.est_monthly_usd_legacy).toBe(0.0059);
    expect(m.preview_fallback).toBe(true);
    expect(m.preview_error).toBe("ffmpeg exited 1");
    expect(m.custom_future_field).toEqual({ nested: true });
    expect(m.extra).toMatchObject({
      duration_s: 4874.0,
      messages: 107000,
      files: 420,
      est_monthly_usd_legacy: 0.0059,
      preview_fallback: true,
      preview_error: "ffmpeg exited 1",
      custom_future_field: { nested: true },
    });
  });

  it("converts a manifest to an ItemRow with basename, bytes, and previews", () => {
    const m = parseManifest(fixtureJson);
    const row = toRow(m);

    expect(row.id).toBe("screen-recording-2026-06-14");
    expect(row.kind).toBe("video");
    expect(row.name).toBe("Screen Recording 2026-06-14 at 15.06.00.mov");
    expect(row.bytes).toBe(3800970978);
    expect(row.uploadedAt).toBe("2026-11-15T00:09:01+00:00");
    expect(row.minStorageUntil).toBe("2027-05-14");
    const expectedMonthly = monthlyUsd(3800970978, 105111076 + 19935);
    expect(row.estMonthlyUsd).toBeCloseTo(expectedMonthly, 10);
    expect(row.estMonthlyUsd).not.toBe(0.0059);
    expect(row.manifestKey).toBe("manifest/screen-recording-2026-06-14.json");
    expect(row.verified).toBe(true);
    expect(row.localDeleted).toBe(false);
    expect(row.originalKey).toBe(
      "originals/2026/11/screen-recording-2026-06-14/Screen Recording 2026-06-14 at 15.06.00.mov",
    );
    expect(row.previews).toEqual([
      {
        key: "previews/2026/11/screen-recording-2026-06-14/screen-recording-2026-06-14.preview.mp4",
        bytes: 105111076,
        contentType: "video/mp4",
      },
      {
        key: "previews/2026/11/screen-recording-2026-06-14/screen-recording-2026-06-14.poster.jpg",
        bytes: 19935,
        contentType: "image/jpeg",
      },
    ]);
    expect(row.tags).toEqual([]);
    expect(row.note).toBe("");
    expect(row.manifest).toEqual(m);
  });

  it("throws on malformed JSON or missing required manifest fields", () => {
    expect(() => parseManifest("{not-json")).toThrow();
    expect(() => parseManifest(JSON.stringify({ id: "only-id" }))).toThrow();
  });

  it("rejects hostile manifests whose originalKey or preview keys do not belong to the item", () => {
    const hostileOriginal = JSON.parse(fixtureJson);
    hostileOriginal.s3.key =
      "originals/2026/11/other-item-id/Screen Recording 2026-06-14 at 15.06.00.mov";
    expect(() => parseManifest(JSON.stringify(hostileOriginal))).toThrow(/original/i);

    const wrongPrefixOriginal = JSON.parse(fixtureJson);
    wrongPrefixOriginal.s3.key =
      "previews/2026/11/screen-recording-2026-06-14/Screen Recording.mov";
    expect(() => parseManifest(JSON.stringify(wrongPrefixOriginal))).toThrow(/originals\//i);

    const hostilePreview = JSON.parse(fixtureJson);
    hostilePreview.previews[0].key =
      "previews/2026/11/other-item-id/screen-recording-2026-06-14.preview.mp4";
    expect(() => parseManifest(JSON.stringify(hostilePreview))).toThrow(/preview/i);

    const wrongPrefixPreview = JSON.parse(fixtureJson);
    wrongPrefixPreview.previews[0].key =
      "originals/2026/11/screen-recording-2026-06-14/file.mp4";
    expect(() => parseManifest(JSON.stringify(wrongPrefixPreview))).toThrow(/previews\//i);

    const validRow = toRow(parseManifest(fixtureJson));
    expect(() => validateRow(validRow)).not.toThrow();
    expect(() =>
      validateRow({
        ...validRow,
        originalKey: "originals/2026/11/victim-item/file.mov",
      }),
    ).toThrow();
    expect(() =>
      validateRow({
        ...validRow,
        manifestKey: "manifest/other-item.json",
      }),
    ).toThrow();
    expect(() => toRow(parseManifest(fixtureJson), "manifest/wrong-stem.json")).toThrow();

    // Positional validation: id matching an earlier path segment (e.g. month "11") must be rejected
    const monthCollisionManifest = JSON.parse(fixtureJson);
    monthCollisionManifest.id = "11";
    monthCollisionManifest.s3.key = "originals/2026/11/victim/x";
    monthCollisionManifest.previews = [
      {
        key: "previews/2026/11/11/preview.mp4",
        bytes: 100,
        content_type: "video/mp4",
      },
    ];
    expect(() => parseManifest(JSON.stringify(monthCollisionManifest))).toThrow(/original/i);

    const previewSegmentCollision = JSON.parse(fixtureJson);
    previewSegmentCollision.id = "11";
    previewSegmentCollision.s3.key = "originals/2026/11/11/x";
    previewSegmentCollision.previews = [
      {
        key: "previews/2026/11/victim/preview.mp4",
        bytes: 100,
        content_type: "video/mp4",
      },
    ];
    expect(() => parseManifest(JSON.stringify(previewSegmentCollision))).toThrow(/preview/i);
  });

  it("provides decodeS3Key and parseRestoreHeader helpers in core", () => {
    expect(decodeS3Key("manifest/my+file%20name.json")).toBe("manifest/my file name.json");
    expect(parseRestoreHeader(undefined)).toEqual({ status: "none" });
    expect(parseRestoreHeader('ongoing-request="true"')).toEqual({ status: "in-progress" });
    expect(
      parseRestoreHeader(
        'ongoing-request="false", expiry-date="Sun, 22 Nov 2026 00:00:00 GMT"',
      ),
    ).toEqual({
      status: "ready",
      expiresAt: "2026-11-22T00:00:00.000Z",
    });
  });
});
