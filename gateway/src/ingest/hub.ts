import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ColleaguePermissions,
  KbColleagueProposalItem,
  KbHtmlBoardItem,
  KbWecomWatchedItemSummary,
  KbWorkspaceIngestLogItem,
  KbWorkspaceStatusData,
  KbWorkspaceSummaryItem,
  WorkspaceScheduleRunSummaryItem,
  WorkspaceScheduleSummaryItem,
} from "../../../shared/protocol.ts";
import { listColleagueProposals } from "../assistant/proposals.ts";
import {
  ensureSafePathInWorkspace,
  loadKbWorkspaceConfig,
  safeReadWorkspaceTextFileSync,
  type KbWorkspaceConfig,
} from "./contract.ts";
import { readWorkspaceIngestLogs } from "./notify.ts";
import { listIngestQueue } from "./queue.ts";
import {
  createDropToken,
  getOwnerWxBinding,
  listDropTokens,
  revokeDropToken,
  setupKbWorkspaceForTenant,
  updateDropToken,
  type DropTenantHost,
} from "./tokens.ts";
import { listWecomWatchItems } from "./wecomSource.ts";
import {
  listWorkspaceScheduleRuns,
  listWorkspaceSchedules,
  type WorkspaceScheduleRecord,
} from "./workspaceSchedules.ts";

/** 从 HTML 头部注释 `<!-- JIEBO_KB_META: {...} -->` 或文件 mtime 提取更新时间 */
function extractHtmlUpdatedAt(workspaceDir: string, relPath: string, fallbackMtimeMs: number): number {
  const headRead = safeReadWorkspaceTextFileSync(workspaceDir, relPath, 2 * 1024 * 1024);
  if (headRead.ok) {
    const match = /^<!--\s*JIEBO_KB_META:\s*(\{[\s\S]*?\})\s*-->/i.exec(headRead.text.trim());
    if (match?.[1]) {
      try {
        const meta = JSON.parse(match[1]) as { updatedAt?: unknown };
        if (typeof meta.updatedAt === "number" && Number.isFinite(meta.updatedAt) && meta.updatedAt > 0) {
          return meta.updatedAt;
        }
      } catch {
        // fallback to mtime
      }
    }
  }
  return Math.floor(fallbackMtimeMs);
}

/**
 * 扫描知识库工作区下所有合法的同名 `.html` 知识库看板：
 * 1. 顶层分类总览看板：`<category>/<category>.html`（`level: "category"`）
 * 2. 主体/专题子目录看板：`<category>/<sub>/<sub>.html`（`level: "subject"`）
 */
