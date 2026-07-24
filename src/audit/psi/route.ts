import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Module B skipped: PAGESPEED_API_KEY is not set." },
      { status: 501 }
    );
  }
  let url: string;
  try {
    const body = (await req.json()) as { url?: string };
    if (!body.url || !/^https?:\/\//i.test(body.url)) throw new Error();
    url = body.url;
  } catch {
    return NextResponse.json({ error: "Provide { url }" }, { status: 400 });
  }
  try {
    const api = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
    api.searchParams.set("url", url);
    api.searchParams.set("key", key);
    api.searchParams.set("strategy", "mobile");
    api.searchParams.append("category", "performance");
    const res = await fetch(api.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error(`PSI API ${res.status}`);
    const data = await res.json();
    const metric = (id: string): number | null =>
      data?.loadingExperience?.metrics?.[id]?.percentile ?? null;
    const audit = (id: string) => data?.lighthouseResult?.audits?.[id];
    const clsField = metric("CUMULATIVE_LAYOUT_SHIFT_SCORE");
    const opportunities = Object.values(data?.lighthouseResult?.audits ?? {})
      .filter(
        (a): a is { title: string; details?: { type?: string; overallSavingsMs?: number } } =>
          typeof a === "object" &&
          a !== null &&
          (a as { details?: { type?: string } }).details?.type === "opportunity"
      )
      .map((a) => ({ title: a.title, savingsMs: a.details?.overallSavingsMs ?? 0 }))
      .filter((o) => o.savingsMs > 100)
      .sort((a, b) => b.savingsMs - a.savingsMs)
      .slice(0, 5);
    return NextResponse.json({
      url,
      field: {
        lcpMs: metric("LARGEST_CONTENTFUL_PAINT_MS"),
        inpMs: metric("INTERACTION_TO_NEXT_PAINT"),
        cls: clsField != null ? clsField / 100 : null,
      },
      lab: {
        lcpMs: audit("largest-contentful-paint")?.numericValue ?? null,
        cls: audit("cumulative-layout-shift")?.numericValue ?? null,
        performanceScore: Math.round((data?.lighthouseResult?.categories?.performance?.score ?? 0) * 100),
      },
      opportunities,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "PSI failed" }, { status: 502 });
  }
}
