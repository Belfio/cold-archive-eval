import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { gzipSync } from "node:zlib";
import { App } from "./App";
import { TsvPreview } from "./components/TsvPreview";
import { TarPreview } from "./components/TarPreview";
import { DeleteDialog } from "./components/DeleteDialog";
import { parseTar } from "./utils/tar";
import { createApiClient, type AuthHandler } from "./api";
import type { ItemSummary } from "./types";

const SAMPLE_ITEM: ItemSummary = {
  id: "screen-recording-2026-06-14",
  kind: "video",
  name: "Screen Recording 2026-06-14 at 15.06.00.mov",
  bytes: 3800970978,
  uploadedAt: "2026-11-15T00:09:01+00:00",
  minStorageUntil: "2027-05-14",
  estMonthlyUsd: 0.0059,
  verified: true,
  localDeleted: false,
  previews: [
    {
      key: "previews/2026/11/screen-recording-2026-06-14/screen-recording-2026-06-14.preview.mp4",
      bytes: 105111076,
      contentType: "video/mp4",
    },
    {
      key: "previews/2026/11/screen-recording-2026-06-14/screen-recording-2026-06-14.poster.jpg",
      bytes: 19935,
      contentType: "image/jpeg",
    },
  ],
  originalKey:
    "originals/2026/11/screen-recording-2026-06-14/Screen Recording 2026-06-14 at 15.06.00.mov",
  restore: { status: "none" },
  tags: ["desktop", "recording"],
  note: "Screen capture session",
};

