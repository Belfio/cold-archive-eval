import { useEffect, useMemo, useRef, useState } from "react";
import { decompressGzipText } from "../utils/gzip";

const ROW_HEIGHT = 32;
const VIEWPORT_HEIGHT = 384;
const OVERSCAN = 5;

export type TsvPreviewProps = {
  tsvText?: string;
  url?: string;
  fetchFn?: typeof fetch;
};

export function TsvPreview({ tsvText, url, fetchFn }: TsvPreviewProps) {
  const [loadedText, setLoadedText] = useState<string | null>(tsvText ?? null);
  const [loading, setLoading] = useState<boolean>(!tsvText && Boolean(url));
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (tsvText !== undefined) {
      setLoadedText(tsvText);
      setLoading(false);
      return;
    }
    if (!url) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const doFetch = fetchFn ?? ((input: RequestInfo | URL) => fetch(input));
    doFetch(url)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to load TSV preview (${res.status})`);
        }
        const buf = await res.arrayBuffer();
        return decompressGzipText(buf);
      })
      .then((text) => {
        if (!cancelled) {
          setLoadedText(text);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load TSV preview");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tsvText, url, fetchFn]);

  const { headers, dataLines } = useMemo(() => {
    if (!loadedText) {
      return { headers: [] as string[], dataLines: [] as string[] };
    }
    const rawLines = loadedText.split(/\r?\n/);
    while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
      rawLines.pop();
    }
    if (rawLines.length === 0) {
      return { headers: [] as string[], dataLines: [] as string[] };
    }
    const firstHeader = rawLines[0].split("\t");
    return {
      headers: firstHeader,
      dataLines: rawLines.slice(1),
    };
  }, [loadedText]);

  const filteredLines = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return dataLines;
    }
    const matches: string[] = [];
    for (let i = 0; i < dataLines.length; i++) {
      const line = dataLines[i];
      if (line.toLowerCase().includes(q)) {
        matches.push(line);
      }
    }
    return matches;
  }, [dataLines, query]);

  useEffect(() => {
    setScrollTop(0);
    if (viewportRef.current) {
      viewportRef.current.scrollTop = 0;
    }
  }, [query, filteredLines]);

  if (loading) {
    return <div className="preview-status">Decompressing TSV index…</div>;
  }

  if (error) {
    return <div className="preview-error">{error}</div>;
  }

  const totalRows = filteredLines.length;
  const totalHeight = totalRows * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(totalRows, startIndex + visibleCount);
  const topSpacerHeight = startIndex * ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, totalHeight - endIndex * ROW_HEIGHT);

  const visibleSlice = filteredLines.slice(startIndex, endIndex);
  const colCount = Math.max(1, headers.length);

  return (
    <div className="tsv-preview">
      <div className="tsv-toolbar">
        <input
          type="search"
          className="control-input tsv-search"
          placeholder="Search or filter TSV rows…"
          aria-label="Filter TSV rows"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setScrollTop(0);
          }}
        />
        <span className="tsv-count">
          {totalRows.toLocaleString("en-US")} rows
          {query.trim() ? ` (of ${dataLines.length.toLocaleString("en-US")})` : ""}
        </span>
      </div>

      <div
        ref={viewportRef}
        className="tsv-viewport"
        style={{ height: `${VIEWPORT_HEIGHT}px`, overflowY: "auto" }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <table className="tsv-table">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topSpacerHeight > 0 && (
              <tr aria-hidden="true" style={{ height: `${topSpacerHeight}px` }}>
                <td colSpan={colCount} style={{ padding: 0, border: 0 }} />
              </tr>
            )}
            {visibleSlice.map((line, idx) => {
              const rowIndex = startIndex + idx;
              const cells = line.split("\t");
              return (
                <tr
                  key={rowIndex}
                  data-row-index={rowIndex}
                  style={{ height: `${ROW_HEIGHT}px` }}
                >
                  {headers.map((_, colIdx) => (
                    <td key={colIdx}>{cells[colIdx] ?? ""}</td>
                  ))}
                </tr>
              );
            })}
            {bottomSpacerHeight > 0 && (
              <tr aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }}>
                <td colSpan={colCount} style={{ padding: 0, border: 0 }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
