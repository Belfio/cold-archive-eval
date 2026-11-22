import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { S3Event } from "aws-lambda";
import { Resource } from "sst";
import {
  type ItemRow,
  type RestoreState,
  decodeS3Key,
  parseRestoreHeader,
} from "../core/manifest.js";

const s3 = new S3Client({});
const ses = new SESClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

async function findRowByOriginalKey(
  tableName: string,
  originalKey: string,
): Promise<ItemRow | null> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "originalKey = :originalKey",
        ExpressionAttributeValues: {
          ":originalKey": originalKey,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const match = (res.Items ?? [])[0] as ItemRow | undefined;
    if (match) {
      return match;
    }
    exclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return null;
}

function normalizeIso(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

async function resolveExpiry(
  bucket: string,
  key: string,
  eventExpiry?: string,
): Promise<string | undefined> {
  const fromEvent = normalizeIso(eventExpiry);
  if (fromEvent) {
    return fromEvent;
  }
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return parseRestoreHeader(head.Restore).expiresAt;
  } catch {
    return undefined;
  }
}

function resolveSiteUrl(): string {
  if (process.env.SITE_URL) {
    return process.env.SITE_URL;
  }
  try {
    return (Resource as unknown as { Site?: { url?: string } }).Site?.url ?? "";
  } catch {
    return "";
  }
}

function isConditionalCheckFailed(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as { name?: string; Code?: string; code?: string };
  return (
    e.name === "ConditionalCheckFailedException" ||
    e.Code === "ConditionalCheckFailedException" ||
    e.code === "ConditionalCheckFailedException"
  );
}

export async function handler(event: S3Event): Promise<{ notified: number }> {
  const tableName = Resource.Items.name;
  const ownerEmail = Resource.OwnerEmail.value;
  const siteUrl = resolveSiteUrl();
  let notified = 0;

  for (const record of event.Records ?? []) {
    if (record.eventName && !record.eventName.startsWith("ObjectRestore:Completed")) {
      continue;
    }
    const bucket = record.s3?.bucket?.name || Resource.Archive.name;
    const rawKey = record.s3?.object?.key;
    if (!rawKey) {
      continue;
    }
    const key = decodeS3Key(rawKey);

    const row = await findRowByOriginalKey(tableName, key);
    if (!row) {
      console.warn(`No item row found for restored originalKey: ${key}`);
      continue;
    }

    const eventExpiry =
      record.glacierEventData?.restoreEventData?.lifecycleRestorationExpiryTime;
    const expiresAt = await resolveExpiry(bucket, key, eventExpiry);
    const notificationMarker = expiresAt ?? "ready";

    if (row.notifiedExpiresAt === notificationMarker) {
      continue;
    }

    const restore: RestoreState = expiresAt
      ? { status: "ready", expiresAt }
      : { status: "ready" };

    const subject = `Cold archive: ${row.name} is ready to download`;
    const bodyLines = [
      `${row.name} (${row.id}) has finished restoring from Glacier Deep Archive and is ready to download.`,
      expiresAt ? `Restore expires at: ${expiresAt}` : "Restore is ready now.",
      siteUrl ? `Open viewer: ${siteUrl}` : "",
    ].filter(Boolean);

    await ses.send(
      new SendEmailCommand({
        Source: ownerEmail,
        Destination: {
          ToAddresses: [ownerEmail],
        },
        Message: {
          Subject: {
            Charset: "UTF-8",
            Data: subject,
          },
          Body: {
            Text: {
              Charset: "UTF-8",
              Data: bodyLines.join("\n\n"),
            },
          },
        },
      }),
    );

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id: row.id },
          UpdateExpression: "SET #restore = :restore, notifiedExpiresAt = :e",
          ConditionExpression:
            "attribute_not_exists(notifiedExpiresAt) OR notifiedExpiresAt <> :e",
          ExpressionAttributeNames: { "#restore": "restore" },
          ExpressionAttributeValues: {
            ":restore": restore,
            ":e": notificationMarker,
          },
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        continue;
      }
      throw err;
    }

    notified += 1;
  }

  return { notified };
}
