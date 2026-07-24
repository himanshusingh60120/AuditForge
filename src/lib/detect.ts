import { CrawlRow, Issue, Owner, Severity } from "./schema";

interface RuleDef {
  id: string;
  label: string;
  severity: Severity;
  owner: Owner;
  /** Rules that need cross-row context receive the index maps. */
  test: (row: CrawlRow, ctx: DetectContext) => string | null; // returns evidence or null
}

export interface DetectContext {
  byUrl: Map<string, CrawlRow>;
  titleCounts: Map<string, number>;
  metaCounts: Map<string, number>;
  isHtml: (r: CrawlRow) => boolean;
}

const isIndexable = (r: CrawlRow) => /indexable/i.test(r.indexability) && !/non-?indexable/i.test(r.indexability);
const isNoindex = (r: CrawlRow) => /noindex/i.test(r.metaRobots) || /noindex/i.test(r.indexabilityStatus);
const norm = (u: string) => u.replace(/\/$/, "").toLowerCase();

export const RULES: RuleDef[] = [
  {
    id: "http-4xx",
    label: "4xx client error",
    severity: "Critical",
    owner: "Dev",
    test: (r) => (r.statusCode >= 400 && r.statusCode < 500 ? `HTTP ${r.statusCode}, ${r.inlinks} internal inlinks` : null),
  },
  {
    id: "http-5xx",
    label: "5xx server error",
    severity: "Critical",
    owner: "Dev",
    test: (r) => (r.statusCode >= 500 ? `HTTP ${r.statusCode}` : null),
  },
  {
    id: "redirect-302",
    label: "Temporary redirect (302) that should likely be 301",
    severity: "Medium",
    owner: "Dev",
    test: (r) =>
      r.statusCode === 302 || /302|temporary/i.test(r.redirectType)
        ? `302 → ${r.redirectUrl || "(unknown target)"}`
        : null,
  },
  {
    id: "redirect-chain",
    label: "Redirect chain (redirect pointing at another redirect)",
    severity: "High",
    owner: "Dev",
    test: (r, ctx) => {
      if (!(r.statusCode >= 300 && r.statusCode < 400) || !r.redirectUrl) return null;
      const next = ctx.byUrl.get(r.redirectUrl);
      if (next && next.statusCode >= 300 && next.statusCode < 400) {
        return `${r.url} → ${r.redirectUrl} → ${next.redirectUrl || "(further redirect)"}`;
      }
      return null;
    },
  },
  {
    id: "redirect-loop",
    label: "Redirect loop",
    severity: "Critical",
    owner: "Dev",
    test: (r, ctx) => {
      if (!(r.statusCode >= 300 && r.statusCode < 400) || !r.redirectUrl) return null;
      const seen = new Set<string>([norm(r.url)]);
      let cur = r.redirectUrl;
      for (let hop = 0; hop < 6; hop++) {
        if (seen.has(norm(cur))) return `Loop detected via ${cur}`;
        seen.add(norm(cur));
        const next = ctx.byUrl.get(cur);
        if (!next || !(next.statusCode >= 300 && next.statusCode < 400) || !next.redirectUrl) return null;
        cur = next.redirectUrl;
      }
      return null;
    },
  },
  {
    id: "redirect-broken-target",
    label: "Redirect pointing at a 4xx/5xx URL",
    severity: "Critical",
    owner: "Dev",
    test: (r, ctx) => {
      if (!(r.statusCode >= 300 && r.statusCode < 400) || !r.redirectUrl) return null;
      const t = ctx.byUrl.get(r.redirectUrl);
      return t && t.statusCode >= 400 ? `Redirects to ${r.redirectUrl} which returns ${t.statusCode}` : null;
    },
  },
  {
    id: "title-missing",
    label: "Missing title",
    severity: "High",
    owner: "Content",
    test: (r, ctx) => (ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && !r.title ? "Title tag empty or absent" : null),
  },
  {
    id: "title-duplicate",
    label: "Duplicate title",
    severity: "Medium",
    owner: "Content",
    test: (r, ctx) => {
      if (!ctx.isHtml(r) || r.statusCode !== 200 || !r.title || !isIndexable(r)) return null;
      const c = ctx.titleCounts.get(r.title) ?? 0;
      return c > 1 ? `"${r.title}" shared by ${c} indexable URLs` : null;
    },
  },
  {
    id: "title-long",
    label: "Title too long (> 60 chars)",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) => (ctx.isHtml(r) && r.statusCode === 200 && r.titleLength > 60 ? `${r.titleLength} chars: "${r.title.slice(0, 90)}"` : null),
  },
  {
    id: "title-short",
    label: "Title too short (< 20 chars)",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && r.title && r.titleLength < 20
        ? `${r.titleLength} chars: "${r.title}"`
        : null,
  },
  {
    id: "meta-missing",
    label: "Missing meta description",
    severity: "Medium",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && !r.metaDescription ? "Meta description absent" : null,
  },
  {
    id: "meta-duplicate",
    label: "Duplicate meta description",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) => {
      if (!ctx.isHtml(r) || r.statusCode !== 200 || !r.metaDescription || !isIndexable(r)) return null;
      const c = ctx.metaCounts.get(r.metaDescription) ?? 0;
      return c > 1 ? `Shared by ${c} URLs: "${r.metaDescription.slice(0, 80)}…"` : null;
    },
  },
  {
    id: "meta-long",
    label: "Meta description too long (> 160 chars)",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) => (ctx.isHtml(r) && r.statusCode === 200 && r.metaLength > 160 ? `${r.metaLength} chars` : null),
  },
  {
    id: "h1-missing",
    label: "Missing H1",
    severity: "Medium",
    owner: "Content",
    test: (r, ctx) => (ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && !r.h1 ? "No H1 found on page" : null),
  },
  {
    id: "h1-multiple",
    label: "Multiple H1s",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.h1 && r.h1Second ? `H1 #1: "${r.h1.slice(0, 60)}" · H1 #2: "${r.h1Second.slice(0, 60)}"` : null,
  },
  {
    id: "h2-missing",
    label: "No H2 structure on substantial page",
    severity: "Low",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && !r.h2 && r.wordCount > 600
        ? `${r.wordCount} words with no H2 headings`
        : null,
  },
  {
    id: "canonical-missing",
    label: "Missing canonical on indexable page",
    severity: "Medium",
    owner: "Dev",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && !r.canonical ? "No <link rel=\"canonical\"> present" : null,
  },
  {
    id: "canonical-noindex-conflict",
    label: "Canonicalized page also noindexed (conflicting signals)",
    severity: "High",
    owner: "Dev",
    test: (r) =>
      r.canonical && norm(r.canonical) !== norm(r.url) && isNoindex(r)
        ? `canonical → ${r.canonical} AND meta robots: ${r.metaRobots || r.indexabilityStatus}`
        : null,
  },
  {
    id: "canonical-to-non-200",
    label: "Canonical pointing at a non-200 URL",
    severity: "High",
    owner: "Dev",
    test: (r, ctx) => {
      if (!r.canonical) return null;
      const t = ctx.byUrl.get(r.canonical);
      return t && t.statusCode !== 200 ? `canonical → ${r.canonical} (returns ${t.statusCode})` : null;
    },
  },
  {
    id: "canonicalised",
    label: "Canonicalized to a different URL (verify intent)",
    severity: "Low",
    owner: "SEO",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && r.canonical && norm(r.canonical) !== norm(r.url)
        ? `canonical → ${r.canonical}`
        : null,
  },
  {
    id: "noindex-with-inlinks",
    label: "Noindexed page receiving internal links",
    severity: "High",
    owner: "SEO",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isNoindex(r) && r.inlinks >= 5
        ? `noindex (${r.metaRobots || r.indexabilityStatus}) with ${r.inlinks} inlinks`
        : null,
  },
  {
    id: "blocked-with-inlinks",
    label: "Blocked by robots.txt but receiving internal links",
    severity: "Medium",
    owner: "SEO",
    test: (r) =>
      /blocked by robots/i.test(r.indexabilityStatus) && r.inlinks >= 3
        ? `${r.indexabilityStatus}, ${r.inlinks} inlinks`
        : null,
  },
  {
    id: "orphan-in-crawl",
    label: "Page with zero internal inlinks",
    severity: "Medium",
    owner: "SEO",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && r.inlinks === 0 && r.crawlDepth > 0
        ? "0 internal inlinks (reachable only via sitemap/start URL)"
        : null,
  },
  {
    id: "deep-page",
    label: "Deep page (crawl depth > 4)",
    severity: "Low",
    owner: "SEO",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && r.crawlDepth > 4
        ? `Crawl depth ${r.crawlDepth}`
        : null,
  },
  {
    id: "thin-content",
    label: "Thin content",
    severity: "Medium",
    owner: "Content",
    test: (r, ctx) =>
      ctx.isHtml(r) && r.statusCode === 200 && isIndexable(r) && r.wordCount > 0 && r.wordCount < 150
        ? `${r.wordCount} words`
        : null,
  },
  {
    id: "slow-response",
    label: "Slow server response (> 1s TTFB)",
    severity: "Medium",
    owner: "Dev",
    test: (r) => (r.statusCode === 200 && r.responseTime > 1 ? `${r.responseTime.toFixed(2)}s response time` : null),
  },
];

