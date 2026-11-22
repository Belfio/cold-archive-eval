import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import type { S3Event } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest, toRow } from "../core/manifest.js";
import { handler } from "./restored.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureJson = readFileSync(
  join(__dirname, "..", "core", "fixtures", "screen.json"),
  "utf8",
);

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const sesMock = mockClient(SESClient);

function makeRestoreCompletedEvent(
  encodedKey: string,
  expiryTime = "2026-11-22T00:00:00.000Z",
): S3Event {
  return {
    Records: [
      {
        eventVersion: "2.1",
        eventSource: "aws:s3",
        awsRegion: "eu-west-2",
        eventTime: "2026-11-15T06:00:00.000Z",
        eventName: "ObjectRestore:Completed",
        userIdentity: { principalId: "test" },
        requestParameters: { sourceIPAddress: "127.0.0.1" },
        responseElements: { "x-amz-request-id": "1", "x-amz-id-2": "2" },
        s3: {
          s3SchemaVersion: "1.0",
          configurationId: "OriginalsRestored",
          bucket: {
            name: "example-cold-archive",
            ownerIdentity: { principalId: "test" },
            arn: "arn:aws:s3:::example-cold-archive",
          },
          object: {
            key: encodedKey,
            size: 3800970978,
            eTag: "etag",
            sequencer: "1",
          },
        },
        glacierEventData: {
          restoreEventData: {
            lifecycleRestorationExpiryTime: expiryTime,
            lifecycleRestoreStorageClass: "DEEP_ARCHIVE",
          },
        },
      },
    ],
  };
}

describe("restored lambda", () => {
  beforeEach(() => {
    s3Mock.reset();
    ddbMock.reset();
    sesMock.reset();
  });

  it("updates row to ready and sends SES email once on ObjectRestore:Completed", async () => {
    const row = {
      ...toRow(parseManifest(fixtureJson)),
      restore: { status: "in-progress" as const },
    };
    const encodedKey = row.originalKey.replace(/ /g, "+");

    ddbMock.on(ScanCommand).resolves({ Items: [row] });
    ddbMock.on(UpdateCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({
      Restore: 'ongoing-request="false", expiry-date="Sun, 22 Nov 2026 00:00:00 GMT"',
    });
    sesMock.on(SendEmailCommand).resolves({ MessageId: "msg-1" });

    await handler(makeRestoreCompletedEvent(encodedKey, "2026-11-22T00:00:00.000Z"));

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.Key?.id).toBe(row.id);
    expect(updateCalls[0].args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(notifiedExpiresAt) OR notifiedExpiresAt <> :e",
    );
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues).toEqual({
      ":restore": {
        status: "ready",
        expiresAt: "2026-11-22T00:00:00.000Z",
      },
      ":e": "2026-11-22T00:00:00.000Z",
    });

    const emailCalls = sesMock.commandCalls(SendEmailCommand);
    expect(emailCalls).toHaveLength(1);
    const emailInput = emailCalls[0].args[0].input;
    expect(emailInput.Source).toBe("owner@example.com");
    expect(emailInput.Destination?.ToAddresses).toEqual(["owner@example.com"]);
    expect(emailInput.Message?.Subject?.Data).toBe(
      `Cold archive: ${row.name} is ready to download`,
    );
    const bodyText = emailInput.Message?.Body?.Text?.Data ?? "";
    expect(bodyText).toContain("2026-11-22T00:00:00.000Z");
    expect(bodyText).toContain("https://viewer.example.com");
  });

  it("SES rejects first call then same event again -> leaves row so retry sends exactly one successful email", async () => {
    let currentRow: Record<string, unknown> = {
      ...toRow(parseManifest(fixtureJson)),
      restore: { status: "in-progress" as const },
    };
    const encodedKey = String(currentRow.originalKey).replace(/ /g, "+");
    const event = makeRestoreCompletedEvent(encodedKey, "2026-11-22T00:00:00.000Z");

    ddbMock.on(ScanCommand).callsFake(async () => ({ Items: [{ ...currentRow }] }));
    ddbMock.on(UpdateCommand).callsFake(async (input) => {
      currentRow = {
        ...currentRow,
        restore: input.ExpressionAttributeValues?.[":restore"],
        notifiedExpiresAt: input.ExpressionAttributeValues?.[":e"],
      };
      return {};
    });

    let successfulSends = 0;
    let attempt = 0;
    sesMock.on(SendEmailCommand).callsFake(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("SES transient error");
      }
      successfulSends += 1;
      return { MessageId: "msg-retry-ok" };
    });

    await expect(handler(event)).rejects.toThrow("SES transient error");
    expect(successfulSends).toBe(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(currentRow.notifiedExpiresAt).toBeUndefined();

    const retryResult = await handler(event);
    expect(retryResult).toEqual({ notified: 1 });
    expect(successfulSends).toBe(1);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
    expect(currentRow.notifiedExpiresAt).toBe("2026-11-22T00:00:00.000Z");
  });

  it("two identical events -> sends only one email", async () => {
    let currentRow: Record<string, unknown> = {
      ...toRow(parseManifest(fixtureJson)),
      restore: {
        status: "ready" as const,
        expiresAt: "2026-11-22T00:00:00.000Z",
      },
    };
    const encodedKey = encodeURIComponent(String(currentRow.originalKey));
    const event = makeRestoreCompletedEvent(encodedKey, "2026-11-22T00:00:00.000Z");

    ddbMock.on(ScanCommand).callsFake(async () => ({ Items: [{ ...currentRow }] }));
    ddbMock.on(UpdateCommand).callsFake(async (input) => {
      currentRow = {
        ...currentRow,
        restore: input.ExpressionAttributeValues?.[":restore"],
        notifiedExpiresAt: input.ExpressionAttributeValues?.[":e"],
      };
      return {};
    });
    sesMock.on(SendEmailCommand).resolves({ MessageId: "msg-1" });

    const first = await handler(event);
    const second = await handler(event);

    expect(first).toEqual({ notified: 1 });
    expect(second).toEqual({ notified: 0 });
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("logs and does not throw when originalKey is unknown", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await expect(
      handler(makeRestoreCompletedEvent("originals/2026/11/unknown/missing.mov")),
    ).resolves.not.toThrow();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    warnSpy.mockRestore();
  });
});
