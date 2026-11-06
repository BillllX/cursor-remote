import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { KbHtmlBoardItem, KbWorkspaceStatusData } from "../../../shared/protocol.ts";
import {
  ensureSafePathInWorkspace,
  loadKbWorkspaceConfig,
  safeReadWorkspaceTextFileSync,
  type KbWorkspaceConfig,
} from "./contract.ts";
import {
  createDropToken,
  listDropTokens,
  revokeDropToken,
  setupKbWorkspaceForTenant,
  type DropTenantHost,
} from "./tokens.ts";

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

/**
 * 获取指定子工作区的知识库状态、已生成的 HTML 看板列表、以及关联的投递口令列表（供前端 UI 展示）
 */
export function getKbWorkspaceStatusForUi(
  host: DropTenantHost,
  workspaceKeyOrPath: string,
): { ok: true; data: KbWorkspaceStatusData } | { ok: false; error: string } {
  const raw = workspaceKeyOrPath.trim();
  if (!raw) {
    return { ok: false, error: "请指定工作区名称或路径" };
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

  const dropPortalPath = `/p/${host.id}/drop`;
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
        dropPortalPath,
      },
    };
  }

  const boards = scanWorkspaceKbHtmlBoards(kbLoaded.workspaceRealPath, kbLoaded.config);
  const allTokens = listDropTokens(host, { includeRevoked: false });
  const wsTokens = allTokens.filter((t) => t.workspaceId === wsRef.workspaceId);

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
  },
): { ok: true; data: KbWorkspaceStatusData } | { ok: false; error: string } {
  const created = createDropToken(host, input);
  if (!created.ok) return created;
  return getKbWorkspaceStatusForUi(host, input.workspace);
}

export function revokeDropTokenFromUi(
  host: DropTenantHost,
  input: {
    workspace: string;
    idOrLabel: string;
  },
): { ok: true; data: KbWorkspaceStatusData } | { ok: false; error: string } {
  const wsRef = host.resolveWorkspace(input.workspace);
  if (!wsRef) return { ok: false, error: `找不到子工作区：${input.workspace}` };
  const revoked = revokeDropToken(host, input.idOrLabel, Date.now(), wsRef.workspaceId);
  if (!revoked.ok) return revoked;
  return getKbWorkspaceStatusForUi(host, input.workspace);
}
