import type { NextRequest } from "next/server";
/** 项目内容仅经同源认证代理，既有 nginx 无需新增公开路由。 */
export async function projectProxy(req: NextRequest, workspaceId: string, kind: "upload" | "media") {
  if (!/^wsa_[0-9a-f-]{36}$/i.test(workspaceId)) return new Response(null, { status: 400 });
  const auth = req.headers.get("authorization");
  if (!auth) return new Response(null, { status: 401 });
  const base = new URL(process.env.GATEWAY_HTTP_URL || process.env.GATEWAY_WS_URL || "http://127.0.0.1:8787");
  base.protocol = base.protocol === "wss:" ? "https:" : base.protocol === "ws:" ? "http:" : base.protocol;
  base.pathname = `/${kind === "upload" ? "upload" : "media"}/projects/${workspaceId}`;
  base.search = "";
  if (kind === "media") base.searchParams.set("ticket", req.nextUrl.searchParams.get("ticket") || "");
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: { Authorization: auth, "X-Jiebo-Project-Protocol": "1" },
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  };
  if (kind === "upload") {
    init.body = req.body;
    init.duplex = "half";
  }
  const response = await fetch(base, init);
  const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
  for (const key of ["content-type", "content-length", "content-disposition"]) {
    const value = response.headers.get(key);
    if (value) headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
