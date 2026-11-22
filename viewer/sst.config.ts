/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "cold-archive-viewer",
      removal: input?.stage === "prod" ? "retain" : "remove",
      protect: ["prod"].includes(input?.stage),
      home: "aws",
      providers: {
        aws: {
          region: "eu-west-2",
          profile: "personal",
        },
      },
    };
  },
  async run() {
    $transform(sst.aws.Function, (args) => {
      args.runtime ??= "nodejs22.x";
    });

    const { createStorage } = await import("./infra/storage.js");
    const { createNotifications } = await import("./infra/notifications.js");
    const { createAuth } = await import("./infra/auth.js");
    const { createApi } = await import("./infra/api.js");
    const { createSite } = await import("./infra/site.js");

    let resolveSiteUrl!: (url: $util.Output<string>) => void;
    const siteUrl = $util
      .output(
        new Promise<$util.Output<string>>((resolve) => {
          resolveSiteUrl = resolve;
        }),
      )
      .apply((u) => u);

    const storage = createStorage(siteUrl);
    const notifications = createNotifications(storage, siteUrl);
    const auth = createAuth(siteUrl);
    const { api } = createApi(storage, auth, siteUrl);
    const { site } = createSite(api, auth);

    resolveSiteUrl(site.url);

    return {
      apiUrl: api.url,
      siteUrl: site.url,
      userPoolId: auth.users.id,
      clientId: auth.webClient.id,
      authDomain: auth.authDomain,
      itemsTable: storage.items.name,
      indexerFunction: notifications.indexer.name,
    };
  },
});
