import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { hasControlChars, isAllowedUploadFileName, loadKbWorkspaceConfig } from "../ingest/contract.ts";
import { submitDirectIngestBatch } from "../ingest/queue.ts";
import type { DropTenantHost } from "../ingest/tokens.ts";
import {
  addCalendarEvent,
  checkCalendarConflicts,
  parseEventTimeInput,
  updateCalendarEvent,
} from "./calendarEvents.ts";
import { postInbox } from "./inbox.ts";
import { assistantPath, clip, newId, readJson, type TenantRef } from "./store.ts";

/**
 * 同事日历变更与知识库更新提案状态机（Proposals + Transactional Outbox）：
 * - 铁律：同事通过 `/p/<tenant>/drop`、站内 IM 或微信提出「约会/改日历」或「更新知识库数据」时，提案阶段对正式日历与知识库 0 写入（不预先写 tentative 污染忙闲）；
 * - 提案生成后自动写入主人的收件箱（`inbox.json` kind="approval"），并支持同步推送到主人微信；
 * - 主人批准时在锁内先执行 CAS 状态抢占（`pending` -> `applying`），确保并发点击批准或批准/拒绝竞态绝不会重复写日历或重复入队归档；生效后落定为 `approved` 并将回执写入 `receiptOutbox`。
 */

export type ColleagueProposalChannel = "drop_portal" | "im_dm" | "wechat";

export type CalendarChangePayload = {
  kind: "calendar_book" | "calendar_reschedule";
  title: string;
  startIso: string;
  endIso: string;
  location?: string;
  notes?: string;
  targetEventId?: string;
};

export type KnowledgeUpdatePayload = {
  kind: "knowledge_update";
  workspaceKey: string;
  workspaceId: string;
  fileName: string;
  content: string;
  summary: string;
};

export type ProposalReceiptDelivery = {
  channel: ColleagueProposalChannel;
  targetId: string;
  status: "queued" | "sending" | "delivered" | "pending_wx_window" | "failed";
  message: string;
  updatedAt: number;
  error?: string;
};

export type ColleagueProposalStatus = "pending" | "applying" | "approved" | "rejected";

export type ColleagueProposal = {
  id: string;
  rev: number;
  tokenId: string;
  proposerName: string;
  sourceChannel: ColleagueProposalChannel;
  /** 发起人通道标识（如 IM 的 convId / peerTenantId，或微信的 openId） */
  sourcePeerId?: string;
  status: ColleagueProposalStatus;
  payload: CalendarChangePayload | KnowledgeUpdatePayload;
  /** 审批执行结果（生成的日程 ID 或归档批次 batchId） */
  appliedResult?: {
    calendarEventId?: string;
    ingestBatchId?: string;
    decidedAt: number;
    decisionNote?: string;
  };
  /** 跨通道回执 Transactional Outbox */
  receiptOutbox: ProposalReceiptDelivery[];
  createdAt: number;
  updatedAt: number;
};

type ProposalsFile = {
  version: 1;
  items: ColleagueProposal[];
};

const MAX_PROPOSAL_CONTENT_BYTES = 256 * 1024;
const MAX_STORED_PROPOSALS = 200;

export type ProposalOutboxDispatcher = (
  host: DropTenantHost,
  proposal: ColleagueProposal,
  delivery: ProposalReceiptDelivery,
) => Promise<{ status: "delivered" | "pending_wx_window" | "failed"; error?: string }>;

let outboxDispatcher: ProposalOutboxDispatcher | null = null;

export function bindProposalOutboxDispatcher(next: ProposalOutboxDispatcher | null) {
  outboxDispatcher = next;
}

function proposalsFilePath(ref: TenantRef): string {
  return assistantPath(ref, "colleague-proposals.json");
}

function readProposalsUnlocked(ref: TenantRef): ProposalsFile {
  const raw = readJson<Partial<ProposalsFile>>(proposalsFilePath(ref), { version: 1, items: [] });
  const items = Array.isArray(raw.items)
    ? raw.items.filter((x): x is ColleagueProposal => Boolean(x && typeof x.id === "string"))
    : [];
  return { version: 1, items };
}

