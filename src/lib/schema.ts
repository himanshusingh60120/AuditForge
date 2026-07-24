import { z } from "zod";

/** One normalized crawl row. Every input format maps into this. */
export const CrawlRowSchema = z.object({
  url: z.string().url(),
  statusCode: z.number().int().min(0).max(999),
  indexability: z.string().default(""),
  indexabilityStatus: z.string().default(""),
  title: z.string().default(""),
  titleLength: z.number().int().nonnegative().default(0),
  metaDescription: z.string().default(""),
  metaLength: z.number().int().nonnegative().default(0),
  h1: z.string().default(""),
  h1Second: z.string().default(""),
  h2: z.string().default(""),
  canonical: z.string().default(""),
  metaRobots: z.string().default(""),
  wordCount: z.number().int().nonnegative().default(0),
  crawlDepth: z.number().int().default(0),
  inlinks: z.number().int().nonnegative().default(0),
  outlinks: z.number().int().nonnegative().default(0),
  responseTime: z.number().nonnegative().default(0),
  contentType: z.string().default(""),
  redirectUrl: z.string().default(""),
  redirectType: z.string().default(""),
});
export type CrawlRow = z.infer<typeof CrawlRowSchema>;

export const Severity = z.enum(["Critical", "High", "Medium", "Low"]);
export type Severity = z.infer<typeof Severity>;

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  Critical: 8,
  High: 4,
  Medium: 2,
  Low: 1,
};

export type Owner = "Dev" | "Content" | "SEO";

export type VerificationStatus =
  | "PENDING"
  | "CONFIRMED"
  | "RESOLVED"
  | "UNVERIFIABLE"
  | "SKIPPED";

export type FixStatus = "Open" | "In Progress" | "Fixed-Claimed" | "Fixed-Verified";

export interface Issue {
  id: string; // `${ruleId}::${url}`
  ruleId: string;
  ruleLabel: string;
  severity: Severity;
  owner: Owner;
  url: string;
  /** The actual value found in the crawl that triggered the rule. */
  evidence: string;
  /** Populated by the verification loop from live source. */
  liveEvidence?: string;
  verification: VerificationStatus;
  verifiedAt?: string;
  verifyError?: string;
  impactScore: number;
  fixStatus: FixStatus;
  gscClicks?: number;
  gscImpressions?: number;
}

export interface HeaderFinding {
  url: string;
  check: string;
  grade: "pass" | "warn" | "fail";
  detail: string;
}

export interface VerifyRequestItem {
  issueId: string;
  url: string;
  ruleId: string;
  crawlEvidence: string;
  expected?: string; // e.g. the canonical value the crawl saw
}

export interface VerifyResultItem {
  issueId: string;
  status: Exclude<VerificationStatus, "PENDING">;
  liveEvidence: string;
  verifyError?: string;
  finalStatusCode?: number;
  redirectChain?: string[];
  headerFindings?: HeaderFinding[];
  mixedContentCount?: number;
  hasJsonLd?: boolean;
  /** Same-origin links extracted from the live HTML — fuel for link-jump verification. */
  internalLinks?: string[];
}

export const VerifyRequestSchema = z.object({
  items: z
    .array(
      z.object({
        issueId: z.string().min(1),
        url: z.string().url(),
        ruleId: z.string().min(1),
        crawlEvidence: z.string().default(""),
        expected: z.string().optional(),
      })
    )
    .min(1)
    .max(10),
  delayMs: z.number().int().min(0).max(5000).default(300),
});

export const AnalyzeRequestSchema = z.object({
  groups: z
    .array(
      z.object({
        ruleId: z.string(),
        ruleLabel: z.string(),
        severity: Severity,
        count: z.number().int().positive(),
        sampleUrls: z.array(z.string()).max(5),
        sampleEvidence: z.array(z.string()).max(5),
      })
    )
    .min(1)
    .max(40),
  siteStats: z.object({
    totalUrls: z.number(),
    confirmed: z.number(),
    resolved: z.number(),
    unverifiable: z.number(),
    healthScore: z.number(),
  }),
});

export interface RuleAnalysis {
  ruleId: string;
  explanation: string;
  rootCause: string;
  fixSteps: string[];
  codeSnippet: string;
  effort: "S" | "M" | "L";
  owner: Owner;
}

export interface ExecSummary {
  grade: string;
  narrative: string;
  topPriorities: string[];
  projectedImpact: string;
  actionPlan30Day: string[];
}

export interface GscRow {
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface AuditState {
  meta: { createdAt: string; name: string; auditId: string };
  rows: CrawlRow[];
  issues: Issue[];
  headerFindings: HeaderFinding[];
  gsc: GscRow[];
  sitemapUrls: string[];
  inlinksLoaded: boolean;
  pagerank?: PagerankReport;
  analyses?: RuleAnalysis[];
  execSummary?: ExecSummary;
  parseWarnings: string[];
}

export interface PagerankReport {
  topPages: { url: string; pr: number }[];
  equityLeaks: { source: string; target: string; anchor: string; sourcePr: number; problem: string }[];
  deadEnds: { url: string; pr: number }[];
  opportunities: { target: string; suggestedSource: string; anchor: string; reason: string }[];
}

export function severityRank(s: Severity): number {
  return { Critical: 0, High: 1, Medium: 2, Low: 3 }[s];
}
