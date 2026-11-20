import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { PROJECT_LIMITS, ProjectError, type ProjectErrorCode } from "../../../shared/projectTypes.ts";
export const PROJECT_ERROR_CODES: ProjectErrorCode[] = [
  "BAD_REQUEST",
  "CAP_REQUIRED",
  "NOT_ACCESSIBLE",
  "FORBIDDEN",
  "CONFLICT",
  "IDEMPOTENCY_MISMATCH",
  "INVITE_EXPIRED",
  "PROJECT_UNAVAILABLE",
  "ENGINE_UNAVAILABLE",
  "BUDGET_EXCEEDED",
  "LIMIT_EXCEEDED",
  "RATE_LIMITED",
  "RESYNC_REQUIRED",
  "STORAGE_CORRUPT",
  "INTERNAL",
];
export function publicProjectError(e: unknown) {
  const v = e as {
    code?: ProjectErrorCode;
    message?: string;
    currentRevision?: number;
    changedPaths?: string[];
  } | null;
  if (v?.code && PROJECT_ERROR_CODES.includes(v.code))
    return {
      code: v.code,
      message: v.message || v.code,
      currentRevision: v.currentRevision,
      changedPaths: v.changedPaths,
    };
  return { code: "INTERNAL" as const, message: "项目服务处理失败" };
}
const base64Size = (bytes: number) => Math.ceil(bytes / 3) * 4;
export const PROJECT_IPC_REQUEST_BYTES = base64Size(base64Size(PROJECT_LIMITS.fileBytes) + 4096) + 1024;
export const PROJECT_IPC_RESPONSE_BYTES = base64Size(PROJECT_LIMITS.fileBytes) + 4096;
export type ProjectTransportCommand = {
  principal: string;
  method: "request" | "upload" | "resource" | "health";
  request?: unknown;
  workspaceId?: string;
  base64?: string;
  ticket?: string;
  timestamp: number;
  nonce: string;
};
export function signProjectEnvelope(command: ProjectTransportCommand, key: Buffer) {
  const body = Buffer.from(JSON.stringify(command)).toString("base64url");
  return { body, mac: createHmac("sha256", key).update(body).digest("base64url") };
}
export function verifyProjectEnvelope(
  input: unknown,
  key: Buffer,
  seen: Map<string, number>,
  now = Date.now(),
): ProjectTransportCommand {
  if (!input || typeof input !== "object") throw new ProjectError("NOT_ACCESSIBLE");
  const { body, mac } = input as { body: unknown; mac: unknown };
  if (typeof body !== "string" || typeof mac !== "string") throw new ProjectError("NOT_ACCESSIBLE");
  const expected = createHmac("sha256", key).update(body).digest(),
    got = Buffer.from(mac, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new ProjectError("NOT_ACCESSIBLE");
  let c: ProjectTransportCommand;
  try {
    c = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    throw new ProjectError("BAD_REQUEST");
  }
  if (
    !c ||
    typeof c.principal !== "string" ||
    !["request", "upload", "resource", "health"].includes(c.method) ||
    !Number.isSafeInteger(c.timestamp) ||
    Math.abs(now - c.timestamp) > 30000 ||
    typeof c.nonce !== "string" ||
    c.nonce.length !== 36 ||
    seen.has(c.nonce)
  )
    throw new ProjectError("NOT_ACCESSIBLE");
  for (const [nonce, time] of seen) if (time < now) seen.delete(nonce);
  if (seen.size > 100000) throw new ProjectError("RATE_LIMITED");
  seen.set(c.nonce, c.timestamp + 30000);
  return c;
}
export type ProjectClientSettings = { socketPath: string; keyFile: string };
export class ProjectStoreClient {
  constructor(readonly settings: ProjectClientSettings) {}
  async call<T = unknown>(
    principal: string,
    method: ProjectTransportCommand["method"],
    fields: Partial<ProjectTransportCommand> = {},
  ): Promise<T> {
    const key = readFileSync(this.settings.keyFile);
    if (key.length !== 32) throw new ProjectError("PROJECT_UNAVAILABLE");
    const envelope = signProjectEnvelope(
      { ...fields, principal, method, timestamp: Date.now(), nonce: randomUUID() },
      key,
    );
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.settings.socketPath);
      let bytes = 0;
      const chunks: Buffer[] = [];
      socket.setTimeout(30000, () => socket.destroy(new Error("timeout")));
      socket.once("connect", () => socket.end(JSON.stringify(envelope) + "\n"));
      socket.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > PROJECT_IPC_RESPONSE_BYTES) {
          socket.destroy();
          reject(new ProjectError("LIMIT_EXCEEDED"));
          return;
        }
        chunks.push(chunk);
      });
      socket.on("error", () => reject(new ProjectError("PROJECT_UNAVAILABLE", "项目存储服务不可用")));
      socket.once("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
          if (!result.ok) {
            const e = result.error;
            throw new ProjectError(
              PROJECT_ERROR_CODES.includes(e?.code) ? e.code : "INTERNAL",
              e?.message || "项目处理失败",
              e?.currentRevision,
              e?.changedPaths,
            );
          }
          resolve(result.data as T);
        } catch (e) {
          reject(e instanceof Error ? e : new ProjectError("INTERNAL"));
        }
      });
    });
  }
}
