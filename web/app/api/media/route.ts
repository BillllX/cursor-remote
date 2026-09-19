import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function gatewayHttp() {
  if (process.env.GATEWAY_HTTP_URL) return process.env.GATEWAY_HTTP_URL.replace(/\/$/, "");
  const ws = process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787";
  return ws.replace(/^ws/i, "http").replace(/\/$/, "");
}

const PASS = new Set([
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "x-content-type-options",
]);

async function proxyMedia(req: NextRequest) {
  const target = `${gatewayHttp()}/media?${req.nextUrl.searchParams.toString()}`;
  const headers = new Headers();
  const range = req.headers.get("range");
  const auth = req.headers.get("authorization");
  if (range) headers.set("range", range);
  if (auth) headers.set("authorization", auth);
  const incoming = await fetch(target, {
    method: req.method,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  const out = new Headers();
  incoming.headers.forEach((value, key) => {
    if (PASS.has(key.toLowerCase())) out.set(key, value);
  });
  if (!out.has("cache-control")) out.set("cache-control", "private, no-store");
  return new Response(req.method === "HEAD" ? null : incoming.body, {
    status: incoming.status,
    headers: out,
  });
}

export async function GET(req: NextRequest) {
  try {
    return await proxyMedia(req);
  } catch {
    return new Response("gateway unreachable", { status: 502 });
  }
}

export async function HEAD(req: NextRequest) {
  try {
    return await proxyMedia(req);
  } catch {
    return new Response(null, { status: 502 });
  }
}