describe("401 handling", () => {
  it("silently renews token on 401 and retries request without showing empty archive", async () => {
    let token = "expired-token";
    const silentRenew = vi.fn(async () => {
      token = "renewed-token";
      return token;
    });
    const loginRedirect = vi.fn(async () => {});

    const auth: AuthHandler = {
      getAccessToken: async () => token,
      getUserEmail: async () => "owner@example.com",
      handleCallbackIfPresent: async () => false,
      silentRenew,
      loginRedirect,
      logout: async () => {},
    };

    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (authHeader === "Bearer expired-token") {
        return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
      }
      if (url.endsWith("/items")) {
        return new Response(JSON.stringify([SAMPLE_ITEM]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/costs")) {
        return new Response(
          JSON.stringify({
            items: 1,
            storedBytes: SAMPLE_ITEM.bytes,
            previewBytes: 105131011,
            monthlyUsd: 0.0087,
            bytesFreed: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const api = createApiClient({
      baseUrl: "https://api.example.com",
      auth,
      fetchFn,
    });

    render(<App api={api} auth={auth} />);

    await waitFor(() => {
      expect(
        screen.getByText("Screen Recording 2026-06-14 at 15.06.00.mov"),
      ).toBeInTheDocument();
    });

    expect(silentRenew).toHaveBeenCalledTimes(1);
    expect(loginRedirect).not.toHaveBeenCalled();
  });

  it("redirects to login when silent renew fails on 401 and never shows empty archive", async () => {
    const silentRenew = vi.fn(async () => null);
    const loginRedirect = vi.fn(async () => {});

    const auth: AuthHandler = {
      getAccessToken: async () => "expired-token",
      getUserEmail: async () => "owner@example.com",
      handleCallbackIfPresent: async () => false,
      silentRenew,
      loginRedirect,
      logout: async () => {},
    };

    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
    });

    const api = createApiClient({
      baseUrl: "https://api.example.com",
      auth,
      fetchFn,
    });

    render(<App api={api} auth={auth} />);

    await waitFor(() => {
      expect(loginRedirect).toHaveBeenCalledTimes(1);
    });

    expect(silentRenew).toHaveBeenCalled();
    expect(screen.queryByText(/no archived items/i)).not.toBeInTheDocument();
    expect(screen.getByText(/redirecting to login/i)).toBeInTheDocument();
  });
});

describe("Cost panel, Archive table search/filter/sort, and ItemDrawer", () => {
  it("displays cost metrics, filters/sorts archive rows, and opens item drawer with restore/download actions", async () => {
    const secondItem: ItemSummary = {
      ...SAMPLE_ITEM,
      id: "takeout-mail-2026",
      kind: "mbox",
      name: "All mail Including Spam and Trash.mbox",
      bytes: 9800000000,
      uploadedAt: "2026-11-10T00:00:00+00:00",
      minStorageUntil: "2027-05-09",
      estMonthlyUsd: 0.0165,
      verified: true,
      localDeleted: true,
      previews: [],
      restore: { status: "ready", expiresAt: "2026-11-22T00:00:00Z" },
      tags: ["gmail", "backup"],
      note: "Full Gmail mbox export",
    };

    const auth: AuthHandler = {
      getAccessToken: async () => "valid-token",
      getUserEmail: async () => "owner@example.com",
      handleCallbackIfPresent: async () => false,
      silentRenew: async () => "valid-token",
      loginRedirect: async () => {},
      logout: async () => {},
    };

    const restoreSpy = vi.fn(async () => ({
      restore: { status: "in-progress" as const },
    }));

    const api = {
      listItems: vi.fn(async () => [SAMPLE_ITEM, secondItem]),
      getItem: vi.fn(async (id: string) =>
        id === secondItem.id ? secondItem : SAMPLE_ITEM,
      ),
      getPreviewUrl: vi.fn(async () => ({ url: "https://s3.example.com/preview" })),
      restoreItem: restoreSpy,
      getDownloadUrl: vi.fn(async () => ({
        status: "ready" as const,
        url: "https://s3.example.com/download",
        restore: { status: "ready" as const },
      })),
      dryRunDelete: vi.fn(async () => ({ charge: 0.0123 })),
      confirmDelete: vi.fn(async (id: string) => ({ deleted: id, charge: 0.0123 })),
      getCosts: vi.fn(async () => ({
        items: 2,
        storedBytes: SAMPLE_ITEM.bytes + secondItem.bytes,
        previewBytes: 105131011,
        monthlyUsd: 0.0252,
        bytesFreed: secondItem.bytes,
      })),
    };

    render(<App api={api} auth={auth} />);

    await waitFor(() => {
      expect(screen.getByText(SAMPLE_ITEM.name)).toBeInTheDocument();
      expect(screen.getByText(secondItem.name)).toBeInTheDocument();
    });

    // Cost panel displays formatted values
    expect(screen.getByText("$0.0252/mo")).toBeInTheDocument();

    // Filter by kind
    const kindSelect = screen.getByLabelText("Filter by kind");
    fireEvent.change(kindSelect, { target: { value: "mbox" } });
    expect(screen.queryByText(SAMPLE_ITEM.name)).not.toBeInTheDocument();
    expect(screen.getByText(secondItem.name)).toBeInTheDocument();

    // Reset kind filter & search by tag
    fireEvent.change(kindSelect, { target: { value: "all" } });
    const searchInput = screen.getByLabelText("Search archived items");
    fireEvent.change(searchInput, { target: { value: "desktop" } });
    expect(screen.getByText(SAMPLE_ITEM.name)).toBeInTheDocument();
    expect(screen.queryByText(secondItem.name)).not.toBeInTheDocument();

    // Click row to open ItemDrawer and initiate restore
    fireEvent.click(screen.getByText(SAMPLE_ITEM.name));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /initiate restore/i })).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(api.getItem).toHaveBeenCalledTimes(1);
      expect(api.getPreviewUrl).toHaveBeenCalledTimes(2);
    });

    // Item 6: Video preview uses the image as poster and does not render a duplicate <img> block
    const videoEl = document.querySelector("video.preview-video");
    expect(videoEl).not.toBeNull();
    expect(document.querySelector("img.preview-image")).toBeNull();

    // Item 2: Restore updates state without re-running drawer load effect or clearing actionMessage
    fireEvent.click(screen.getByRole("button", { name: /initiate restore/i }));
    await waitFor(() => {
      expect(restoreSpy).toHaveBeenCalledWith(SAMPLE_ITEM.id, "Bulk");
      expect(screen.getByText("Restore requested (Bulk tier).")).toBeInTheDocument();
    });
    expect(api.getItem).toHaveBeenCalledTimes(1);
    expect(api.getPreviewUrl).toHaveBeenCalledTimes(2);
  });
});

