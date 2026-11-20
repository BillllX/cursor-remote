import type { IncomingMessage, ServerResponse } from "node:http";
import { PROJECT_LIMITS, ProjectError } from "../../../shared/projectTypes.ts";
import { resolveTenant } from "../tenants.ts";
import { projectClient } from "./runtime.ts";
import { publicProjectError } from "./ipc.ts";
let uploads = 0;
export async function handleProjectHttp(req: IncomingMessage, res: ServerResponse, url: URL) {
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("x-content-type-options", "nosniff");
  const header = String(req.headers.authorization || ""),
    token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  const tenant = token ? resolveTenant(token) : null;
  if (!tenant) {
    res.writeHead(401).end();
    return;
  }
  if (req.headers["x-jiebo-project-protocol"] !== "1") {
    res.writeHead(403).end();
    return;
  }
  try {
    const client = projectClient(tenant),
      parts = url.pathname.split("/"),
      id = parts[3];
    if (url.pathname.startsWith("/upload/projects/")) {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (uploads >= 4) throw new ProjectError("RATE_LIMITED");
      uploads++;
      try {
        // 先在线鉴权，再读入有限字节；规范存储最终再次鉴权与核对配额。
        const permission = await client.call<{ summary: { role: string; state: string } }>(tenant.id, "request", {
          request: {
            type: "project_request",
            protocol: 1,
            requestId: crypto.randomUUID(),
            action: "project_snapshot",
            workspaceId: id,
            payload: {},
          },
        });
        if (permission.summary.role === "viewer" || permission.summary.state !== "active")
          throw new ProjectError("FORBIDDEN");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const b = Buffer.from(chunk);
          size += b.length;
          if (size > PROJECT_LIMITS.fileBytes) throw new ProjectError("LIMIT_EXCEEDED");
          chunks.push(b);
        }
        const data = await client.call(tenant.id, "upload", {
          workspaceId: id,
          base64: Buffer.concat(chunks).toString("base64"),
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, data }));
      } finally {
        uploads--;
      }
    } else {
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const result = await client.call<{ base64: string }>(tenant.id, "resource", {
        workspaceId: id,
        ticket: url.searchParams.get("ticket") || "",
      });
      res
        .writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment" })
        .end(Buffer.from(result.base64, "base64"));
    }
  } catch (e) {
    const error = publicProjectError(e);
    res
      .writeHead(
        error.code === "LIMIT_EXCEEDED"
          ? 413
          : error.code === "RATE_LIMITED"
            ? 429
            : error.code === "PROJECT_UNAVAILABLE"
              ? 503
              : 403,
        { "content-type": "application/json" },
      )
      .end(JSON.stringify({ ok: false, error }));
  }
}
