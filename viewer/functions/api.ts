import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  RestoreObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { earlyDeleteCharge, monthlyUsd } from "../core/cost.js";
import {
  type ItemRow,
  type RestoreState,
  parseRestoreHeader,
  validateRow,
} from "../core/manifest.js";

export { parseRestoreHeader };

const PRESIGN_EXPIRES_SECONDS = 900;
const RESTORE_DAYS = 7;

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function json(statusCode: number, payload: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

async function scanAllRows(tableName: string): Promise<ItemRow[]> {
  const rows: ItemRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of res.Items ?? []) {
      rows.push(item as ItemRow);
    }
    exclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return rows;
}

async function getRow(tableName: string, id: string): Promise<ItemRow | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { id },
    }),
  );
  return (res.Item as ItemRow | undefined) ?? null;
}

function isRestoreAlreadyInProgress(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as { name?: string; Code?: string; code?: string };
  return (
    e.name === "RestoreAlreadyInProgress" ||
    e.Code === "RestoreAlreadyInProgress" ||
    e.code === "RestoreAlreadyInProgress"
  );
}

async function routeRequest(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const bucket = Resource.Archive.name;
  const tableName = Resource.Items.name;
  const routeKey =
    event.routeKey || `${event.requestContext?.http?.method ?? "GET"} ${event.rawPath}`;
  const id = event.pathParameters?.id;

  if (routeKey === "GET /items") {
    const rows = await scanAllRows(tableName);
    rows.sort((a, b) => {
      const tA = Date.parse(a.uploadedAt);
      const tB = Date.parse(b.uploadedAt);
      if (!Number.isNaN(tA) && !Number.isNaN(tB) && tB !== tA) {
        return tB - tA;
      }
      return b.uploadedAt.localeCompare(a.uploadedAt);
    });
    const withoutManifest = rows.map(({ manifest: _manifest, ...rest }) => rest);
    return json(200, withoutManifest);
  }

  if (routeKey === "GET /items/{id}" && id) {
    const row = await getRow(tableName, id);
    if (!row) {
      return json(404, { error: "Item not found" });
    }
    return json(200, row);
  }

  if (routeKey === "GET /items/{id}/preview/{n}" && id) {
    const row = await getRow(tableName, id);
    if (!row) {
      return json(404, { error: "Item not found" });
    }
    try {
      validateRow(row);
    } catch (err) {
      return json(409, {
        error: err instanceof Error ? err.message : "Invalid item keys",
      });
    }
    const rawN = event.pathParameters?.n ?? "";
    const n = Number(rawN);
    if (!/^\d+$/.test(rawN) || !Number.isInteger(n) || n < 0 || n >= row.previews.length) {
      return json(404, { error: "Preview index out of range" });
    }
    const preview = row.previews[n];
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: preview.key,
      }),
      { expiresIn: PRESIGN_EXPIRES_SECONDS },
    );
    return json(200, { url });
  }

  if (routeKey === "POST /items/{id}/restore" && id) {
    const row = await getRow(tableName, id);
    if (!row) {
      return json(404, { error: "Item not found" });
    }
    try {
      validateRow(row);
    } catch (err) {
      return json(409, {
        error: err instanceof Error ? err.message : "Invalid item keys",
      });
    }

    let tier: "Bulk" | "Standard" = "Bulk";
    if (event.body) {
      try {
        const parsed = JSON.parse(event.body) as { tier?: string };
        if (parsed.tier !== undefined) {
          if (parsed.tier !== "Bulk" && parsed.tier !== "Standard") {
            return json(400, { error: "Invalid restore tier" });
          }
          tier = parsed.tier;
        }
      } catch {
        return json(400, { error: "Invalid JSON body" });
      }
    }

    try {
      await s3.send(
        new RestoreObjectCommand({
          Bucket: bucket,
          Key: row.originalKey,
          RestoreRequest: {
            Days: RESTORE_DAYS,
            GlacierJobParameters: {
              Tier: tier,
            },
          },
        }),
      );
    } catch (err) {
      if (!isRestoreAlreadyInProgress(err)) {
        throw err;
      }
    }

    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: row.originalKey,
      }),
    );
    const parsedRestore = parseRestoreHeader(head.Restore);
    const restore: RestoreState =
      parsedRestore.status === "none" ? { status: "in-progress" } : parsedRestore;

    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { id: row.id },
        UpdateExpression: "SET #restore = :restore",
        ExpressionAttributeNames: { "#restore": "restore" },
        ExpressionAttributeValues: { ":restore": restore },
      }),
    );

    return json(200, { restore });
  }

  if (routeKey === "GET /items/{id}/download" && id) {
    const row = await getRow(tableName, id);
    if (!row) {
      return json(404, { error: "Item not found" });
    }
    try {
      validateRow(row);
    } catch (err) {
      return json(409, {
        error: err instanceof Error ? err.message : "Invalid item keys",
      });
    }
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: row.originalKey,
      }),
    );
    const restore = parseRestoreHeader(head.Restore);
    if (restore.status !== "ready") {
      return json(409, { restore });
    }

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: row.originalKey,
      }),
      { expiresIn: PRESIGN_EXPIRES_SECONDS },
    );
    return json(200, { url, restore });
  }

  if (routeKey === "DELETE /items/{id}" && id) {
    const row = await getRow(tableName, id);
    if (!row) {
      return json(404, { error: "Item not found" });
    }
    const charge = earlyDeleteCharge(row, new Date());
    if (event.queryStringParameters?.confirm !== "true") {
      return json(409, { charge });
    }

    const expectedManifestKey = `manifest/${id}.json`;
    const rowManifestKey = row.manifestKey ?? `manifest/${row.id}.json`;
    const manifestId = row.manifest?.id ?? row.id;
    const originalKey = row.manifest?.s3?.key ?? row.originalKey;
    const previews = row.previews ?? (row.manifest?.previews ?? []).map((p) => ({
      key: p.key,
      bytes: p.bytes,
      contentType: p.content_type,
    }));

    if (
      row.id !== id ||
      manifestId !== id ||
      rowManifestKey !== expectedManifestKey ||
      originalKey !== row.originalKey
    ) {
      return json(409, {
        error: "Manifest key or item id mismatch; refusing to delete",
      });
    }

    try {
      validateRow({
        id: row.id,
        originalKey,
        previews,
        manifestKey: rowManifestKey,
      });
    } catch (err) {
      return json(409, {
        error: err instanceof Error ? err.message : "Invalid item keys",
      });
    }

    const previewKeys = previews.map((p) => p.key);
    const keysToDelete = [originalKey, ...previewKeys, expectedManifestKey];

    for (let i = 0; i < keysToDelete.length; i++) {
      const key = keysToDelete[i];
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );
      } catch (err) {
        const remainingKeys = keysToDelete.slice(i);
        return json(502, {
          error: err instanceof Error ? err.message : "Failed to delete S3 object",
          remainingKeys,
        });
      }
    }

    await ddb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { id: row.id },
      }),
    );

    return json(200, { deleted: row.id, charge });
  }

  if (routeKey === "GET /costs") {
    const rows = await scanAllRows(tableName);
    let storedBytes = 0;
    let previewBytes = 0;
    let bytesFreed = 0;

    for (const row of rows) {
      storedBytes += row.bytes ?? 0;
      for (const p of row.previews ?? []) {
        previewBytes += p.bytes ?? 0;
      }
      if (typeof row.manifest?.bytes_freed === "number" && row.manifest.bytes_freed > 0) {
        bytesFreed += row.manifest.bytes_freed;
      } else if (row.localDeleted) {
        bytesFreed += row.manifest?.original?.bytes_on_disk ?? row.bytes ?? 0;
      }
    }

    return json(200, {
      items: rows.length,
      storedBytes,
      previewBytes,
      monthlyUsd: monthlyUsd(storedBytes, previewBytes),
      bytesFreed,
    });
  }

  return json(404, { error: "Route not found" });
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    return await routeRequest(event);
  } catch (err) {
    console.error("Unhandled API error:", err);
    return json(500, {
      error: err instanceof Error ? err.message : "Internal server error",
    });
  }
}
