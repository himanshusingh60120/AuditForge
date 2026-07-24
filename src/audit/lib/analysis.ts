import { InlinkEdge } from "./parse";
import {
  AuditState,
  CrawlRow,
  GscRow,
  Issue,
  PagerankReport,
  SEVERITY_WEIGHT,
} from "./schema";

/**
 * Impact Score = severity weight × log2(2 + traffic signal) — the +2 floor keeps
 * zero-signal findings (e.g. link-jump discoveries) from sorting to the very bottom.
 * With GSC data: signal = clicks×10 + impressions×0.1. Without: internal inlinks.
 * Sorting the report by this makes teams fix what actually loses money first.
 */
export function computeImpactScores(
  issues: Issue[],
  rows: CrawlRow[],
  gsc: GscRow[]
): Issue[] {
  const inlinksByUrl = new Map(rows.map((r) => [r.url, r.inlinks]));
  const gscByUrl = new Map(gsc.map((g) => [g.url.replace(/\/$/, ""), g]));
  return issues.map((issue) => {
    const g = gscByUrl.get(issue.url.replace(/\/$/, ""));
    const signal = g
      ? g.clicks * 10 + g.impressions * 0.1
      : (inlinksByUrl.get(issue.url) ?? 0);
    return {
      ...issue,
      gscClicks: g?.clicks,
      gscImpressions: g?.impressions,
      impactScore: Math.round(SEVERITY_WEIGHT[issue.severity] * Math.log2(2 + signal) * 10) / 10,
    };
  });
}

/** Pages with impressions but Critical confirmed issues, and indexed pages returning errors. */
export function findMoneyLeaks(issues: Issue[], gsc: GscRow[]): Issue[] {
  const gscByUrl = new Map(gsc.map((g) => [g.url.replace(/\/$/, ""), g]));
  return issues.filter((i) => {
    const g = gscByUrl.get(i.url.replace(/\/$/, ""));
    if (!g || g.impressions === 0) return false;
    return i.severity === "Critical" && i.verification === "CONFIRMED";
  });
}

export function healthScore(issues: Issue[], totalUrls: number): number {
  if (totalUrls === 0) return 100;
  const penalty = issues
    .filter((i) => i.verification === "CONFIRMED" || i.verification === "PENDING")
    .reduce((sum, i) => sum + SEVERITY_WEIGHT[i.severity], 0);
  return Math.max(0, Math.round(100 - (penalty / totalUrls) * 12));
}

export function healthGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

// ---------- Module F: delta audits ----------
export interface DeltaReport {
  newIssues: Issue[];
  fixedIssues: Issue[];
  regressed: Issue[];
  previousHealth: number;
  currentHealth: number;
}

export function computeDelta(previous: AuditState, current: AuditState): DeltaReport {
  const prevMap = new Map(previous.issues.map((i) => [i.id, i]));
  const curMap = new Map(current.issues.map((i) => [i.id, i]));
  const newIssues = current.issues.filter(
    (i) => !prevMap.has(i.id) && i.verification !== "RESOLVED"
  );
  const fixedIssues = previous.issues.filter((i) => !curMap.has(i.id));
  const regressed = current.issues.filter((i) => {
    const prev = prevMap.get(i.id);
    return (
      prev !== undefined &&
      (prev.fixStatus === "Fixed-Verified" || prev.verification === "RESOLVED") &&
      i.verification === "CONFIRMED"
    );
  });
  return {
    newIssues,
    fixedIssues,
    regressed,
    previousHealth: healthScore(previous.issues, previous.rows.length),
    currentHealth: healthScore(current.issues, current.rows.length),
  };
}

// ---------- Module D: internal PageRank ----------
export function computePagerank(
  edges: InlinkEdge[],
  rows: CrawlRow[],
  iterations = 25,
  damping = 0.85
): PagerankReport {
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.source);
    nodes.add(e.target);
  }
  const nodeList = [...nodes];
  const index = new Map(nodeList.map((n, i) => [n, i]));
  const n = nodeList.length;
  if (n === 0) {
    return { topPages: [], equityLeaks: [], deadEnds: [], opportunities: [] };
  }
  const out: number[] = new Array(n).fill(0);
  const incoming: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    const s = index.get(e.source)!;
    const t = index.get(e.target)!;
    out[s]++;
    incoming[t].push(s);
  }
  let pr = new Array<number>(n).fill(1 / n);
  for (let it = 0; it < iterations; it++) {
    const next = new Array<number>(n).fill((1 - damping) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) if (out[i] === 0) dangling += pr[i];
    const danglingShare = (damping * dangling) / n;
    for (let t = 0; t < n; t++) {
      let sum = 0;
      for (const s of incoming[t]) sum += pr[s] / out[s];
      next[t] += damping * sum + danglingShare;
    }
    pr = next;
  }

  const prOf = (url: string) => pr[index.get(url) ?? -1] ?? 0;
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const topPages = nodeList
    .map((url) => ({ url, pr: prOf(url) }))
    .sort((a, b) => b.pr - a.pr)
    .slice(0, 25);

  // Equity leaks: links from high-PR sources to broken/redirecting URLs.
  const medianPr = [...pr].sort((a, b) => a - b)[Math.floor(n / 2)] ?? 0;
  const equityLeaks = edges
    .filter((e) => {
      const target = byUrl.get(e.target);
      return target !== undefined && (target.statusCode >= 300) && prOf(e.source) > medianPr;
    })
    .map((e) => {
      const target = byUrl.get(e.target)!;
      return {
        source: e.source,
        target: e.target,
        anchor: e.anchor,
        sourcePr: prOf(e.source),
        problem:
          target.statusCode >= 400
            ? `target returns ${target.statusCode}`
            : `target redirects (${target.statusCode}) → ${target.redirectUrl}`,
      };
    })
    .sort((a, b) => b.sourcePr - a.sourcePr)
    .slice(0, 50);

  const deadEnds = nodeList
    .filter((url) => {
      const i = index.get(url)!;
      const row = byUrl.get(url);
      return out[i] === 0 && row !== undefined && row.statusCode === 200 && /html/i.test(row.contentType || "html");
    })
    .map((url) => ({ url, pr: prOf(url) }))
    .sort((a, b) => b.pr - a.pr)
    .slice(0, 25);

  // Opportunities: indexable 200 pages starved of equity (below-median PR, few inlinks)
  // paired with the highest-PR topically-nearest source (shared first path segment).
  const starved = rows
    .filter(
      (r) =>
        r.statusCode === 200 &&
        /indexable/i.test(r.indexability) &&
        !/non-?indexable/i.test(r.indexability) &&
        prOf(r.url) <= medianPr &&
        r.inlinks <= 2
    )
    .sort((a, b) => b.wordCount - a.wordCount)
    .slice(0, 20);
  const seg = (u: string) => {
    try {
      return new URL(u).pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      return "";
    }
  };
  const opportunities = starved.map((target) => {
    const tseg = seg(target.url);
    const source =
      topPages.find((p) => p.url !== target.url && seg(p.url) === tseg) ?? topPages[0];
    const anchor = target.h1 || target.title || new URL(target.url).pathname;
    return {
      target: target.url,
      suggestedSource: source?.url ?? "(homepage)",
      anchor: anchor.slice(0, 70),
      reason: `Only ${target.inlinks} inlinks and below-median internal PageRank; ${
        source && seg(source.url) === tseg ? "topically related high-equity page available" : "route equity from a top page"
      }.`,
    };
  });

  return { topPages, equityLeaks, deadEnds, opportunities };
}
