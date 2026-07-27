import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { GSC_COOKIE, getAccessToken, googlePost, gscConfigured } from "@/lib/gsc-server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GSC URL Inspection API — traces the *source* of an error URL:
 * which sitemaps Google found it in and which pages refer to it, plus the
 * coverage state ("URL is unknown to Google", "Crawled - currently not
 * indexed", …). Works with the webmasters.readonly scope already requested
 * at OAuth time, so no re-consent is needed.
 *
 * Google's quota is 2,000 inspections/day and 600/min per property — the
 * client caps how many URLs it sends per audit; this route additionally
 * paces calls sequentially with a small delay.
 */

const BodySchema = z.object({
  siteUrl: z.string().min(1),
  urls: z.array(z.string().url()).min(1).max(10),
});

interface InspectResult {
  url: string;
  sitemaps: string[];
  referringPages: string[];
  coverageState?: string;
  verdict?: string;
  lastCrawlTime?: string;
  error?: string;
}

const INSPECT_ENDPOINT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const PER_URL_DELAY_MS = 150;

export async function POST(req: NextRequest) {
  if (!gscConfigured()) {
    return NextResponse.json({ error: "GSC not configured on this deployment." }, { status: 501 });
  }
  const auth = await getAccessToken(req);
  if (!auth) return NextResponse.json({ error: "Not connected to Google Search Console." }, { status: 401 });

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Provide { siteUrl, urls: string[] } with 1–10 valid URLs." },
      { status: 400 }
    );
  }

  const results: InspectResult[] = [];
  for (let i = 0; i < body.urls.length; i++) {
    const url = body.urls[i];
    try {
      const res = await googlePost(auth.token, INSPECT_ENDPOINT, {
        inspectionUrl: url,
        siteUrl: body.siteUrl,
        languageCode: "en-US",
      });
      if (res.status === 401) {
        return NextResponse.json({ error: "Google session expired — reconnect Search Console." }, { status: 401 });
      }
      if (res.status === 403) {
        // Per-URL 403s happen when the URL sits outside the property — record and continue.
        results.push({ url, sitemaps: [], referringPages: [], error: "No inspection access for this URL in the selected property." });
      } else if (res.status === 429) {
        results.push({ url, sitemaps: [], referringPages: [], error: "GSC inspection quota hit (600/min or 2,000/day) — remaining URLs skipped." });
        // Quota exhausted: fail the rest fast instead of hammering the API.
        for (const rest of body.urls.slice(i + 1)) {
          results.push({ url: rest, sitemaps: [], referringPages: [], error: "Skipped after quota hit." });
        }
        break;
      } else if (!res.ok) {
        results.push({ url, sitemaps: [], referringPages: [], error: `Inspection API ${res.status}: ${(await res.text()).slice(0, 160)}` });
      } else {
        const data = (await res.json()) as {
          inspectionResult?: {
            indexStatusResult?: {
              verdict?: string;
              coverageState?: string;
              sitemap?: string[];
              referringUrls?: string[];
              lastCrawlTime?: string;
            };
          };
        };
        const idx = data.inspectionResult?.indexStatusResult;
        results.push({
          url,
          sitemaps: idx?.sitemap ?? [],
          referringPages: idx?.referringUrls ?? [],
          coverageState: idx?.coverageState,
          verdict: idx?.verdict,
          lastCrawlTime: idx?.lastCrawlTime,
        });
      }
    } catch (e) {
      results.push({ url, sitemaps: [], referringPages: [], error: e instanceof Error ? e.message : "Inspection failed" });
    }
    if (i < body.urls.length - 1) await new Promise((r) => setTimeout(r, PER_URL_DELAY_MS));
  }

  const out = NextResponse.json({ results });
  if (auth.resealed) {
    out.cookies.set(GSC_COOKIE, auth.resealed, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 180, path: "/" });
  }
  return out;
}
