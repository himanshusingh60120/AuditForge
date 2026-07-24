import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { GSC_SCOPE, GSC_STATE_COOKIE, gscConfigured, redirectUri } from "@/lib/gsc-server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!gscConfigured()) {
    return NextResponse.json(
      { error: "GSC connection not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see README). The GSC CSV upload still works." },
      { status: 501 }
    );
  }
  const state = randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: GSC_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  const res = NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  res.cookies.set(GSC_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
