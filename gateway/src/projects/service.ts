import { ProjectExecutor, type ProjectModelProfile } from "./executor.ts";
import { createServer, type Server } from "node:net";
import { chmodSync, readFileSync } from "node:fs";
import { ProjectError, type ProjectPrincipal } from "../../../shared/projectTypes.ts";
import { ProjectStore } from "./store/main.ts";
import {
  PROJECT_IPC_REQUEST_BYTES,
  PROJECT_IPC_RESPONSE_BYTES,
  publicProjectError,
  verifyProjectEnvelope,
} from "./ipc.ts";
export type ProjectServiceOptions = {
  directory: string;
  socketPath: string;
  keyFile: string;
  accountsFile: string;
  modelsFile?: string;
};
/** 只能由专用操作系统身份启动，网络入口由 Gateway 认证后签名。 */
export async function startProjectService(
  options: ProjectServiceOptions,
): Promise<{ server: Server; store: ProjectStore; close: () => Promise<void> }> {
  const key = readFileSync(options.keyFile);
  if (key.length !== 32) throw new Error("项目服务密钥必须为32字节");
  const store = new ProjectStore(options.directory),
    seen = new Map(
      store
        .all<{ nonce: string; expires: number }>("SELECT * FROM ipc_nonces WHERE expires>=?", Date.now())
        .map((r) => [r.nonce, r.expires]),
    );
  const reload = () => {
    try {
      const accounts = JSON.parse(readFileSync(options.accountsFile, "utf8")) as ProjectPrincipal[];
      if (
        !Array.isArray(accounts) ||
        accounts.some(
          (a) =>
            !a ||
            typeof a.id !== "string" ||
            typeof a.sharingEnabled !== "boolean" ||
            typeof a.sandboxVerified !== "boolean" ||
            (a.sharingDomain !== null && typeof a.sharingDomain !== "string"),
        ) ||
        new Set(accounts.map((a) => a.id)).size !== accounts.length
      )
        throw new Error("账户策略文件不合法");
      store.setAccounts(accounts);
    } catch (error) {
      store.setAccounts([]);
      throw error;
    }
  };
  reload();
  const profiles = options.modelsFile
    ? (JSON.parse(readFileSync(options.modelsFile, "utf8")) as ProjectModelProfile[])
    : [];
  const executor = new ProjectExecutor(store, profiles, undefined, reload);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let bytes = 0;
    let done = false;
    const chunks: Buffer[] = [];
    socket.setTimeout(30000, () => socket.destroy());
    socket.on("data", (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > PROJECT_IPC_REQUEST_BYTES) {
        done = true;
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      done = true;
      try {
        const command = verifyProjectEnvelope(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")), key, seen);
        store.exec("DELETE FROM ipc_nonces WHERE expires<?", Date.now());
        store.exec("INSERT INTO ipc_nonces VALUES(?,?)", command.nonce, command.timestamp + 30000);
        reload();
        let data: unknown;
        if (command.method === "health") {
          store.principal(command.principal);
          data = { ok: true, schema: 1 };
        } else if (command.method === "request") data = store.request(command.principal, command.request);
        else if (command.method === "upload") {
          if (typeof command.base64 !== "string" || command.base64.length > 35 * 1024 * 1024)
            throw new ProjectError("LIMIT_EXCEEDED");
          data = store.stageUpload(
            command.principal,
            String(command.workspaceId),
            Buffer.from(command.base64, "base64"),
          );
        } else
          data = {
            base64: store
              .readResource(command.principal, String(command.workspaceId), String(command.ticket))
              .toString("base64"),
          };
        const response = JSON.stringify({ ok: true, data }) + "\n";
        if (Buffer.byteLength(response) > PROJECT_IPC_RESPONSE_BYTES) throw new ProjectError("LIMIT_EXCEEDED");
        socket.end(response);
      } catch (e) {
        socket.end(JSON.stringify({ ok: false, error: publicProjectError(e) }) + "\n");
      }
    });
    socket.on("error", () => {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => {
        server.removeListener("error", reject);
        try {
          chmodSync(options.socketPath, 0o660);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  } catch (error) {
    server.close();
    store.close();
    throw error;
  }
  executor.start();
  return {
    server,
    store,
    close: async () => {
      await executor.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => {
          store.close();
          if (e) reject(e);
          else resolve();
        }),
      );
    },
  };
}
