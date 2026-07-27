"use client";
import { Fragment, useMemo, useState } from "react";
import {
  AuditState,
  Issue,
  FixStatus,
  Severity,
  severityRank,
} from "@/lib/schema";
import { DeltaReport, healthGrade, healthScore, findMoneyLeaks } from "@/lib/analysis";
import {
  HygieneFinding,
  SitemapDiff,
  buildRedirectMap,
  issuesAsJiraCsv,
  redirectMapAsHtaccess,
  redirectMapAsNextConfig,
  redirectMapAsNginx,
} from "@/lib/modules";
import { checkRobots, parseRobotsTxt } from "@/lib/robots";
import { downloadText, exportAuditJson, exportXlsx } from "@/lib/exports";
import { buildStandaloneReport } from "@/lib/report-html";
import { splitConcatenatedUrls } from "@/lib/url-utils";

export interface PsiResult {
  url: string;
  field: { lcpMs: number | null; inpMs: number | null; cls: number | null };
  lab: { lcpMs: number | null; cls: number | null; performanceScore: number };
  opportunities: { title: string; savingsMs: number }[];
}

interface Props {
  audit: AuditState;
  sitemapDiff: SitemapDiff | null;
  hygiene: HygieneFinding[];
  delta: DeltaReport | null;
  psi: PsiResult[];
  psiError: string;
  moduleNotes: string[];
  readOnly?: boolean;
  onFixStatus?: (issueId: string, status: FixStatus) => void;
  onReverifyClaimed?: () => void;
  onRunPsi?: () => void;
}

const sevColor: Record<Severity, string> = {
  Critical: "bg-ember/20 text-ember",
  High: "bg-forge/20 text-forge",
  Medium: "bg-cobalt/20 text-cobalt",
  Low: "bg-steel/20 text-steel",
};
const verColor: Record<string, string> = {
  CONFIRMED: "bg-ember/20 text-ember",
  RESOLVED: "bg-verdant/20 text-verdant",
  UNVERIFIABLE: "bg-steel/20 text-steel",
  PENDING: "bg-cobalt/20 text-cobalt",
  SKIPPED: "bg-steel/10 text-steel/70",
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="border-b border-edge pb-2 font-mono text-sm uppercase tracking-[0.2em] text-forge">
      {children}
    </h2>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded border border-edge bg-panel/60 px-4 py-3">
      <div className={`text-2xl font-semibold ${tone ?? "text-slate-100"}`}>{value}</div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-steel">{label}</div>
    </div>
  );
}

