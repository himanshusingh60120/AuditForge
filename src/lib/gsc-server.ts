import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

/**
 * GSC OAuth without a database: tokens live in an AES-256-GCM-encrypted httpOnly
 * cookie, keyed off GOOGLE_CLIENT_SECRET. The browser stores the ciphertext; only
 * the server can read it.
 */

export const GSC_COOKIE = "af_gsc";
export const GSC_STATE_COOKIE = "af_gsc_state";
export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export interface GscTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
}

export function gscConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function key(): Buffer {
  return createHash("sha256")
    .update((process.env.GOOGLE_CLIENT_SECRET ?? "unset") + "::auditforge-cookie-key")
    .digest();
}

export function seal(obj: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");
}

export function unseal<T>(sealed: string | undefined): T | null {
  if (!sealed) return null;
  try {
    const buf = Buffer.from(sealed, "base64url");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Works on Vercel (behind proxy) and localhost. */
export function requestOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  const proto =
    req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export function redirectUri(req: NextRequest): string {
  return `${requestOrigin(req)}/api/gsc/callback`;
}

/**
 * Returns a valid access token, refreshing it if within 60s of expiry.
 * `resealed` is set when the cookie must be updated with the refreshed token.
 */
export async function getAccessToken(
  req: NextRequest
): Promise<{ token: string; resealed?: string } | null> {
  const tokens = unseal<GscTokens>(req.cookies.get(GSC_COOKIE)?.value);
  if (!tokens?.access_token) return null;
  if (tokens.expires_at - 60_000 > Date.now()) return { token: tokens.access_token };
  if (!tokens.refresh_token) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token: string; expires_in: number };
  const next: GscTokens = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  return { token: next.access_token, resealed: seal(next) };
}

export async function googleGet(token: string, url: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
}

export async function googlePost(token: string, url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
}
