import type { IncomingMessage, ServerResponse } from "node:http";
import { kindFromPath } from "../../../shared/preview.ts";
import { sendMediaDescriptor } from "../media.ts";
import { allTenants, resolveTenant, stateDir } from "../tenants.ts";
import { WorkspaceSharing, WorkspaceShareError } from "../workspace/sharing.ts";

const UPLOAD_LIMIT = 32 * 1024 * 1024;
const uploading = new Set<string>();

export async function handleSharedWorkspaceFile(req: IncomingMessage, res: ServerResponse, url: URL) {
  const tenant = resolveTenant(/^Bearer (.+)$/i.exec(req.headers.authorization || "")?.[1] || "");
  const workspace = url.searchParams.get("shared");
  const path = url.searchParams.get("path") || "";
  const reply = (status: number, error?: string) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "private, no-store" });
    res.end(JSON.stringify(error ? { error } : { ok: true, path }));
  };
  if (!tenant) return reply(401, "请先登录");
  const sharing = new WorkspaceSharing(stateDir(), allTenants);
  try {
    if (req.method === "GET" || req.method === "HEAD") {
      if (url.pathname !== "/media") return reply(405, "请求方式不支持");
      const fd = sharing.openSharedFile(tenant, workspace, path);
      // 直接访问原件时也禁止执行活动内容。预览由客户端的隔离容器处理。
      res.setHeader("content-security-policy", "sandbox; default-src 'none'");
      sendMediaDescriptor(req, res, fd, path, kindFromPath(path));
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/upload") return reply(405, "请求方式不支持");
    const epoch = sharing.memberEpoch(tenant, workspace);
    const declared = Number(req.headers["content-length"]);
    if (declared > UPLOAD_LIMIT) return reply(413, "单个文件不能超过 32 MiB");
    if (uploading.has(tenant.id) || uploading.size >= 4) return reply(429, "上传繁忙，请稍后重试");
    uploading.add(tenant.id);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > UPLOAD_LIMIT) return reply(413, "单个文件不能超过 32 MiB");
        chunks.push(bytes);
      }
      if (sharing.memberEpoch(tenant, workspace) !== epoch) return reply(403, "共享名单已变更，请重新上传");
      sharing.uploadSharedFile(tenant, workspace, path, Buffer.concat(chunks, size));
      return reply(201);
    } finally {
      uploading.delete(tenant.id);
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof WorkspaceShareError)
      return reply(error.code === "UNAVAILABLE" ? 403 : error.code === "CONFLICT" ? 409 : 400, error.message);
    return reply((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400, "无法读写此文件");
  }
}
