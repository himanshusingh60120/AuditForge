"use client";
import { InlinkEdge } from "./parse";
import { Issue } from "./schema";

/**
 * Error-source tracing: for every confirmed broken URL, answer "where is this
 * URL coming from?" using two independent signals —
 *   1. the crawl link graph (All Inlinks export / project DB edges): which
 *      internal pages link to it, with anchor text;
 *   2. the GSC URL Inspection API: which sitemaps Google found it in and
 *      which referring pages Google knows, plus its coverage state.
 */

/** Rules whose findings are "a URL is broken" — the ones worth tracing. */
export const ERROR_SOURCE_RULES = new Set([
  "http-4xx",
  "http-5xx",
  "redirect-broken-target",
  "link-jump-check",
  "live-broken-link",
  "malformed-concatenated-url",
]);

const norm = (u: string) => u.replace(/\/$/, "");
const MAX_INLINK_SOURCES = 10;

/** Attach crawl-graph sources (needs the All Inlinks export or DB edges). Pure, cheap, offline. */
export function attachCrawlInlinkSources(issues: Issue[], edges: InlinkEdge[] | null | undefined): Issue[] {
  if (!edges || edges.length === 0) return issues;
  const wanted = new Set(
    issues.filter((i) => ERROR_SOURCE_RULES.has(i.ruleId)).map((i) => norm(i.url))
  );
  if (wanted.size === 0) return issues;

  const sourcesByTarget = new Map<string, string[]>();
  for (const e of edges) {
    const t = norm(e.target);
    if (!wanted.has(t)) continue;
    const list = sourcesByTarget.get(t) ?? [];
    if (list.length < MAX_INLINK_SOURCES) {
      const entry = e.anchor ? `${e.source} — anchor: "${e.anchor.slice(0, 60)}"` : e.source;
      if (!list.includes(entry)) list.push(entry);
    }
    sourcesByTarget.set(t, list);
  }
  if (sourcesByTarget.size === 0) return issues;

  return issues.map((i) => {
    const s = sourcesByTarget.get(norm(i.url));
    if (!s || s.length === 0) return i;
    const merged = [...(i.sourceInternalInlinks ?? [])];
    for (const entry of s) if (!merged.includes(entry)) merged.push(entry);
    return { ...i, sourceInternalInlinks: merged };
  });
}

interface GscInspectResult {
  url: string;
  sitemaps: string[];
  referringPages: string[];
  coverageState?: string;
  verdict?: string;
  error?: string;
}

export interface GscSourceTrace {
  issues: Issue[];
  inspected: number;
  withSources: number;
  failures: number;
}

/**
 * Attach GSC URL Inspection sources to confirmed error issues.
 * Highest-impact URLs first, unique, capped — Google's inspection quota is
 * 2,000/day per property, and one audit must never eat it.
 */
export async function attachGscSources(
  issues: Issue[],
  siteUrl: string,
  cap: number,
  onProgress: (done: number, total: number) => void
): Promise<GscSourceTrace> {
  const candidates = issues
    .filter((i) => ERROR_SOURCE_RULES.has(i.ruleId) && i.verification === "CONFIRMED")
    .sort((a, b) => b.impactScore - a.impactScore);

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const i of candidates) {
    if (!seen.has(i.url)) {
      seen.add(i.url);
      urls.push(i.url);
    }
    if (urls.length >= cap) break;
  }
  if (urls.length === 0) return { issues, inspected: 0, withSources: 0, failures: 0 };

  const resultByUrl = new Map<string, GscInspectResult>();
  let failures = 0;
  for (let b = 0; b < urls.length; b += 10) {
    const batch = urls.slice(b, b + 10);
    try {
      const res = await fetch("/api/gsc/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl, urls: batch }),
      });
      const data = (await res.json()) as { results?: GscInspectResult[]; error?: string };
      if (!res.ok || !data.results) throw new Error(data.error ?? `Inspect batch failed (${res.status})`);
      for (const r of data.results) {
        if (r.error) failures++;
        resultByUrl.set(norm(r.url), r);
      }
    } catch {
      failures += batch.length;
    }
    onProgress(Math.min(b + 10, urls.length), urls.length);
  }

  let withSources = 0;
  const out = issues.map((i) => {
    const r = resultByUrl.get(norm(i.url));
    if (!r || r.error) return i;
    if (r.sitemaps.length > 0 || r.referringPages.length > 0) withSources++;
    return {
      ...i,
      sourceSitemaps: r.sitemaps.length > 0 ? r.sitemaps : i.sourceSitemaps,
      sourceReferringPages: r.referringPages.length > 0 ? r.referringPages : i.sourceReferringPages,
      gscCoverageState: r.coverageState ?? i.gscCoverageState,
    };
  });
  return { issues: out, inspected: urls.length, withSources, failures };
}
