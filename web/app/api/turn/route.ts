import { NextRequest } from "next/server";
import { gatewayHttp } from "../../../lib/gatewayHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PASS = new Set(["content-type", "content-length", "cache-control", "x-content-type-options"]);

export async function GET(req: NextRequest) {
  const target = `${gatewayHttp()}/state/turn?${req.nextUrl.searchParams.toString()}`;
  const headers = new Headers();
  const auth = req.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  try {
    const incoming = await fetch(target, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    const out = new Headers();
    incoming.headers.forEach((value, key) => {
      if (PASS.has(key.toLowerCase())) out.set(key, value);
    });
    out.set("cache-control", "private, no-store");
    return new Response(incoming.body, { status: incoming.status, headers: out });
  } catch {
    return new Response("gateway unreachable", {
      status: 502,
      headers: { "cache-control": "private, no-store" },
    });
  }
}