describe("TSV preview virtualisation (100k rows)", () => {
  it("renders 100k synthetic rows in < 1s, virtualises DOM nodes, and filters rows", async () => {
    const rowCount = 100_000;
    const lines = new Array<string>(rowCount + 1);
    lines[0] = "date\tfrom\tto\tsubject\tgmail_labels\tbytes";
    for (let i = 1; i <= rowCount; i++) {
      lines[i] = `2026-01-01\tsender${i}@example.com\tme@example.com\tMessage subject ${i}\tInbox\t${i * 100}`;
    }
    lines[54321] =
      "2026-11-14\tspecial-needle@example.com\tme@example.com\tUnique Needle Subject 54321\tImportant\t9999";
    const rawTsv = lines.join("\n");

    const start = performance.now();
    const { container } = render(<TsvPreview tsvText={rawTsv} />);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    expect(screen.getByText(/100,000 rows/i)).toBeInTheDocument();
    expect(screen.getByText("sender1@example.com")).toBeInTheDocument();

    // Virtualised: only a small window of rows is mounted in the DOM
    const renderedRows = container.querySelectorAll("tbody tr[data-row-index]");
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(100);

    // Scroll down first, then filter: viewport DOM scrollTop must reset to 0
    const viewport = container.querySelector(".tsv-viewport") as HTMLDivElement;
    viewport.scrollTop = 1600;
    fireEvent.scroll(viewport);
    expect(viewport.scrollTop).toBe(1600);

    // Filter down to the needle row
    const searchInput = screen.getByPlaceholderText(/search|filter/i);
    fireEvent.change(searchInput, { target: { value: "special-needle@example.com" } });

    await waitFor(() => {
      expect(screen.getByText("Unique Needle Subject 54321")).toBeInTheDocument();
    });
    expect(viewport.scrollTop).toBe(0);
    expect(screen.queryByText("sender1@example.com")).not.toBeInTheDocument();
  });

  it("decompresses gzipped TSV via DecompressionStream('gzip')", async () => {
    const sampleTsv = "path\tbytes\tmtime\nphotos/img1.jpg\t12345\t2026-10-25T18:59:00\n";
    const compressed = gzipSync(Buffer.from(sampleTsv, "utf-8"));

    const fetchFn = vi.fn(async () => new Response(compressed, { status: 200 }));

    render(<TsvPreview url="https://s3.example.com/preview.tsv.gz" fetchFn={fetchFn} />);

    await waitFor(() => {
      expect(screen.getByText("photos/img1.jpg")).toBeInTheDocument();
    });
    expect(screen.getByText("12345")).toBeInTheDocument();
  });
});

describe("DeleteDialog", () => {
  it("fetches 409 dry-run early-delete charge, shows charge, and requires typing item id/name before enabling confirm", async () => {
    let resolveDryRun!: (val: { charge: number }) => void;
    const dryRunPromise = new Promise<{ charge: number }>((res) => {
      resolveDryRun = res;
    });

    const dryRunDelete = vi.fn(() => dryRunPromise);
    const confirmDelete = vi.fn(async () => ({
      deleted: SAMPLE_ITEM.id,
      charge: 0.0342,
    }));
    const onDeleted = vi.fn();
    const onClose = vi.fn();

    render(
      <DeleteDialog
        item={SAMPLE_ITEM}
        onDryRunDelete={dryRunDelete}
        onConfirmDelete={confirmDelete}
        onDeleted={onDeleted}
        onClose={onClose}
      />,
    );

    expect(dryRunDelete).toHaveBeenCalledWith(SAMPLE_ITEM.id);

    const confirmBtn = screen.getByRole("button", { name: /delete permanently|confirm delete/i });
    const input = screen.getByRole("textbox");

    // Even if user types the ID before the 409 dry-run resolves, confirm remains disabled
    fireEvent.change(input, { target: { value: SAMPLE_ITEM.id } });
    expect(confirmBtn).toBeDisabled();

    // Resolve the 409 dry-run response
    resolveDryRun({ charge: 0.0342 });

    await waitFor(() => {
      expect(screen.getByText(/\$0\.0342/)).toBeInTheDocument();
    });

    // Now that charge is shown and input matches item.id, confirm button is enabled
    expect(confirmBtn).not.toBeDisabled();

    // Typing wrong text disables confirm button
    fireEvent.change(input, { target: { value: "wrong-item" } });
    expect(confirmBtn).toBeDisabled();

    // Typing item name does NOT enable confirm button (must match item.id exactly)
    fireEvent.change(input, { target: { value: SAMPLE_ITEM.name } });
    expect(confirmBtn).toBeDisabled();

    // Empty input never enables confirm button
    fireEvent.change(input, { target: { value: "" } });
    expect(confirmBtn).toBeDisabled();

    // Typing item id enables confirm button and triggers confirmDelete on click
    fireEvent.change(input, { target: { value: SAMPLE_ITEM.id } });
    expect(confirmBtn).not.toBeDisabled();

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(confirmDelete).toHaveBeenCalledWith(SAMPLE_ITEM.id);
      expect(onDeleted).toHaveBeenCalledWith(SAMPLE_ITEM.id);
    });
  });

  it("validates numeric charge in dryRunDelete and parses JSON errors in confirmDelete", async () => {
    const auth: AuthHandler = {
      getAccessToken: async () => "valid-token",
      getUserEmail: async () => "owner@example.com",
      handleCallbackIfPresent: async () => false,
      silentRenew: async () => "valid-token",
      loginRedirect: async () => {},
      logout: async () => {},
    };

    const fetchInvalidCharge = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Item is locked" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    const apiInvalidCharge = createApiClient({
      baseUrl: "https://api.example.com",
      auth,
      fetchFn: fetchInvalidCharge,
    });
    await expect(apiInvalidCharge.dryRunDelete("item-1")).rejects.toThrow("Item is locked");

    const fetchMissingCharge = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const apiMissingCharge = createApiClient({
      baseUrl: "https://api.example.com",
      auth,
      fetchFn: fetchMissingCharge,
    });
    await expect(apiMissingCharge.dryRunDelete("item-1")).rejects.toThrow(/missing numeric charge/i);

    const fetch409Confirm = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Invalid originalKey for item-1" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    const api409Confirm = createApiClient({
      baseUrl: "https://api.example.com",
      auth,
      fetchFn: fetch409Confirm,
    });
    await expect(api409Confirm.confirmDelete("item-1")).rejects.toThrow(
      "Invalid originalKey for item-1",
    );

    const fetch502 = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "S3 InternalError",
            remainingKeys: ["previews/2026/11/item-1/a.jpg", "manifest/item-1.json"],
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        ),
    );
    const api502 = createApiClient({
      baseUrl: "https://api.example.com",
      auth,
      fetchFn: fetch502,
    });
    await expect(api502.confirmDelete("item-1")).rejects.toThrow(
      /S3 InternalError.*remainingKeys: previews\/2026\/11\/item-1\/a\.jpg, manifest\/item-1\.json/,
    );
  });
});