export function scanWorkspaceKbHtmlBoards(workspaceDir: string, config: KbWorkspaceConfig): KbHtmlBoardItem[] {
  const boards: KbHtmlBoardItem[] = [];

  for (const category of config.allowedCategories) {
    const catCheck = ensureSafePathInWorkspace(workspaceDir, category, { expectLeaf: "dir" });
    if (!catCheck.ok || !existsSync(catCheck.absPath)) continue;

    // 1. 检查一级分类同名 HTML：<category>/<category>.html
    const topHtmlRel = `${category}/${category}.html`;
    const topCheck = ensureSafePathInWorkspace(workspaceDir, topHtmlRel, { expectLeaf: "file" });
    if (topCheck.ok && existsSync(topCheck.absPath)) {
      try {
        const st = lstatSync(topCheck.absPath);
        if (st.isFile() && !st.isSymbolicLink()) {
          boards.push({
            relPath: topCheck.normalizedRel,
            title: `${category}（总览看板）`,
            category,
            level: "category",
            updatedAt: extractHtmlUpdatedAt(workspaceDir, topCheck.normalizedRel, st.mtimeMs),
            size: st.size,
          });
        }
      } catch {
        // ignore
      }
    }

    // 2. 扫描该一级分类下的子目录同名 HTML：<category>/<sub>/<sub>.html
    let entries: string[] = [];
    try {
      entries = readdirSync(catCheck.absPath).sort();
    } catch {
      continue;
    }

    for (const subName of entries) {
      if (!subName || subName.startsWith(".")) continue;
      const subDirRel = `${category}/${subName}`;
      const subDirCheck = ensureSafePathInWorkspace(workspaceDir, subDirRel, { expectLeaf: "dir" });
      if (!subDirCheck.ok || !existsSync(subDirCheck.absPath)) continue;
      try {
        if (!statSync(subDirCheck.absPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const subHtmlRel = `${category}/${subName}/${subName}.html`;
      const subHtmlCheck = ensureSafePathInWorkspace(workspaceDir, subHtmlRel, { expectLeaf: "file" });
      if (!subHtmlCheck.ok || !existsSync(subHtmlCheck.absPath)) continue;

      try {
        const st = lstatSync(subHtmlCheck.absPath);
        if (st.isFile() && !st.isSymbolicLink()) {
          boards.push({
            relPath: subHtmlCheck.normalizedRel,
            title: subName,
            category,
            level: "subject",
            updatedAt: extractHtmlUpdatedAt(workspaceDir, subHtmlCheck.normalizedRel, st.mtimeMs),
            size: st.size,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  return boards;
}

function buildTenantKbWorkspacesSummary(host: DropTenantHost): KbWorkspaceSummaryItem[] {
  return listTenantKbWorkspaces(host).map((w) => ({
    workspaceId: w.workspaceId,
    workspaceKey: w.workspaceKey,
    title: w.config.title,
  }));
}

function buildTenantProposalsSummary(host: DropTenantHost): KbColleagueProposalItem[] {
  const pending = listColleagueProposals(host, { status: "pending", limit: 100 });
  const recentAll = listColleagueProposals(host, { limit: 30 });
  const seen = new Set<string>();
  const merged = [...pending, ...recentAll].filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  return merged.map((p) => ({
    id: p.id,
    status: p.status,
    kind: p.payload.kind,
    proposerName: p.proposerName,
    sourceChannel: p.sourceChannel,
    summary: p.payload.kind === "knowledge_update" ? p.payload.summary : p.payload.title,
    detail:
      p.payload.kind === "knowledge_update"
        ? `知识库：${p.payload.workspaceKey} · 文件：${p.payload.fileName}`
        : `时间：${p.payload.startIso} ~ ${p.payload.endIso}${p.payload.location ? ` · 地点：${p.payload.location}` : ""}`,
    createdAt: p.createdAt,
  }));
}

function buildWorkspaceWecomWatchItemsForUi(host: DropTenantHost, workspaceKey?: string): KbWecomWatchedItemSummary[] {
  const res = listWecomWatchItems(host, workspaceKey ? { workspace: workspaceKey } : undefined);
  if (!res.ok) return [];
  return res.items.map((item) => {
    const hasSynced = Boolean(item.lastSyncedSha256);
    const hasChanged =
      item.lastCheckHasChanged !== undefined ? item.lastCheckHasChanged : hasSynced ? false : undefined;
    return {
      id: item.id,
      workspaceId: item.workspaceId,
      workspaceKey: item.workspaceKeySnapshot,
      title: item.title,
      sourceType: item.sourceType,
      ...(item.docId ? { docId: item.docId } : {}),
      ...(item.fileId ? { fileId: item.fileId } : {}),
      ...(item.sheet ? { sheet: item.sheet } : {}),
      ...(item.range ? { range: item.range } : {}),
      ...(item.note ? { note: item.note } : {}),
      ...(item.lastSyncedUpdateTime ? { lastSyncedUpdateTime: item.lastSyncedUpdateTime } : {}),
      ...(item.lastSyncedSha256 ? { lastSyncedSha256: item.lastSyncedSha256 } : {}),
      ...(item.lastSnapshotPreview ? { lastSnapshotPreview: item.lastSnapshotPreview } : {}),
      ...(item.lastBatchId ? { lastBatchId: item.lastBatchId } : {}),
      ...(item.lastCheckedAt ? { lastCheckedAt: item.lastCheckedAt } : {}),
      ...(item.lastSyncedAt ? { lastSyncedAt: item.lastSyncedAt } : {}),
      ...(item.lastCheckedUpdateTime || item.lastSyncedUpdateTime
        ? { lastCheckedUpdateTime: item.lastCheckedUpdateTime ?? item.lastSyncedUpdateTime }
        : {}),
      ...(item.lastCheckedSha256 || item.lastSyncedSha256
        ? { lastCheckedSha256: item.lastCheckedSha256 ?? item.lastSyncedSha256 }
        : {}),
      ...(hasChanged !== undefined ? { lastCheckHasChanged: hasChanged } : {}),
      ...(item.lastCheckSummary ? { lastCheckSummary: item.lastCheckSummary } : {}),
      ...(item.lastCheckDiffHint ? { lastCheckDiffHint: item.lastCheckDiffHint } : {}),
      ...(item.lastCheckPreview || item.lastSnapshotPreview
        ? { lastCheckPreview: item.lastCheckPreview ?? item.lastSnapshotPreview }
        : {}),
      ...(item.lastCheckError ? { lastCheckError: item.lastCheckError } : {}),
      createdAt: item.createdAt,
    };
  });
}

function buildWorkspaceIngestLogsForUi(
  host: DropTenantHost,
  workspaceId: string,
  workspaceDir: string,
  limit = 25,
): KbWorkspaceIngestLogItem[] {
  const historyLogs = readWorkspaceIngestLogs(workspaceDir, limit);
  const seenBatchIds = new Set(historyLogs.map((l) => l.batchId));
  const queueEntries = listIngestQueue(host).filter(
    (entry) => entry.workspaceId === workspaceId && !seenBatchIds.has(entry.batchId),
  );
  const activeItems: KbWorkspaceIngestLogItem[] = [];
  const finishedFallbackItems: KbWorkspaceIngestLogItem[] = [];

  for (const entry of queueEntries) {
    const isRunning = entry.status === "queued" || entry.status === "processing";
    const mapped: KbWorkspaceIngestLogItem = {
      batchId: entry.batchId,
      timestamp: entry.finishedAt ?? entry.startedAt ?? entry.queuedAt,
      status: entry.status,
      submitterName: entry.submitterName,
      note: entry.note,
      movedFiles: [],
      updatedHtmls: [],
      summary: isRunning
        ? entry.status === "processing"
          ? "正在后台分析归档并同步更新 HTML 看板…"
          : "已在归档队列中排队等待处理…"
        : "",
      ...(entry.errorReason ? { errorReason: entry.errorReason } : {}),
    };
    if (isRunning) activeItems.push(mapped);
    else finishedFallbackItems.push(mapped);
  }

  activeItems.sort((a, b) => b.timestamp - a.timestamp);
  const mergedFinished = [...historyLogs, ...finishedFallbackItems].sort((a, b) => b.timestamp - a.timestamp);

  return [...activeItems, ...mergedFinished].slice(0, limit);
}

function summarizeSchedulePayload(rec: WorkspaceScheduleRecord): string {
  const p = rec.payload;
  if (rec.executorKind === "wecom_watch_sync") {
    const scope =
      Array.isArray(p.watchItemIds) && p.watchItemIds.length > 0
        ? `指定 ${p.watchItemIds.length} 项`
        : "全部关注文件";
    return `企微关注表巡检（${scope} · 静默防抖 ${p.quietPeriodMinutes ?? 3} 分钟）`;
  }
  if (rec.executorKind === "wecom_mail_poll") {
    return `企微邮箱拉取${p.mailKeyword ? `（关键词：${p.mailKeyword}）` : "（全部新邮件）"}${p.onlyWithAttachments ? " · 仅含附件" : ""}`;
  }
  if (rec.executorKind === "http_api_ingest") {
    return `接口/网页抓取：${p.url || "未配置 URL"}`;
  }
  if (rec.executorKind === "workspace_script") {
    return `受控脚本：${p.runner ?? "python3"} ${p.scriptRelPath || ""}`;
  }
  return `AI 定时分析：${(p.prompt || "").slice(0, 60)}`;
}

function buildWorkspaceSchedulesForUi(host: DropTenantHost, workspaceKey?: string): WorkspaceScheduleSummaryItem[] {
  return listWorkspaceSchedules(host, workspaceKey ? { workspace: workspaceKey } : undefined).map((s) => ({
    id: s.id,
    workspaceId: s.workspaceId,
    workspaceKey: s.workspaceKeySnapshot,
    title: s.title,
    enabled: s.enabled,
    executorKind: s.executorKind,
    scheduleMode: s.scheduleMode,
    intervalMinutes: s.intervalMinutes,
    ...(s.dailyTimes?.length ? { dailyTimes: s.dailyTimes } : {}),
    ...(s.activeHours ? { activeHours: s.activeHours } : {}),
    tz: s.tz,
    state: s.state,
    ...(s.activeRunId ? { activeRunId: s.activeRunId } : {}),
    ...(s.activeStartedAt ? { activeStartedAt: s.activeStartedAt } : {}),
    ...(s.activeBatchIds?.length ? { activeBatchIds: s.activeBatchIds } : {}),
    nextRunAt: s.nextRunAt,
    ...(s.lastStartedAt ? { lastStartedAt: s.lastStartedAt } : {}),
    ...(s.lastFinishedAt ? { lastFinishedAt: s.lastFinishedAt } : {}),
    ...(s.lastStatus ? { lastStatus: s.lastStatus } : {}),
    ...(s.lastSummary ? { lastSummary: s.lastSummary } : {}),
    ...(s.lastUpdatedFiles?.length ? { lastUpdatedFiles: s.lastUpdatedFiles } : {}),
    ...(s.lastError ? { lastError: s.lastError } : {}),
    consecutiveFailures: s.consecutiveFailures ?? 0,
    payloadSummary: summarizeSchedulePayload(s),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

function buildWorkspaceScheduleRunsForUi(
  host: DropTenantHost,
  workspaceKey?: string,
  limit = 20,
): WorkspaceScheduleRunSummaryItem[] {
  return listWorkspaceScheduleRuns(host, { workspace: workspaceKey, limit }).map((r) => ({
    runId: r.runId,
    scheduleId: r.scheduleId,
    workspaceKey: r.workspaceKey,
    title: r.title,
    executorKind: r.executorKind,
    trigger: r.trigger,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    status: r.status,
    summary: r.summary,
    ...(r.batchIds?.length ? { batchIds: r.batchIds } : {}),
    ...(r.updatedFiles?.length ? { updatedFiles: r.updatedFiles } : {}),
    ...(r.error ? { error: r.error } : {}),
  }));
}

/**
 * 获取指定子工作区（或传 `""` / `"__all__"` 获取小驳全局跨工作区）的知识库状态、HTML 看板列表、同事通行证列表及待批提案（供 Web / iOS 前端展示）
 */
export function getKbWorkspaceStatusForUi(
  host: DropTenantHost,
  workspaceKeyOrPath: string,
): { ok: true; data: KbWorkspaceStatusData } | { ok: false; error: string } {
  const raw = workspaceKeyOrPath.trim();
  const dropPortalPath = `/p/${host.id}/drop`;
  const kbWorkspaces = buildTenantKbWorkspacesSummary(host);
  const proposals = buildTenantProposalsSummary(host);
  const ownerWx = getOwnerWxBinding(host);

  // 小驳全局跨工作区同事管理视图（workspace 传 "" 或 "__all__"）
  if (!raw || raw === "__all__") {
    const allTokens = listDropTokens(host, { includeRevoked: false });
    const wecomWatchItems = buildWorkspaceWecomWatchItemsForUi(host);
    const workspaceSchedules = buildWorkspaceSchedulesForUi(host);
    const workspaceScheduleRuns = buildWorkspaceScheduleRunsForUi(host);
    return {
      ok: true,
      data: {
        workspaceKey: "",
        workspaceId: "",
        isKnowledgeBase: kbWorkspaces.length > 0,
        title: "跨工作区同事与知识库通行证",
        allowedCategories: [],
        boards: [],
        tokens: allTokens,
        kbWorkspaces,
        proposals,
        wecomWatchItems,
        workspaceSchedules,
        workspaceScheduleRuns,
        ...(ownerWx ? { ownerWx } : {}),
        dropPortalPath,
      },
    };
  }

  // 支持传入相对工作区名或绝对路径
  const rootAbs = resolve(host.workspaceRoot);
  let targetKey = raw;
  if (raw.startsWith("/")) {
    const abs = resolve(raw);
    if (abs === rootAbs) {
      return { ok: false, error: "USER 根目录不能作为知识库子工作区" };
    }
    if (abs.startsWith(`${rootAbs}/`)) {
      targetKey = abs.slice(rootAbs.length + 1).split("/")[0] || raw;
    }
  }

  const wsRef = host.resolveWorkspace(targetKey);
  if (!wsRef) {
    return { ok: false, error: `找不到子工作区：${targetKey}` };
  }

  const kbLoaded = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);

  // 读取工作区下现有一级子目录，供未开启知识库时一键勾选推荐分类
  let existingSubDirs: string[] = [];
  try {
    existingSubDirs = readdirSync(wsRef.path)
      .filter((name) => {
        if (!name || name.startsWith(".") || name === "node_modules") return false;
        try {
          const st = lstatSync(resolve(wsRef.path, name));
          return st.isDirectory() && !st.isSymbolicLink();
        } catch {
          return false;
        }
      })
      .slice(0, 20);
  } catch {
    existingSubDirs = [];
  }

  if (!kbLoaded.ok) {
    const workspaceSchedules = buildWorkspaceSchedulesForUi(host, wsRef.key);
    const workspaceScheduleRuns = buildWorkspaceScheduleRunsForUi(host, wsRef.key);
    return {
      ok: true,
      data: {
        workspaceKey: wsRef.key,
        workspaceId: wsRef.workspaceId,
        isKnowledgeBase: false,
        title: `${wsRef.key} 知识库`,
        allowedCategories: existingSubDirs.length > 0 ? existingSubDirs : ["资金", "资产", "牌照"],
        boards: [],
        tokens: [],
        kbWorkspaces,
        proposals,
        workspaceSchedules,
        workspaceScheduleRuns,
        dropPortalPath,
      },
    };
  }

  const boards = scanWorkspaceKbHtmlBoards(kbLoaded.workspaceRealPath, kbLoaded.config);
  const allTokens = listDropTokens(host, { includeRevoked: false });
  const wsTokens = allTokens.filter((t) =>
    t.workspaces ? t.workspaces.some((w) => w.workspaceId === wsRef.workspaceId) : t.workspaceId === wsRef.workspaceId,
  );
  const otherTokens = allTokens.filter(
    (t) =>
      t.active &&
      !(t.workspaces
        ? t.workspaces.some((w) => w.workspaceId === wsRef.workspaceId)
        : t.workspaceId === wsRef.workspaceId),
  );
  const wecomWatchItems = buildWorkspaceWecomWatchItemsForUi(host, wsRef.key);
  const ingestLogs = buildWorkspaceIngestLogsForUi(host, wsRef.workspaceId, kbLoaded.workspaceRealPath);
  const workspaceSchedules = buildWorkspaceSchedulesForUi(host, wsRef.key);
  const workspaceScheduleRuns = buildWorkspaceScheduleRunsForUi(host, wsRef.key);

  return {
    ok: true,
    data: {
      workspaceKey: wsRef.key,
      workspaceId: wsRef.workspaceId,
      isKnowledgeBase: true,
      title: kbLoaded.config.title,
      allowedCategories: kbLoaded.config.allowedCategories,
      maxFileBytes: kbLoaded.config.maxFileBytes,
      boards,
      tokens: wsTokens,
      otherTokens,
      kbWorkspaces,
      proposals,
      wecomWatchItems,
      ingestLogs,
      workspaceSchedules,
      workspaceScheduleRuns,
      ...(ownerWx ? { ownerWx } : {}),
      dropPortalPath,
    },
  };
}

export function initKbWorkspaceFromUi(
  host: DropTenantHost,
  input: {
    workspace: string;
    title: string;
    categories: string[];
  },
): { ok: true; data: KbWorkspaceStatusData } | { ok: false; error: string } {
  const setupRes = setupKbWorkspaceForTenant(host, input);
  if (!setupRes.ok) return setupRes;
  return getKbWorkspaceStatusForUi(host, setupRes.workspaceKey);
}

export function createDropTokenFromUi(
  host: DropTenantHost,
  input: {
    workspace: string;
    passcode: string;
    label?: string;
    expiresInDays?: number;
    workspaces?: string[];
    permissions?: Partial<ColleaguePermissions>;
    imTenantId?: string;
  },
): { ok: true; data: KbWorkspaceStatusData } | { ok: false; error: string } {
  const rawWs = input.workspace.trim();
  const isGlobalView = !rawWs || rawWs === "__all__";
  const candidateWorkspaces = Array.isArray(input.workspaces)
    ? input.workspaces.map((w) => w.trim()).filter(Boolean)
    : [];
  const primaryWorkspace = !isGlobalView
    ? rawWs
    : candidateWorkspaces[0] || listTenantKbWorkspaces(host)[0]?.workspaceKey || "";
  if (!primaryWorkspace) {
    return { ok: false, error: "当前还没有已开启的知识库子工作区，请先将一个子工作区设为知识库" };
  }
  const created = createDropToken(host, {
    ...input,
    workspace: primaryWorkspace,
    workspaces: candidateWorkspaces.length > 0 ? candidateWorkspaces : [primaryWorkspace],
  });
  if (!created.ok) return created;
  return getKbWorkspaceStatusForUi(host, isGlobalView ? "" : rawWs);
}

export function updateDropTokenFromUi(
  host: DropTenantHost,
  input: {
    workspace: string;
    tokenId: string;
    label?: string;
    addWorkspaces?: string[];
    removeWorkspaces?: string[];
    permissions?: Partial<ColleaguePermissions>;
    imTenantId?: string | null;
    wxOpenId?: string | null;
    wxStatus?: "pending_owner" | "active" | "revoked";
    neverExpire?: boolean;
    expiresInDays?: number;
  },
): { ok: true; data: KbWorkspaceStatusData } | { ok: false; error: string } {
  const rawWs = input.workspace.trim();
  const isGlobalView = !rawWs || rawWs === "__all__";
  const updated = updateDropToken(host, {
    tokenId: input.tokenId,
    label: input.label,
    addWorkspaces: input.addWorkspaces,
    removeWorkspaces: input.removeWorkspaces,
    permissions: input.permissions,
    imTenantId: input.imTenantId,
    ...(input.wxOpenId !== undefined
      ? {
          wxBinding:
            input.wxOpenId === null || input.wxOpenId.trim() === ""
              ? null
              : {
                  status: input.wxStatus ?? "active",
                  openId: input.wxOpenId.trim(),
                  updatedAt: Date.now(),
                },
        }
      : {}),
    neverExpire: input.neverExpire,
    expiresInDays: input.expiresInDays,
  });
  if (!updated.ok) return updated;
  return getKbWorkspaceStatusForUi(host, isGlobalView ? "" : rawWs);
}

export function revokeDropTokenFromUi(
  host: DropTenantHost,
  input: {
    workspace: string;
    idOrLabel: string;
    globalRevoke?: boolean;
  },
): { ok: true; data: KbWorkspaceStatusData } | { ok: false; error: string } {
  const rawWs = input.workspace.trim();
  const isGlobalView = !rawWs || rawWs === "__all__";
  if (isGlobalView || input.globalRevoke) {
    const revoked = revokeDropToken(host, input.idOrLabel, Date.now(), undefined, {
      globalRevoke: true,
    });
    if (!revoked.ok) return revoked;
    return getKbWorkspaceStatusForUi(host, isGlobalView ? "" : rawWs);
  }
  const wsRef = host.resolveWorkspace(rawWs);
  if (!wsRef) return { ok: false, error: `找不到子工作区：${rawWs}` };
  const revoked = revokeDropToken(host, input.idOrLabel, Date.now(), wsRef.workspaceId, {
    globalRevoke: input.globalRevoke,
  });
  if (!revoked.ok) return revoked;
  return getKbWorkspaceStatusForUi(host, rawWs);
}

/**
 * 列出当前租户下所有已初始化为知识库（含合法 `.jiebo/kb.json`）的子工作区：
 * 供 iOS 分享扩展「归档入库」自动路由、以及日常巡检/助理工具使用。
 */
export function listTenantKbWorkspaces(host: DropTenantHost): Array<{
  workspaceKey: string;
  workspaceId: string;
  workspacePath: string;
  config: KbWorkspaceConfig;
}> {
  const results: Array<{
    workspaceKey: string;
    workspaceId: string;
    workspacePath: string;
    config: KbWorkspaceConfig;
  }> = [];
  let dirNames: string[] = [];
  try {
    dirNames = readdirSync(host.workspaceRoot).sort();
  } catch {
    return results;
  }
  for (const name of dirNames) {
    if (!name || name.startsWith(".")) continue;
    const wsRef = host.resolveWorkspace(name);
    if (!wsRef) continue;
    const kbLoaded = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
    if (!kbLoaded.ok) continue;
    results.push({
      workspaceKey: wsRef.key,
      workspaceId: wsRef.workspaceId,
      workspacePath: kbLoaded.workspaceRealPath,
      config: kbLoaded.config,
    });
  }
  return results;
}

/**
 * 根据可选的 workspace 参数、用户备注、文件名/标题与正文，智能且严格地匹配目标知识库子工作区：
 * 1. 若显式传入了 `preferredWorkspace`，优先精确匹配或大小写不敏感匹配，未命中直接拒绝；
 * 2. 若未指定且租户下只有 1 个知识库工作区，直接选中该工作区；
 * 3. 若有多个知识库工作区，赋予用户备注（note）最高权重（+30），文件名/标题次之（+12），正文再次之（+6）；
 * 4. 必须取得正分（`bestScore > 0`）且严格唯一最高分（无并列第一）才自动选中；若为 0 分或最高分并列，返回 `ok: false` 拒绝盲投，防止跨知识库误归档。
 */
export function resolveTargetKbWorkspaceForCapture(
  host: DropTenantHost,
  opts: {
    preferredWorkspace?: string;
    note?: string;
    hintTexts?: string[];
  } = {},
):
  | {
      ok: true;
      target: {
        workspaceKey: string;
        workspaceId: string;
        workspacePath: string;
        config: KbWorkspaceConfig;
      };
    }
  | { ok: false; error: string } {
  const kbList = listTenantKbWorkspaces(host);
  if (kbList.length === 0) {
    return { ok: false, error: "当前还没有已初始化的知识库工作区" };
  }

  const preferred = (opts.preferredWorkspace || "").trim();
  if (preferred) {
    const exact = kbList.find(
      (item) =>
        item.workspaceKey === preferred ||
        item.workspaceId === preferred ||
        item.workspaceKey.toLowerCase() === preferred.toLowerCase() ||
        item.config.title.toLowerCase() === preferred.toLowerCase(),
    );
    if (exact) return { ok: true, target: exact };
    return { ok: false, error: `指定的知识库工作区不存在或未开启知识库：${preferred}` };
  }

  if (kbList.length === 1) {
    return { ok: true, target: kbList[0] };
  }

  const noteLower = (opts.note || "").trim().toLowerCase();
  const combinedHint = (opts.hintTexts || []).filter(Boolean).join(" ").toLowerCase();

  let best = kbList[0];
  let bestScore = 0;
  let tiedCount = 0;

  for (const candidate of kbList) {
    let score = 0;
    const keyLower = candidate.workspaceKey.toLowerCase();
    const titleLower = candidate.config.title.toLowerCase();

    if (noteLower) {
      if (keyLower.length >= 2 && noteLower.includes(keyLower)) score += 30;
      if (titleLower.length >= 2 && noteLower.includes(titleLower)) score += 24;
    }

    if (keyLower.length >= 2 && combinedHint.includes(keyLower)) score += 10;
    if (titleLower.length >= 2 && combinedHint.includes(titleLower)) score += 8;

    for (const cat of candidate.config.allowedCategories) {
      const catLower = cat.trim().toLowerCase();
      if (catLower.length >= 2 && combinedHint.includes(catLower)) {
        score += 2;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
      tiedCount = 1;
    } else if (score > 0 && score === bestScore) {
      tiedCount += 1;
    }
  }

  if (bestScore <= 0 || tiedCount > 1) {
    const availableNames = kbList.map((k) => k.workspaceKey).join("、");
    return {
      ok: false,
      error: `存在多个知识库工作区（${availableNames}），未能唯一定位目标库，请在备注中写明目标知识库名称`,
    };
  }

  return { ok: true, target: best };
}
