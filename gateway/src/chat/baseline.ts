// 每轮运行的检查点与本轮文件基线
import type { WebSocket } from "ws";
import type { AgentMode } from "../../../shared/protocol.ts";
import { log } from "../log.ts";
import { persistConn } from "../runtime/slots.ts";
import type { Conn, Slot } from "../runtime/types.ts";
import { snapshotTree, TREE_BASELINE_MAX_FILES } from "../turnFiles.ts";
import { checkpointGit, createCheckpoint, sendCheckpoints, workspacePrefix } from "../workspace/checkpoints.ts";
import { listWorkspaceFiles } from "../workspace/files.ts";
import { send } from "../ws/send.ts";

export function recordRunCheckpoint(ws: WebSocket, conn: Conn, slot: Slot, cwd: string, mode: AgentMode) {
  try {
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const kind = mode === "plan" ? "Plan" : "Agent";
    let label = `${kind} · ${stamp}`;
    if (slot.checkpoints.some((item) => item.label === label)) {
      label = `${kind} · ${stamp} · ${slot.checkpoints.length + 1}`;
    }
    const checkpoint = createCheckpoint(cwd, label);
    const turnId = slot.transcript?.turnId;
    if (turnId && slot.turnBase?.turnId !== turnId) slot.turnBase = { turnId, cwd, checkpoint };
    slot.checkpoints.unshift(checkpoint);
    slot.checkpoints = slot.checkpoints.slice(0, 10);
    sendCheckpoints(ws, slot);
    persistConn(conn);
  } catch (err) {
    send(ws, {
      type: "status",
      chatId: slot.chatId,
      status: "RUNNING",
      message: `检查点没记下：${err instanceof Error ? err.message : "未知错误"}`,
    });
  }
}

/** 新回合没建检查点（autoApprove、检查点失败）时补一个只用于文件清单的 tree 基线，不进还原点列表 */
export function ensureTurnBaseline(slot: Slot, cwd: string, mode: AgentMode) {
  if (mode !== "agent" && mode !== "plan") return;
  const turnId = slot.transcript?.turnId;
  if (!turnId || slot.turnBase?.turnId === turnId) return;
  // 先占位：建不成也不在同一轮的重放里补建，否则基线会落在半轮的位置
  const base: NonNullable<Slot["turnBase"]> = { turnId, cwd };
  slot.turnBase = base;
  try {
    const ctx = checkpointGit(cwd);
    const prefix = workspacePrefix(ctx.cwd, cwd);
    let scope: string[] = [];
    if (!prefix) {
      const listed = listWorkspaceFiles(cwd, "");
      if (listed.truncated || listed.paths.length > TREE_BASELINE_MAX_FILES) return;
      scope = listed.paths;
    }
    base.tree = snapshotTree({ ctx, prefix, scope }) || undefined;
  } catch (err) {
    // 没基线就只用工具路径
    const now = Date.now();
    const quiet = now - (baselineWarnedAt.get(cwd) ?? -Infinity) < BASELINE_WARN_MS;
    if (!quiet) baselineWarnedAt.set(cwd, now);
    (quiet ? log.debug : log.warn)("本轮文件基线没建成", slot.chatId, cwd, err instanceof Error ? err.message : err);
  }
}

/** 基线持续失败时每轮都会走到上面：同一目录 10 分钟内只 warn 一次，其余记 debug */
const BASELINE_WARN_MS = 10 * 60_000;

const baselineWarnedAt = new Map<string, number>();