export function detectIssues(rows: CrawlRow[]): Issue[] {
  const byUrl = new Map<string, CrawlRow>();
  const titleCounts = new Map<string, number>();
  const metaCounts = new Map<string, number>();
  const isHtml = (r: CrawlRow) => r.contentType === "" || /html/i.test(r.contentType);

  for (const r of rows) {
    byUrl.set(r.url, r);
    if (isHtml(r) && r.statusCode === 200 && isIndexable(r)) {
      if (r.title) titleCounts.set(r.title, (titleCounts.get(r.title) ?? 0) + 1);
      if (r.metaDescription) metaCounts.set(r.metaDescription, (metaCounts.get(r.metaDescription) ?? 0) + 1);
    }
  }
  const ctx: DetectContext = { byUrl, titleCounts, metaCounts, isHtml };

  const issues: Issue[] = [];
  for (const row of rows) {
    for (const rule of RULES) {
      let evidence: string | null = null;
      try {
        evidence = rule.test(row, ctx);
      } catch {
        evidence = null; // a single bad row must never kill detection
      }
      if (evidence) {
        issues.push({
          id: `${rule.id}::${row.url}`,
          ruleId: rule.id,
          ruleLabel: rule.label,
          severity: rule.severity,
          owner: rule.owner,
          url: row.url,
          evidence,
          verification: "PENDING",
          impactScore: 0,
          fixStatus: "Open",
        });
      }
    }
  }
  return issues;
}
