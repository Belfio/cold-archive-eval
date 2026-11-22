/// <reference path="../.sst/platform/config.d.ts" />

export function createAuth(siteUrl: $util.Input<string>) {
  const users = new sst.aws.CognitoUserPool("Users", {
    transform: {
      userPool: {
        adminCreateUserConfig: {
          allowAdminCreateUserOnly: true,
        },
      },
    },
  });

  const userPoolDomain = new aws.cognito.UserPoolDomain("UsersDomain", {
    domain: $interpolate`cold-archive-viewer-${$app.stage}`,
    userPoolId: users.id,
  });

  // Cognito matches redirect_uri exactly; the web app sends `${origin}/`, so register both forms.
  // A mismatch surfaces as the misleading "Client is not enabled for OAuth2.0 flows".
  const urls = $output(siteUrl).apply((u) => {
    const base = u.replace(/\/$/, "");
    return [base, `${base}/`, "http://localhost:5173", "http://localhost:5173/"];
  });

  const webClient = users.addClient("Web", {
    callbackUrls: urls,
    transform: {
      client: {
        logoutUrls: urls,
        allowedOauthFlows: ["code"],
        allowedOauthFlowsUserPoolClient: true,
        allowedOauthScopes: ["openid", "email", "profile"],
        supportedIdentityProviders: ["COGNITO"],
      },
    },
  });

  const region = aws.getRegionOutput().name;
  const authDomain = $interpolate`https://${userPoolDomain.domain}.auth.${region}.amazoncognito.com`;

  return { users, userPoolDomain, webClient, authDomain };
}
