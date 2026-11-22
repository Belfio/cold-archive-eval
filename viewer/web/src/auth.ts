import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";

export interface AuthHandler {
  getAccessToken(): Promise<string | null>;
  getUserEmail(): Promise<string | null>;
  handleCallbackIfPresent(): Promise<boolean>;
  silentRenew(): Promise<string | null>;
  loginRedirect(): Promise<void>;
  logout(): Promise<void>;
}

export type CognitoAuthConfig = {
  userPoolId: string;
  clientId: string;
  authDomain: string;
  origin?: string;
};

function extractToken(user: User | null | undefined): string | null {
  if (!user) {
    return null;
  }
  // Cognito JWT authorizer checks audience == clientId, which is present on id_token (and falls back to access_token)
  return user.id_token || user.access_token || null;
}

export function createCognitoAuth(config?: Partial<CognitoAuthConfig>): AuthHandler {
  const userPoolId = config?.userPoolId ?? (import.meta.env.VITE_USER_POOL_ID || "");
  const clientId = config?.clientId ?? (import.meta.env.VITE_CLIENT_ID || "");
  const authDomain = (config?.authDomain ?? (import.meta.env.VITE_AUTH_DOMAIN || "")).replace(
    /\/$/,
    "",
  );
  const origin = config?.origin ?? window.location.origin;
  const redirectUri = `${origin}/`;

  const region = userPoolId.includes("_") ? userPoolId.split("_")[0] : "eu-west-2";
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

  const userManager = new UserManager({
    authority: issuer,
    client_id: clientId,
    redirect_uri: redirectUri,
    post_logout_redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: false,
    metadata: authDomain
      ? {
          issuer,
          authorization_endpoint: `${authDomain}/oauth2/authorize`,
          token_endpoint: `${authDomain}/oauth2/token`,
          userinfo_endpoint: `${authDomain}/oauth2/userInfo`,
          end_session_endpoint: `${authDomain}/logout`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
        }
      : undefined,
  });

  // In-memory cache alongside sessionStorage store
  let memoryUser: User | null = null;

  async function resolveUser(): Promise<User | null> {
    if (memoryUser && !memoryUser.expired) {
      return memoryUser;
    }
    try {
      const stored = await userManager.getUser();
      memoryUser = stored;
      return stored;
    } catch {
      return null;
    }
  }

  return {
    async getAccessToken(): Promise<string | null> {
      const user = await resolveUser();
      if (!user || user.expired) {
        return null;
      }
      return extractToken(user);
    },

    async getUserEmail(): Promise<string | null> {
      const user = await resolveUser();
      const email = user?.profile?.email;
      return typeof email === "string" ? email : null;
    },

    async handleCallbackIfPresent(): Promise<boolean> {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("code") || !params.has("state")) {
        return false;
      }
      const user = await userManager.signinRedirectCallback();
      memoryUser = user;
      window.history.replaceState({}, document.title, window.location.pathname);
      return true;
    },

    async silentRenew(): Promise<string | null> {
      try {
        const user = await userManager.signinSilent();
        memoryUser = user;
        return extractToken(user);
      } catch {
        memoryUser = null;
        try {
          await userManager.removeUser();
        } catch {
          // ignore cleanup errors
        }
        return null;
      }
    },

    async loginRedirect(): Promise<void> {
      memoryUser = null;
      try {
        await userManager.removeUser();
      } catch {
        // ignore
      }
      await userManager.signinRedirect();
    },

    async logout(): Promise<void> {
      memoryUser = null;
      await userManager.removeUser();
      if (authDomain && clientId) {
        const logoutUrl = `${authDomain}/logout?client_id=${encodeURIComponent(clientId)}&logout_uri=${encodeURIComponent(redirectUri)}`;
        window.location.assign(logoutUrl);
      }
    },
  };
}
