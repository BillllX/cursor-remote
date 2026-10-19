import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type {
  MemoryCenterActivityAction,
  MemoryCenterAuditSnapshot,
  MemoryCenterMutateArgs,
  MemoryCenterMutateData,
  MemoryCenterMutateErrorCode,
  MemoryCenterScopeDetail,
} from "../../../shared/protocol.ts";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { isInside } from "../pathInside.ts";
import { insertLineInSectionLines, type MemoryFileLines } from "./memoryFileEdit.ts";
import { appendAuditRecord, lineToAuditSnapshot } from "./memoryCenterAudit.ts";
import {
  indexMemoryRowsFromLines,
  parseMemoryFileLines,
  writeMemoryView,
} from "./memoryCenterMutateShared.ts";
import { memoryLineRevision } from "./memoryRevision.ts";
import { memoryCenterGet } from "./memoryCenter.ts";
import { resolveWorkspaceScope } from "./memoryCenterScope.ts";
import { validateMemoryCenterMutateArgs } from "./memoryCenterMutateValidate.ts";
import {
  detectSecret,
  isValid,
  listMemory,
  PERSONAL_CORE_FIELDS,
  readCore,
} from "./memory.ts";
import { newId, type TenantRef } from "./store.ts";
import {
  effectiveMemoryState,
  ensureMemoryJieboGitignore,
  formatMemoryLine,
  leaksPersonal,
  safeMemoryPaths,
  type MemoryLine,
  type WorkspaceRoot,
} from "./workspaceMemory.ts";

const MUTATE_FROM = "user";
const EMPTY_MEMORY_HEAD =
  "# 工作区记忆\n\n<!-- 接驳维护：每条一行，可以手改或删。行尾注释是来源和引用的路径，引用的文件没了会标“待核实”。这里不放个人信息。 -->\n";

export type MutateFail = {
  ok: false;
  code: MemoryCenterMutateErrorCode;
  message: string;
  detail?: MemoryCenterScopeDetail;
};

export type MutateOk = { ok: true; data: MemoryCenterMutateData };

const today = () => new Date().toISOString().slice(0, 10);

function fail(code: MemoryCenterMutateErrorCode, message: string, detail?: MemoryCenterScopeDetail): MutateFail {
  return { ok: false, code, message, detail };
}

function readPersonalNeedles(ref: TenantRef) {
  const needles: string[] = [];
  for (const entry of listMemory(ref).entries) {
    if (!isValid(entry)) continue;
    needles.push(entry.text.replace(/^(用户|他|她)(的)?/, "").replace(/[。.!！]$/, ""));
  }
  const core = readCore(ref);
  for (const key of PERSONAL_CORE_FIELDS) needles.push(...core.fields[key].split(/[。\n；;]/));
  return needles.map((item) => item.trim()).filter((needle) => needle.length >= 8);
}

function normalizeRefsPaths(refs: string[], scopeDir: string, allowedRoot: string) {
  const out: string[] = [];
  for (const item of refs) {
    const ref = item.trim().replace(/\\/g, "/");
    if (!ref || ref.includes("..") || ref.startsWith("/")) {
      return fail("unsafe_ref", "引用路径不能是绝对路径或含 ..。");
    }
    try {
      const { dir } = safeMemoryPaths(scopeDir, allowedRoot);
      const target = resolve(dir, ref);
      if (!isInside(target, dir) && target !== dir) {
        return fail("unsafe_ref", "引用路径超出工作区作用域。");
      }
      if (!out.includes(ref)) out.push(ref);
    } catch {
      return fail("unsafe_ref", "引用路径校验失败。");
    }
  }
  return { ok: true as const, refs: out };
}

function scopeDetailAfter(tenant: WorkspaceRoot, workspaceNames: string[], scopeId: string) {
  const got = memoryCenterGet(tenant, workspaceNames, scopeId);
  if (got.mode !== "detail") return undefined;
  return got.detail;
}

function auditActionForMutation(action: MemoryCenterMutateArgs["mutation"]["action"]): MemoryCenterActivityAction {
  return action;
}

