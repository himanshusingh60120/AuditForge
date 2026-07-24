"use client";
import { healthGrade, healthScore } from "./analysis";
import { HygieneFinding, RedirectEntry, SitemapDiff } from "./modules";
import { AuditState, Issue, Severity, severityRank } from "./schema";

/**
 * Builds a single self-contained .html file: all styles inline, no scripts,
 * no external requests, no expiry. Email it, drop it in Slack, commit it,
 * host it anywhere, or open it straight from disk. Print → Save as PDF works.
 */

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Rows embedded per section — keeps the file emailable; XLSX has the complete set. */
const SECTION_CAP = 750;

function issueRowsHtml(issues: Issue[], analyses: Map<string, { fixSteps: string[]; codeSnippet: string; rootCause: string; explanation: string }>): string {
  const shown = issues.slice(0, SECTION_CAP);
  const rows = shown
    .map((i) => {
      const a = analyses.get(i.ruleId);
      return `<tr>
<td class="num">${esc(i.impactScore)}</td>
<td><span class="sev sev-${i.severity.toLowerCase()}">${esc(i.severity)}</span></td>
<td>
  <div class="issue">${esc(i.ruleLabel)}</div>
  <div class="url">${esc(i.url)}</div>
  <div class="ev"><b>Crawl:</b> ${esc(i.evidence)}</div>
  ${i.liveEvidence ? `<div class="ev live"><b>Live source:</b> ${esc(i.liveEvidence)}</div>` : ""}
  ${i.verifyError ? `<div class="ev err"><b>Verification failed:</b> ${esc(i.verifyError)}</div>` : ""}
  ${
    a
      ? `<details class="fix"><summary>Fix instructions</summary>
      <p>${esc(a.explanation)}</p>
      <p><b>Root cause:</b> ${esc(a.rootCause)}</p>
      <ol>${a.fixSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      ${a.codeSnippet ? `<pre>${esc(a.codeSnippet)}</pre>` : ""}
    </details>`
      : ""
  }
</td>
<td>${esc(i.verification)}${i.verifiedAt ? `<div class="ts">${esc(new Date(i.verifiedAt).toLocaleString())}</div>` : ""}</td>
<td>${esc(i.owner)}</td>
<td>${esc(i.fixStatus)}</td>
${i.gscImpressions != null ? `<td class="num">${esc(i.gscClicks ?? 0)} / ${esc(i.gscImpressions)}</td>` : "<td class=\"num\">—</td>"}
</tr>`;
    })
    .join("");
  const more =
    issues.length > SECTION_CAP
      ? `<p class="note">Showing the top ${SECTION_CAP} of ${issues.length.toLocaleString()} by impact — the XLSX export contains every row.</p>`
      : "";
  return `<table>
<thead><tr><th>Impact</th><th>Severity</th><th>Issue · URL · Evidence</th><th>Verification</th><th>Owner</th><th>Fix status</th><th>Clicks / Impr.</th></tr></thead>
<tbody>${rows}</tbody></table>${more}`;
}

export interface StandaloneInput {
  audit: AuditState;
  hygiene: HygieneFinding[];
  sitemapDiff: SitemapDiff | null;
  redirectMap: RedirectEntry[];
  moduleNotes: string[];
}

export function buildStandaloneReport({
  audit,
  hygiene,
  sitemapDiff,
  redirectMap,
  moduleNotes,
}: StandaloneInput): string {
  const sorted = [...audit.issues].sort(
    (a, b) => b.impactScore - a.impactScore || severityRank(a.severity) - severityRank(b.severity)
  );
  const confirmed = sorted.filter((i) => i.verification === "CONFIRMED");
  const resolved = sorted.filter((i) => i.verification === "RESOLVED");
  const unverifiable = sorted.filter((i) => i.verification === "UNVERIFIABLE");
  const score = healthScore(audit.issues, audit.rows.length);
  const grade = audit.execSummary?.grade ?? healthGrade(score);
  const analyses = new Map((audit.analyses ?? []).map((a) => [a.ruleId, a]));
  const created = new Date(audit.meta.createdAt).toLocaleString();

  let domain = "";
  try {
    domain = audit.rows[0] ? new URL(audit.rows[0].url).hostname : "";
  } catch {
    /* leave blank */
  }

  const sevSections = (["Critical", "High", "Medium", "Low"] as Severity[])
    .map((sev) => {
      const list = confirmed.filter((i) => i.severity === sev);
      if (list.length === 0) return "";
      return `<details ${sev === "Critical" || sev === "High" ? "open" : ""}>
<summary><span class="sev sev-${sev.toLowerCase()}">${sev}</span> ${list.length.toLocaleString()} confirmed</summary>
${issueRowsHtml(list, analyses)}</details>`;
    })
    .join("");

  const teamSections = (["Dev", "Content", "SEO"] as const)
    .map((team) => {
      const list = confirmed.filter((i) => i.owner === team);
      if (list.length === 0) return "";
      return `<details><summary>${team} — ${list.length.toLocaleString()} issues</summary>${issueRowsHtml(list, analyses)}</details>`;
    })
    .join("");

  const execHtml = audit.execSummary
    ? `<p>${esc(audit.execSummary.narrative)}</p>
<h3>Top priorities</h3><ol>${audit.execSummary.topPriorities.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
<p><b>Projected impact:</b> ${esc(audit.execSummary.projectedImpact)}</p>
<h3>30-day action plan</h3><ul>${audit.execSummary.actionPlan30Day.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
    : `<p class="note">AI executive summary not generated for this audit. All verified findings are below.</p>`;

  const pr = audit.pagerank;
  const equityHtml = pr
    ? `<h3>Equity leaks — high-authority links pointing at broken or redirecting URLs (${pr.equityLeaks.length})</h3>
<ul class="mono">${pr.equityLeaks.slice(0, 100).map((l) => `<li>${esc(l.source)} → ${esc(l.target)} <b>(${esc(l.problem)})</b>${l.anchor ? ` anchor: "${esc(l.anchor)}"` : ""}</li>`).join("")}</ul>
<h3>Top internal linking opportunities</h3>
<ul>${pr.opportunities.map((o) => `<li>Link from <span class="mono">${esc(o.suggestedSource)}</span> → <span class="mono">${esc(o.target)}</span><br><small>Anchor: "${esc(o.anchor)}" — ${esc(o.reason)}</small></li>`).join("")}</ul>`
    : `<p class="note">Module skipped: no link graph available (upload the All Inlinks export).</p>`;

  const sitemapHtml = sitemapDiff
    ? `<h3>In sitemap but not crawled — potential orphans (${sitemapDiff.inSitemapNotCrawled.length})</h3>
<ul class="mono">${sitemapDiff.inSitemapNotCrawled.slice(0, 200).map((u) => `<li>${esc(u)}</li>`).join("")}</ul>
<h3>Sitemap pollution — non-200 or non-indexable URLs listed (${sitemapDiff.sitemapPollution.length})</h3>
<ul class="mono">${sitemapDiff.sitemapPollution.slice(0, 200).map((p) => `<li>${esc(p.url)} — <b>${esc(p.reason)}</b></li>`).join("")}</ul>
<h3>High-traffic URLs missing from the sitemap (${sitemapDiff.gscMissingFromSitemap.length})</h3>
<ul class="mono">${sitemapDiff.gscMissingFromSitemap.slice(0, 200).map((p) => `<li>${esc(p.url)} (${esc(p.clicks)} clicks)</li>`).join("")}</ul>`
    : `<p class="note">Module skipped: no sitemap URL provided.</p>`;

  const hygieneHtml =
    hygiene.length > 0
      ? `<ul>${hygiene
          .map(
            (h) =>
              `<li><b class="mono">${esc(h.pattern)}</b> × ${h.count.toLocaleString()}<br>${esc(h.recommendation)}${
                h.robotsRule ? `<pre>${esc(h.robotsRule)}</pre>` : ""
              }<small class="mono">e.g. ${esc(h.examples[0])}</small></li>`
          )
          .join("")}</ul>`
      : `<p class="note">No parameter bloat, case/slash/protocol duplication, or infinite-space patterns detected.</p>`;

  const headerFails = audit.headerFindings.filter((h) => h.grade !== "pass");
  const headersHtml =
    headerFails.length > 0
      ? `<table><thead><tr><th>Grade</th><th>Check</th><th>URL</th><th>Detail</th></tr></thead><tbody>${headerFails
          .slice(0, 300)
          .map(
            (h) =>
              `<tr><td><span class="sev sev-${h.grade === "fail" ? "critical" : "medium"}">${esc(h.grade)}</span></td><td>${esc(h.check)}</td><td class="url">${esc(h.url)}</td><td>${esc(h.detail)}</td></tr>`
          )
          .join("")}</tbody></table>`
      : `<p class="note">No header findings recorded.</p>`;

  const redirectHtml =
    redirectMap.length > 0
      ? `<p>${redirectMap.length.toLocaleString()} redirects collapsed to final destinations (${redirectMap.filter((r) => r.hops > 1).length} were multi-hop chains).</p>
<table><thead><tr><th>Source</th><th>Final destination</th><th>Hops</th></tr></thead><tbody>${redirectMap
          .slice(0, 300)
          .map((r) => `<tr><td class="url">${esc(r.source)}</td><td class="url">${esc(r.finalDestination)}</td><td class="num">${r.hops}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p class="note">No redirects found in the crawl.</p>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AuditForge report${domain ? ` — ${esc(domain)}` : ""} — ${esc(created)}</title>
<style>
:root { --ink:#16202b; --muted:#6b7785; --line:#e3e8ee; --bg:#fff; --panel:#f7f9fb;
  --crit:#c0392b; --high:#c47000; --med:#1f6fb2; --low:#6b7785; --ok:#1a7f4b; --forge:#b45309; }
* { box-sizing: border-box; }
body { margin:0; padding:32px 20px 64px; background:var(--bg); color:var(--ink);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
.wrap { max-width:1100px; margin:0 auto; }
h1 { font-size:26px; margin:0 0 4px; letter-spacing:-.02em; }
h2 { font-size:13px; text-transform:uppercase; letter-spacing:.14em; color:var(--forge);
  border-bottom:1px solid var(--line); padding-bottom:7px; margin:38px 0 14px; }
h3 { font-size:14px; margin:20px 0 8px; }
.sub { color:var(--muted); font-size:13px; margin:0 0 22px; }
.cards { display:flex; flex-wrap:wrap; gap:10px; margin:16px 0; }
.card { flex:1 1 130px; border:1px solid var(--line); border-radius:6px; padding:12px 14px; background:var(--panel); }
.card .v { font-size:24px; font-weight:650; }
.card .l { font-size:10px; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin-top:3px; }
table { width:100%; border-collapse:collapse; margin:10px 0; font-size:13px; }
th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted);
  border-bottom:1px solid var(--line); padding:7px 8px; }
td { border-bottom:1px solid var(--line); padding:9px 8px; vertical-align:top; }
.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
.issue { font-weight:600; }
.url, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px; word-break:break-all; }
.url { color:var(--muted); }
.ev { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px;
  background:var(--panel); border:1px solid var(--line); border-radius:4px; padding:4px 6px; margin-top:5px; word-break:break-word; }
.ev.live { border-color:#cfe3d4; background:#f2f9f4; }
.ev.err { border-color:#f0d8d4; background:#fdf5f4; }
.ts { font-size:10.5px; color:var(--muted); }
.sev { display:inline-block; padding:2px 7px; border-radius:3px; font-size:10px; font-weight:700;
  text-transform:uppercase; letter-spacing:.06em; color:#fff; white-space:nowrap; }
.sev-critical,.sev-fail { background:var(--crit); } .sev-high { background:var(--high); }
.sev-medium,.sev-warn { background:var(--med); } .sev-low { background:var(--low); }
details { border:1px solid var(--line); border-radius:6px; padding:10px 14px; margin:10px 0; }
summary { cursor:pointer; font-weight:600; }
details.fix { margin-top:8px; background:var(--panel); font-size:12.5px; }
pre { background:#0f172a; color:#e2e8f0; padding:10px; border-radius:5px; overflow-x:auto;
  font-size:11.5px; white-space:pre-wrap; word-break:break-word; }
ul.mono li { margin:2px 0; }
.note { color:var(--muted); font-size:13px; font-style:italic; }
.banner { border:1px solid var(--line); background:var(--panel); border-radius:6px; padding:12px 14px; font-size:13px; }
footer { margin-top:44px; padding-top:14px; border-top:1px solid var(--line); color:var(--muted); font-size:11.5px; }
@media print { body { padding:0; } details { break-inside:avoid; } details:not([open]) > *:not(summary) { display:revert; } details { border:none; padding:0; } }
</style></head><body><div class="wrap">

<h1>Technical SEO audit${domain ? ` — ${esc(domain)}` : ""}</h1>
<p class="sub">Generated by AuditForge · audit ${esc(audit.meta.auditId)} · ${esc(created)} · ${audit.rows.length.toLocaleString()} URLs crawled<br>
Every issue below was re-fetched and re-checked against the live site before inclusion.</p>

<div class="cards">
<div class="card"><div class="v">${esc(grade)}</div><div class="l">Health grade</div></div>
<div class="card"><div class="v">${score}/100</div><div class="l">Health score</div></div>
<div class="card"><div class="v" style="color:var(--crit)">${confirmed.length.toLocaleString()}</div><div class="l">Confirmed issues</div></div>
<div class="card"><div class="v" style="color:var(--ok)">${resolved.length.toLocaleString()}</div><div class="l">Already fixed</div></div>
<div class="card"><div class="v">${unverifiable.length.toLocaleString()}</div><div class="l">Unverifiable</div></div>
</div>

<h2>Executive summary</h2>
${execHtml}

<h2>Verification log</h2>
<div class="banner">Each flagged URL was fetched live, with its HTML source re-parsed and compared against the crawl.
<b>${confirmed.length.toLocaleString()}</b> confirmed still present, <b>${resolved.length.toLocaleString()}</b> already fixed since the crawl,
<b>${unverifiable.length.toLocaleString()}</b> unverifiable — each listed below with its failure reason, never silently dropped.</div>
${unverifiable.length > 0 ? `<details><summary>Unverifiable items (${unverifiable.length.toLocaleString()})</summary>${issueRowsHtml(unverifiable, analyses)}</details>` : ""}
${moduleNotes.length > 0 ? `<h3>Run notes</h3><ul>${moduleNotes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}

<h2>Issues by severity</h2>
${sevSections || `<p class="note">No confirmed issues.</p>`}

<h2>Issues by owning team</h2>
${teamSections || `<p class="note">No confirmed issues.</p>`}

<h2>Sitemap intelligence</h2>
${sitemapHtml}

<h2>Internal link equity</h2>
${equityHtml}

<h2>Crawl budget &amp; URL hygiene</h2>
${hygieneHtml}

<h2>Security &amp; response headers</h2>
${headersHtml}

<h2>Redirect map</h2>
${redirectHtml}

<footer>AuditForge — accuracy over speed, evidence over assumption. Nothing in this report skipped the verification loop.<br>
This file is fully self-contained: no scripts, no tracking, no external requests, no expiry. Email it, share it, archive it, or host it anywhere.</footer>
</div></body></html>`;
}
