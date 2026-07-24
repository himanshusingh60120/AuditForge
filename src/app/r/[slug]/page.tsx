"use client";
import { useEffect, useState } from "react";
import Report from "@/components/Report";
import { AuditState } from "@/lib/schema";
import { analyzeUrlHygiene, diffSitemap, HygieneFinding, SitemapDiff } from "@/lib/modules";

export default function SharedReport({ params }: { params: { slug: string } }) {
  const [audit, setAudit] = useState<AuditState | null>(null);
  const [hygiene, setHygiene] = useState<HygieneFinding[]>([]);
  const [sitemapDiff, setSitemapDiff] = useState<SitemapDiff | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/reports?slug=${encodeURIComponent(params.slug)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Report unavailable");
        const parsed = data as AuditState;
        setAudit(parsed);
        setHygiene(analyzeUrlHygiene(parsed.rows));
        if (parsed.sitemapUrls?.length > 0)
          setSitemapDiff(diffSitemap(parsed.sitemapUrls, parsed.rows, parsed.gsc));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load report");
      }
    })();
  }, [params.slug]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8">
        <h1 className="font-mono text-2xl tracking-tight text-slate-100">
          Audit<span className="text-forge">Forge</span> <span className="text-sm text-steel">· shared report</span>
        </h1>
      </header>
      {error && <p className="rounded border border-ember/50 bg-ember/10 px-3 py-2 text-sm text-ember">{error}</p>}
      {!audit && !error && <p className="font-mono text-sm text-steel">Loading report…</p>}
      {audit && (
        <Report
          audit={audit}
          sitemapDiff={sitemapDiff}
          hygiene={hygiene}
          delta={null}
          psi={[]}
          psiError=""
          moduleNotes={[]}
          readOnly
        />
      )}
    </main>
  );
}