/** 记忆中心：结构化编辑工作区 .jiebo/memory.md（revision CAS + 同事务审计）。 */
export function memoryCenterMutate(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  input: MemoryCenterMutateArgs,
): MutateOk | MutateFail {
  try {
    const resolved = resolveWorkspaceScope(tenant, workspaceNames, input.scope);
    if (!resolved.ok) return fail(resolved.code, resolved.message);
    const { discovered, record, scopeId, absDir, root, paths } = resolved;
    const ref = discovered.ref;

    const mutation = input.mutation;
    const action = mutation.action;
    const needles = readPersonalNeedles(ref);

    const locked = withFileLockSync(paths.lockTarget, () => {
      try {
        safeMemoryPaths(absDir, root);
      } catch {
        return fail("write_failed", "加锁后路径变成不安全符号链接，已中止。");
      }

      const memoryExisted = existsSync(paths.memory);
      let rawText = "";
      try {
        rawText = readFileSync(paths.memory, "utf8");
      } catch {
        rawText = "";
      }
      const rollbackBytes = rawText;
      const rollbackMemory = () => {
        if (memoryExisted) atomicWriteFileSync(paths.memory, rollbackBytes, { mkdir: true });
        else rmSync(paths.memory, { force: true });
      };
      let view: MemoryFileLines = rawText.length ? parseMemoryFileLines(rawText) : parseMemoryFileLines(EMPTY_MEMORY_HEAD);
      const lines = view.lines;
      const indexed = indexMemoryRowsFromLines(lines);

      const finishOk = (item?: MemoryLine, deletedId?: string): MutateOk | MutateFail => {
        const detail = scopeDetailAfter(tenant, workspaceNames, scopeId);
        if (!detail) return fail("write_failed", "写入成功但无法生成详情快照。");
        const hit = item ? detail.items.find((row) => row.id === item.id) : undefined;
        return { ok: true, data: { scope: scopeId, action, item: hit, deletedId, detail } };
      };

      const commit = (
        item?: MemoryLine,
        deletedId?: string,
        audit?: {
          itemId: string;
          before?: MemoryCenterAuditSnapshot;
          after?: MemoryCenterAuditSnapshot;
          rowHint?: number;
        },
      ): MutateOk | MutateFail => {
        view.lines = lines;
        try {
          ensureMemoryJieboGitignore(absDir, root);
          writeMemoryView(paths, view);
        } catch (err) {
          return fail("write_failed", `写入失败：${err instanceof Error ? err.message : String(err)}`);
        }
        if (audit) {
          try {
            appendAuditRecord(paths, {
              scope: scopeId,
              itemId: audit.itemId,
              action: auditActionForMutation(action),
              actor: "user",
              at: new Date().toISOString(),
              before: audit.before,
              after: audit.after,
              rowHint: audit.rowHint,
            });
          } catch {
            try {
              rollbackMemory();
            } catch {
              return fail("write_failed", "审计失败且记忆回滚失败，请人工检查 memory.md。");
            }
            return fail("write_failed", "审计写入失败，已回滚记忆。");
          }
        }
        return finishOk(item, deletedId);
      };

      const sensitiveCheck = (line: MemoryLine) => {
        if (detectSecret(line.text)) return fail("sensitive", "内容像密钥或密码，不能写入。");
        if (leaksPersonal(ref, line.text, needles)) return fail("sensitive", "内容疑似个人信息，工作区记忆不收录。");
        return null;
      };

      if (mutation.action === "create") {
        const refsNorm = normalizeRefsPaths(mutation.refs ?? [], absDir, root);
        if ("code" in refsNorm) return refsNorm;
        const line: MemoryLine = {
          section: mutation.section,
          text: mutation.text,
          id: newId("wm"),
          from: MUTATE_FROM,
          at: today(),
          refs: refsNorm.refs,
          pinned: mutation.pinned ? true : undefined,
          state: mutation.state,
          expires: mutation.expires,
        };
        const sens = sensitiveCheck(line);
        if (sens) return sens;
        const formatted = formatMemoryLine(line);
        insertLineInSectionLines(lines, line.section, formatted);
        const afterRow = indexMemoryRowsFromLines(lines).find((row) => row.line.id === line.id);
        return commit(line, undefined, {
          itemId: line.id!,
          after: lineToAuditSnapshot(line, afterRow ? lines[afterRow.row] : formatted, afterRow?.row),
        });
      }

      const id = mutation.id;
      const matches = indexed.filter((row) => row.line.id === id);
      if (matches.length !== 1) return fail("not_found", "找不到该条目或 id 不唯一。");
      const target = matches[0];
      if (mutation.revision !== memoryLineRevision(target.line)) {
        const detail = scopeDetailAfter(tenant, workspaceNames, scopeId);
        return fail("conflict", "内容已变化，请刷新后重试。", detail);
      }

      const eff = effectiveMemoryState(target.line);
      const beforeSnap = lineToAuditSnapshot(target.line, lines[target.row], target.row);

      if (mutation.action === "delete") {
        lines.splice(target.row, 1);
        return commit(undefined, id, { itemId: id, before: beforeSnap, rowHint: target.row });
      }

      const mergePatch = (base: MemoryLine): MemoryLine | MutateFail => {
        if (mutation.action !== "update") return base;
        const patch = mutation.patch;
        const next: MemoryLine = {
          ...base,
          refs: [...base.refs],
          meta: base.meta ? { ...base.meta } : undefined,
          metaOrder: base.metaOrder ? [...base.metaOrder] : undefined,
        };
        if (patch.section !== undefined) next.section = patch.section;
        if (patch.text !== undefined) next.text = patch.text;
        if (patch.refs !== undefined) next.refs = [...patch.refs];
        if (patch.pinned !== undefined) next.pinned = patch.pinned || undefined;
        if (patch.state !== undefined) next.state = patch.state ?? undefined;
        if (patch.expires !== undefined) next.expires = patch.expires ?? undefined;
        if (next.pinned && next.state === "done") {
          return fail("invalid_input", "置顶条目不能标为完成，请先取消置顶。");
        }
        return next;
      };

      if (mutation.action === "set_state") {
        const state = mutation.state;
        if (eff === "expired" && state === "done") {
          return fail("invalid_input", "已过期条目不能直接标完成，请改 expires 或恢复热/冷。");
        }
        if (state === "done" && target.line.pinned) {
          return fail("invalid_input", "置顶条目不能标为完成，请先取消置顶。");
        }
        if (eff === "expired" && state !== "hot" && state !== "cold") {
          return fail("invalid_input", "已过期条目只能恢复为 hot 或 cold。");
        }
        const next: MemoryLine = { ...target.line, state };
        const sens = sensitiveCheck(next);
        if (sens) return sens;
        const formatted = formatMemoryLine(next);
        if (next.section !== target.section) {
          lines.splice(target.row, 1);
          insertLineInSectionLines(lines, next.section, formatted);
        } else {
          lines[target.row] = formatted;
        }
        const rowAfter = indexMemoryRowsFromLines(lines).find((row) => row.line.id === id);
        const rawAfter = rowAfter ? lines[rowAfter.row] : formatMemoryLine(next);
        return commit(next, undefined, {
          itemId: id,
          before: beforeSnap,
          after: lineToAuditSnapshot(next, rawAfter, rowAfter?.row),
        });
      }

      if (mutation.action === "set_pinned") {
        if (mutation.pinned && target.line.state === "done") {
          return fail("invalid_input", "已完成条目不能置顶。");
        }
        if (eff === "expired" && mutation.pinned) {
          return fail("invalid_input", "已过期条目不能置顶，请先改 expires。");
        }
        const next: MemoryLine = { ...target.line, pinned: mutation.pinned || undefined };
        if (next.pinned && next.state === "done") {
          return fail("invalid_input", "置顶与完成状态冲突。");
        }
        const sens = sensitiveCheck(next);
        if (sens) return sens;
        const formattedPin = formatMemoryLine(next);
        lines[target.row] = formattedPin;
        return commit(next, undefined, {
          itemId: id,
          before: beforeSnap,
          after: lineToAuditSnapshot(next, formattedPin, target.row),
        });
      }

      if (mutation.action === "update") {
        if (eff === "expired") {
          const keys = Object.keys(mutation.patch);
          const onlyExpiresOrRestore =
            keys.every((k) => k === "expires" || k === "state") &&
            (mutation.patch.state === undefined ||
              mutation.patch.state === "hot" ||
              mutation.patch.state === "cold" ||
              mutation.patch.state === null);
          if (!onlyExpiresOrRestore) {
            return fail("invalid_input", "已过期条目只能修改 expires 或恢复 hot/cold。");
          }
        }
        const merged = mergePatch(target.line);
        if ("code" in merged) return merged;
        const next = merged;
        const refsNorm = normalizeRefsPaths(next.refs, absDir, root);
        if ("code" in refsNorm) return refsNorm;
        next.refs = refsNorm.refs;
        const sens = sensitiveCheck(next);
        if (sens) return sens;
        const formatted = formatMemoryLine(next);
        if (next.section !== target.section) {
          lines.splice(target.row, 1);
          insertLineInSectionLines(lines, next.section, formatted);
        } else {
          lines[target.row] = formatted;
        }
        const rowAfter = indexMemoryRowsFromLines(lines).find((row) => row.line.id === id);
        const rawAfter = rowAfter ? lines[rowAfter.row] : formatMemoryLine(next);
        return commit(next, undefined, {
          itemId: id,
          before: beforeSnap,
          after: lineToAuditSnapshot(next, rawAfter, rowAfter?.row),
        });
      }

      return fail("invalid_input", "不支持的 mutation。");
    });

    return locked;
  } catch (err) {
    return fail("write_failed", `内部错误：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseMemoryCenterMutateArgs(raw: Record<string, unknown>) {
  const v = validateMemoryCenterMutateArgs(raw);
  if (!v.ok) return { ok: false as const, message: v.message, code: v.code };
  return { ok: true as const, value: v.value };
}
