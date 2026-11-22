import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  RestoreObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { earlyDeleteCharge, monthlyUsd } from "../core/cost.js";
import { parseManifest, toRow } from "../core/manifest.js";
import { handler } from "./api.js";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(
    async (_client: unknown, cmd: { input: { Bucket: string; Key: string } }, opts: { expiresIn: number }) =>
      `https://s3.eu-west-2.amazonaws.com/${cmd.input.Bucket}/${encodeURIComponent(cmd.input.Key)}?X-Amz-Expires=${opts.expiresIn}`,
  ),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureJson = readFileSync(
  join(__dirname, "..", "core", "fixtures", "screen.json"),
  "utf8",
);

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

function makeRow(overrides: Partial<ReturnType<typeof toRow>> = {}) {
  const base = toRow(parseManifest(fixtureJson));
  return { ...base, ...overrides };
}

function makeApiEvent(
  method: string,
  rawPath: string,
  options: {
    routeKey?: string;
    pathParameters?: Record<string, string>;
    queryStringParameters?: Record<string, string>;
    body?: string;
  } = {},
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: options.routeKey ?? `${method} ${rawPath}`,
    rawPath,
    rawQueryString: "",
    headers: {},
    pathParameters: options.pathParameters,
    queryStringParameters: options.queryStringParameters,
    body: options.body,
    isBase64Encoded: false,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "api.example.com",
      domainPrefix: "api",
      http: {
        method,
        path: rawPath,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "req-1",
      routeKey: options.routeKey ?? `${method} ${rawPath}`,
      stage: "$default",
      time: "15/Nov/2026:01:00:00 +0000",
      timeEpoch: 1794704400000,
    },
  };
}

async function callApi(
  event: APIGatewayProxyEventV2,
): Promise<{ statusCode: number; body: Record<string, unknown> | unknown[] }> {
  const res = (await handler(event)) as APIGatewayProxyStructuredResultV2;
  return {
    statusCode: res.statusCode ?? 200,
    body: res.body ? JSON.parse(res.body) : {},
  };
}

