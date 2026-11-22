import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { S3Event } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "./indexer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureJson = readFileSync(
  join(__dirname, "..", "core", "fixtures", "screen.json"),
  "utf8",
);

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

function s3Body(text: string) {
  return {
    transformToString: async () => text,
  } as never;
}

function makeS3Event(eventName: string, key: string): S3Event {
  return {
    Records: [
      {
        eventVersion: "2.1",
        eventSource: "aws:s3",
        awsRegion: "eu-west-2",
        eventTime: "2026-11-15T01:00:00.000Z",
        eventName,
        userIdentity: { principalId: "test" },
        requestParameters: { sourceIPAddress: "127.0.0.1" },
        responseElements: { "x-amz-request-id": "1", "x-amz-id-2": "2" },
        s3: {
          s3SchemaVersion: "1.0",
          configurationId: "ManifestIndexer",
          bucket: {
            name: "example-cold-archive",
            ownerIdentity: { principalId: "test" },
            arn: "arn:aws:s3:::example-cold-archive",
          },
          object: {
            key,
            size: 1024,
            eTag: "etag",
            sequencer: "1",
          },
        },
      },
    ],
  };
}

describe("indexer lambda", () => {
  beforeEach(() => {
    s3Mock.reset();
    ddbMock.reset();
  });

  it("upserts row on ObjectCreated, stores manifestKey, and preserves existing restore and notifiedExpiresAt attributes", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: s3Body(fixtureJson),
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        id: "screen-recording-2026-06-14",
        restore: { status: "ready", expiresAt: "2026-11-22T00:00:00Z" },
        notifiedExpiresAt: "2026-11-22T00:00:00Z",
      },
    });
    ddbMock.on(PutCommand).resolves({});

    await handler(
      makeS3Event("ObjectCreated:Put", "manifest/screen-recording-2026-06-14.json"),
    );

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item;
    expect(item?.id).toBe("screen-recording-2026-06-14");
    expect(item?.manifestKey).toBe("manifest/screen-recording-2026-06-14.json");
    expect(item?.name).toBe("Screen Recording 2026-06-14 at 15.06.00.mov");
    expect(item?.restore).toEqual({
      status: "ready",
      expiresAt: "2026-11-22T00:00:00Z",
    });
    expect(item?.notifiedExpiresAt).toBe("2026-11-22T00:00:00Z");
  });

  it("deletes row on ObjectRemoved", async () => {
    ddbMock.on(DeleteCommand).resolves({});

    await handler(
      makeS3Event("ObjectRemoved:Delete", "manifest/screen-recording-2026-06-14.json"),
    );

    const delCalls = ddbMock.commandCalls(DeleteCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0].args[0].input.Key).toEqual({
      id: "screen-recording-2026-06-14",
    });
  });

  it("URL-decodes + and %20 in S3 event object keys", async () => {
    const customJson = fixtureJson.replaceAll(
      "screen-recording-2026-06-14",
      "my file with spaces",
    );
    s3Mock.on(GetObjectCommand).resolves({
      Body: s3Body(customJson),
    });
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    await handler(
      makeS3Event("ObjectCreated:Put", "manifest/my+file%20with+spaces.json"),
    );

    const getObjCalls = s3Mock.commandCalls(GetObjectCommand);
    expect(getObjCalls).toHaveLength(1);
    expect(getObjCalls[0].args[0].input.Key).toBe("manifest/my file with spaces.json");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);

    await handler(
      makeS3Event("ObjectRemoved:Delete", "manifest/my+file%20with+spaces.json"),
    );

    const delCalls = ddbMock.commandCalls(DeleteCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0].args[0].input.Key).toEqual({ id: "my file with spaces" });
  });

  it("logs and skips malformed, mismatched-id, or hostile-key manifests without failing the batch", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mismatchedIdManifest = JSON.parse(fixtureJson);
    mismatchedIdManifest.id = "different-id";
    mismatchedIdManifest.s3.key = "originals/2026/11/different-id/file.mov";
    mismatchedIdManifest.previews = [];

    const hostileManifest = JSON.parse(fixtureJson);
    hostileManifest.id = "hostile-item";
    hostileManifest.s3.key =
      "originals/2026/11/screen-recording-2026-06-14/Screen Recording 2026-06-14 at 15.06.00.mov";

    s3Mock
      .on(GetObjectCommand, { Key: "manifest/corrupt.json" })
      .resolves({ Body: s3Body("{not-valid-json") })
      .on(GetObjectCommand, { Key: "manifest/mismatched-stem.json" })
      .resolves({ Body: s3Body(JSON.stringify(mismatchedIdManifest)) })
      .on(GetObjectCommand, { Key: "manifest/hostile-item.json" })
      .resolves({ Body: s3Body(JSON.stringify(hostileManifest)) })
      .on(GetObjectCommand, { Key: "manifest/screen-recording-2026-06-14.json" })
      .resolves({ Body: s3Body(fixtureJson) });
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const event: S3Event = {
      Records: [
        ...makeS3Event("ObjectCreated:Put", "manifest/corrupt.json").Records,
        ...makeS3Event("ObjectCreated:Put", "manifest/mismatched-stem.json").Records,
        ...makeS3Event("ObjectCreated:Put", "manifest/hostile-item.json").Records,
        ...makeS3Event(
          "ObjectCreated:Put",
          "manifest/screen-recording-2026-06-14.json",
        ).Records,
      ],
    };

    await expect(handler(event)).resolves.toEqual({ upserted: 1, deleted: 0 });
    expect(errSpy).toHaveBeenCalledTimes(3);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    errSpy.mockRestore();
  });

  it("rethrows AWS SDK and DynamoDB errors on ObjectCreated", async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: s3Body(fixtureJson) });
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).rejects(new Error("ProvisionedThroughputExceededException"));

    await expect(
      handler(
        makeS3Event("ObjectCreated:Put", "manifest/screen-recording-2026-06-14.json"),
      ),
    ).rejects.toThrow("ProvisionedThroughputExceededException");
  });

  it("backfill reconciles both directions (upserts missing rows, deletes orphaned rows)", async () => {
    const secondJson = fixtureJson.replaceAll(
      "screen-recording-2026-06-14",
      "second-item",
    );

    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: "manifest/screen-recording-2026-06-14.json" },
        { Key: "manifest/second-item.json" },
      ],
      IsTruncated: false,
    });
    s3Mock
      .on(GetObjectCommand, { Key: "manifest/screen-recording-2026-06-14.json" })
      .resolves({ Body: s3Body(fixtureJson) })
      .on(GetObjectCommand, { Key: "manifest/second-item.json" })
      .resolves({ Body: s3Body(secondJson) });

    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          id: "screen-recording-2026-06-14",
          restore: { status: "in-progress" },
        },
        {
          id: "orphaned-row-without-manifest",
        },
      ],
    });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const result = await handler({ backfill: true });
    expect(result).toEqual({ upserted: 2, deleted: 1 });

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(2);
    const upsertedScreen = putCalls.find(
      (c) => c.args[0].input.Item?.id === "screen-recording-2026-06-14",
    );
    expect(upsertedScreen?.args[0].input.Item?.restore).toEqual({
      status: "in-progress",
    });

    const delCalls = ddbMock.commandCalls(DeleteCommand);
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0].args[0].input.Key).toEqual({
      id: "orphaned-row-without-manifest",
    });
  });
});
