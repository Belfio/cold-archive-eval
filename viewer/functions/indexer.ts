import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { S3Event } from "aws-lambda";
import { Resource } from "sst";
import {
  type ItemRow,
  ManifestValidationError,
  type RestoreState,
  decodeS3Key,
  idFromManifestKey,
  parseManifest,
  toRow,
} from "../core/manifest.js";

export { decodeS3Key };

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export type IndexerResult = {
  upserted: number;
  deleted: number;
};

export type IndexerEvent = S3Event | { backfill: true };

function isBackfillEvent(event: IndexerEvent): event is { backfill: true } {
  return (
    typeof event === "object" &&
    event !== null &&
    "backfill" in event &&
    event.backfill === true
  );
}

async function fetchManifestRow(bucket: string, key: string): Promise<ItemRow> {
  const expectedId = idFromManifestKey(key);
  if (!expectedId) {
    throw new ManifestValidationError(`Invalid manifest key: ${key}`);
  }
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await obj.Body?.transformToString();
  if (!text) {
    throw new ManifestValidationError(`Empty manifest body for key: ${key}`);
  }
  const manifest = parseManifest(text);
  if (manifest.id !== expectedId) {
    throw new ManifestValidationError(
      `Manifest id "${manifest.id}" does not match manifest filename stem "${expectedId}"`,
    );
  }
  return toRow(manifest, key);
}

type ExistingState = {
  id: string;
  restore?: RestoreState;
  notifiedExpiresAt?: string;
};

async function runBackfill(): Promise<IndexerResult> {
  const bucket = Resource.Archive.name;
  const tableName = Resource.Items.name;

  const manifestKeys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "manifest/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key && idFromManifestKey(obj.Key)) {
        manifestKeys.push(obj.Key);
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  const existingById = new Map<string, ExistingState>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const scanPage = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of scanPage.Items ?? []) {
      if (typeof item.id === "string") {
        existingById.set(item.id, item as ExistingState);
      }
    }
    exclusiveStartKey = scanPage.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  let upserted = 0;
  let deleted = 0;
  const seenIds = new Set<string>();

  for (const key of manifestKeys) {
    try {
      const row = await fetchManifestRow(bucket, key);
      const existing = existingById.get(row.id);
      if (existing?.restore) {
        row.restore = existing.restore;
      }
      if (existing?.notifiedExpiresAt) {
        row.notifiedExpiresAt = existing.notifiedExpiresAt;
      }
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: row,
        }),
      );
      seenIds.add(row.id);
      upserted += 1;
    } catch (err) {
      if (!(err instanceof ManifestValidationError)) {
        throw err;
      }
      const keyId = idFromManifestKey(key);
      if (keyId) {
        seenIds.add(keyId);
      }
      console.error(`Skipping invalid manifest ${key}:`, err);
    }
  }

  for (const existingId of existingById.keys()) {
    if (!seenIds.has(existingId)) {
      await ddb.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { id: existingId },
        }),
      );
      deleted += 1;
    }
  }

  return { upserted, deleted };
}

export async function handler(event: IndexerEvent): Promise<IndexerResult> {
  if (isBackfillEvent(event)) {
    return runBackfill();
  }

  const tableName = Resource.Items.name;
  let upserted = 0;
  let deleted = 0;

  for (const record of event.Records ?? []) {
    const bucket = record.s3?.bucket?.name || Resource.Archive.name;
    const rawKey = record.s3?.object?.key;
    if (!rawKey) {
      continue;
    }
    const key = decodeS3Key(rawKey);
    const eventName = record.eventName ?? "";

    if (eventName.startsWith("ObjectCreated:")) {
      let row: ItemRow;
      try {
        row = await fetchManifestRow(bucket, key);
      } catch (err) {
        if (err instanceof ManifestValidationError) {
          console.error(`Skipping invalid manifest ${key}:`, err);
          continue;
        }
        throw err;
      }
      const existing = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { id: row.id },
        }),
      );
      if (existing.Item?.restore) {
        row.restore = existing.Item.restore as RestoreState;
      }
      if (typeof existing.Item?.notifiedExpiresAt === "string") {
        row.notifiedExpiresAt = existing.Item.notifiedExpiresAt;
      }
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: row,
        }),
      );
      upserted += 1;
    } else if (eventName.startsWith("ObjectRemoved:")) {
      const id = idFromManifestKey(key);
      if (!id) {
        console.error(`Cannot derive item id from removed key: ${key}`);
        continue;
      }
      await ddb.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { id },
        }),
      );
      deleted += 1;
    }
  }

  return { upserted, deleted };
}
