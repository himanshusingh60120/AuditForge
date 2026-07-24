"use client";
import { useCallback, useRef, useState } from "react";

const ACCEPT = [".csv", ".xlsx", ".seospider", ".dbseospider"];
const MAX_BYTES = 500 * 1024 * 1024; // 500MB — dbseospider projects get big

export function validateCrawlFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!ACCEPT.some((ext) => name.endsWith(ext)))
    return `"${file.name}" isn't an accepted format. Upload ${ACCEPT.join(", ")}.`;
  if (file.size > MAX_BYTES) return `"${file.name}" exceeds the 500MB limit.`;
  if (file.size === 0) return `"${file.name}" is empty.`;
  return null;
}

interface Props {
  onCrawlFile: (f: File) => void;
  onInlinksFile: (f: File) => void;
  onGscFile: (f: File) => void;
  onSitemapUrl: (u: string) => void;
  onPreviousAudit: (f: File) => void;
  busy: boolean;
  gscStatus: "unknown" | "unconfigured" | "disconnected" | "connected";
  gscSites: string[];
  gscSite: string;
  onGscConnect: () => void;
  onGscSelect: (site: string) => void;
  onGscDisconnect: () => void;
}

export default function Upload({
  onCrawlFile,
  onInlinksFile,
  onGscFile,
  onSitemapUrl,
  onPreviousAudit,
  busy,
  gscStatus,
  gscSites,
  gscSite,
  onGscConnect,
  onGscSelect,
  onGscDisconnect,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [sitemap, setSitemap] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File | undefined | null) => {
      if (!file) return;
      const err = validateCrawlFile(file);
      if (err) {
        setError(err);
        return;
      }
      setError("");
      onCrawlFile(file);
    },
    [onCrawlFile]
  );

  return (
    <div className="space-y-6">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload Screaming Frog crawl file"
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFile(e.dataTransfer.files?.[0]);
        }}
        className={`cursor-pointer rounded-lg border-2 border-dashed px-8 py-14 text-center transition ${
          dragging ? "border-forge bg-forge/5" : "border-edge bg-panel/50 hover:border-steel"
        } ${busy ? "pointer-events-none opacity-50" : ""}`}
      >
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-forge">crawl input</p>
        <p className="mt-3 text-lg">Drop your Screaming Frog crawl here</p>
        <p className="mt-2 text-sm text-steel">
          .csv / .xlsx (&quot;Internal: All&quot; export — fully supported) · .seospider / .dbseospider (best-effort)
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT.join(",")}
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>
      {error && (
        <p role="alert" className="rounded border border-ember/50 bg-ember/10 px-3 py-2 text-sm text-ember">
          {error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="rounded border border-edge bg-panel/50 p-3 text-sm">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-steel">
            optional · All Inlinks export
          </span>
          <span className="mt-1 block text-xs text-steel">
            Unlocks link-equity modeling (Module D). Needed for CSV/XLSX crawls — &quot;Internal: All&quot; has inlink
            counts only, not the link graph. For .dbseospider projects we try to read the edges automatically.
          </span>
          <input
            type="file"
            accept=".csv"
            disabled={busy}
            className="mt-2 block w-full text-xs file:mr-2 file:rounded file:border file:border-edge file:bg-ink file:px-2 file:py-1 file:text-xs file:text-slate-300"
            onChange={(e) => e.target.files?.[0] && onInlinksFile(e.target.files[0])}
          />
        </label>
        <div className="rounded border border-edge bg-panel/50 p-3 text-sm">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-steel">
            google search console — automatic
          </span>
          {gscStatus === "connected" ? (
            <>
              <span className="mt-1 block text-xs text-verdant">
                ✓ Connected. Pick the property — clicks/impressions are pulled automatically during every audit.
              </span>
              <div className="mt-2 flex gap-2">
                <select
                  aria-label="GSC property"
                  value={gscSite}
                  disabled={busy}
                  onChange={(e) => onGscSelect(e.target.value)}
                  className="w-full rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-200"
                >
                  <option value="">Auto-match property to crawl domain</option>
                  {gscSites.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn text-xs" onClick={onGscDisconnect} disabled={busy}>
                  Disconnect
                </button>
              </div>
            </>
          ) : gscStatus === "unconfigured" ? (
            <span className="mt-1 block text-xs text-steel">
              OAuth keys not set on this deployment (see README). Fallback: upload the Search Console
              Performance → Pages CSV below.
            </span>
          ) : (
            <>
              <span className="mt-1 block text-xs text-steel">
                Connect once — every audit then pulls clicks/impressions per URL automatically. Unlocks
                traffic-weighted Impact Scores &amp; money leaks.
              </span>
              <button type="button" className="btn mt-2 text-xs" onClick={onGscConnect} disabled={busy || gscStatus === "unknown"}>
                Connect Google Search Console
              </button>
            </>
          )}
          {gscStatus !== "connected" && (
            <input
              type="file"
              accept=".csv"
              disabled={busy}
              aria-label="GSC Pages CSV fallback"
              className="mt-2 block w-full text-xs file:mr-2 file:rounded file:border file:border-edge file:bg-ink file:px-2 file:py-1 file:text-xs file:text-slate-300"
              onChange={(e) => e.target.files?.[0] && onGscFile(e.target.files[0])}
            />
          )}
        </div>
        <label className="rounded border border-edge bg-panel/50 p-3 text-sm">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-steel">optional · sitemap URL</span>
          <div className="mt-2 flex gap-2">
            <input
              type="url"
              placeholder="https://example.com/sitemap.xml"
              value={sitemap}
              disabled={busy}
              onChange={(e) => setSitemap(e.target.value)}
              className="w-full rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-200 placeholder:text-steel/50"
            />
            <button
              type="button"
              className="btn text-xs"
              disabled={busy || !/^https?:\/\//.test(sitemap)}
              onClick={() => onSitemapUrl(sitemap)}
            >
              Add
            </button>
          </div>
        </label>
        <label className="rounded border border-edge bg-panel/50 p-3 text-sm">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-steel">
            optional · previous audit (.json)
          </span>
          <span className="mt-1 block text-xs text-steel">Unlocks delta report: new / fixed / regressed (Module F)</span>
          <input
            type="file"
            accept=".json"
            disabled={busy}
            className="mt-2 block w-full text-xs file:mr-2 file:rounded file:border file:border-edge file:bg-ink file:px-2 file:py-1 file:text-xs file:text-slate-300"
            onChange={(e) => e.target.files?.[0] && onPreviousAudit(e.target.files[0])}
          />
        </label>
      </div>
    </div>
  );
}
