import fs from "node:fs";
import { buildStandaloneReport } from "@/lib/report-html";
import { AuditState, Issue } from "@/lib/schema";

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "http-4xx::https://x.com/a", ruleId: "http-4xx", ruleLabel: "4xx client error",
  severity: "Critical", owner: "Dev", url: "https://x.com/a",
  evidence: 'HTTP 404, 12 internal inlinks', liveEvidence: 'Live fetch: HTTP 404',
  verification: "CONFIRMED", verifiedAt: new Date().toISOString(),
  impactScore: 42.5, fixStatus: "Open", gscClicks: 30, gscImpressions: 900, ...over,
});

const audit: AuditState = {
  meta: { createdAt: new Date().toISOString(), name: "t", auditId: "abc123" },
  rows: [{ url: "https://x.com/", statusCode: 200, indexability: "Indexable", indexabilityStatus: "",
    title: "T", titleLength: 1, metaDescription: "", metaLength: 0, h1: "", h1Second: "", h2: "",
    canonical: "", metaRobots: "", wordCount: 10, crawlDepth: 0, inlinks: 1, outlinks: 1,
    responseTime: 0.1, contentType: "text/html", redirectUrl: "", redirectType: "" }],
  issues: [issue(), issue({ id: "b", severity: "High", verification: "RESOLVED", url: "https://x.com/b" }),
    issue({ id: "c", severity: "Medium", verification: "UNVERIFIABLE", verifyError: "timeout", url: "https://x.com/c" })],
  headerFindings: [{ url: "https://x.com/a", check: "HSTS", grade: "warn", detail: "missing" }],
  gsc: [], sitemapUrls: [], inlinksLoaded: false, parseWarnings: [],
  analyses: [{ ruleId: "http-4xx", explanation: "Broken pages waste equity.", rootCause: "Deleted pages",
    fixSteps: ["Restore or 301"], codeSnippet: 'location /a { return 301 /b; }', effort: "S", owner: "Dev" }],
  execSummary: { grade: "C", narrative: "Site needs work.", topPriorities: ["Fix 404s"],
    projectedImpact: "Recover equity.", actionPlan30Day: ["Week 1: 404s"] },
};

const html = buildStandaloneReport({ audit, hygiene: [], sitemapDiff: null,
  redirectMap: [{ source: "https://x.com/o", finalDestination: "https://x.com/n", hops: 2 }],
  moduleNotes: ["Module C skipped: no sitemap"] });

// Self-contained: no external requests of any kind
for (const bad of ["<script", "src=\"http", "href=\"http://cdn", "@import", "url(http"]) {
  if (html.includes(bad)) throw new Error(`report is not self-contained, found: ${bad}`);
}
if (!html.startsWith("<!DOCTYPE html>")) throw new Error("not a full document");
for (const must of ["4xx client error", "Live fetch: HTTP 404", "Executive summary", "Verification log",
  "Broken pages waste equity", "location /a { return 301 /b; }", "timeout", "Redirect map"]) {
  if (!html.includes(must)) throw new Error(`missing content: ${must}`);
}
// XSS: evidence containing markup must be escaped, not rendered
const xss = buildStandaloneReport({ audit: { ...audit,
  issues: [issue({ evidence: '<script>alert(1)</script><img src=x onerror=y>' })] },
  hygiene: [], sitemapDiff: null, redirectMap: [], moduleNotes: [] });
if (xss.includes("<script>alert(1)")) throw new Error("XSS: unescaped evidence");
if (!xss.includes("&lt;script&gt;alert(1)")) throw new Error("escaping did not run");
fs.writeFileSync("/tmp/sample-report.html", html);
console.log(`standalone HTML report: PASS (${(html.length / 1024).toFixed(1)}KB, self-contained, escaped)`);
