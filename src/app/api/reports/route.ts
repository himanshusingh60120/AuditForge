import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

export async function POST(req: NextRequest) {
  if (!kvConfigured()) {
    return NextResponse.json(
      {
        error:
          "Sharing requires Vercel KV. Set KV_REST_API_URL and KV_REST_API_TOKEN (see README). You can still export the audit JSON and re-import it anywhere.",
      },
      { status: 501 }
    );
  }
  try {
    const { kv } = await import("@vercel/kv");
    const body = await req.text();
    if (body.length > 4_000_000) {
      return NextResponse.json(
        { error: "Audit too large to share via KV (>4MB). Export JSON instead." },
        { status: 413 }
      );
    }
    const slug = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    await kv.set(`auditforge:report:${slug}`, body, { ex: 60 * 60 * 24 * 90 });
    return NextResponse.json({ slug });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to store report" }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug || !/^[a-f0-9]{20}$/.test(slug)) {
    return NextResponse.json({ error: "Invalid slug." }, { status: 400 });
  }
  if (!kvConfigured()) {
    return NextResponse.json({ error: "Sharing not configured on this deployment." }, { status: 501 });
  }
  try {
    const { kv } = await import("@vercel/kv");
    const data = await kv.get<string>(`auditforge:report:${slug}`);
    if (!data) return NextResponse.json({ error: "Report not found or expired." }, { status: 404 });
    return new NextResponse(typeof data === "string" ? data : JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load report" }, { status: 502 });
  }
}
