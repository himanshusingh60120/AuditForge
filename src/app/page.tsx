"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Upload from "@/components/Upload";
import Pipeline, { Stage } from "@/components/Pipeline";
import Report, { PsiResult } from "@/components/Report";
import LiveFindings, { emptyLiveStats, LiveStats } from "@/components/LiveFindings";
import { downloadConverterBat } from "@/lib/converter-bat";
import { InlinkEdge, MAX_INLINK_EDGES, parseAllInlinksCsv, parseCrawlFile, parseGscPagesCsv } from "@/lib/parse";
import { detectIssues } from "@/lib/detect";
import {
  computeDelta,
  computeImpactScores,
  computePagerank,
  DeltaReport,
  healthScore,
} from "@/lib/analysis";
import { analyzeUrlHygiene, diffSitemap, HygieneFinding, SitemapDiff } from "@/lib/modules";
import { attachCrawlInlinkSources, attachGscSources } from "@/lib/sources";
import {
  AuditState,
  FixStatus,
  Issue,
  VerifyResultItem,
  severityRank,
} from "@/lib/schema";

const VERIFY_BATCH = 8;
/** Max confirmed error URLs traced via GSC URL Inspection per audit (quota: 2,000/day/property). */
const GSC_INSPECT_CAP = 40;
const VERIFY_CONCURRENCY = 3; // parallel batch requests; server adds per-URL delay inside each batch
const STORAGE_KEY = "auditforge:last-audit";

