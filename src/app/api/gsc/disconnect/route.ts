import { NextResponse } from "next/server";
import { GSC_COOKIE } from "@/lib/gsc-server";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(GSC_COOKIE);
  return res;
}
