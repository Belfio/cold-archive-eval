/// <reference path="../.sst/platform/config.d.ts" />

export const ARCHIVE_BUCKET_NAME = "example-cold-archive";

export function createStorage(siteUrl: $util.Input<string>) {
  // Override default SST link definitions for Bucket and Dynamo so that
  // linking them exposes Resource.Archive.name and Resource.Items.name
  // without attaching wildcard s3:* or dynamodb:* IAM permissions.
  sst.Linkable.wrap(sst.aws.Bucket, (bucket) => ({
    properties: { name: bucket.name },
  }));
  sst.Linkable.wrap(sst.aws.Dynamo, (table) => ({
    properties: { name: table.name },
  }));

  const archive = sst.aws.Bucket.get("Archive", ARCHIVE_BUCKET_NAME);

  // Configure CORS on the existing imported archive bucket so the browser can
  // fetch TSV/tar/JSON previews directly from presigned S3 GET URLs.
  // Nothing else on the bucket (bucket resource, versioning, lifecycle,
  // encryption, public-access block, or bucket policy) is created or modified.
  const archiveCors = new aws.s3.BucketCorsConfigurationV2("ArchiveCors", {
    bucket: archive.name,
    corsRules: [
      {
        allowedMethods: ["GET", "HEAD"],
        allowedOrigins: [siteUrl, "http://localhost:5173"],
        allowedHeaders: ["*"],
        maxAgeSeconds: 3000,
      },
    ],
  });

  const items = new sst.aws.Dynamo("Items", {
    fields: { id: "string" },
    primaryIndex: { hashKey: "id" },
  });

  const ownerEmail = new sst.Secret("OwnerEmail", "unset@example.invalid");

  return { archive, archiveCors, items, ownerEmail };
}
