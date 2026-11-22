/// <reference path="../.sst/platform/config.d.ts" />

import type { createStorage } from "./storage.js";

export function createNotifications(
  storage: ReturnType<typeof createStorage>,
  siteUrl: $util.Input<string>,
) {
  const { archive, items, ownerEmail } = storage;
  const region = aws.getRegionOutput().name;
  const accountId = aws.getCallerIdentityOutput().accountId;

  const indexer = new sst.aws.Function("Indexer", {
    handler: "functions/indexer.handler",
    link: [archive, items],
    permissions: [
      {
        actions: ["s3:GetObject"],
        resources: [$interpolate`${archive.arn}/manifest/*`],
      },
      {
        actions: ["s3:ListBucket"],
        resources: [archive.arn],
        conditions: [
          {
            test: "StringLike",
            variable: "s3:prefix",
            values: ["manifest/*"],
          },
        ],
      },
      {
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:Scan",
          "dynamodb:Query",
        ],
        resources: [items.arn],
      },
    ],
  });

  const restored = new sst.aws.Function("Restored", {
    handler: "functions/restored.handler",
    link: [archive, items, ownerEmail],
    environment: {
      SITE_URL: siteUrl,
    },
    permissions: [
      // s3:HeadObject is authorised by s3:GetObject.
      {
        actions: ["s3:GetObject", "s3:HeadObject"],
        resources: [$interpolate`${archive.arn}/originals/*`],
      },
      {
        actions: ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:UpdateItem"],
        resources: [items.arn],
      },
      {
        actions: ["ses:SendEmail"],
        resources: [
          $interpolate`arn:aws:ses:${region}:${accountId}:identity/${ownerEmail.value}`,
        ],
        conditions: [
          {
            test: "StringEquals",
            variable: "ses:FromAddress",
            values: [ownerEmail.value],
          },
        ],
      },
    ],
  });

  const indexerPermission = new aws.lambda.Permission(
    "IndexerBucketPermission",
    {
      action: "lambda:InvokeFunction",
      function: indexer.arn,
      principal: "s3.amazonaws.com",
      sourceArn: archive.arn,
      sourceAccount: accountId,
    },
  );

  const restoredPermission = new aws.lambda.Permission(
    "RestoredBucketPermission",
    {
      action: "lambda:InvokeFunction",
      function: restored.arn,
      principal: "s3.amazonaws.com",
      sourceArn: archive.arn,
      sourceAccount: accountId,
    },
  );

  // BucketNotification is the sole owner of the bucket's notification config.
  const notifications = new aws.s3.BucketNotification(
    "ArchiveNotifications",
    {
      bucket: archive.name,
      lambdaFunctions: [
        {
          id: "ManifestIndexer",
          lambdaFunctionArn: indexer.arn,
          events: ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"],
          filterPrefix: "manifest/",
        },
        {
          id: "OriginalsRestored",
          lambdaFunctionArn: restored.arn,
          events: ["s3:ObjectRestore:Completed"],
          filterPrefix: "originals/",
        },
      ],
    },
    {
      dependsOn: [indexerPermission, restoredPermission],
    },
  );

  return { indexer, restored, notifications };
}
