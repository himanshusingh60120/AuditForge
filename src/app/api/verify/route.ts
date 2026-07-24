import { NextRequest, NextResponse } from "next/server";
import { parse as parseHtml } from "node-html-parser";
import { checkRobots, parseRobotsTxt, RobotsGroup } from "@/lib/robots";
import { HeaderFinding, VerifyRequestSchema, VerifyResultItem } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

const UA = "Mozilla/5.0 (compatible; AuditForgeBot/1.0; SEO audit verification)";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HOPS = 5;

// Per-instance caches (fine for serverless: warm instances reuse, cold ones refetch)
const robotsCache = new Map<string, { groups: RobotsGroup[]; fetchedAt: number }>();

// Naive per-instance rate limit: max 30 batch requests/min per IP.
const rateBucket = new Map<string, { count: number; windowStart: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBucket.get(ip);
  if (!bucket || now - bucket.windowStart > 60_000) {
    rateBucket.set(ip, { count: 1, windowStart: now });
    return false;
  }
  bucket.count++;
  return bucket.count > 30;
}

async function fetchWithTimeout(url: string, method: "GET" | "HEAD" = "GET"): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getRobots(origin: string): Promise<RobotsGroup[]> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < 10 * 60_000) return cached.groups;
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`);
    const groups = res.ok ? parseRobotsTxt(await res.text()) : [];
    robotsCache.set(origin, { groups, fetchedAt: Date.now() });
    return groups;
  } catch {
    robotsCache.set(origin, { groups: [], fetchedAt: Date.now() });
    return [];
  }
}

interface LiveState {
  finalUrl: string;
  finalStatus: number;
  chain: string[];
  html: string;
  headers: Headers;
  title: string;
  metaDescription: string;
  metaRobots: string;
  canonical: string;
  canonicalRawLine: string;
  h1s: string[];
  mixedContentCount: number;
  hasJsonLd: boolean;
  internalLinks: string[];
  responseMs: number;
}

/** Follow redirects manually (max 5 hops), then parse the final HTML. Retries once on network failure. */
async function fetchLive(url: string): Promise<LiveState> {
  const attempt = async (): Promise<LiveState> => {
    const chain: string[] = [];
    let current = url;
    let res: Response | null = null;
    const started = Date.now();
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      res = await fetchWithTimeout(current);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        const next = new URL(loc, current).toString();
        chain.push(`${res.status} → ${next}`);
        if (hop === MAX_HOPS) throw new Error(`Redirect chain exceeded ${MAX_HOPS} hops`);
        current = next;
        continue;
      }
      break;
    }
    if (!res) throw new Error("No response");
    const responseMs = Date.now() - started;
    const contentType = res.headers.get("content-type") ?? "";
    const html = /html|xml/i.test(contentType) ? (await res.text()).slice(0, 2_000_000) : "";
    const root = html ? parseHtml(html) : null;

    const canonicalEl = root?.querySelector('link[rel="canonical"]');
    const canonicalRawLine =
      html.match(/<link[^>]*rel=["']canonical["'][^>]*>/i)?.[0] ?? "";
    const metaRobots =
      root?.querySelector('meta[name="robots" i]')?.getAttribute("content") ?? "";
    const isHttps = current.startsWith("https://");
    const mixedContentCount = isHttps
      ? (html.match(/(?:src|href)=["']http:\/\//gi) ?? []).length
      : 0;

    // Link-jump fuel: every same-origin <a href> in the live source (deduped, capped).
    const internalLinks: string[] = [];
    if (root) {
      const seen = new Set<string>();
      const pageOrigin = new URL(current).origin;
      for (const a of root.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href");
        if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
        try {
          const abs = new URL(href, current);
          abs.hash = "";
          const str = abs.toString();
          if (abs.origin === pageOrigin && !seen.has(str)) {
            seen.add(str);
            internalLinks.push(str);
          }
        } catch {
          /* malformed href */
        }
        if (internalLinks.length >= 300) break;
      }
    }

    return {
      finalUrl: current,
      finalStatus: res.status,
      chain,
      html,
      headers: res.headers,
      title: root?.querySelector("title")?.text.trim() ?? "",
      metaDescription:
        root?.querySelector('meta[name="description" i]')?.getAttribute("content")?.trim() ?? "",
      metaRobots,
      canonical: canonicalEl?.getAttribute("href")?.trim() ?? "",
      canonicalRawLine,
      h1s: (root?.querySelectorAll("h1") ?? []).map((h) => h.text.trim()),
      mixedContentCount,
      hasJsonLd: (root?.querySelectorAll('script[type="application/ld+json"]') ?? []).length > 0,
      internalLinks,
      responseMs,
    };
  };
  try {
    return await attempt();
  } catch (first) {
    // one retry on network failure
    try {
      return await attempt();
    } catch {
      throw first instanceof Error ? first : new Error("Fetch failed");
    }
  }
}

/** Module J: grade response headers on the fetch we already made — zero extra requests. */
function auditHeaders(url: string, headers: Headers, metaRobots: string): HeaderFinding[] {
  const findings: HeaderFinding[] = [];
  const get = (k: string) => headers.get(k) ?? "";
  const isHttps = url.startsWith("https://");

  if (isHttps) {
    findings.push(
      get("strict-transport-security")
        ? { url, check: "HSTS", grade: "pass", detail: get("strict-transport-security") }
        : { url, check: "HSTS", grade: "warn", detail: "No Strict-Transport-Security header" }
    );
  }
  const xRobots = get("x-robots-tag");
  if (xRobots) {
    const headerNoindex = /noindex/i.test(xRobots);
    const metaNoindex = /noindex/i.test(metaRobots);
    if (headerNoindex !== metaNoindex && (metaRobots || headerNoindex)) {
      findings.push({
        url,
        check: "X-Robots-Tag vs meta robots",
        grade: "fail",
        detail: `Header "${xRobots}" conflicts with meta robots "${metaRobots || "(absent)"}" — header-level directives silently win.`,
      });
    } else {
      findings.push({ url, check: "X-Robots-Tag", grade: "pass", detail: xRobots });
    }
  }
  const enc = get("content-encoding");
  findings.push(
    /br|gzip|zstd/.test(enc)
      ? { url, check: "Compression", grade: "pass", detail: enc }
      : { url, check: "Compression", grade: "warn", detail: "Response not compressed (no br/gzip)" }
  );
  const cache = get("cache-control");
  if (!cache) findings.push({ url, check: "Cache-Control", grade: "warn", detail: "No Cache-Control header" });
  const ct = get("content-type");
  if (ct && !/charset/i.test(ct) && /text\/html/i.test(ct))
    findings.push({ url, check: "Content-Type charset", grade: "warn", detail: `"${ct}" declares no charset` });
  return findings;
}

/** Compare the live state against the flagged rule → CONFIRMED / RESOLVED. */
function classify(
  ruleId: string,
  crawlEvidence: string,
  live: LiveState
): { status: "CONFIRMED" | "RESOLVED"; liveEvidence: string } {
  const confirmed = (ev: string) => ({ status: "CONFIRMED" as const, liveEvidence: ev });
  const resolved = (ev: string) => ({ status: "RESOLVED" as const, liveEvidence: ev });
  const s = live.finalStatus;
  const redirected = live.chain.length > 0;

  switch (ruleId) {
    case "http-4xx":
      return s >= 400 && s < 500 ? confirmed(`Live fetch: HTTP ${s}`) : resolved(`Live fetch now returns ${s}${redirected ? ` via ${live.chain.join(" ")}` : ""}`);
    case "http-5xx":
      return s >= 500 ? confirmed(`Live fetch: HTTP ${s}`) : resolved(`Live fetch now returns ${s}`);
    case "redirect-302": {
      const first = live.chain[0] ?? "";
      if (first.startsWith("302") || first.startsWith("307")) return confirmed(`Live: ${first}`);
      return resolved(redirected ? `Live: ${live.chain.join(" ")}` : `No longer redirects (HTTP ${s})`);
    }
    case "redirect-chain":
      return live.chain.length >= 2
        ? confirmed(`Live chain (${live.chain.length} hops): ${live.chain.join(" ")}`)
        : resolved(redirected ? `Single hop now: ${live.chain[0]}` : `No longer redirects (HTTP ${s})`);
    case "redirect-loop":
      return redirected && live.chain.length >= MAX_HOPS
        ? confirmed(`Still chaining at ${live.chain.length}+ hops: ${live.chain.slice(0, 3).join(" ")}…`)
        : resolved(`Chain now resolves: ${live.chain.join(" ") || `HTTP ${s}`}`);
    case "redirect-broken-target":
      return redirected && s >= 400
        ? confirmed(`Live: ${live.chain.join(" ")} → final HTTP ${s}`)
        : resolved(`Final destination now returns ${s}`);
    case "title-missing":
      return live.title === "" ? confirmed("Live source: no <title> content") : resolved(`Live <title>: "${live.title.slice(0, 90)}"`);
    case "title-long":
      return live.title.length > 60 ? confirmed(`Live title, ${live.title.length} chars: "${live.title.slice(0, 90)}"`) : resolved(`Live title now ${live.title.length} chars`);
    case "title-short":
      return live.title.length > 0 && live.title.length < 20 ? confirmed(`Live title, ${live.title.length} chars: "${live.title}"`) : resolved(`Live title now ${live.title.length} chars`);
    case "title-duplicate":
      // Duplication is cross-page; verify the title itself is unchanged.
      return crawlEvidence.includes(live.title) && live.title !== ""
        ? confirmed(`Live title unchanged: "${live.title.slice(0, 90)}"`)
        : resolved(`Live title changed to: "${live.title.slice(0, 90)}"`);
    case "meta-missing":
      return live.metaDescription === "" ? confirmed("Live source: no meta description") : resolved(`Live meta description present (${live.metaDescription.length} chars)`);
    case "meta-long":
      return live.metaDescription.length > 160 ? confirmed(`Live meta description ${live.metaDescription.length} chars`) : resolved(`Now ${live.metaDescription.length} chars`);
    case "meta-duplicate":
      return crawlEvidence.includes(live.metaDescription.slice(0, 60)) && live.metaDescription !== ""
        ? confirmed(`Live meta description unchanged`)
        : resolved("Live meta description changed");
    case "h1-missing":
      return live.h1s.length === 0 ? confirmed("Live source: no <h1> element") : resolved(`Live H1: "${live.h1s[0]?.slice(0, 90)}"`);
    case "h1-multiple":
      return live.h1s.length > 1
        ? confirmed(`Live source has ${live.h1s.length} H1s: ${live.h1s.slice(0, 2).map((h) => `"${h.slice(0, 50)}"`).join(", ")}`)
        : resolved(`Live source has ${live.h1s.length} H1`);
    case "h2-missing":
      return !/<h2[\s>]/i.test(live.html) ? confirmed("Live source: no <h2> elements") : resolved("Live source now contains H2s");
    case "canonical-missing":
      return live.canonical === ""
        ? confirmed("Live source: no <link rel=\"canonical\">")
        : resolved(`Live: ${live.canonicalRawLine || live.canonical}`);
    case "canonical-noindex-conflict": {
      const stillNoindex = /noindex/i.test(live.metaRobots);
      const stillCanonicalized = live.canonical !== "" && live.canonical.replace(/\/$/, "") !== live.finalUrl.replace(/\/$/, "");
      return stillNoindex && stillCanonicalized
        ? confirmed(`Live: ${live.canonicalRawLine} + <meta name="robots" content="${live.metaRobots}">`)
        : resolved(`Live signals: canonical="${live.canonical}", robots="${live.metaRobots || "(none)"}"`);
    }
    case "canonical-to-non-200":
    case "canonicalised":
      return live.canonical !== "" && live.canonical.replace(/\/$/, "") !== live.finalUrl.replace(/\/$/, "")
        ? confirmed(`Live: ${live.canonicalRawLine || `canonical → ${live.canonical}`}`)
        : resolved(`Live canonical: "${live.canonical || "(absent)"}"`);
    case "noindex-with-inlinks":
    case "blocked-with-inlinks":
      return /noindex/i.test(live.metaRobots)
        ? confirmed(`Live: <meta name="robots" content="${live.metaRobots}">`)
        : resolved(`Live meta robots: "${live.metaRobots || "(none)"}"`);
    case "slow-response":
      return live.responseMs > 1000
        ? confirmed(`Live fetch took ${(live.responseMs / 1000).toFixed(2)}s`)
        : resolved(`Live fetch took ${(live.responseMs / 1000).toFixed(2)}s`);
    case "thin-content": {
      const text = live.html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ");
      const words = text.split(/\s+/).filter(Boolean).length;
      return words < 150 ? confirmed(`Live body ≈ ${words} words`) : resolved(`Live body ≈ ${words} words`);
    }
    case "link-jump-check":
      return s >= 400
        ? confirmed(`Live fetch: HTTP ${s} — this URL was discovered in another page's live source, not in the crawl`)
        : resolved(`Live fetch: HTTP ${s}${redirected ? ` via ${live.chain.join(" ")}` : ""}`);
    default:
      // Rules verified structurally (orphans, depth) can't change via a single live fetch:
      // confirm that the page is still live and indexable-looking, keep crawl evidence.
      return s === 200
        ? confirmed(`Page live (HTTP 200); structural finding from crawl stands: ${crawlEvidence}`)
        : resolved(`Page no longer returns 200 (now ${s}); re-crawl to reassess`);
  }
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Rate limit exceeded. Slow down and retry." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = VerifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request: " + parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }
  const { items, delayMs } = parsed.data;

  const results: VerifyResultItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const origin = new URL(item.url).origin;
      const robots = await getRobots(origin);
      const verdict = checkRobots(robots, new URL(item.url).pathname + new URL(item.url).search);
      if (!verdict.allowed) {
        results.push({
          issueId: item.issueId,
          status: "UNVERIFIABLE",
          liveEvidence: "",
          verifyError: `Blocked by robots.txt (${verdict.matchedRule}) — AuditForge respects crawl directives.`,
        });
      } else {
        const live = await fetchLive(item.url);
        const { status, liveEvidence } = classify(item.ruleId, item.crawlEvidence, live);
        results.push({
          issueId: item.issueId,
          status,
          liveEvidence,
          finalStatusCode: live.finalStatus,
          redirectChain: live.chain,
          headerFindings: auditHeaders(item.url, live.headers, live.metaRobots),
          mixedContentCount: live.mixedContentCount,
          hasJsonLd: live.hasJsonLd,
          internalLinks: live.internalLinks,
        });
      }
    } catch (e) {
      results.push({
        issueId: item.issueId,
        status: "UNVERIFIABLE",
        liveEvidence: "",
        verifyError: e instanceof Error ? e.message : "Fetch failed",
      });
    }
    if (i < items.length - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return NextResponse.json({ results });
}
