/// <reference path="../.sst/platform/config.d.ts" />

import type { createApi } from "./api.js";
import type { createAuth } from "./auth.js";

export function createSite(
  api: ReturnType<typeof createApi>["api"],
  auth: ReturnType<typeof createAuth>,
) {
  const site = new sst.aws.StaticSite("Site", {
    path: "web",
    build: {
      command: "npm run build",
      output: "dist",
    },
    environment: {
      VITE_API_URL: api.url,
      VITE_USER_POOL_ID: auth.users.id,
      VITE_CLIENT_ID: auth.webClient.id,
      VITE_AUTH_DOMAIN: auth.authDomain,
    },
  });

  return { site };
}