describe("api lambda", () => {
  beforeEach(() => {
    s3Mock.reset();
    ddbMock.reset();
    vi.clearAllMocks();
  });

  it("GET /items returns rows without manifest blob sorted by uploadedAt desc", async () => {
    const older = makeRow({
      id: "older-item",
      uploadedAt: "2026-11-10T10:00:00+00:00",
    });
    const newer = makeRow({
      id: "newer-item",
      uploadedAt: "2026-11-15T12:00:00+00:00",
    });
    ddbMock.on(ScanCommand).resolves({ Items: [older, newer] });

    const res = await callApi(makeApiEvent("GET", "/items"));
    expect(res.statusCode).toBe(200);
    const items = res.body as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("newer-item");
    expect(items[1].id).toBe("older-item");
    expect(items[0]).not.toHaveProperty("manifest");
    expect(items[1]).not.toHaveProperty("manifest");
  });

  it("GET /items/{id} returns full row with manifest and 404 on unknown id", async () => {
    const row = makeRow();
    ddbMock
      .on(GetCommand, { Key: { id: row.id } })
      .resolves({ Item: row })
      .on(GetCommand, { Key: { id: "missing" } })
      .resolves({});

    const ok = await callApi(
      makeApiEvent("GET", `/items/${row.id}`, {
        routeKey: "GET /items/{id}",
        pathParameters: { id: row.id },
      }),
    );
    expect(ok.statusCode).toBe(200);
    expect((ok.body as Record<string, unknown>).id).toBe(row.id);
    expect((ok.body as Record<string, unknown>).manifest).toEqual(row.manifest);

    const notFound = await callApi(
      makeApiEvent("GET", "/items/missing", {
        routeKey: "GET /items/{id}",
        pathParameters: { id: "missing" },
      }),
    );
    expect(notFound.statusCode).toBe(404);
  });

  it("GET /items/{id}/preview/{n} returns 900s presigned URL and 404 when out of range or unknown", async () => {
    const row = makeRow();
    ddbMock
      .on(GetCommand, { Key: { id: row.id } })
      .resolves({ Item: row })
      .on(GetCommand, { Key: { id: "missing" } })
      .resolves({});

    const ok = await callApi(
      makeApiEvent("GET", `/items/${row.id}/preview/1`, {
        routeKey: "GET /items/{id}/preview/{n}",
        pathParameters: { id: row.id, n: "1" },
      }),
    );
    expect(ok.statusCode).toBe(200);
    const url = (ok.body as { url: string }).url;
    expect(url).toContain(encodeURIComponent(row.previews[1].key));
    expect(url).toContain("X-Amz-Expires=900");

    const outOfRange = await callApi(
      makeApiEvent("GET", `/items/${row.id}/preview/2`, {
        routeKey: "GET /items/{id}/preview/{n}",
        pathParameters: { id: row.id, n: "2" },
      }),
    );
    expect(outOfRange.statusCode).toBe(404);

    const negativeIdx = await callApi(
      makeApiEvent("GET", `/items/${row.id}/preview/-1`, {
        routeKey: "GET /items/{id}/preview/{n}",
        pathParameters: { id: row.id, n: "-1" },
      }),
    );
    expect(negativeIdx.statusCode).toBe(404);

    const unknownItem = await callApi(
      makeApiEvent("GET", "/items/missing/preview/0", {
        routeKey: "GET /items/{id}/preview/{n}",
        pathParameters: { id: "missing", n: "0" },
      }),
    );
    expect(unknownItem.statusCode).toBe(404);
  });

  it("POST /items/{id}/restore initiates RestoreObject (Days 7, default Bulk) and handles RestoreAlreadyInProgress with 200", async () => {
    const row = makeRow();
    ddbMock.on(GetCommand, { Key: { id: row.id } }).resolves({ Item: row });
    ddbMock.on(UpdateCommand).resolves({});
    s3Mock.on(RestoreObjectCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({
      Restore: 'ongoing-request="true"',
    });

    const first = await callApi(
      makeApiEvent("POST", `/items/${row.id}/restore`, {
        routeKey: "POST /items/{id}/restore",
        pathParameters: { id: row.id },
      }),
    );
    expect(first.statusCode).toBe(200);
    expect(first.body).toEqual({
      restore: { status: "in-progress" },
    });

    const restoreCalls = s3Mock.commandCalls(RestoreObjectCommand);
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0].args[0].input).toEqual({
      Bucket: "example-cold-archive",
      Key: row.originalKey,
      RestoreRequest: {
        Days: 7,
        GlacierJobParameters: { Tier: "Bulk" },
      },
    });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);

    // Second call: RestoreAlreadyInProgress -> 200 with current status from HeadObject
    const alreadyErr = new Error("Restore already in progress");
    alreadyErr.name = "RestoreAlreadyInProgress";
    s3Mock.on(RestoreObjectCommand).rejects(alreadyErr);
    s3Mock.on(HeadObjectCommand).resolves({
      Restore: 'ongoing-request="false", expiry-date="Sun, 22 Nov 2026 00:00:00 GMT"',
    });

    const second = await callApi(
      makeApiEvent("POST", `/items/${row.id}/restore`, {
        routeKey: "POST /items/{id}/restore",
        pathParameters: { id: row.id },
        body: JSON.stringify({ tier: "Standard" }),
      }),
    );
    expect(second.statusCode).toBe(200);
    expect(second.body).toEqual({
      restore: {
        status: "ready",
        expiresAt: "2026-11-22T00:00:00.000Z",
      },
    });
  });

  it("GET /items/{id}/download returns 409 when not ready and 200 with 900s presigned URL when restore is complete", async () => {
    const row = makeRow();
    ddbMock.on(GetCommand, { Key: { id: row.id } }).resolves({ Item: row });

    // In-progress -> 409
    s3Mock.on(HeadObjectCommand).resolves({
      Restore: 'ongoing-request="true"',
    });
    const inProgress = await callApi(
      makeApiEvent("GET", `/items/${row.id}/download`, {
        routeKey: "GET /items/{id}/download",
        pathParameters: { id: row.id },
      }),
    );
    expect(inProgress.statusCode).toBe(409);
    expect(inProgress.body).toEqual({
      restore: { status: "in-progress" },
    });

    // Completed -> 200 with presigned URL
    s3Mock.on(HeadObjectCommand).resolves({
      Restore: 'ongoing-request="false", expiry-date="Sun, 22 Nov 2026 00:00:00 GMT"',
    });
    const ready = await callApi(
      makeApiEvent("GET", `/items/${row.id}/download`, {
        routeKey: "GET /items/{id}/download",
        pathParameters: { id: row.id },
      }),
    );
    expect(ready.statusCode).toBe(200);
    const body = ready.body as { url: string; restore: { status: string; expiresAt: string } };
    expect(body.url).toContain(encodeURIComponent(row.originalKey));
    expect(body.url).toContain("X-Amz-Expires=900");
    expect(body.restore).toEqual({
      status: "ready",
      expiresAt: "2026-11-22T00:00:00.000Z",
    });
  });

  it("DELETE /items/{id} without confirm returns 409 {charge}; with confirm=true deletes original -> previews -> manifest then Dynamo row (even if restore in progress)", async () => {
    const row = makeRow({
      restore: { status: "in-progress" },
    });
    ddbMock.on(GetCommand, { Key: { id: row.id } }).resolves({ Item: row });
    s3Mock.on(DeleteObjectCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    // Without confirm -> 409 with earlyDeleteCharge
    const dryRun = await callApi(
      makeApiEvent("DELETE", `/items/${row.id}`, {
        routeKey: "DELETE /items/{id}",
        pathParameters: { id: row.id },
      }),
    );
    expect(dryRun.statusCode).toBe(409);
    const expectedCharge = earlyDeleteCharge(row, new Date());
    expect((dryRun.body as { charge: number }).charge).toBeCloseTo(expectedCharge, 5);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);

    // With confirm=true -> deletes S3 keys in order original -> previews -> manifest, then DynamoDB
    const confirmed = await callApi(
      makeApiEvent("DELETE", `/items/${row.id}`, {
        routeKey: "DELETE /items/{id}",
        pathParameters: { id: row.id },
        queryStringParameters: { confirm: "true" },
      }),
    );
    expect(confirmed.statusCode).toBe(200);

    const s3Deletes = s3Mock
      .commandCalls(DeleteObjectCommand)
      .map((c) => c.args[0].input.Key);
    expect(s3Deletes).toEqual([
      row.originalKey,
      row.previews[0].key,
      row.previews[1].key,
      `manifest/${row.id}.json`,
    ]);

    const ddbDeletes = ddbMock.commandCalls(DeleteCommand);
    expect(ddbDeletes).toHaveLength(1);
    expect(ddbDeletes[0].args[0].input.Key).toEqual({ id: row.id });
  });

  it("DELETE /items/{id}?confirm=true surfaces S3 error with 502 and remainingKeys without deleting Dynamo row", async () => {
    const row = makeRow({
      restore: { status: "in-progress" },
    });
    ddbMock.on(GetCommand, { Key: { id: row.id } }).resolves({ Item: row });

    s3Mock
      .on(DeleteObjectCommand, { Key: row.originalKey })
      .resolves({})
      .on(DeleteObjectCommand, { Key: row.previews[0].key })
      .rejects(new Error("S3 InternalError"));

    const res = await callApi(
      makeApiEvent("DELETE", `/items/${row.id}`, {
        routeKey: "DELETE /items/{id}",
        pathParameters: { id: row.id },
        queryStringParameters: { confirm: "true" },
      }),
    );
    expect(res.statusCode).toBe(502);
    expect((res.body as { remainingKeys: string[] }).remainingKeys).toEqual([
      row.previews[0].key,
      row.previews[1].key,
      `manifest/${row.id}.json`,
    ]);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it("GET /costs aggregates items, storedBytes, previewBytes, monthlyUsd, and bytesFreed", async () => {
    const row1 = makeRow({ id: "item-1", localDeleted: false });
    const row2 = makeRow({
      id: "item-2",
      bytes: 1_000_000_000,
      localDeleted: true,
      previews: [{ key: "previews/2.jpg", bytes: 50_000, contentType: "image/jpeg" }],
    });
    ddbMock.on(ScanCommand).resolves({ Items: [row1, row2] });

    const res = await callApi(makeApiEvent("GET", "/costs"));
    expect(res.statusCode).toBe(200);

    const expectedStored = row1.bytes + row2.bytes;
    const expectedPreviews =
      row1.previews[0].bytes + row1.previews[1].bytes + row2.previews[0].bytes;
    const expectedMonthly = monthlyUsd(expectedStored, expectedPreviews);
    const expectedFreed = row2.manifest.original.bytes_on_disk;

    expect(res.body).toEqual({
      items: 2,
      storedBytes: expectedStored,
      previewBytes: expectedPreviews,
      monthlyUsd: expectedMonthly,
      bytesFreed: expectedFreed,
    });
  });

  it("refuses preview, restore, download, and delete with 409 {error} when row keys or manifestKey do not belong to the item", async () => {
    const hostileRow = makeRow({
      id: "11",
      originalKey: "originals/2026/11/victim/x",
    });
    ddbMock
      .on(GetCommand, { Key: { id: hostileRow.id } })
      .resolves({ Item: hostileRow });

    const previewRes = await callApi(
      makeApiEvent("GET", `/items/${hostileRow.id}/preview/0`, {
        routeKey: "GET /items/{id}/preview/{n}",
        pathParameters: { id: hostileRow.id, n: "0" },
      }),
    );
    expect(previewRes.statusCode).toBe(409);
    expect(previewRes.body).toHaveProperty("error");

    const restoreRes = await callApi(
      makeApiEvent("POST", `/items/${hostileRow.id}/restore`, {
        routeKey: "POST /items/{id}/restore",
        pathParameters: { id: hostileRow.id },
      }),
    );
    expect(restoreRes.statusCode).toBe(409);
    expect(restoreRes.body).toHaveProperty("error");
    expect(s3Mock.commandCalls(RestoreObjectCommand)).toHaveLength(0);

    const downloadRes = await callApi(
      makeApiEvent("GET", `/items/${hostileRow.id}/download`, {
        routeKey: "GET /items/{id}/download",
        pathParameters: { id: hostileRow.id },
      }),
    );
    expect(downloadRes.statusCode).toBe(409);
    expect(downloadRes.body).toHaveProperty("error");
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);

    const delRes = await callApi(
      makeApiEvent("DELETE", `/items/${hostileRow.id}`, {
        routeKey: "DELETE /items/{id}",
        pathParameters: { id: hostileRow.id },
        queryStringParameters: { confirm: "true" },
      }),
    );
    expect(delRes.statusCode).toBe(409);
    expect(delRes.body).toHaveProperty("error");
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);

    const mismatchedManifestRow = makeRow({
      manifestKey: "manifest/other-item.json",
    });
    ddbMock
      .on(GetCommand, { Key: { id: mismatchedManifestRow.id } })
      .resolves({ Item: mismatchedManifestRow });

    const delMismatched = await callApi(
      makeApiEvent("DELETE", `/items/${mismatchedManifestRow.id}`, {
        routeKey: "DELETE /items/{id}",
        pathParameters: { id: mismatchedManifestRow.id },
        queryStringParameters: { confirm: "true" },
      }),
    );
    expect(delMismatched.statusCode).toBe(409);
    expect(delMismatched.body).toHaveProperty("error");
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it("returns 500 {error} on unhandled exception and does not double-decode pathParameters.id", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    ddbMock.on(ScanCommand).rejects(new Error("DynamoDB outage"));

    const res500 = await callApi(makeApiEvent("GET", "/items"));
    expect(res500.statusCode).toBe(500);
    expect(res500.body).toEqual({ error: "DynamoDB outage" });

    ddbMock.on(GetCommand, { Key: { id: "100%raw" } }).resolves({});
    const res404 = await callApi(
      makeApiEvent("GET", "/items/100%25raw", {
        routeKey: "GET /items/{id}",
        pathParameters: { id: "100%raw" },
      }),
    );
    expect(res404.statusCode).toBe(404);
    errSpy.mockRestore();
  });
});
