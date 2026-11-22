import type { AuthHandler } from "./auth";
import type { CostSummary, ItemDetail, ItemSummary, RestoreState } from "./types";

export type { AuthHandler } from "./auth";

export class UnauthorizedError extends Error {
  constructor(message = "Session expired. Redirecting to login...") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export type ApiClientOptions = {
  baseUrl?: string;
  auth: AuthHandler;
  fetchFn?: typeof fetch;
};

export interface ApiClient {
  listItems(): Promise<ItemSummary[]>;
  getItem(id: string): Promise<ItemDetail>;
  getPreviewUrl(id: string, index: number): Promise<{ url: string }>;
  restoreItem(id: string, tier: "Bulk" | "Standard"): Promise<{ restore: RestoreState }>;
  getDownloadUrl(
    id: string,
  ): Promise<
    | { status: "ready"; url: string; restore: RestoreState }
    | { status: "not-ready"; restore: RestoreState }
  >;
  dryRunDelete(id: string): Promise<{ charge: number }>;
  confirmDelete(id: string): Promise<{ deleted: string; charge: number }>;
  getCosts(): Promise<CostSummary>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = (options.baseUrl ?? (import.meta.env.VITE_API_URL || "")).replace(/\/$/, "");
  const { auth } = options;
  const fetchFn = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  let renewInFlight: Promise<string | null> | null = null;
  let redirectInFlight: Promise<void> | null = null;

  function triggerSilentRenew(): Promise<string | null> {
    if (!renewInFlight) {
      renewInFlight = auth.silentRenew().finally(() => {
        renewInFlight = null;
      });
    }
    return renewInFlight;
  }

  function triggerLoginRedirect(): Promise<void> {
    if (!redirectInFlight) {
      redirectInFlight = auth.loginRedirect().finally(() => {
        redirectInFlight = null;
      });
    }
    return redirectInFlight;
  }

  async function requestWithAuth(path: string, init?: RequestInit): Promise<Response> {
    let token = await auth.getAccessToken();
    if (!token) {
      token = await triggerSilentRenew();
      if (!token) {
        await triggerLoginRedirect();
        throw new UnauthorizedError();
      }
    }

    const doFetch = (bearer: string) => {
      const headers: Record<string, string> = {
        ...(init?.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${bearer}`,
      };
      if (init?.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      return fetchFn(`${baseUrl}${path}`, {
        ...init,
        headers,
      });
    };

    let res = await doFetch(token);
    if (res.status === 401) {
      const renewedToken = await triggerSilentRenew();
      if (!renewedToken) {
        await triggerLoginRedirect();
        throw new UnauthorizedError();
      }
      res = await doFetch(renewedToken);
      if (res.status === 401) {
        await triggerLoginRedirect();
        throw new UnauthorizedError();
      }
    }

    return res;
  }

  return {
    async listItems(): Promise<ItemSummary[]> {
      const res = await requestWithAuth("/items");
      if (!res.ok) {
        throw new Error(`Failed to fetch items (${res.status})`);
      }
      return (await res.json()) as ItemSummary[];
    },

    async getItem(id: string): Promise<ItemDetail> {
      const res = await requestWithAuth(`/items/${encodeURIComponent(id)}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch item ${id} (${res.status})`);
      }
      return (await res.json()) as ItemDetail;
    },

    async getPreviewUrl(id: string, index: number): Promise<{ url: string }> {
      const res = await requestWithAuth(`/items/${encodeURIComponent(id)}/preview/${index}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch preview ${index} (${res.status})`);
      }
      return (await res.json()) as { url: string };
    },

    async restoreItem(id: string, tier: "Bulk" | "Standard"): Promise<{ restore: RestoreState }> {
      const res = await requestWithAuth(`/items/${encodeURIComponent(id)}/restore`, {
        method: "POST",
        body: JSON.stringify({ tier }),
      });
      if (!res.ok) {
        throw new Error(`Failed to initiate restore (${res.status})`);
      }
      return (await res.json()) as { restore: RestoreState };
    },

    async getDownloadUrl(
      id: string,
    ): Promise<
      | { status: "ready"; url: string; restore: RestoreState }
      | { status: "not-ready"; restore: RestoreState }
    > {
      const res = await requestWithAuth(`/items/${encodeURIComponent(id)}/download`);
      if (res.status === 409) {
        const body = (await res.json()) as { restore: RestoreState };
        return { status: "not-ready", restore: body.restore };
      }
      if (!res.ok) {
        throw new Error(`Failed to get download URL (${res.status})`);
      }
      const body = (await res.json()) as { url: string; restore: RestoreState };
      return { status: "ready", url: body.url, restore: body.restore };
    },

    async dryRunDelete(id: string): Promise<{ charge: number }> {
      const res = await requestWithAuth(`/items/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.status === 409 || res.ok) {
        const record = body as { charge?: unknown; error?: unknown } | null;
        if (record && typeof record.charge === "number" && Number.isFinite(record.charge)) {
          return { charge: record.charge };
        }
        const errMsg =
          record && typeof record.error === "string" && record.error
            ? record.error
            : `Invalid early-delete response (${res.status}): missing numeric charge`;
        throw new Error(errMsg);
      }
      const errRecord = body as { error?: unknown } | null;
      const errDetail =
        errRecord && typeof errRecord.error === "string" && errRecord.error
          ? `: ${errRecord.error}`
          : "";
      throw new Error(`Failed to check early-delete charge (${res.status})${errDetail}`);
    },

    async confirmDelete(id: string): Promise<{ deleted: string; charge: number }> {
      const res = await requestWithAuth(`/items/${encodeURIComponent(id)}?confirm=true`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: unknown; remainingKeys?: unknown } | null = null;
        try {
          parsed = JSON.parse(text) as { error?: unknown; remainingKeys?: unknown };
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === "object") {
          const baseMsg =
            typeof parsed.error === "string" && parsed.error
              ? parsed.error
              : `Delete failed (${res.status})`;
          const remaining =
            Array.isArray(parsed.remainingKeys) && parsed.remainingKeys.length > 0
              ? ` (remainingKeys: ${parsed.remainingKeys.map(String).join(", ")})`
              : "";
          throw new Error(`${baseMsg}${remaining}`);
        }
        throw new Error(`Delete failed (${res.status}): ${text}`);
      }
      return (await res.json()) as { deleted: string; charge: number };
    },

    async getCosts(): Promise<CostSummary> {
      const res = await requestWithAuth("/costs");
      if (!res.ok) {
        throw new Error(`Failed to fetch costs (${res.status})`);
      }
      return (await res.json()) as CostSummary;
    },
  };
}
