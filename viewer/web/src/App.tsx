import { useCallback, useEffect, useMemo, useState } from "react";
import { createApiClient, UnauthorizedError, type ApiClient } from "./api";
import { createCognitoAuth, type AuthHandler } from "./auth";
import type { CostSummary, ItemSummary, RestoreState } from "./types";
import { CostPanel } from "./components/CostPanel";
import { ArchiveTable } from "./components/ArchiveTable";
import { ItemDrawer } from "./components/ItemDrawer";

export type AppProps = {
  api?: ApiClient;
  auth?: AuthHandler;
};

type ViewState = "initializing" | "redirecting" | "ready" | "error";

export function App({ api: providedApi, auth: providedAuth }: AppProps) {
  const auth = useMemo(() => providedAuth ?? createCognitoAuth(), [providedAuth]);
  const api = useMemo(
    () => providedApi ?? createApiClient({ auth }),
    [providedApi, auth],
  );

  const [viewState, setViewState] = useState<ViewState>("initializing");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [costs, setCosts] = useState<CostSummary | null>(null);
  const [selectedItem, setSelectedItem] = useState<ItemSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadArchiveData = useCallback(async () => {
    try {
      const [fetchedItems, fetchedCosts, email] = await Promise.all([
        api.listItems(),
        api.getCosts(),
        auth.getUserEmail(),
      ]);
      setItems(fetchedItems);
      setCosts(fetchedCosts);
      setUserEmail(email);
      setViewState("ready");
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError) {
        setViewState("redirecting");
        return;
      }
      setErrorMessage(err instanceof Error ? err.message : "Failed to load archive");
      setViewState("error");
    }
  }, [api, auth]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        await auth.handleCallbackIfPresent();
        if (cancelled) {
          return;
        }
        await loadArchiveData();
      } catch (err: unknown) {
        if (cancelled) {
          return;
        }
        if (err instanceof UnauthorizedError) {
          setViewState("redirecting");
          return;
        }
        setErrorMessage(err instanceof Error ? err.message : "Authentication error");
        setViewState("error");
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [auth, loadArchiveData]);

  function handleItemUpdated(id: string, restore: RestoreState) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, restore } : it)),
    );
  }

  function handleItemDeleted(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
    setSelectedItem((prev) => (prev && prev.id === id ? null : prev));
    void api
      .getCosts()
      .then((updatedCosts) => setCosts(updatedCosts))
      .catch(() => {
        // ignore cost refresh errors
      });
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <h1 className="brand-title">Cold Archive</h1>
          <span className="brand-subtitle">S3 Glacier Deep Archive</span>
        </div>
        <div className="header-actions">
          {userEmail && <span className="user-email">{userEmail}</span>}
          {viewState === "ready" && (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void loadArchiveData()}
              >
                Refresh
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void auth.logout()}
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </header>

      <main className="app-main">
        {viewState === "initializing" && (
          <div className="state-banner">Loading archive…</div>
        )}

        {viewState === "redirecting" && (
          <div className="state-banner">
            <p>Session expired or unauthenticated. Redirecting to login…</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void auth.loginRedirect()}
            >
              Sign in with Cognito
            </button>
          </div>
        )}

        {viewState === "error" && (
          <div className="state-banner state-error" role="alert">
            <p>{errorMessage || "Unable to load Cold Archive."}</p>
            <div className="banner-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void loadArchiveData()}
              >
                Retry
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void auth.loginRedirect()}
              >
                Sign in again
              </button>
            </div>
          </div>
        )}

        {viewState === "ready" && (
          <>
            <CostPanel costs={costs} />
            <div className={`workspace${selectedItem ? " with-drawer" : ""}`}>
              <ArchiveTable
                items={items}
                selectedId={selectedItem?.id ?? null}
                onSelectItem={(item) => setSelectedItem(item)}
              />
              {selectedItem && (
                <ItemDrawer
                  item={selectedItem}
                  api={api}
                  onClose={() => setSelectedItem(null)}
                  onItemUpdated={handleItemUpdated}
                  onItemDeleted={handleItemDeleted}
                />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