describe("Tar reader and TarPreview", () => {
  it("lists entries from a tar archive and identifies JPEG thumbnails", () => {
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const tar = new Uint8Array(1536); // 512 header + 512 data + 512 zero EOF
    const encoder = new TextEncoder();
    tar.set(encoder.encode("album/thumb1.jpg"), 0);
    tar.set(encoder.encode(jpegBytes.length.toString(8).padStart(11, "0") + "\0"), 124);
    tar[156] = "0".charCodeAt(0);
    tar.set(jpegBytes, 512);

    const entries = parseTar(tar);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("album/thumb1.jpg");
    expect(entries[0].size).toBe(jpegBytes.length);
    expect(entries[0].isJpeg).toBe(true);
    expect(Array.from(entries[0].data)).toEqual(Array.from(jpegBytes));
  });

  it("caps rendered thumbnails at 120 and revokes object URLs created after unmount", async () => {
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const count = 130;
    const tar = new Uint8Array((count * 2 + 1) * 512);
    const encoder = new TextEncoder();
    for (let i = 0; i < count; i++) {
      const headerOffset = i * 1024;
      tar.set(encoder.encode(`album/thumb-${i + 1}.jpg`), headerOffset);
      tar.set(
        encoder.encode(jpegBytes.length.toString(8).padStart(11, "0") + "\0"),
        headerOffset + 124,
      );
      tar[headerOffset + 156] = "0".charCodeAt(0);
      tar.set(jpegBytes, headerOffset + 512);
    }

    const { container, unmount } = render(<TarPreview tarData={tar} />);
    await waitFor(() => {
      expect(container.querySelectorAll(".tar-thumb-card img")).toHaveLength(120);
    });
    expect(screen.getByText(/showing first 120/i)).toBeInTheDocument();
    unmount();

    // Async fetch resolving after unmount must immediately revoke created object URLs
    let resolveFetch!: (res: Response) => void;
    const slowFetch = vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    );
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late-url");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const singleTar = tar.slice(0, 1536);
    const { unmount: unmountSlow } = render(
      <TarPreview url="https://s3.example.com/thumbs.tar" fetchFn={slowFetch} />,
    );
    unmountSlow();

    resolveFetch(new Response(singleTar, { status: 200 }));
    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalled();
    });

    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });
});