function IssueTable({
  issues,
  audit,
  readOnly,
  onFixStatus,
}: {
  issues: Issue[];
  audit: AuditState;
  readOnly?: boolean;
  onFixStatus?: (id: string, s: FixStatus) => void;
}) {
  const [limit, setLimit] = useState(50);
  const analyses = new Map((audit.analyses ?? []).map((a) => [a.ruleId, a]));
  const [open, setOpen] = useState<string | null>(null);
  const shown = issues.slice(0, limit);
  if (issues.length === 0) return <p className="py-4 text-sm text-steel">Nothing in this view. Clean.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-edge font-mono text-[10px] uppercase tracking-widest text-steel">
            <th className="py-2 pr-3">Impact</th>
            <th className="py-2 pr-3">Sev</th>
            <th className="py-2 pr-3">Issue / URL</th>
            <th className="py-2 pr-3">Verification</th>
            <th className="py-2 pr-3">Owner</th>
            {!readOnly && <th className="py-2">Fix status</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((i) => {
            const a = analyses.get(i.ruleId);
            const expanded = open === i.id;
            const urlParts = splitConcatenatedUrls(i.url);
            const hasSources =
              (i.sourceSitemaps?.length ?? 0) > 0 ||
              (i.sourceReferringPages?.length ?? 0) > 0 ||
              (i.sourceInternalInlinks?.length ?? 0) > 0 ||
              Boolean(i.gscCoverageState);
            return (
              <Fragment key={i.id}>
                <tr
                  className="cursor-pointer border-b border-edge/50 align-top hover:bg-panel/60"
                  onClick={() => setOpen(expanded ? null : i.id)}
                >
                  <td className="py-2 pr-3 font-mono text-forge">{i.impactScore}</td>
                  <td className="py-2 pr-3">
                    <span className={`chip ${sevColor[i.severity]}`}>{i.severity}</span>
                  </td>
                  <td className="max-w-md py-2 pr-3">
                    <div className="text-slate-200">{i.ruleLabel}</div>
                    <div className="break-all font-mono text-xs text-steel">
                      {urlParts.length > 1
                        ? `${urlParts[0]}  ⚠ +${urlParts.length - 1} more URLs concatenated into this one crawled address — expand for the full list`
                        : i.url}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`chip ${verColor[i.verification]}`}>{i.verification}</span>
                    {i.verifiedAt && (
                      <div className="mt-1 font-mono text-[10px] text-steel/70">{new Date(i.verifiedAt).toLocaleString()}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-steel">{i.owner}</td>
                  {!readOnly && (
                    <td className="py-2" onClick={(e) => e.stopPropagation()}>
                      <select
                        aria-label="Fix status"
                        value={i.fixStatus}
                        onChange={(e) => onFixStatus?.(i.id, e.target.value as FixStatus)}
                        className="rounded border border-edge bg-ink px-1 py-0.5 text-xs"
                      >
                        {(["Open", "In Progress", "Fixed-Claimed", "Fixed-Verified"] as FixStatus[]).map((s) => (
                          <option key={s} value={s} disabled={s === "Fixed-Verified"}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                </tr>
                {expanded && (
                  <tr className="border-b border-edge/50 bg-black/20">
                    <td colSpan={readOnly ? 5 : 6} className="space-y-2 px-3 py-3">
                      {urlParts.length > 1 && (
                        <div>
                          <span className="font-mono text-[10px] uppercase tracking-widest text-steel">
                            full crawled address (malformed — {urlParts.length} URLs in one)
                          </span>
                          <code className="evidence mt-1">{i.url}</code>
                        </div>
                      )}
                      <div>
                        <span className="font-mono text-[10px] uppercase tracking-widest text-steel">crawl evidence</span>
                        <code className="evidence mt-1">{i.evidence}</code>
                      </div>
                      {hasSources && (
                        <div>
                          <span className="font-mono text-[10px] uppercase tracking-widest text-steel">
                            error source · where this url is referenced
                          </span>
                          <code className="evidence mt-1">
                            {[
                              i.gscCoverageState ? `GSC indexing state: ${i.gscCoverageState}` : "",
                              i.sourceSitemaps?.length
                                ? `Sitemaps (GSC):\n${i.sourceSitemaps.map((s) => `  • ${s}`).join("\n")}`
                                : "",
                              i.sourceReferringPages?.length
                                ? `Referring pages (GSC):\n${i.sourceReferringPages.map((s) => `  • ${s}`).join("\n")}`
                                : "",
                              i.sourceInternalInlinks?.length
                                ? `Internal pages linking here (crawl / live source):\n${i.sourceInternalInlinks.map((s) => `  • ${s}`).join("\n")}`
                                : "",
                            ]
                              .filter(Boolean)
                              .join("\n")}
                          </code>
                        </div>
                      )}
                      {i.liveEvidence && (
                        <div>
                          <span className="font-mono text-[10px] uppercase tracking-widest text-steel">live source evidence</span>
                          <code className="evidence mt-1">{i.liveEvidence}</code>
                        </div>
                      )}
                      {i.verifyError && (
                        <div>
                          <span className="font-mono text-[10px] uppercase tracking-widest text-steel">verification failure</span>
                          <code className="evidence mt-1">{i.verifyError}</code>
                        </div>
                      )}
                      {a && (
                        <div className="rounded border border-edge bg-panel/60 p-3 text-sm">
                          <p className="text-slate-200">{a.explanation}</p>
                          <p className="mt-2 text-steel">
                            <span className="text-slate-300">Likely root cause:</span> {a.rootCause}
                          </p>
                          <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-300">
                            {a.fixSteps.map((s, idx) => (
                              <li key={idx}>{s}</li>
                            ))}
                          </ol>
                          {a.codeSnippet && <code className="evidence mt-2 text-verdant/90">{a.codeSnippet}</code>}
                          <p className="mt-2 font-mono text-xs text-steel">
                            Effort: {a.effort} · Owner: {a.owner}
                          </p>
                        </div>
                      )}
                      {(i.gscClicks ?? 0) > 0 || (i.gscImpressions ?? 0) > 0 ? (
                        <p className="font-mono text-xs text-cobalt">
                          GSC (28d): {i.gscClicks ?? 0} clicks · {i.gscImpressions ?? 0} impressions
                        </p>
                      ) : null}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {issues.length > limit && (
        <button className="btn mt-3 text-xs" onClick={() => setLimit((l) => l + 200)}>
          Show more ({issues.length - limit} remaining)
        </button>
      )}
    </div>
  );
}

function RobotsSimulator() {
  const [origin, setOrigin] = useState("");
  const [testUrl, setTestUrl] = useState("");
  const [robotsTxt, setRobotsTxt] = useState("");
  const [verdict, setVerdict] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/api/robots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setRobotsTxt(data.text || "(empty or missing robots.txt — everything allowed)");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load robots.txt");
    } finally {
      setLoading(false);
    }
  };

  const test = () => {
    try {
      const u = new URL(testUrl);
      const v = checkRobots(parseRobotsTxt(robotsTxt), u.pathname + u.search, "googlebot");
      setVerdict(
        `${v.allowed ? "ALLOWED" : "BLOCKED"} for Googlebot — ${
          v.matchedRule ? `matched rule "${v.matchedRule}"` : "no rule matched (default allow)"
        } (group: ${v.group})`
      );
    } catch {
      setVerdict("Enter a full URL to test.");
    }
  };

  return (
    <div className="rounded border border-edge bg-panel/60 p-4">
      <h3 className="text-sm text-slate-200">robots.txt simulator</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          className="w-64 rounded border border-edge bg-ink px-2 py-1 text-xs"
          placeholder="https://example.com"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
        />
        <button className="btn text-xs" onClick={load} disabled={loading || !/^https?:\/\//.test(origin)}>
          {loading ? "Loading…" : "Load live robots.txt"}
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-ember">{err}</p>}
      {robotsTxt && (
        <>
          <pre className="mt-3 max-h-40 overflow-auto rounded bg-black/40 p-2 font-mono text-[11px] text-steel">{robotsTxt}</pre>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              className="w-80 rounded border border-edge bg-ink px-2 py-1 text-xs"
              placeholder="https://example.com/some/path?x=1"
              value={testUrl}
              onChange={(e) => setTestUrl(e.target.value)}
            />
            <button className="btn text-xs" onClick={test}>
              Test URL
            </button>
          </div>
          {verdict && <code className="evidence mt-2">{verdict}</code>}
        </>
      )}
    </div>
  );
}

export default function Report(props: Props) {
  const { audit, sitemapDiff, hygiene, delta, psi, psiError, moduleNotes, readOnly } = props;
  const [tab, setTab] = useState<"severity" | "team" | "appendix">("severity");
  const [team, setTeam] = useState<"Dev" | "Content" | "SEO">("Dev");

  const sorted = useMemo(
    () =>
      [...audit.issues].sort(
        (a, b) =>
          b.impactScore - a.impactScore || severityRank(a.severity) - severityRank(b.severity)
      ),
    [audit.issues]
  );
  const confirmed = sorted.filter((i) => i.verification === "CONFIRMED");
  const resolved = sorted.filter((i) => i.verification === "RESOLVED");
  const unverifiable = sorted.filter((i) => i.verification === "UNVERIFIABLE");
  const score = healthScore(audit.issues, audit.rows.length);
  const moneyLeaks = findMoneyLeaks(audit.issues, audit.gsc);
  const redirectMap = useMemo(() => buildRedirectMap(audit.rows), [audit.rows]);
  const claimed = audit.issues.filter((i) => i.fixStatus === "Fixed-Claimed").length;

  return (
    <div className="space-y-10">
      {/* Exports bar */}
      <div className="no-print flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => exportXlsx(audit)}>
          ⬇ XLSX (master + per-type sheets)
        </button>
        <button
          className="btn"
          onClick={() => downloadText(`auditforge-${audit.meta.auditId}-jira.csv`, issuesAsJiraCsv(audit.issues), "text/csv")}
        >
          ⬇ Jira CSV
        </button>
        <button className="btn" onClick={() => window.print()}>
          ⬇ PDF (print view)
        </button>
        <button className="btn" onClick={() => exportAuditJson(audit)}>
          ⬇ Audit JSON
        </button>
        <button
          className="btn border-forge/60 text-forge"
          onClick={() =>
            downloadText(
              `auditforge-report-${audit.meta.auditId}.html`,
              buildStandaloneReport({ audit, hygiene, sitemapDiff, redirectMap, moduleNotes }),
              "text/html"
            )
          }
          title="One self-contained file — email it, drop it in Slack, or host it anywhere. No link, no login, no expiry."
        >
          ⬇ Shareable report (single HTML file)
        </button>
      </div>

      {moduleNotes.length > 0 && (
        <div className="rounded border border-edge bg-panel/40 p-3">
          {moduleNotes.map((n, i) => (
            <p key={i} className="font-mono text-xs text-steel">
              ◦ {n}
            </p>
          ))}
        </div>
      )}

      {/* Executive summary */}
      <section className="space-y-3">
        <SectionTitle>Executive summary</SectionTitle>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Health grade" value={audit.execSummary?.grade ?? healthGrade(score)} tone="text-forge" />
          <Stat label="Health score" value={`${score}/100`} />
          <Stat label="Confirmed issues" value={confirmed.length} tone="text-ember" />
          <Stat label="Already fixed" value={resolved.length} tone="text-verdant" />
          <Stat label="Unverifiable" value={unverifiable.length} tone="text-steel" />
        </div>
        {audit.execSummary ? (
          <div className="space-y-3 rounded border border-edge bg-panel/60 p-4 text-sm leading-relaxed">
            <p>{audit.execSummary.narrative}</p>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-steel">top 5 priorities</p>
              <ol className="mt-1 list-decimal space-y-1 pl-5">
                {audit.execSummary.topPriorities.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            </div>
            <p className="text-steel">{audit.execSummary.projectedImpact}</p>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-steel">30-day action plan</p>
              <ul className="mt-1 space-y-1 pl-5">
                {audit.execSummary.actionPlan30Day.map((p, i) => (
                  <li key={i} className="list-disc">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <p className="text-sm text-steel">
            AI executive summary unavailable (no OPENAI_API_KEY or the analyze step was skipped). All verified findings below.
          </p>
        )}
      </section>

      {/* Verification log */}
      <section className="space-y-3">
        <SectionTitle>Verification log</SectionTitle>
        <p className="text-sm text-steel">
          Every flagged URL was re-fetched live before entering this report. {confirmed.length} confirmed against current
          source, {resolved.length} already fixed since the crawl, {unverifiable.length} unverifiable (each with its
          failure reason — never silently dropped).
        </p>
        {unverifiable.length > 0 && (
          <details className="rounded border border-edge bg-panel/40 p-3">
            <summary className="cursor-pointer text-sm text-steel">Unverifiable items ({unverifiable.length})</summary>
            <IssueTable issues={unverifiable} audit={audit} readOnly />
          </details>
        )}
      </section>

      {/* GSC impact */}
      <section className="space-y-3">
        <SectionTitle>GSC impact view</SectionTitle>
        {audit.gsc.length === 0 ? (
          <p className="text-sm text-steel">
            No GSC data supplied. Upload the Search Console &quot;Pages&quot; CSV export to unlock Impact Scores weighted by real
            clicks/impressions and money-leak detection. (OAuth-based GSC connection is on the v2 roadmap — see README.)
          </p>
        ) : (
          <>
            <p className="text-sm text-steel">
              {audit.gsc.length.toLocaleString()} URLs enriched with clicks/impressions. Impact Scores across the whole
              report are traffic-weighted.
            </p>
            <h3 className="text-sm text-ember">Money leaks — pages earning impressions with Critical confirmed issues</h3>
            <IssueTable issues={moneyLeaks} audit={audit} readOnly />
          </>
        )}
      </section>

      {/* Delta */}
      {delta && (
        <section className="space-y-3">
          <SectionTitle>Delta vs. previous audit</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="New issues" value={delta.newIssues.length} tone="text-forge" />
            <Stat label="Fixed since last audit" value={delta.fixedIssues.length} tone="text-verdant" />
            <Stat label="⚠ Regressed" value={delta.regressed.length} tone="text-ember" />
            <Stat
              label="Health trend"
              value={`${delta.previousHealth} → ${delta.currentHealth}`}
              tone={delta.currentHealth >= delta.previousHealth ? "text-verdant" : "text-ember"}
            />
          </div>
          {delta.regressed.length > 0 && (
            <div className="rounded border-2 border-ember/60 bg-ember/5 p-3">
              <p className="text-sm font-semibold text-ember">
                REGRESSIONS — these were fixed before and are broken again:
              </p>
              <IssueTable issues={delta.regressed} audit={audit} readOnly />
            </div>
          )}
          {delta.newIssues.length > 0 && (
            <details className="rounded border border-edge bg-panel/40 p-3">
              <summary className="cursor-pointer text-sm text-steel">New issues ({delta.newIssues.length})</summary>
              <IssueTable issues={delta.newIssues} audit={audit} readOnly />
            </details>
          )}
        </section>
      )}

      {/* Issues */}
      <section className="space-y-3">
        <SectionTitle>Issues — sorted by impact</SectionTitle>
        <div className="no-print flex gap-2">
          {(["severity", "team", "appendix"] as const).map((t) => (
            <button
              key={t}
              className={`btn text-xs ${tab === t ? "border-forge text-forge" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "severity" ? "By severity" : t === "team" ? "By owning team" : "Full URL appendix"}
            </button>
          ))}
          {tab === "team" &&
            (["Dev", "Content", "SEO"] as const).map((t) => (
              <button
                key={t}
                className={`btn text-xs ${team === t ? "border-cobalt text-cobalt" : ""}`}
                onClick={() => setTeam(t)}
              >
                {t}
              </button>
            ))}
        </div>
        {tab === "severity" &&
          (["Critical", "High", "Medium", "Low"] as Severity[]).map((sev) => {
            const list = confirmed.filter((i) => i.severity === sev);
            if (list.length === 0) return null;
            return (
              <details key={sev} open={sev === "Critical" || sev === "High"} className="rounded border border-edge bg-panel/40 p-3">
                <summary className="cursor-pointer">
                  <span className={`chip ${sevColor[sev]}`}>{sev}</span>{" "}
                  <span className="text-sm text-steel">{list.length} confirmed</span>
                </summary>
                <IssueTable issues={list} audit={audit} readOnly={readOnly} onFixStatus={props.onFixStatus} />
              </details>
            );
          })}
        {tab === "team" && (
          <IssueTable
            issues={confirmed.filter((i) => i.owner === team)}
            audit={audit}
            readOnly={readOnly}
            onFixStatus={props.onFixStatus}
          />
        )}
        {tab === "appendix" && <IssueTable issues={sorted} audit={audit} readOnly={readOnly} onFixStatus={props.onFixStatus} />}
      </section>

      {/* Fix tracker */}
      {!readOnly && (
        <section className="no-print space-y-3">
          <SectionTitle>Fix tracker (Module G)</SectionTitle>
          <p className="text-sm text-steel">
            Mark issues &quot;Fixed-Claimed&quot; in the tables above, then re-run verification: AuditForge promotes them to
            Fixed-Verified only when the live source proves the fix. ({claimed} currently claimed.)
          </p>
          <button className="btn" disabled={claimed === 0} onClick={props.onReverifyClaimed}>
            Re-verify {claimed} claimed fix{claimed === 1 ? "" : "es"} against live source
          </button>
          <p className="text-xs text-steel">
            For scheduled nightly re-verification, wire this same endpoint to a Vercel Cron job — steps in the README.
          </p>
        </section>
      )}

      {/* Module C */}
      <section className="space-y-3">
        <SectionTitle>Module C — Sitemap intelligence</SectionTitle>
        {!sitemapDiff ? (
          <p className="text-sm text-steel">Module skipped: no sitemap URL provided.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded border border-edge bg-panel/40 p-3">
              <p className="text-sm text-forge">In sitemap, not crawled ({sitemapDiff.inSitemapNotCrawled.length})</p>
              <p className="text-xs text-steel">Potential orphans — pages Google is told about but your site doesn&apos;t link to.</p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-auto font-mono text-[11px] text-slate-300">
                {sitemapDiff.inSitemapNotCrawled.slice(0, 100).map((u) => (
                  <li key={u} className="break-all">{u}</li>
                ))}
              </ul>
            </div>
            <div className="rounded border border-edge bg-panel/40 p-3">
              <p className="text-sm text-ember">Sitemap pollution ({sitemapDiff.sitemapPollution.length})</p>
              <p className="text-xs text-steel">Non-200 / non-indexable URLs polluting the sitemap.</p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-auto font-mono text-[11px] text-slate-300">
                {sitemapDiff.sitemapPollution.slice(0, 100).map((p) => (
                  <li key={p.url} className="break-all">
                    {p.url} <span className="text-ember">— {p.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded border border-edge bg-panel/40 p-3">
              <p className="text-sm text-cobalt">High-traffic URLs missing from sitemap ({sitemapDiff.gscMissingFromSitemap.length})</p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-auto font-mono text-[11px] text-slate-300">
                {sitemapDiff.gscMissingFromSitemap.map((p) => (
                  <li key={p.url} className="break-all">
                    {p.url} <span className="text-cobalt">({p.clicks} clicks)</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>

      {/* Module D */}
      <section className="space-y-3">
        <SectionTitle>Module D — Internal link equity</SectionTitle>
        {!audit.pagerank ? (
          <p className="text-sm text-steel">Module skipped: upload the &quot;All Inlinks&quot; export to model link equity.</p>
        ) : (
          <div className="space-y-4">
            <div className="rounded border border-edge bg-panel/40 p-3">
              <p className="text-sm text-ember">Equity leaks — high-PR links pointing at broken/redirecting URLs ({audit.pagerank.equityLeaks.length})</p>
              <ul className="mt-2 max-h-56 space-y-1 overflow-auto font-mono text-[11px]">
                {audit.pagerank.equityLeaks.slice(0, 30).map((l, i) => (
                  <li key={i} className="break-all text-slate-300">
                    {l.source} → {l.target} <span className="text-ember">({l.problem})</span>
                    {l.anchor && <span className="text-steel"> anchor: &quot;{l.anchor}&quot;</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded border border-edge bg-panel/40 p-3">
              <p className="text-sm text-verdant">Top &quot;move the needle&quot; linking opportunities</p>
              <ul className="mt-2 space-y-2 text-xs">
                {audit.pagerank.opportunities.map((o, i) => (
                  <li key={i} className="rounded bg-black/20 p-2">
                    <span className="font-mono text-slate-300">
                      Link from {o.suggestedSource} → {o.target}
                    </span>
                    <br />
                    <span className="text-steel">Anchor: &quot;{o.anchor}&quot; — {o.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
            <details className="rounded border border-edge bg-panel/40 p-3">
              <summary className="cursor-pointer text-sm text-steel">
                Top pages by internal PageRank · equity dead-ends ({audit.pagerank.deadEnds.length})
              </summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-2 font-mono text-[11px] text-slate-300">
                <ul className="space-y-1">
                  {audit.pagerank.topPages.slice(0, 15).map((p) => (
                    <li key={p.url} className="break-all">
                      {(p.pr * 1000).toFixed(2)}‰ {p.url}
                    </li>
                  ))}
                </ul>
                <ul className="space-y-1">
                  {audit.pagerank.deadEnds.slice(0, 15).map((p) => (
                    <li key={p.url} className="break-all text-steel">
                      dead-end: {p.url}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          </div>
        )}
      </section>

      {/* Module B */}
      <section className="space-y-3">
        <SectionTitle>Module B — Core Web Vitals (template samples)</SectionTitle>
        {psi.length === 0 && !psiError && (
          <div className="text-sm text-steel">
            <p>URLs are auto-clustered into templates by path pattern; 1 sample per template is tested (quota-safe).</p>
            {!readOnly && (
              <button className="btn no-print mt-2" onClick={props.onRunPsi}>
                Run PageSpeed Insights on template samples
              </button>
            )}
          </div>
        )}
        {psiError && <p className="text-sm text-ember">{psiError}</p>}
        {psi.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {psi.map((r) => {
              const pass = (v: number | null, limit: number) => v != null && v <= limit;
              return (
                <div key={r.url} className="rounded border border-edge bg-panel/40 p-3 text-xs">
                  <p className="break-all font-mono text-slate-300">{r.url}</p>
                  <p className="mt-2">
                    <span className={pass(r.field.lcpMs, 2500) ? "text-verdant" : "text-ember"}>
                      LCP {r.field.lcpMs != null ? `${(r.field.lcpMs / 1000).toFixed(1)}s` : "n/a"}
                    </span>{" "}
                    ·{" "}
                    <span className={pass(r.field.inpMs, 200) ? "text-verdant" : "text-ember"}>
                      INP {r.field.inpMs ?? "n/a"}ms
                    </span>{" "}
                    ·{" "}
                    <span className={pass(r.field.cls, 0.1) ? "text-verdant" : "text-ember"}>
                      CLS {r.field.cls ?? "n/a"}
                    </span>{" "}
                    <span className="text-steel">(field) · Lab perf {r.lab.performanceScore}/100</span>
                  </p>
                  {r.opportunities.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-steel">
                      {r.opportunities.map((o, i) => (
                        <li key={i}>
                          ↯ {o.title} (~{Math.round(o.savingsMs)}ms)
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Module I */}
      <section className="space-y-3">
        <SectionTitle>Module I — Crawl budget &amp; URL hygiene</SectionTitle>
        {hygiene.length === 0 ? (
          <p className="text-sm text-steel">No parameter bloat, case/slash/protocol duplication, or infinite-space patterns detected.</p>
        ) : (
          <div className="space-y-2">
            {hygiene.map((h) => (
              <div key={h.pattern} className="rounded border border-edge bg-panel/40 p-3 text-sm">
                <p>
                  <span className="font-mono text-forge">{h.pattern}</span>{" "}
                  <span className="text-steel">× {h.count.toLocaleString()}</span>
                </p>
                <p className="mt-1 text-xs text-steel">{h.recommendation}</p>
                {h.robotsRule && <code className="evidence mt-1">{h.robotsRule}</code>}
                <p className="mt-1 break-all font-mono text-[10px] text-steel/70">e.g. {h.examples[0]}</p>
              </div>
            ))}
          </div>
        )}
        <RobotsSimulator />
      </section>

      {/* Module J */}
      <section className="space-y-3">
        <SectionTitle>Module J — Security &amp; response headers</SectionTitle>
        <p className="text-xs text-steel">Captured on the verification fetches — zero extra requests.</p>
        {audit.headerFindings.length === 0 ? (
          <p className="text-sm text-steel">No header findings recorded (verification not run yet).</p>
        ) : (
          <div className="max-h-80 overflow-auto rounded border border-edge">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-panel font-mono text-[10px] uppercase tracking-widest text-steel">
                <tr>
                  <th className="p-2">Grade</th>
                  <th className="p-2">Check</th>
                  <th className="p-2">URL</th>
                  <th className="p-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {audit.headerFindings
                  .filter((h) => h.grade !== "pass")
                  .slice(0, 300)
                  .map((h, i) => (
                    <tr key={i} className="border-t border-edge/50 align-top">
                      <td className="p-2">
                        <span className={`chip ${h.grade === "fail" ? "bg-ember/20 text-ember" : "bg-forge/20 text-forge"}`}>
                          {h.grade}
                        </span>
                      </td>
                      <td className="p-2 text-slate-300">{h.check}</td>
                      <td className="max-w-xs break-all p-2 font-mono text-steel">{h.url}</td>
                      <td className="p-2 text-steel">{h.detail}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Module M */}
      <section className="space-y-3">
        <SectionTitle>Module M — Redirect map &amp; dev handoff</SectionTitle>
        {redirectMap.length === 0 ? (
          <p className="text-sm text-steel">No redirects in the crawl — nothing to collapse.</p>
        ) : (
          <>
            <p className="text-sm text-steel">
              {redirectMap.length} redirects collapsed to their final destinations (
              {redirectMap.filter((r) => r.hops > 1).length} were multi-hop chains).
            </p>
            <div className="no-print flex flex-wrap gap-2">
              <button className="btn text-xs" onClick={() => downloadText("redirects-nginx.conf", redirectMapAsNginx(redirectMap))}>
                ⬇ nginx
              </button>
              <button className="btn text-xs" onClick={() => downloadText("redirects.htaccess", redirectMapAsHtaccess(redirectMap))}>
                ⬇ .htaccess
              </button>
              <button className="btn text-xs" onClick={() => downloadText("redirects.next.config.js", redirectMapAsNextConfig(redirectMap))}>
                ⬇ Next.js config
              </button>
            </div>
          </>
        )}
      </section>

      <footer className="border-t border-edge pt-4 font-mono text-[10px] text-steel/70">
        AuditForge audit {audit.meta.auditId} · created {new Date(audit.meta.createdAt).toLocaleString()} ·{" "}
        {audit.rows.length.toLocaleString()} URLs crawled · nothing in this report skipped the verification loop
      </footer>
    </div>
  );
}
