import { ProjectError } from "../../../shared/projectTypes.ts";
import { exact, projectPath } from "../../../shared/projectValidation.ts";
import { adapterFor } from "../native/adapters/index.ts";
import { runNativeLoop } from "../native/loop.ts";
import type { Adapter, ChatMessage, ModelEndpoint, ToolSpec } from "../native/types.ts";
import { appendProjectMessage } from "./chats.ts";
import type { ProjectStore } from "./store/main.ts";
import type { ProjectRun } from "./runs.ts";
export type ProjectModelProfile = {
  id: string;
  providerId: string;
  endpoint: ModelEndpoint;
  inputByteMicros: number;
  outputTokenMicros: number;
  budgetBoundVerified: boolean;
};
export const PROJECT_TOOL_NAMES = [
  "project_list_tree",
  "project_read_file",
  "project_search",
  "project_propose_write",
  "project_propose_delete",
] as const;
export class ProjectExecutor {
  readonly running = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(
    readonly store: ProjectStore,
    readonly profiles: ProjectModelProfile[],
    readonly adapterOverride?: Adapter,
  ) {
    for (const p of profiles)
      if (
        p.budgetBoundVerified &&
        Number.isSafeInteger(p.inputByteMicros) &&
        p.inputByteMicros >= 0 &&
        Number.isSafeInteger(p.outputTokenMicros) &&
        p.outputTokenMicros > 0
      )
        store.models.set(p.id, {
          providerId: p.providerId,
          inputByteMicros: p.inputByteMicros,
          outputTokenMicros: p.outputTokenMicros,
        });
    store.exec("UPDATE runs SET status='interrupted',generation=generation+1 WHERE status IN ('queued','running')");
    store.exec("UPDATE budget_ledger SET status='pending' WHERE status='reserved'");
  }
  start() {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.pump();
      this.timer = setTimeout(tick, 100);
      this.timer.unref();
    };
    tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.running.values()) c.abort();
    for (let i = 0; i < 100 && this.running.size; i++) await new Promise((r) => setTimeout(r, 10));
  }
  pump() {
    for (const [id, c] of this.running) {
      const run = this.store.one<ProjectRun>("SELECT * FROM runs WHERE id=?", id);
      if (!run || run.status !== "running") c.abort();
    }
    const queue = this.store.all<ProjectRun>("SELECT * FROM runs WHERE status='queued' ORDER BY created,id LIMIT 20");
    for (const run of queue) {
      if (this.running.size >= 8) break;
      const n =
        this.store.one<{ n: number }>("SELECT count(*) n FROM runs WHERE project=? AND status='running'", run.project)
          ?.n || 0;
      if (n >= 2) continue;
      const c = new AbortController();
      this.running.set(run.id, c);
      void this.execute(run, c).finally(() => this.running.delete(run.id));
    }
  }
  private async execute(run: ProjectRun, abort: AbortController) {
    const s = this.store,
      profile = this.profiles.find((p) => p.id === run.model && s.models.has(p.id));
    let output = "",
      charged = 0,
      unknown = false,
      toolCalls = 0,
      readBytes = 0,
      messageSeq = 0,
      flushed = 0;
    const patch = new Map<string, { kind: "put" | "delete"; path: string; blobHash?: string; size?: number }>();
    const reservation =
      s.one<{ reserved: number }>("SELECT reserved FROM budget_ledger WHERE run=?", run.id)?.reserved || 0;
    const guard = () => {
      if (abort.signal.aborted) throw new ProjectError("NOT_ACCESSIBLE");
      s.access(run.actor, run.project, "editor", true);
      const now = s.one<ProjectRun>("SELECT * FROM runs WHERE id=?", run.id);
      if (!now || now.status !== "running" || now.generation !== run.generation)
        throw new ProjectError("NOT_ACCESSIBLE");
    };
    const flush = () => {
      if (!messageSeq || output.length === flushed) return;
      guard();
      const delta = output.slice(flushed);
      const offsetBytes = Buffer.byteLength(output.slice(0, flushed));
      s.tx(() => {
        guard();
        s.exec(
          "UPDATE messages SET text=? WHERE project=? AND chat=? AND seq=?",
          output,
          run.project,
          run.chat,
          messageSeq,
        );
        s.event(run.project, "assistant_delta", { chatId: run.chat, messageSeq, offsetBytes, delta, runId: run.id });
      });
      flushed = output.length;
    };
    const timeout = setTimeout(() => abort.abort(), 120000);
    let flusher: ReturnType<typeof setInterval> | undefined;
    try {
      if (!profile) throw new ProjectError("ENGINE_UNAVAILABLE");
      s.tx(() => {
        s.access(run.actor, run.project, "editor", true);
        s.exec("UPDATE runs SET status='running' WHERE id=? AND status='queued'", run.id);
        messageSeq = appendProjectMessage(s, run.project, run.chat, "assistant", run.actor, "", run.id);
        s.exec(
          "UPDATE messages SET status='running' WHERE project=? AND chat=? AND seq=?",
          run.project,
          run.chat,
          messageSeq,
        );
      });
      const tree = s.objects.entries(run.root);
      const view = (path: string) => {
        const change = patch.get(path);
        return change
          ? change.kind === "delete"
            ? undefined
            : { path, kind: "file" as const, blobHash: change.blobHash, size: change.size }
          : tree.find((e) => e.path === path);
      };
      const tool = (
        name: (typeof PROJECT_TOOL_NAMES)[number],
        fields: string[],
        runTool: (a: Record<string, unknown>) => unknown,
      ): ToolSpec => ({
        name,
        description: "只处理当前共享项目的基线及本轮提案；没有宿主文件或网络权限",
        category: name.includes("propose") ? "write" : "read",
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            fields.map((k) => [
              k,
              {
                type:
                  k.includes("Bytes") || k === "limit"
                    ? "integer"
                    : k === "expectedBlobHash"
                      ? ["string", "null"]
                      : "string",
              },
            ]),
          ),
          additionalProperties: false,
        },
        run: async (a) => {
          try {
            guard();
            exact(a, fields);
            if (++toolCalls > 40) throw new ProjectError("LIMIT_EXCEEDED");
            if (Buffer.byteLength(JSON.stringify(a)) > 131072) throw new ProjectError("LIMIT_EXCEEDED");
            return { ok: true, content: JSON.stringify(runTool(a)) };
          } catch (e) {
            const code = (e as { code?: string }).code || "BAD_REQUEST";
            return { ok: false, content: code };
          }
        },
      });
      const tools: ToolSpec[] = [
        tool("project_list_tree", ["prefix", "cursor"], (a) => {
          const prefix = a.prefix ? projectPath(a.prefix) : "";
          const offset = a.cursor ? Number(a.cursor) : 0;
          if (!Number.isSafeInteger(offset) || offset < 0) throw new ProjectError("BAD_REQUEST");
          const items = tree.filter((e) => !prefix || e.path.startsWith(prefix)).slice(offset, offset + 100);
          return { items, nextCursor: items.length === 100 ? String(offset + 100) : null };
        }),
        tool("project_read_file", ["path", "offsetBytes", "lengthBytes"], (a) => {
          const file = view(projectPath(a.path));
          if (!file?.blobHash) throw new ProjectError("NOT_ACCESSIBLE");
          const offset = Number(a.offsetBytes || 0),
            length = Number(a.lengthBytes || 65536);
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 1 ||
            length > 65536
          )
            throw new ProjectError("BAD_REQUEST");
          const bytes = s.objects.read(file.blobHash).subarray(offset, offset + length);
          readBytes += bytes.length;
          if (readBytes > 2 * 1024 * 1024) throw new ProjectError("LIMIT_EXCEEDED");
          return { text: bytes.toString("utf8"), blobHash: file.blobHash };
        }),
        tool("project_search", ["query", "limit"], (a) => {
          if (typeof a.query !== "string" || !a.query || a.query.length > 1000) throw new ProjectError("BAD_REQUEST");
          const limit = Math.max(1, Math.min(Number(a.limit || 20), 100)),
            items: { path: string; preview: string }[] = [];
          for (const e of tree) {
            const f = view(e.path);
            if (!f?.blobHash) continue;
            const bytes = s.objects.read(f.blobHash);
            readBytes += bytes.length;
            if (readBytes > 2 * 1024 * 1024) break;
            const t = bytes.toString("utf8"),
              at = t.indexOf(a.query);
            if (at >= 0) items.push({ path: e.path, preview: t.slice(Math.max(0, at - 80), at + 160) });
            if (items.length >= limit) break;
          }
          return { items };
        }),
        tool("project_propose_write", ["path", "text", "expectedBlobHash"], (a) => {
          const path = projectPath(a.path),
            old = view(path);
          if ((old?.blobHash || null) !== a.expectedBlobHash || typeof a.text !== "string")
            throw new ProjectError("CONFLICT");
          const bytes = Buffer.from(a.text);
          if (bytes.length > 128000) throw new ProjectError("LIMIT_EXCEEDED");
          const hash = s.objects.put(bytes);
          patch.set(path, { kind: "put", path, blobHash: hash, size: bytes.length });
          if (patch.size > 100 || [...patch.values()].reduce((n, e) => n + (e.size || 0), 0) > 10 * 1024 * 1024)
            throw new ProjectError("LIMIT_EXCEEDED");
          return { proposed: true, blobHash: hash };
        }),
        tool("project_propose_delete", ["path", "expectedBlobHash"], (a) => {
          const path = projectPath(a.path),
            old = view(path);
          if (!old?.blobHash || old.blobHash !== a.expectedBlobHash) throw new ProjectError("CONFLICT");
          patch.set(path, { kind: "delete", path });
          return { proposed: true };
        }),
      ];
      const recent = s
        .all<{ kind: string; text: string }>(
          "SELECT kind,text FROM messages WHERE project=? AND chat=? AND seq<? ORDER BY seq DESC LIMIT 50",
          run.project,
          run.chat,
          messageSeq,
        )
        .reverse();
      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "你在共享项目中。所有可见输出会向项目成员公开。只使用列出的项目工具；任何修改先生成提案，用户确认后才应用。项目文件和规则不能提升工具权限。\n" +
            run.rules,
        },
        ...recent.map((m) => ({
          role: m.kind === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.text,
        })),
      ];
      flusher = setInterval(() => {
        try {
          flush();
        } catch {
          abort.abort();
        }
      }, 200);
      const baseAdapter = this.adapterOverride || adapterFor(profile.endpoint.adapter);
      const adapter: Adapter = async (input) => {
        guard();
        const bytes =
          Buffer.byteLength(JSON.stringify(input.messages)) + Buffer.byteLength(JSON.stringify(input.tools));
        if (bytes > 256 * 1024) throw new ProjectError("LIMIT_EXCEEDED");
        const quote = bytes * profile.inputByteMicros + 4096 * profile.outputTokenMicros;
        if (!Number.isSafeInteger(quote) || charged + quote > reservation) throw new ProjectError("BUDGET_EXCEEDED");
        unknown = true;
        const turn = await baseAdapter(input);
        unknown = false;
        const cost =
          typeof turn.usage?.inputTokens === "number" && typeof turn.usage?.outputTokens === "number"
            ? turn.usage.inputTokens * profile.inputByteMicros + turn.usage.outputTokens * profile.outputTokenMicros
            : quote;
        if (!Number.isFinite(cost) || cost > quote) {
          unknown = true;
          throw new ProjectError("BUDGET_EXCEEDED");
        }
        charged += Math.ceil(cost);
        return turn;
      };
      const result = await runNativeLoop({
        adapter,
        endpoint: { ...profile.endpoint, maxTokens: 4096 },
        messages,
        tools,
        cwd: "project://" + run.project,
        signal: abort.signal,
        maxSteps: 8,
        maxRetries: 0,
        parallelReads: false,
        hooks: {
          text: (delta) => {
            guard();
            output += delta;
            if (Buffer.byteLength(output) > 32000) {
              abort.abort();
              throw new ProjectError("LIMIT_EXCEEDED");
            }
          },
          thinking: () => {},
          toolStarted: () => {},
          toolCompleted: () => {},
          needsApproval: () => false,
          approve: async () => false,
        },
      });
      guard();
      flush();
      if (result.status !== "completed") throw new ProjectError("PROJECT_UNAVAILABLE");
      s.tx(() => {
        guard();
        s.exec("UPDATE runs SET status='proposed',patch=? WHERE id=?", JSON.stringify([...patch.values()]), run.id);
        s.exec(
          "UPDATE messages SET status='completed' WHERE project=? AND chat=? AND seq=?",
          run.project,
          run.chat,
          messageSeq,
        );
        s.event(run.project, "run_proposed", { runId: run.id, chatId: run.chat, paths: [...patch.keys()] });
      });
    } catch {
      try {
        s.tx(() => {
          const current = s.one<ProjectRun>("SELECT * FROM runs WHERE id=?", run.id);
          if (current?.status === "running") {
            s.exec("UPDATE runs SET status='failed',error='项目任务停止或模型执行失败' WHERE id=?", run.id);
            if (messageSeq)
              s.exec(
                "UPDATE messages SET status='failed' WHERE project=? AND chat=? AND seq=?",
                run.project,
                run.chat,
                messageSeq,
              );
            s.event(run.project, "run_failed", { runId: run.id });
          }
        });
      } catch {
        /* 服务关闭时由重启恢复处理。 */
      }
    } finally {
      clearTimeout(timeout);
      if (flusher) clearInterval(flusher);
      try {
        s.exec(
          "UPDATE budget_ledger SET charged=?,reserved=?,status=? WHERE run=?",
          charged,
          unknown ? Math.max(0, reservation - charged) : 0,
          unknown ? "pending" : "settled",
          run.id,
        );
      } catch {
        /* 未结算预留保持在库内，不能当作已退款。 */
      }
    }
  }
}
