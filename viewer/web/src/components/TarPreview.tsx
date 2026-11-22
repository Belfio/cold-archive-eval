import { useEffect, useState } from "react";
import { parseTar, type TarEntry } from "../utils/tar";
import { formatBytes } from "../utils/format";

export type TarPreviewProps = {
  url?: string;
  tarData?: Uint8Array | ArrayBuffer;
  fetchFn?: typeof fetch;
};

type RenderedEntry = TarEntry & {
  objectUrl?: string;
};

function bytesToDataUrl(data: Uint8Array, mime: string): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

const MAX_THUMBNAILS = 120;

export function TarPreview({ url, tarData, fetchFn }: TarPreviewProps) {
  const [entries, setEntries] = useState<RenderedEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(!tarData && Boolean(url));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];

    function revokeCreatedUrls() {
      for (const u of createdUrls) {
        URL.revokeObjectURL(u);
      }
      createdUrls.length = 0;
    }

    function hydrateEntries(raw: ArrayBuffer | Uint8Array) {
      const parsed = parseTar(raw);
      let jpegCount = 0;
      const withUrls: RenderedEntry[] = parsed.map((entry) => {
        if (!entry.isJpeg) {
          return entry;
        }
        jpegCount += 1;
        if (jpegCount > MAX_THUMBNAILS) {
          return entry;
        }
        if (typeof URL.createObjectURL === "function") {
          try {
            const blob = new Blob([entry.data as unknown as BlobPart], { type: "image/jpeg" });
            const objUrl = URL.createObjectURL(blob);
            createdUrls.push(objUrl);
            return { ...entry, objectUrl: objUrl };
          } catch {
            return { ...entry, objectUrl: bytesToDataUrl(entry.data, "image/jpeg") };
          }
        }
        return { ...entry, objectUrl: bytesToDataUrl(entry.data, "image/jpeg") };
      });

      if (cancelled) {
        revokeCreatedUrls();
        return;
      }

      setEntries(withUrls);
      setLoading(false);
    }

    if (tarData) {
      hydrateEntries(tarData);
      return () => {
        cancelled = true;
        revokeCreatedUrls();
      };
    }

    if (!url) {
      return;
    }

    setLoading(true);
    setError(null);

    const doFetch = fetchFn ?? ((input: RequestInfo | URL) => fetch(input));
    doFetch(url)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to fetch tar preview (${res.status})`);
        }
        return res.arrayBuffer();
      })
      .then((buf) => {
        hydrateEntries(buf);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load tar preview");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      revokeCreatedUrls();
    };
  }, [url, tarData, fetchFn]);

  if (loading) {
    return <div className="preview-status">Loading thumbnail archive…</div>;
  }

  if (error) {
    return <div className="preview-error">{error}</div>;
  }

  if (entries.length === 0) {
    return <div className="preview-status">No entries found in tar archive.</div>;
  }

  const totalJpegs = entries.filter((e) => e.isJpeg).length;
  const jpegs = entries.filter((e) => e.isJpeg && e.objectUrl).slice(0, MAX_THUMBNAILS);

  return (
    <div className="tar-preview">
      <div className="tar-summary">
        {entries.length} {entries.length === 1 ? "entry" : "entries"} in tar archive (
        {totalJpegs} {totalJpegs === 1 ? "thumbnail" : "thumbnails"}
        {totalJpegs > MAX_THUMBNAILS ? `, showing first ${MAX_THUMBNAILS}` : ""})
      </div>

      {jpegs.length > 0 && (
        <div className="tar-grid">
          {jpegs.map((entry, idx) => (
            <figure key={`${entry.name}-${idx}`} className="tar-thumb-card">
              <img src={entry.objectUrl} alt={entry.name} loading="lazy" />
              <figcaption title={entry.name}>
                <span className="tar-thumb-name">{entry.name.split("/").pop() || entry.name}</span>
                <span className="tar-thumb-size">{formatBytes(entry.size)}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <details className="tar-entry-list">
        <summary>All tar entries ({entries.length})</summary>
        <ul>
          {entries.map((entry, idx) => (
            <li key={`${entry.name}-${idx}`}>
              <span className="mono">{entry.name}</span>
              <span className="mono">{formatBytes(entry.size)}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