function trimProposalsPreservingPending(items: ColleagueProposal[]): ColleagueProposal[] {
  if (items.length <= MAX_STORED_PROPOSALS) return items;
  const pendingOrApplying = items.filter((x) => x.status === "pending" || x.status === "applying");
  const decided = items.filter((x) => x.status !== "pending" && x.status !== "applying");
  const keepDecidedCount = Math.max(0, MAX_STORED_PROPOSALS - pendingOrApplying.length);
  const keptSet = new Set([...pendingOrApplying.slice(-MAX_STORED_PROPOSALS), ...decided.slice(-keepDecidedCount)]);
  return items.filter((x) => keptSet.has(x));
}

function writeProposalsUnlocked(ref: TenantRef, data: ProposalsFile) {
  data.items = trimProposalsPreservingPending(data.items);
  atomicWriteFileSync(proposalsFilePath(ref), `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mkdir: true,
    mode: 0o600,
  });
}

export function listColleagueProposals(
  ref: TenantRef,
  opts: { status?: ColleagueProposalStatus; tokenId?: string; limit?: number } = {},
): ColleagueProposal[] {
  const data = readProposalsUnlocked(ref);
  const filtered = data.items.filter((p) => {
    if (opts.status && p.status !== opts.status) return false;
    if (opts.tokenId && p.tokenId !== opts.tokenId) return false;
    return true;
  });
  const max = opts.limit ?? 100;
  return filtered.slice(-max).reverse();
}

export function getColleagueProposalById(ref: TenantRef, proposalId: string): ColleagueProposal | null {
  const clean = (proposalId || "").trim();
  if (!clean) return null;
  const data = readProposalsUnlocked(ref);
  return data.items.find((x) => x.id === clean) ?? null;
}

/**
 * 同事发起一条「预约/修改日历」提案：
 * 1. 先检查请求的时间格式与当前是否冲突；
 * 2. 落盘到 `colleague-proposals.json`（不修改正式日历）；
 * 3. 向主人收件箱推送一条 `kind: "approval"` 卡片。
 */
export function createCalendarProposal(
  host: DropTenantHost,
  input: {
    tokenId: string;
    proposerName: string;
    sourceChannel: ColleagueProposalChannel;
    sourcePeerId?: string;
    kind?: "calendar_book" | "calendar_reschedule";
    title: string;
    startIso: string;
    endIso?: string;
    location?: string;
    notes?: string;
    targetEventId?: string;
  },
  now = Date.now(),
): { ok: true; proposal: ColleagueProposal; conflictWarning?: string } | { ok: false; error: string } {
  const title = clip((input.title || "").trim(), 200);
  if (!title) return { ok: false, error: "请提供会议或日程主题" };

  const parsedTime = parseEventTimeInput(input.startIso, input.endIso);
  if (!parsedTime.ok) return parsedTime;

  const conflicts = checkCalendarConflicts(host, parsedTime.startAt, parsedTime.endAt, input.targetEventId);
  const conflictWarning =
    conflicts.length > 0
      ? `注意：该时段主人已有其他安排（${conflicts.map((c) => `${c.startIso}~${c.endIso}`).join("、")}），仍已为您提交申请供主人协调`
      : undefined;

  const file = proposalsFilePath(host);
  const proposal = withFileLockSync(file, () => {
    const data = readProposalsUnlocked(host);
    const created: ColleagueProposal = {
      id: newId("prop"),
      rev: 1,
      tokenId: input.tokenId,
      proposerName: clip(input.proposerName.trim() || "同事", 40),
      sourceChannel: input.sourceChannel,
      ...(input.sourcePeerId ? { sourcePeerId: input.sourcePeerId } : {}),
      status: "pending",
      payload: {
        kind: input.kind === "calendar_reschedule" ? "calendar_reschedule" : "calendar_book",
        title,
        startIso: parsedTime.startIso,
        endIso: parsedTime.endIso,
        ...(input.location?.trim() ? { location: clip(input.location.trim(), 120) } : {}),
        ...(input.notes?.trim() ? { notes: clip(input.notes.trim(), 600) } : {}),
        ...(input.targetEventId?.trim() ? { targetEventId: input.targetEventId.trim() } : {}),
      },
      receiptOutbox: [],
      createdAt: now,
      updatedAt: now,
    };
    data.items.push(created);
    writeProposalsUnlocked(host, data);
    return created;
  });

  postInbox(host, {
    kind: "approval",
    key: `proposal:${proposal.id}`,
    title: `[日历申请] ${proposal.proposerName}：${title}`,
    body: [
      `提案编号：${proposal.id}`,
      `申请人：${proposal.proposerName}（来源：${proposal.sourceChannel}）`,
      `时段：${parsedTime.startIso} 至 ${parsedTime.endIso}`,
      ...(input.location?.trim() ? [`地点：${input.location.trim()}`] : []),
      ...(input.notes?.trim() ? [`备注：${input.notes.trim()}`] : []),
      ...(conflictWarning ? [`冲突提示：时段存在重叠日程`] : [`冲突检查：当前时段空闲`]),
      `操作提示：你可以对我说「批准提案 ${proposal.id}」或「拒绝提案 ${proposal.id}」。`,
    ].join("\n"),
    actionPrompt: `请帮我批准同事提案 ${proposal.id}`,
  });

  return { ok: true, proposal, ...(conflictWarning ? { conflictWarning } : {}) };
}

/**
 * 同事发起一条「更新知识库数据/文档」提案：
 * 1. 校验目标工作区在同事获权范围内且文件后缀合法（单提案文本 ≤ 256KB，防同步 JSON 膨胀）；
 * 2. 将变更内容保存在 `colleague-proposals.json` 中（未经批准前绝不入队归档或修改知识库）；
 * 3. 向主人收件箱推送一条 `kind: "approval"` 审批卡。
 */
export function createKnowledgeUpdateProposal(
  host: DropTenantHost,
  input: {
    tokenId: string;
    proposerName: string;
    sourceChannel: ColleagueProposalChannel;
    sourcePeerId?: string;
    workspaceKeyOrId: string;
    fileName?: string;
    content: string;
    summary: string;
    authorizedWorkspaceIds?: string[];
  },
  now = Date.now(),
): { ok: true; proposal: ColleagueProposal } | { ok: false; error: string } {
  const wsRef = host.resolveWorkspace((input.workspaceKeyOrId || "").trim());
  if (!wsRef) {
    return { ok: false, error: `找不到目标知识库工作区：${input.workspaceKeyOrId}` };
  }
  if (
    Array.isArray(input.authorizedWorkspaceIds) &&
    input.authorizedWorkspaceIds.length > 0 &&
    !input.authorizedWorkspaceIds.includes(wsRef.workspaceId)
  ) {
    return { ok: false, error: `您的通行证无权向知识库 "${wsRef.key}" 提交更新提案` };
  }
  const kbLoaded = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbLoaded.ok) {
    return { ok: false, error: kbLoaded.error };
  }

  const summary = clip((input.summary || "").trim(), 300);
  if (!summary) {
    return { ok: false, error: "请简要说明本次知识库更新的内容摘要" };
  }
  const content = (input.content || "").trim();
  if (!content) {
    return { ok: false, error: "更新内容不能为空" };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_PROPOSAL_CONTENT_BYTES) {
    return { ok: false, error: "单条对话式知识更新提案内容不能超过 256KB（大文件请走上传归档区）" };
  }

  const datePrefix = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
  const rawFileName =
    (input.fileName || "").trim() ||
    `${datePrefix}_${summary.slice(0, 20).replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]/g, "_")}.md`;
  if (hasControlChars(rawFileName)) {
    return { ok: false, error: "文件名包含非法字符" };
  }
  const finalFileName = /\.[a-z0-9]+$/i.test(rawFileName) ? rawFileName : `${rawFileName}.md`;
  const nameCheck = isAllowedUploadFileName(finalFileName, kbLoaded.config);
  if (!nameCheck.ok) return nameCheck;

  const file = proposalsFilePath(host);
  const proposal = withFileLockSync(file, () => {
    const data = readProposalsUnlocked(host);
    const created: ColleagueProposal = {
      id: newId("prop"),
      rev: 1,
      tokenId: input.tokenId,
      proposerName: clip(input.proposerName.trim() || "同事", 40),
      sourceChannel: input.sourceChannel,
      ...(input.sourcePeerId ? { sourcePeerId: input.sourcePeerId } : {}),
      status: "pending",
      payload: {
        kind: "knowledge_update",
        workspaceKey: wsRef.key,
        workspaceId: wsRef.workspaceId,
        fileName: nameCheck.normalizedName,
        content,
        summary,
      },
      receiptOutbox: [],
      createdAt: now,
      updatedAt: now,
    };
    data.items.push(created);
    writeProposalsUnlocked(host, data);
    return created;
  });

  postInbox(host, {
    kind: "approval",
    key: `proposal:${proposal.id}`,
    title: `[知识库更新申请] ${proposal.proposerName} → ${wsRef.key}`,
    body: [
      `提案编号：${proposal.id}`,
      `申请人：${proposal.proposerName}（来源：${proposal.sourceChannel}）`,
      `目标知识库：${wsRef.key}（${kbLoaded.config.title}）`,
      `归档文件名：${nameCheck.normalizedName}`,
      `变更摘要：${summary}`,
      `内容预览：\n${clip(content, 500)}`,
      `操作提示：你可以对我说「批准提案 ${proposal.id}」或「拒绝提案 ${proposal.id}」。`,
    ].join("\n"),
    actionPrompt: `请帮我批准同事提案 ${proposal.id}`,
  });

  return { ok: true, proposal };
}

/**
 * 主人审批同事提案：
 * 1. 先在 `withFileLockSync(proposalsFilePath)` 锁内检查当前状态并原子抢占为 `applying`（若为拒绝则直接原子置为 `rejected`）；
 * 2. 抢占成功后执行日历写入或知识库归档入队（若因时间冲突等原因失败，在锁内安全回退为 `pending`，供主人调整时间后重批）；
 * 3. 成功后在锁内落定为 `approved` 并追加 `receiptOutbox`，异步触发原通道回执投递。
 */
export async function decideColleagueProposal(
  host: DropTenantHost,
  input: {
    proposalId: string;
    approve: boolean;
    decisionNote?: string;
    overrideStartIso?: string;
    overrideEndIso?: string;
    allowConflict?: boolean;
  },
  now = Date.now(),
): Promise<
  | {
      ok: true;
      proposal: ColleagueProposal;
      idempotent: boolean;
    }
  | { ok: false; error: string }
> {
  const targetId = (input.proposalId || "").trim();
  if (!targetId) return { ok: false, error: "请提供提案 ID" };

  const file = proposalsFilePath(host);

  // 第一阶段：在文件锁内做幂等判定与状态抢占
  const claimRes = withFileLockSync(file, () => {
    const data = readProposalsUnlocked(host);
    const target = data.items.find((x) => x.id === targetId);
    if (!target) {
      return { kind: "error" as const, error: `找不到提案：${targetId}` };
    }
    if ((input.approve && target.status === "approved") || (!input.approve && target.status === "rejected")) {
      return { kind: "idempotent" as const, proposal: { ...target, receiptOutbox: [...target.receiptOutbox] } };
    }
    if (target.status !== "pending") {
      // 若上次审批因进程意外崩溃停留在 applying 超过 60 秒，自动恢复为可重入抢占
      const staleApplying = target.status === "applying" && now - target.updatedAt > 60_000;
      if (!staleApplying) {
        return {
          kind: "error" as const,
          error: `提案 ${targetId} 正在处理或已被处理（当前状态：${target.status}）`,
        };
      }
    }

    if (!input.approve) {
      const titleDesc =
        target.payload.kind === "knowledge_update"
          ? `知识库更新「${target.payload.summary}」`
          : `日程「${target.payload.title}」`;
      const receiptMessage = `ℹ️ 主人未批准您的申请（${titleDesc}）${
        input.decisionNote ? `，说明：${input.decisionNote}` : ""
      }`;
      target.status = "rejected";
      target.rev += 1;
      target.updatedAt = now;
      target.appliedResult = {
        decidedAt: now,
        ...(input.decisionNote?.trim() ? { decisionNote: clip(input.decisionNote.trim(), 200) } : {}),
      };
      target.receiptOutbox.push({
        channel: target.sourceChannel,
        targetId: target.sourcePeerId || target.tokenId,
        status: target.sourceChannel === "drop_portal" ? "delivered" : "queued",
        message: receiptMessage,
        updatedAt: now,
      });
      writeProposalsUnlocked(host, data);
      return { kind: "rejected" as const, proposal: { ...target, receiptOutbox: [...target.receiptOutbox] } };
    }

    target.status = "applying";
    target.rev += 1;
    target.updatedAt = now;
    writeProposalsUnlocked(host, data);
    return { kind: "claimed" as const, snapshot: { ...target, payload: { ...target.payload } } };
  });

  if (claimRes.kind === "error") {
    return { ok: false, error: claimRes.error };
  }
  if (claimRes.kind === "idempotent") {
    return { ok: true, proposal: claimRes.proposal, idempotent: true };
  }

  let updated: ColleagueProposal | null = null;

  if (claimRes.kind === "rejected") {
    updated = claimRes.proposal;
  } else {
    const existing = claimRes.snapshot;
    let calendarEventId: string | undefined;
    let ingestBatchId: string | undefined;
    let receiptMessage = "";

    const revertToPending = () => {
      withFileLockSync(file, () => {
        const data = readProposalsUnlocked(host);
        const t = data.items.find((x) => x.id === targetId);
        if (t && t.status === "applying") {
          t.status = "pending";
          t.rev += 1;
          t.updatedAt = Date.now();
          writeProposalsUnlocked(host, data);
        }
      });
    };

    if (existing.payload.kind === "calendar_book" || existing.payload.kind === "calendar_reschedule") {
      const startIso = input.overrideStartIso?.trim() || existing.payload.startIso;
      const endIso = input.overrideEndIso?.trim() || existing.payload.endIso;
      if (existing.payload.kind === "calendar_reschedule" && existing.payload.targetEventId) {
        const upRes = updateCalendarEvent(
          host,
          existing.payload.targetEventId,
          {
            title: existing.payload.title,
            startIso,
            endIso,
            location: existing.payload.location,
            notes: existing.payload.notes,
            visibility: "private",
            remindMinutesBefore: 15,
            allowConflict: input.allowConflict,
          },
          now,
        );
        if (!upRes.ok) {
          revertToPending();
          return upRes;
        }
        calendarEventId = upRes.event.id;
        receiptMessage = `✅ 主人已批准您的日程改期申请：「${upRes.event.title}」（${upRes.event.startIso} ~ ${upRes.event.endIso}）${
          input.decisionNote ? `，备注：${input.decisionNote}` : ""
        }`;
      } else {
        const addRes = addCalendarEvent(
          host,
          {
            title: existing.payload.title,
            startIso,
            endIso,
            location: existing.payload.location,
            notes: existing.payload.notes,
            visibility: "private",
            busy: "busy",
            remindMinutesBefore: 15,
            source: "colleague_proposal",
            proposerName: existing.proposerName,
            proposalId: existing.id,
            allowConflict: input.allowConflict,
          },
          now,
        );
        if (!addRes.ok) {
          revertToPending();
          return addRes;
        }
        calendarEventId = addRes.event.id;
        receiptMessage = `✅ 主人已确认您的日程预约：「${addRes.event.title}」（${addRes.event.startIso} ~ ${addRes.event.endIso}）${
          input.decisionNote ? `，备注：${input.decisionNote}` : ""
        }`;
      }
    } else if (existing.payload.kind === "knowledge_update") {
      const kbPayload = existing.payload;
      const submitted = submitDirectIngestBatch(host, {
        workspaceKeyOrId: kbPayload.workspaceId,
        tokenId: existing.tokenId,
        submitterName: existing.proposerName,
        note: `经主人批准的同事知识更新提案 (${existing.id})：${kbPayload.summary}`,
        files: [
          {
            fileName: kbPayload.fileName,
            data: Buffer.from(kbPayload.content, "utf8"),
          },
        ],
      });
      if (!submitted.ok) {
        revertToPending();
        return { ok: false, error: submitted.error };
      }
      ingestBatchId = submitted.batchId;
      receiptMessage = `✅ 主人已批准您的知识库更新提案（目标库：${kbPayload.workspaceKey}，摘要：${kbPayload.summary}），已进入自动归档队列（批次：${submitted.batchId}）。`;
    }

    updated = withFileLockSync(file, () => {
      const data = readProposalsUnlocked(host);
      const target = data.items.find((x) => x.id === targetId);
      if (!target) return null;
      target.status = "approved";
      target.rev += 1;
      target.updatedAt = now;
      target.appliedResult = {
        ...(calendarEventId ? { calendarEventId } : {}),
        ...(ingestBatchId ? { ingestBatchId } : {}),
        decidedAt: now,
        ...(input.decisionNote?.trim() ? { decisionNote: clip(input.decisionNote.trim(), 200) } : {}),
      };
      target.receiptOutbox.push({
        channel: target.sourceChannel,
        targetId: target.sourcePeerId || target.tokenId,
        status: target.sourceChannel === "drop_portal" ? "delivered" : "queued",
        message: receiptMessage,
        updatedAt: now,
      });
      writeProposalsUnlocked(host, data);
      return { ...target, receiptOutbox: [...target.receiptOutbox] };
    });
  }

  if (!updated) {
    return { ok: false, error: "保存提案状态时发生异常" };
  }

  // 触发 Outbox 异步投递（站内 IM / 微信）
  await flushProposalReceiptOutbox(host, updated.id);

  const finalProposal = getColleagueProposalById(host, targetId) ?? updated;
  return { ok: true, proposal: finalProposal, idempotent: false };
}

/**
 * 扫描并投递指定提案（或全部提案）中处于 `queued` 状态的回执
 */
export async function flushProposalReceiptOutbox(host: DropTenantHost, onlyProposalId?: string): Promise<number> {
  if (!outboxDispatcher) return 0;
  const file = proposalsFilePath(host);
  const now = Date.now();
  const data = readProposalsUnlocked(host);
  let dispatchedCount = 0;

  for (const proposal of data.items) {
    if (onlyProposalId && proposal.id !== onlyProposalId) continue;
    for (let idx = 0; idx < proposal.receiptOutbox.length; idx++) {
      // 在文件锁内原子抢占 queued（或卡死超过 60 秒的 sending）-> sending，杜绝并发重复发送
      const claimed = withFileLockSync(file, () => {
        const fresh = readProposalsUnlocked(host);
        const p = fresh.items.find((x) => x.id === proposal.id);
        const d = p?.receiptOutbox[idx];
        if (!d) return null;
        const canClaim = d.status === "queued" || (d.status === "sending" && now - d.updatedAt > 60_000);
        if (!canClaim) return null;
        if (d.channel === "drop_portal") {
          d.status = "delivered";
          d.updatedAt = now;
          writeProposalsUnlocked(host, fresh);
          return { kind: "portal_done" as const };
        }
        d.status = "sending";
        d.updatedAt = now;
        writeProposalsUnlocked(host, fresh);
        return { kind: "send" as const, proposal: { ...p! }, delivery: { ...d } };
      });

      if (!claimed) continue;
      if (claimed.kind === "portal_done") {
        dispatchedCount += 1;
        continue;
      }

      try {
        const res = await outboxDispatcher(host, claimed.proposal, claimed.delivery);
        withFileLockSync(file, () => {
          const fresh = readProposalsUnlocked(host);
          const p = fresh.items.find((x) => x.id === proposal.id);
          const d = p?.receiptOutbox[idx];
          if (d) {
            d.status = res.status;
            d.updatedAt = Date.now();
            if (res.error) d.error = res.error;
            else delete d.error;
            writeProposalsUnlocked(host, fresh);
          }
        });
        dispatchedCount += 1;
      } catch (err) {
        withFileLockSync(file, () => {
          const fresh = readProposalsUnlocked(host);
          const p = fresh.items.find((x) => x.id === proposal.id);
          const d = p?.receiptOutbox[idx];
          if (d) {
            d.status = "failed";
            d.error = err instanceof Error ? err.message : String(err);
            d.updatedAt = Date.now();
            writeProposalsUnlocked(host, fresh);
          }
        });
      }
    }
  }
  return dispatchedCount;
}

/**
 * 当某位同事在微信重新发来消息激活 24h `context_token` 窗口时：
 * - 若传入了 `deliverFn`，则逐条真实调用 `deliverFn(message)` 确认返回 `true` 后才将该条回执标记为 `delivered`（若发送仍失败则保留 `pending_wx_window` 绝不丢消息）；
 * - 若未传 `deliverFn`（如同步读取），则取出所有 `pending_wx_window` / `failed` 的微信回执并标为 `delivered`。
 */
export async function flushPendingWechatReceiptsForPeer(
  ref: TenantRef,
  wxOpenIdOrTokenId: string,
  deliverFn: (message: string) => Promise<boolean>,
  now = Date.now(),
): Promise<string[]> {
  const peer = (wxOpenIdOrTokenId || "").trim();
  if (!peer) return [];
  const file = proposalsFilePath(ref);
  const snapshot = readProposalsUnlocked(ref);
  const candidates: Array<{ proposalId: string; index: number; message: string }> = [];

  for (const item of snapshot.items) {
    if (item.sourcePeerId !== peer && item.tokenId !== peer) continue;
    for (let i = 0; i < item.receiptOutbox.length; i++) {
      const d = item.receiptOutbox[i]!;
      if (d.channel === "wechat" && (d.status === "pending_wx_window" || d.status === "failed")) {
        candidates.push({ proposalId: item.id, index: i, message: d.message });
      }
    }
  }

  const deliveredMessages: string[] = [];
  for (const c of candidates) {
    let ok = false;
    try {
      ok = await deliverFn(c.message);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    withFileLockSync(file, () => {
      const fresh = readProposalsUnlocked(ref);
      const p = fresh.items.find((x) => x.id === c.proposalId);
      const d = p?.receiptOutbox[c.index];
      if (d && (d.status === "pending_wx_window" || d.status === "failed")) {
        d.status = "delivered";
        d.updatedAt = now;
        delete d.error;
        writeProposalsUnlocked(ref, fresh);
      }
    });
    deliveredMessages.push(c.message);
  }
  return deliveredMessages;
}

export function takePendingWechatReceiptsForPeer(
  ref: TenantRef,
  wxOpenIdOrTokenId: string,
  now = Date.now(),
): string[] {
  const peer = (wxOpenIdOrTokenId || "").trim();
  if (!peer) return [];
  const file = proposalsFilePath(ref);
  return withFileLockSync(file, () => {
    const data = readProposalsUnlocked(ref);
    const messages: string[] = [];
    for (const item of data.items) {
      if (item.sourcePeerId !== peer && item.tokenId !== peer) continue;
      for (const d of item.receiptOutbox) {
        if (d.status === "pending_wx_window" || (d.channel === "wechat" && d.status === "failed")) {
          d.status = "delivered";
          d.updatedAt = now;
          delete d.error;
          messages.push(d.message);
        }
      }
    }
    if (messages.length > 0) {
      writeProposalsUnlocked(ref, data);
    }
    return messages;
  });
}
