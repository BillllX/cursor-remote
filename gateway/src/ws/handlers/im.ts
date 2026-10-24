// 即时消息（im_*）。只处理 hello caps 含 "im" 的连接；其余连接回 im_error code=no_cap
// （不静默忽略：网页端从不发 im_*，回错误只会让漏声明 cap 的客户端更容易排查）
import type { ServerMessage } from "../../../../shared/protocol.ts";
import { ImError } from "../../im/errors.ts";
import { hasGroupCaps, IM_CAP, imRuntime } from "../../im/runtime.ts";
import { collabEngine } from "../../collab/runtime.ts";
import type { ImService } from "../../im/service.ts";
import { log } from "../../log.ts";
import { send } from "../send.ts";
import type { MessageOf, WsCtx } from "./types.ts";

type ImType =
  | "im_contacts"
  | "im_group_create"
  | "im_group_update"
  | "collab_sync"
  | "collab_op"
  | "im_list"
  | "im_history"
  | "im_send"
  | "im_recall"
  | "im_read"
  | "im_settings"
  | "im_profile"
  | "im_block"
  | "im_presence";

async function run(
  ctx: WsCtx,
  message: MessageOf<ImType>,
  work: (service: ImService, me: string, origin: unknown) => ServerMessage | null | Promise<ServerMessage | null>,
) {
  const clientId =
    message.type === "im_send" && typeof message.clientId === "string" ? { clientId: message.clientId } : {};
  if (!ctx.conn.caps.has(IM_CAP)) {
    send(ctx.ws, { type: "im_error", ...clientId, code: "no_cap", message: "这个连接没有声明 im 能力" });
    return;
  }
  try {
    const out = await work(imRuntime().service, ctx.tenant.id, ctx.ws);
    if (out) send(ctx.ws, out);
  } catch (err) {
    if (err instanceof ImError) {
      send(ctx.ws, { type: "im_error", ...clientId, code: err.code, message: err.message });
      return;
    }
    log.error("im", message.type, err instanceof Error ? err.message : err);
    send(ctx.ws, { type: "im_error", ...clientId, code: "internal", message: "网关出错了，稍后再试" });
  }
}

export const onImContacts = (ctx: WsCtx, message: MessageOf<"im_contacts">) =>
  run(ctx, message, (service, me) => service.contacts(me));

export const onImList = (ctx: WsCtx, message: MessageOf<"im_list">) =>
  run(ctx, message, (service, me) => service.list(me, message, hasGroupCaps(ctx.conn.caps)));

export const onImGroupCreate = (ctx: WsCtx, message: MessageOf<"im_group_create">) =>
  run(ctx, message, (service, me) => {
    if (!hasGroupCaps(ctx.conn.caps)) throw new ImError("no_cap", "这个连接没有声明 im_group + im_collab 能力");
    return service.createGroup(me, message);
  });

export const onImGroupUpdate = (ctx: WsCtx, message: MessageOf<"im_group_update">) =>
  run(ctx, message, (service, me) => {
    if (!hasGroupCaps(ctx.conn.caps)) throw new ImError("no_cap", "这个连接没有声明 im_group + im_collab 能力");
    return service.updateGroup(me, message, collabEngine(ctx.tenant).activeWorkspaceIds());
  });

export const onCollabSync = (ctx: WsCtx, message: MessageOf<"collab_sync">) =>
  run(ctx, message, async (service, me) => {
    if (!hasGroupCaps(ctx.conn.caps)) throw new ImError("no_cap", "这个连接没有声明 im_group + im_collab 能力");
    if (!(await service.canAccessGroup(me, message.convId))) throw new ImError("not_found", "会话不存在");
    const state = collabEngine(ctx.tenant).state(message.convId);
    const known = new Map(
      (Array.isArray(message.known) ? message.known : [])
        .filter((row) => row && typeof row.runId === "string" && Number.isInteger(row.version))
        .map((row) => [row.runId, row.version]),
    );
    const current = new Set(state.runs.map((row) => row.runId));
    let candidates = state.runs;
    if (message.cursor?.startsWith("task@")) {
      const [, runId, taskId] = message.cursor.split("@");
      const run = state.runs.find((row) => row.runId === runId);
      const at = run?.tasks.findIndex((row) => row.taskId === taskId) ?? -1;
      candidates = run && at >= 0 ? [{ ...run, tasks: run.tasks.slice(at + 1) }] : [];
    } else if (message.cursor) {
      const at = state.runs.findIndex((row) => row.runId === message.cursor);
      candidates = at >= 0 ? state.runs.slice(at + 1) : state.runs;
    }
    return {
      type: "collab_state",
      convId: message.convId,
      snapshotSeq: state.snapshotSeq,
      runs: candidates.filter(
        (row) => message.cursor?.startsWith("task@") || (known.get(row.runId) ?? -1) < row.version,
      ),
      removedRunIds: [...known.keys()].filter((id) => !current.has(id)),
    };
  });

export const onCollabOp = (ctx: WsCtx, message: MessageOf<"collab_op">) =>
  run(ctx, message, async (service, me) => {
    if (!hasGroupCaps(ctx.conn.caps)) throw new ImError("no_cap", "这个连接没有声明 im_group + im_collab 能力");
    if (!(await service.canAccessGroup(me, message.convId))) throw new ImError("not_found", "会话不存在");
    if (typeof message.requestId !== "string" || !message.requestId) throw new ImError("bad_body", "requestId 不合法");
    const result = await collabEngine(ctx.tenant).operation(message);
    return { type: "collab_result", requestId: message.requestId, ...result };
  });

export const onImHistory = (ctx: WsCtx, message: MessageOf<"im_history">) =>
  run(ctx, message, (service, me) => service.history(me, message, hasGroupCaps(ctx.conn.caps)));

export const onImSend = (ctx: WsCtx, message: MessageOf<"im_send">) =>
  run(ctx, message, (service, me, origin) => service.send(me, origin, message, hasGroupCaps(ctx.conn.caps)));

export const onImRecall = (ctx: WsCtx, message: MessageOf<"im_recall">) =>
  run(ctx, message, (service, me, origin) => service.recall(me, origin, message, hasGroupCaps(ctx.conn.caps)));

export const onImRead = (ctx: WsCtx, message: MessageOf<"im_read">) =>
  run(ctx, message, (service, me, origin) => service.read(me, origin, message, hasGroupCaps(ctx.conn.caps)));

export const onImSettings = (ctx: WsCtx, message: MessageOf<"im_settings">) =>
  run(ctx, message, (service, me, origin) => service.settings(me, origin, message, hasGroupCaps(ctx.conn.caps)));

export const onImProfile = (ctx: WsCtx, message: MessageOf<"im_profile">) =>
  run(ctx, message, (service, me, origin) => service.profile(me, origin, message));

export const onImBlock = (ctx: WsCtx, message: MessageOf<"im_block">) =>
  run(ctx, message, (service, me, origin) => service.block(me, origin, message));

/** 只记在连接上，没有回包 */
export const onImPresence = (ctx: WsCtx, message: MessageOf<"im_presence">) =>
  run(ctx, message, () => {
    ctx.conn.imForeground = message.foreground !== false;
    if (!ctx.conn.imForeground) ctx.conn.workspaceViewingChatId = undefined;
    return null;
  });
