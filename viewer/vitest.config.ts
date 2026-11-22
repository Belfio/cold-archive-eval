import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core/**/*.test.ts", "functions/**/*.test.ts"],
    env: {
      SST_RESOURCE_App: JSON.stringify({ name: "cold-archive-viewer", stage: "prod" }),
      SST_RESOURCE_Archive: JSON.stringify({
        type: "sst.aws.Bucket",
        name: "example-cold-archive",
      }),
      SST_RESOURCE_Items: JSON.stringify({
        type: "sst.aws.Dynamo",
        name: "cold-archive-viewer-prod-ItemsTable",
      }),
      SST_RESOURCE_OwnerEmail: JSON.stringify({
        type: "sst.Secret",
        value: "owner@example.com",
      }),
      SST_RESOURCE_Site: JSON.stringify({
        type: "sst.aws.StaticSite",
        url: "https://viewer.example.com",
      }),
    },
  },
});
