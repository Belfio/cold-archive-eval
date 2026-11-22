/// <reference path="../.sst/platform/config.d.ts" />

import type { createAuth } from "./auth.js";
import type { createStorage } from "./storage.js";

export function createApi(
  storage: ReturnType<typeof createStorage>,
  auth: ReturnType<typeof createAuth>,
  siteUrl: $util.Input<string>,
) {
  const { archive, items } = storage;
  const { users, webClient } = auth;

  const api = new sst.aws.ApiGatewayV2("Api", {
    cors: {
      allowOrigins: [siteUrl, "http://localhost:5173"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
    },
  });

  const region = aws.getRegionOutput().name;
  const authorizer = api.addAuthorizer({
    name: "Cognito",
    jwt: {
      issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${users.id}`,
      audiences: [webClient.id],
    },
  });

  const apiHandler = new sst.aws.Function("ApiHandler", {
    handler: "functions/api.handler",
    link: [archive, items],
    permissions: [
      {
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Scan",
          "dynamodb:Query",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
        ],
        resources: [items.arn],
      },
      // s3:HeadObject is authorised by s3:GetObject.
      {
        actions: ["s3:GetObject"],
        resources: [
          $interpolate`${archive.arn}/previews/*`,
          $interpolate`${archive.arn}/originals/*`,
        ],
      },
      {
        actions: ["s3:HeadObject", "s3:RestoreObject"],
        resources: [$interpolate`${archive.arn}/originals/*`],
      },
      {
        actions: ["s3:DeleteObject"],
        resources: [
          $interpolate`${archive.arn}/originals/*`,
          $interpolate`${archive.arn}/previews/*`,
          $interpolate`${archive.arn}/manifest/*`,
        ],
      },
    ],
  });

  const routes = [
    "GET /items",
    "GET /items/{id}",
    "GET /items/{id}/preview/{n}",
    "POST /items/{id}/restore",
    "GET /items/{id}/download",
    "DELETE /items/{id}",
    "GET /costs",
  ];

  for (const route of routes) {
    api.route(route, apiHandler.arn, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });
  }

  return { api, authorizer, apiHandler };
}
