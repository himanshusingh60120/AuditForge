import { NextRequest, NextResponse } from "next/server";
import { GSC_COOKIE, GSC_STATE_COOKIE, GscTokens, gscConfigured, redirectUri, requestOrigin, seal } from "@/lib/gsc-server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const home = (q: string) => NextResponse.redirect(`${requestOrigin(req)}/?${q}`);
  if (!gscConfigured()) return home("gsc=error&reason=not-configured");

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = req.cookies.get(GSC_STATE_COOKIE)?.value;
  if (!code || !state || !expected || state !== expected) {
    return home("gsc=error&reason=" + encodeURIComponent(req.nextUrl.searchParams.get("error") ?? "state-mismatch"));
  }
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(req),
      }),
    });
    if (!res.ok) throw new Error(`token exchange ${res.status}`);
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    const tokens: GscTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    const out = home("gsc=connected");
    out.cookies.set(GSC_COOKIE, seal(tokens), {
      httpOnly: true,
      secure: requestOrigin(req).startsWith("https"),
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 180,
      path: "/",
    });
    out.cookies.delete(GSC_STATE_COOKIE);
    return out;
  } catch (e) {
    return home("gsc=error&reason=" + encodeURIComponent(e instanceof Error ? e.message : "exchange-failed"));
  }
}