function newAudit(): AuditState {
  return {
    meta: {
      createdAt: new Date().toISOString(),
      name: "audit",
      auditId: Math.random().toString(36).slice(2, 10),
    },
    rows: [],
    issues: [],
    headerFindings: [],
    gsc: [],
    sitemapUrls: [],
    inlinksLoaded: false,
    parseWarnings: [],
  };
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("upload");
  const [detail, setDetail] = useState("");
  const [progress, setProgress] = useState(-1);
  const [error, setError] = useState("");
  const [audit, setAudit] = useState<AuditState>(newAudit);
  const [sitemapDiff, setSitemapDiff] = useState<SitemapDiff | null>(null);
  const [hygiene, setHygiene] = useState<HygieneFinding[]>([]);
  const [delta, setDelta] = useState<DeltaReport | null>(null);
  const [previousAudit, setPreviousAudit] = useState<AuditState | null>(null);
  const [psi, setPsi] = useState<PsiResult[]>([]);
  const [psiError, setPsiError] = useState("");
  const [moduleNotes, setModuleNotes] = useState<string[]>([]);
  const [resumable, setResumable] = useState(false);
  const [live, setLive] = useState<LiveStats>(emptyLiveStats);
  const [gscStatus, setGscStatus] = useState<"unknown" | "unconfigured" | "disconnected" | "connected">("unknown");
  const [gscSites, setGscSites] = useState<string[]>([]);
  const [gscSite, setGscSite] = useState("");
  const auditRef = useRef(audit);
  auditRef.current = audit;
  const gscRef = useRef({ status: gscStatus, site: gscSite, sites: gscSites });
  gscRef.current = { status: gscStatus, site: gscSite, sites: gscSites };
  const inlinkEdgesRef = useRef<InlinkEdge[] | null>(null);

  // Resume: nothing lost on refresh.
  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY)) setResumable(true);
      setGscSite(localStorage.getItem("auditforge:gsc-site") ?? "");
    } catch {
      /* storage unavailable */
    }
  }, []);

  // GSC: probe the connection and surface OAuth redirect outcomes.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gsc") === "error") {
      setError(`Google Search Console connection failed: ${params.get("reason") ?? "unknown"}. You can retry or use the CSV fallback.`);
    }
    if (params.has("gsc")) window.history.replaceState({}, "", "/");
    (async () => {
      try {
        const res = await fetch("/api/gsc/sites");
        if (res.ok) {
          const data = (await res.json()) as { sites: string[] };
          setGscSites(data.sites);
          setGscStatus("connected");
        } else if (res.status === 501) setGscStatus("unconfigured");
        else setGscStatus("disconnected");
      } catch {
        setGscStatus("disconnected");
      }
    })();
  }, []);

  const handleGscSelect = useCallback((site: string) => {
    setGscSite(site);
    try {
      localStorage.setItem("auditforge:gsc-site", site);
    } catch {
      /* best effort */
    }
  }, []);

  const handleGscDisconnect = useCallback(async () => {
    await fetch("/api/gsc/disconnect", { method: "POST" }).catch(() => undefined);
    setGscStatus("disconnected");
    setGscSites([]);
  }, []);

  /** Auto-match a GSC property to the crawl's domain when the user hasn't picked one. */
  const resolveGscProperty = useCallback((crawlHost: string): string => {
    const { status, site, sites } = gscRef.current;
    if (status !== "connected") return "";
    if (site) return site;
    const host = crawlHost.replace(/^www\./, "");
    return (
      sites.find((s) => s === `sc-domain:${host}`) ??
      sites.find((s) => {
        try {
          return new URL(s).hostname.replace(/^www\./, "") === host;
        } catch {
          return false;
        }
      }) ??
      ""
    );
  }, []);

  const persist = useCallback((state: AuditState) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* quota — persistence is best-effort */
    }
  }, []);

  const note = (n: string) => setModuleNotes((prev) => (prev.includes(n) ? prev : [...prev, n]));

  /** The verification loop driver: batched, resumable, concurrency-capped, client-driven. */
  const runVerification = useCallback(
    async (
      issues: Issue[],
      onDone: (
        updated: Issue[],
        headers: AuditState["headerFindings"],
        linksBySource: Map<string, string[]>
      ) => void
    ) => {
      const pending = issues.filter((i) => i.verification === "PENDING");
      // Verify each unique URL's issues together so evidence is coherent.
      const items = pending.map((i) => ({
        issueId: i.id,
        url: i.url,
        ruleId: i.ruleId,
        crawlEvidence: i.evidence,
      }));
      const batches: (typeof items)[] = [];
      for (let i = 0; i < items.length; i += VERIFY_BATCH) batches.push(items.slice(i, i + VERIFY_BATCH));

      const issueById = new Map(issues.map((i) => [i.id, i]));
      setLive({ ...emptyLiveStats(), total: items.length, startedAt: Date.now() });
      const resultMap = new Map<string, VerifyResultItem>();
      const headerFindings: AuditState["headerFindings"] = [];
      const seenHeaderUrls = new Set<string>();
      const urlByIssueId = new Map(items.map((i) => [i.issueId, i.url]));
      const linksBySource = new Map<string, string[]>();
      let completed = 0;

      let cursor = 0;
      const worker = async () => {
        while (cursor < batches.length) {
          const batch = batches[cursor++];
          try {
            const res = await fetch("/api/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ items: batch, delayMs: 300 }),
            });
            if (res.status === 429) {
              await new Promise((r) => setTimeout(r, 5000));
              cursor--; // retry this batch
              continue;
            }
            const data = (await res.json()) as { results?: VerifyResultItem[]; error?: string };
            if (!res.ok || !data.results) throw new Error(data.error ?? `Verify batch failed (${res.status})`);
            for (const r of data.results) {
              resultMap.set(r.issueId, r);
              const src = issueById.get(r.issueId);
              if (src) {
                setLive((prev) => {
                  const next: LiveStats = {
                    ...prev,
                    done: prev.done + 1,
                    confirmed: prev.confirmed + (r.status === "CONFIRMED" ? 1 : 0),
                    resolved: prev.resolved + (r.status === "RESOLVED" ? 1 : 0),
                    unverifiable: prev.unverifiable + (r.status === "UNVERIFIABLE" ? 1 : 0),
                    bySeverity: { ...prev.bySeverity },
                    recent: prev.recent,
                  };
                  if (r.status === "CONFIRMED") {
                    next.bySeverity[src.severity] = next.bySeverity[src.severity] + 1;
                    // newest first, keep the feed light
                    next.recent = [{ ...src, liveEvidence: r.liveEvidence, verification: r.status }, ...prev.recent].slice(0, 40);
                  }
                  return next;
                });
              }
              const srcUrl = urlByIssueId.get(r.issueId);
              if (srcUrl && r.internalLinks && !linksBySource.has(srcUrl)) {
                linksBySource.set(srcUrl, r.internalLinks);
              }
              if (r.headerFindings && !seenHeaderUrls.has(r.headerFindings[0]?.url ?? "")) {
                for (const h of r.headerFindings) headerFindings.push(h);
                if (r.headerFindings[0]) seenHeaderUrls.add(r.headerFindings[0].url);
              }
            }
          } catch (e) {
            for (const item of batch) {
              resultMap.set(item.issueId, {
                issueId: item.issueId,
                status: "UNVERIFIABLE",
                liveEvidence: "",
                verifyError: e instanceof Error ? e.message : "Batch request failed",
              });
            }
            setLive((prev) => ({ ...prev, done: prev.done + batch.length, unverifiable: prev.unverifiable + batch.length }));
          }
          completed += batch.length;
          setProgress(items.length === 0 ? 1 : completed / items.length);
          setDetail(
            `Verifying against live source · ${completed.toLocaleString()}/${items.length.toLocaleString()} checks · robots.txt respected · 300ms delay`
          );
        }
      };
      await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, worker));

      const now = new Date().toISOString();
      const updated = issues.map((i) => {
        const r = resultMap.get(i.id);
        if (!r) return i;
        return {
          ...i,
          verification: r.status,
          liveEvidence: r.liveEvidence || i.liveEvidence,
          verifyError: r.verifyError,
          verifiedAt: now,
        };
      });
      onDone(updated, headerFindings, linksBySource);
    },
    []
  );

  const runPipeline = useCallback(
    async (file: File) => {
      setError("");
        setPsi([]);
      setModuleNotes([]);
      const state = { ...newAudit(), gsc: auditRef.current.gsc, sitemapUrls: auditRef.current.sitemapUrls };
      state.meta.name = file.name;
      try {
        // 1 — parse
        setStage("parse");
        setProgress(-1);
        setDetail(`Stream-parsing ${file.name}…`);
        const { rows, warnings, edges } = await parseCrawlFile(file, (n) =>
          setDetail(`Stream-parsing ${file.name} · ${n.toLocaleString()} rows`)
        );
        state.rows = rows;
        state.parseWarnings = warnings;
        warnings.forEach(note);
        if (edges && edges.length > 0) {
          state.inlinksLoaded = true;
          state.pagerank = computePagerank(edges, rows);
        }

        // 2 — detect
        setStage("detect");
        setDetail(`Running detection rules across ${rows.length.toLocaleString()} URLs…`);
        await new Promise((r) => setTimeout(r, 30)); // let the UI paint
        let issues = detectIssues(rows);
        setDetail(`${issues.length.toLocaleString()} potential issues flagged — entering verification loop`);

        // 3 — verify (the soul)
        setStage("verify");
        setProgress(0);
        let linksBySource = new Map<string, string[]>();
        await runVerification(issues, (updated, headers, links) => {
          issues = updated;
          state.headerFindings = headers;
          linksBySource = links;
        });

        // 3b — link jump: chase errors found inside the live source of verified pages.
        const norm = (u: string) => u.replace(/\/$/, "");
        const rowByNorm = new Map(rows.map((r) => [norm(r.url), r]));
        const now = new Date().toISOString();
        const jumpIssues: Issue[] = [];
        const discovered = new Map<string, string>(); // discovered URL -> first source page
        for (const [source, links] of linksBySource) {
          for (const link of links) {
            const known = rowByNorm.get(norm(link));
            if (known && known.statusCode >= 400) {
              jumpIssues.push({
                id: `live-broken-link::${source} -> ${link}`,
                ruleId: "live-broken-link",
                ruleLabel: "Live page links to a broken URL",
                severity: "High",
                owner: "Dev",
                url: source,
                evidence: `Live source contains <a href="${link}"> — that URL returned HTTP ${known.statusCode} in the crawl`,
                liveEvidence: "Link observed in live HTML during verification",
                verification: "CONFIRMED",
                verifiedAt: now,
                impactScore: 0,
                fixStatus: "Open",
              });
            } else if (!known && norm(link) !== norm(source) && !discovered.has(link) && discovered.size < 100) {
              discovered.set(link, source);
            }
          }
        }
        if (discovered.size > 0) {
          setDetail(`Link jump: live-checking ${discovered.size} URLs found in page source but absent from the crawl…`);
          setProgress(0);
          const pseudo: Issue[] = [...discovered].map(([url, source]) => ({
            id: `jump::${url}`,
            ruleId: "link-jump-check",
            ruleLabel: "Broken URL discovered via link jump",
            severity: "Critical",
            owner: "Dev",
            url,
            evidence: `Discovered in the live source of ${source} (not present in the crawl export)`,
            sourceInternalInlinks: [`${source} — observed in live HTML during verification`],
            verification: "PENDING",
            impactScore: 0,
            fixStatus: "Open",
          }));
          await runVerification(pseudo, (updatedPseudo) => {
            for (const p of updatedPseudo) {
              if (p.verification === "CONFIRMED") jumpIssues.push(p);
            }
          });
        }
        if (jumpIssues.length > 0) {
          issues = [...issues, ...jumpIssues];
          note(`Link jump: ${jumpIssues.length} additional finding(s) from cross-checking URLs inside live page source.`);
        }

        // 4 — enrich
        setStage("enrich");
        setProgress(-1);
        let crawlHost = "";
        try {
          crawlHost = new URL(rows[0].url).hostname;
        } catch {
          /* keep empty */
        }
        const gscProperty = gscRef.current.status === "connected" ? resolveGscProperty(crawlHost) : "";
        if (state.gsc.length === 0 && gscRef.current.status === "connected") {
          const property = gscProperty;
          if (property) {
            setDetail(`Pulling Search Console data for ${property} (last 28 days)…`);
            try {
              const res = await fetch("/api/gsc/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ siteUrl: property }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? `GSC query failed (${res.status})`);
              state.gsc = data.rows;
              note(`GSC auto-pulled: ${state.gsc.length.toLocaleString()} URLs with search data from ${property} (${data.window.start} → ${data.window.end}).`);
            } catch (e) {
              note(`GSC auto-pull skipped: ${e instanceof Error ? e.message : "request failed"}. CSV fallback still available.`);
            }
          } else {
            note(`GSC connected but no property matched the crawl domain "${crawlHost}" — pick one in the upload screen.`);
          }
        }
        setDetail(
          state.gsc.length > 0
            ? `Weighting impact scores with GSC data (${state.gsc.length.toLocaleString()} URLs)…`
            : "No GSC data — impact scores weighted by internal inlinks."
        );
        issues = computeImpactScores(issues, rows, state.gsc);
        state.issues = issues.sort(
          (a, b) => b.impactScore - a.impactScore || severityRank(a.severity) - severityRank(b.severity)
        );

        // 4b — error sources: for every confirmed broken URL, answer "where is
        // this coming from?" — crawl link graph first (free, offline), then the
        // GSC URL Inspection API (sitemaps + referring pages Google knows).
        try {
          state.issues = attachCrawlInlinkSources(state.issues, edges ?? inlinkEdgesRef.current);
        } catch {
          /* best effort — sources are enrichment, never a blocker */
        }
        if (gscProperty) {
          try {
            setDetail("Tracing error sources via GSC URL Inspection (sitemaps + referring pages)…");
            setProgress(0);
            const traced = await attachGscSources(state.issues, gscProperty, GSC_INSPECT_CAP, (done, total) => {
              setProgress(total === 0 ? 1 : done / total);
              setDetail(
                `GSC URL Inspection · ${done}/${total} broken URLs traced (capped at ${GSC_INSPECT_CAP}/audit to protect the 2,000/day quota)`
              );
            });
            state.issues = traced.issues;
            if (traced.inspected > 0) {
              note(
                `Error sources: inspected ${traced.inspected} confirmed error URL(s) via GSC URL Inspection — ` +
                  `${traced.withSources} have known sitemaps/referring pages` +
                  (traced.failures > 0 ? `, ${traced.failures} inspection(s) unavailable` : "") +
                  `.`
              );
            }
          } catch (e) {
            note(`GSC error-source tracing skipped: ${e instanceof Error ? e.message : "request failed"}.`);
          }
          setProgress(-1);
        }

        // 5 — modules (each fails independently)
        setStage("modules");
        setDetail("Running power modules…");
        if (!state.pagerank && inlinkEdgesRef.current) {
          try {
            state.inlinksLoaded = true;
            state.pagerank = computePagerank(inlinkEdgesRef.current, rows);
            note(`Module D enabled from the inlinks file dropped alongside the crawl (${inlinkEdgesRef.current.length.toLocaleString()} edges).`);
          } catch (e) {
            note(`Module D skipped: ${e instanceof Error ? e.message : "failed"}`);
          }
        }
        try {
          setHygiene(analyzeUrlHygiene(rows));
        } catch (e) {
          note(`Module I skipped: ${e instanceof Error ? e.message : "failed"}`);
        }
        if (state.sitemapUrls.length > 0) {
          try {
            setSitemapDiff(diffSitemap(state.sitemapUrls, rows, state.gsc));
          } catch (e) {
            note(`Module C skipped: ${e instanceof Error ? e.message : "failed"}`);
          }
        } else {
          setSitemapDiff(null);
        }
        if (previousAudit) {
          try {
            setDelta(computeDelta(previousAudit, state));
          } catch (e) {
            note(`Module F skipped: ${e instanceof Error ? e.message : "failed"}`);
          }
        }
        note("Module A (raw vs rendered DOM) and OAuth-based GSC modules are v2 roadmap — see README.");

        // 6 — analyze (AI)
        setStage("analyze");
        const confirmed = state.issues.filter((i) => i.verification === "CONFIRMED");
        if (confirmed.length === 0) {
          setDetail("No confirmed issues — skipping AI layer.");
        } else {
          setDetail(`AI analysis: batching ${confirmed.length} confirmed issues by type…`);
          try {
            const byRule = new Map<string, Issue[]>();
            for (const i of confirmed) byRule.set(i.ruleId, [...(byRule.get(i.ruleId) ?? []), i]);
            const groups = [...byRule.entries()].slice(0, 40).map(([ruleId, list]) => ({
              ruleId,
              ruleLabel: list[0].ruleLabel,
              severity: list[0].severity,
              count: list.length,
              sampleUrls: list.slice(0, 5).map((i) => i.url),
              sampleEvidence: list.slice(0, 5).map((i) => i.evidence.slice(0, 200)),
            }));
            const res = await fetch("/api/analyze", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                groups,
                siteStats: {
                  totalUrls: rows.length,
                  confirmed: confirmed.length,
                  resolved: state.issues.filter((i) => i.verification === "RESOLVED").length,
                  unverifiable: state.issues.filter((i) => i.verification === "UNVERIFIABLE").length,
                  healthScore: healthScore(state.issues, rows.length),
                },
              }),
            });
            const data = await res.json();
            if (res.ok) {
              state.analyses = data.analyses;
              state.execSummary = data.execSummary;
            } else {
              note(`AI layer skipped: ${data.error}`);
            }
          } catch (e) {
            note(`AI layer skipped: ${e instanceof Error ? e.message : "request failed"}`);
          }
        }

        // 7 — report
        setStage("report");
        setAudit(state);
        persist(state);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The pipeline failed unexpectedly.");
        setStage("upload");
      }
    },
    [persist, previousAudit, runVerification]
  );

  const handleInlinks = useCallback(
    async (file: File) => {
      setError("");
      try {
        setDetail("Parsing All Inlinks…");
        const edges = await parseAllInlinksCsv(file, (n) => setDetail(`Parsing All Inlinks · ${n.toLocaleString()} edges`));
        inlinkEdgesRef.current = edges;
        setAudit((prev) => {
          const next = {
            ...prev,
            inlinksLoaded: true,
            pagerank: prev.rows.length > 0 ? computePagerank(edges, prev.rows) : undefined,
          };
          if (prev.rows.length > 0) persist(next);
          return next;
        });
        note(
          edges.length >= MAX_INLINK_EDGES
            ? `All Inlinks loaded: capped at ${MAX_INLINK_EDGES.toLocaleString()} edges for memory safety — PageRank is computed on this (representative) sample.`
            : `All Inlinks loaded: ${edges.length.toLocaleString()} hyperlink edges → Module D enabled.`
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Inlinks parse failed");
      }
    },
    [persist]
  );

  const handleGsc = useCallback(async (file: File) => {
    setError("");
    try {
      const rowsGsc = await parseGscPagesCsv(file);
      if (rowsGsc.length === 0) throw new Error("No page rows found in that CSV. Export Performance → Pages from Search Console.");
      setAudit((prev) => {
        const issues = prev.issues.length > 0 ? computeImpactScores(prev.issues, prev.rows, rowsGsc) : prev.issues;
        return { ...prev, gsc: rowsGsc, issues };
      });
      note(`GSC data loaded for ${rowsGsc.length.toLocaleString()} URLs → traffic-weighted impact scores.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "GSC parse failed");
    }
  }, []);

  const handleSitemap = useCallback(async (url: string) => {
    setError("");
    try {
      setDetail("Fetching sitemap(s)…");
      const res = await fetch("/api/sitemap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sitemap fetch failed");
      setAudit((prev) => {
        const next = { ...prev, sitemapUrls: data.urls as string[] };
        if (prev.rows.length > 0) setSitemapDiff(diffSitemap(next.sitemapUrls, prev.rows, prev.gsc));
        return next;
      });
      (data.warnings as string[]).forEach(note);
      note(`Sitemap loaded: ${(data.urls as string[]).length.toLocaleString()} URLs → Module C enabled.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sitemap fetch failed");
    }
  }, []);

  const handlePreviousAudit = useCallback(async (file: File) => {
    setError("");
    try {
      const parsed = JSON.parse(await file.text()) as AuditState;
      if (!Array.isArray(parsed.issues) || !Array.isArray(parsed.rows)) throw new Error("Not an AuditForge audit JSON.");
      setPreviousAudit(parsed);
      note(`Previous audit ${parsed.meta?.auditId ?? ""} loaded → delta report enabled.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read previous audit JSON.");
    }
  }, []);

  const handleFixStatus = useCallback(
    (issueId: string, status: FixStatus) => {
      setAudit((prev) => {
        const next = {
          ...prev,
          issues: prev.issues.map((i) => (i.id === issueId ? { ...i, fixStatus: status } : i)),
        };
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const handleReverifyClaimed = useCallback(async () => {
    const current = auditRef.current;
    const claimed = current.issues.filter((i) => i.fixStatus === "Fixed-Claimed");
    if (claimed.length === 0) return;
    setStage("verify");
    setProgress(0);
    const reset = current.issues.map((i) =>
      i.fixStatus === "Fixed-Claimed" ? { ...i, verification: "PENDING" as const } : i
    );
    await runVerification(reset, (updated, headers) => {
      const finalized = updated.map((i) =>
        i.fixStatus === "Fixed-Claimed"
          ? {
              ...i,
              fixStatus: (i.verification === "RESOLVED" ? "Fixed-Verified" : "Fixed-Claimed") as FixStatus,
            }
          : i
      );
      setAudit((prev) => {
        const next = { ...prev, issues: finalized, headerFindings: [...prev.headerFindings, ...headers] };
        persist(next);
        return next;
      });
    });
    setStage("report");
    const verified = auditRef.current.issues.filter((i) => i.fixStatus === "Fixed-Verified").length;
    note(`Re-verification complete: ${verified} fixes proven against live source.`);
  }, [persist, runVerification]);

  const handleRunPsi = useCallback(async () => {
    setPsiError("");
    const current = auditRef.current;
    // Template clustering: first two path segments, param-stripped.
    const templates = new Map<string, string>();
    for (const r of current.rows) {
      if (r.statusCode !== 200) continue;
      try {
        const u = new URL(r.url);
        const key = u.pathname.split("/").filter(Boolean).slice(0, 2).map((s) => (/\d/.test(s) ? "*" : s)).join("/");
        if (!templates.has(key)) templates.set(key, r.url);
      } catch {
        /* skip */
      }
    }
    const samples = [...templates.values()].slice(0, 6);
    const results: PsiResult[] = [];
    for (const [idx, url] of samples.entries()) {
      setDetail(`PageSpeed Insights ${idx + 1}/${samples.length}: ${url}`);
      try {
        const res = await fetch("/api/psi", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        if (!res.ok) {
          setPsiError(data.error ?? "PSI failed");
          if (res.status === 501) return; // no key — stop entirely
          continue;
        }
        results.push(data as PsiResult);
        setPsi([...results]);
      } catch (e) {
        setPsiError(e instanceof Error ? e.message : "PSI request failed");
      }
    }
  }, []);

  const resume = useCallback(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as AuditState;
      setAudit(parsed);
      setHygiene(analyzeUrlHygiene(parsed.rows));
      if (parsed.sitemapUrls.length > 0) setSitemapDiff(diffSitemap(parsed.sitemapUrls, parsed.rows, parsed.gsc));
      setStage("report");
    } catch {
      setError("Couldn't restore the previous audit from this browser.");
    }
  }, []);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl tracking-tight text-slate-100">
            Audit<span className="text-forge">Forge</span>
          </h1>
          <p className="mt-1 text-sm text-steel">
            Screaming Frog in → every issue re-verified against the live site → evidence-backed report out.
          </p>
        </div>
        {stage === "report" && (
          <button className="btn no-print" onClick={() => { setStage("upload"); setAudit(newAudit()); setDelta(null); setSitemapDiff(null); }}>
            New audit
          </button>
        )}
      </header>

      {error && (
        <div role="alert" className="mb-6 rounded border border-ember/50 bg-ember/10 px-3 py-2 text-sm text-ember">
          <p className="whitespace-pre-wrap">{error}</p>
          {error.includes("Apache Derby") && (
            <button
              className="btn mt-3 border-forge/60 text-forge"
              onClick={downloadConverterBat}
              title="Windows batch file: drag your .dbseospider onto it and it runs the whole conversion for you."
            >
              ⬇ Download one-click converter (.bat)
            </button>
          )}
        </div>
      )}

      {stage === "upload" && (
        <>
          {resumable && (
            <button className="btn mb-6" onClick={resume}>
              ↩ Resume last audit from this browser
            </button>
          )}
          <Upload
            busy={false}
            onCrawlFile={runPipeline}
            onInlinksFile={handleInlinks}
            onGscFile={handleGsc}
            onSitemapUrl={handleSitemap}
            onPreviousAudit={handlePreviousAudit}
            gscStatus={gscStatus}
            gscSites={gscSites}
            gscSite={gscSite}
            onGscConnect={() => (window.location.href = "/api/gsc/auth")}
            onGscSelect={handleGscSelect}
            onGscDisconnect={handleGscDisconnect}
          />
          <p className="mt-6 text-xs text-steel">
            Tip: add GSC / inlinks / sitemap / previous audit before dropping the crawl file — they&apos;re woven into the
            pipeline automatically. All parsing happens in your browser; only flagged URLs are fetched server-side for
            verification.
          </p>
        </>
      )}

      {stage !== "upload" && (
        <div className="space-y-8">
          <Pipeline stage={stage} detail={detail} progress={progress} />
          {stage === "verify" && <LiveFindings stats={live} />}
          {stage === "report" && (
            <Report
              audit={audit}
              sitemapDiff={sitemapDiff}
              hygiene={hygiene}
              delta={delta}
              psi={psi}
              psiError={psiError}
              moduleNotes={moduleNotes}
              onFixStatus={handleFixStatus}
              onReverifyClaimed={handleReverifyClaimed}
              onRunPsi={handleRunPsi}
            />
          )}
        </div>
      )}
    </main>
  );
}
