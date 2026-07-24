import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const UA = "Mozilla/5.0 (compatible; AuditForgeBot/1.0; SEO audit verification)";
const MAX_SITEMAPS = 20;
const MAX_URLS = 50_000;

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extract(tag: string, xml: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

export async function POST(req: NextRequest) {
  let sitemapUrl: string;
  try {
    const body = (await req.json()) as { url?: string };
    if (!body.url || !/^https?:\/\//i.test(body.url)) throw new Error();
    sitemapUrl = body.url;
  } catch {
    return NextResponse.json({ error: "Provide { url: 'https://…/sitemap.xml' }" }, { status: 400 });
  }

  const urls: string[] = [];
  const warnings: string[] = [];
  const queue = [sitemapUrl];
  let fetched = 0;
  try {
    while (queue.length > 0 && fetched < MAX_SITEMAPS && urls.length < MAX_URLS) {
      const current = queue.shift()!;
      fetched++;
      let xml: string;
      try {
        xml = await fetchText(current);
      } catch (e) {
        warnings.push(e instanceof Error ? e.message : `Failed fetching ${current}`);
        continue;
      }
      if (/<sitemapindex/i.test(xml)) {
        for (const entry of extract("sitemap", xml)) {
          const loc = extract("loc", entry)[0]?.trim();
          if (loc) queue.push(loc);
        }
      } else {
        const entries = extract("url", xml);
        for (const entry of entries) {
          const loc = extract("loc", entry)[0]?.trim();
          if (loc && urls.length < MAX_URLS) urls.push(loc);
          const lastmod = extract("lastmod", entry)[0]?.trim();
          if (lastmod) {
            const d = new Date(lastmod);
            if (isNaN(d.getTime()) || d.getTime() > Date.now() + 86_400_000) {
              if (warnings.length < 20)
                warnings.push(`Implausible <lastmod> "${lastmod}" for ${loc}`);
            }
          }
        }
        if (entries.length > 50_000) warnings.push(`${current} exceeds the 50,000-URL sitemap limit (${entries.length}).`);
        if (xml.length > 50 * 1024 * 1024) warnings.push(`${current} exceeds the 50MB uncompressed sitemap limit.`);
      }
    }
    if (queue.length > 0) warnings.push(`Stopped after ${MAX_SITEMAPS} sitemap files; ${queue.length} unfetched.`);
    return NextResponse.json({ urls, warnings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Sitemap fetch failed" }, { status: 502 });
  }
}
