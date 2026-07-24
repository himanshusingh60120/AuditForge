import { NextRequest, NextResponse } from "next/server";
import { GSC_COOKIE, getAccessToken, googlePost, gscConfigured } from "@/lib/gsc-server";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Pull per-URL clicks / impressions / CTR / position for the last 28 days. */
export async function POST(req: NextRequest) {
  if (!gscConfigured()) {
    return NextResponse.json({ error: "GSC not configured on this deployment." }, { status: 501 });
  }
  const auth = await getAccessToken(req);
  if (!auth) return NextResponse.json({ error: "Not connected to Google Search Console." }, { status: 401 });

  let siteUrl: string;
  try {
    const body = (await req.json()) as { siteUrl?: string };
    if (!body.siteUrl) throw new Error();
    siteUrl = body.siteUrl;
  } catch {
    return NextResponse.json({ error: "Provide { siteUrl } (a property from /api/gsc/sites)." }, { status: 400 });
  }

  try {
    const end = new Date(Date.now() - 86_400_000); // yesterday (GSC data lags)
    const start = new Date(end.getTime() - 28 * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const rows: { url: string; clicks: number; impressions: number; ctr: number; position: number }[] = [];
    let startRow = 0;
    // Paginate: 25k rows per call, up to 3 pages (75k URLs) — plenty for one property.
    for (let page = 0; page < 3; page++) {
      const res = await googlePost(
        auth.token,
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        { startDate: fmt(start), endDate: fmt(end), dimensions: ["page"], rowLimit: 25000, startRow }
      );
      if (res.status === 401 || res.status === 403) {
        return NextResponse.json({ error: "Google session expired or no access to this property — reconnect." }, { status: 401 });
      }
      if (!res.ok) throw new Error(`GSC query API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as {
        rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[];
      };
      const batch = data.rows ?? [];
      for (const r of batch) {
        rows.push({
          url: r.keys[0],
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: Math.round(r.ctr * 10000) / 100,
          position: Math.round(r.position * 10) / 10,
        });
      }
      if (batch.length < 25000) break;
      startRow += 25000;
    }
    const out = NextResponse.json({ rows, window: { start: fmt(start), end: fmt(end) } });
    if (auth.resealed) {
      out.cookies.set(GSC_COOKIE, auth.resealed, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 180, path: "/" });
    }
    return out;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "GSC query failed" }, { status: 502 });
  }
}
