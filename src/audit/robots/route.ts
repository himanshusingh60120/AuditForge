import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let origin: string;
  try {
    const body = (await req.json()) as { origin?: string };
    origin = new URL(body.origin ?? "").origin;
  } catch {
    return NextResponse.json({ error: "Provide { origin: 'https://example.com' }" }, { status: 400 });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AuditForgeBot/1.0)" },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = res.ok ? await res.text() : "";
    return NextResponse.json({ text, status: res.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "robots.txt fetch failed" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
