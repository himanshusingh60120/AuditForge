import { NextRequest, NextResponse } from "next/server";
import { GSC_COOKIE, getAccessToken, googleGet, gscConfigured } from "@/lib/gsc-server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!gscConfigured()) {
    return NextResponse.json({ error: "GSC not configured on this deployment." }, { status: 501 });
  }
  const auth = await getAccessToken(req);
  if (!auth) return NextResponse.json({ error: "Not connected to Google Search Console." }, { status: 401 });
  try {
    const res = await googleGet(auth.token, "https://www.googleapis.com/webmasters/v3/sites");
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ error: "Google session expired — reconnect." }, { status: 401 });
    }
    if (!res.ok) throw new Error(`GSC sites API ${res.status}`);
    const data = (await res.json()) as { siteEntry?: { siteUrl: string; permissionLevel: string }[] };
    const sites = (data.siteEntry ?? [])
      .filter((s) => s.permissionLevel !== "siteUnverifiedUser")
      .map((s) => s.siteUrl)
      .sort();
    const out = NextResponse.json({ sites });
    if (auth.resealed) {
      out.cookies.set(GSC_COOKIE, auth.resealed, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 180, path: "/" });
    }
    return out;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "GSC sites fetch failed" }, { status: 502 });
  }
}
