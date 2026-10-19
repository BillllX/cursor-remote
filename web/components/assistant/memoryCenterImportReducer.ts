import type { MemoryCenterImportPreviewData } from "@shared/memoryCenterImportTypes";
import {
  parseMemoryCenterExportData,
  parseMemoryCenterImportApplyData,
  parseMemoryCenterImportPreviewData,
  parseMemoryCenterImportRollbackData,
} from "@shared/memoryCenterImportParse";
import type { AssistantResultMessage } from "@shared/protocol";

export type MemoryCenterImportUiState = {
  busy: boolean;
  exportResult: { relativePath: string; sha256: string; bytes: number } | null;
  preview: MemoryCenterImportPreviewData | null;
  resolutions: Record<string, "keep_current" | "use_snapshot" | "duplicate">;
  lastImportId: string | null;
  error: string | null;
};

export const initialMemoryCenterImportUiState: MemoryCenterImportUiState = {
  busy: false,
  exportResult: null,
  preview: null,
  resolutions: {},
  lastImportId: null,
  error: null,
};

export function reduceMemoryCenterImportResult(
  state: MemoryCenterImportUiState,
  message: AssistantResultMessage,
  reqId: string | undefined,
  pendingReqId: string | undefined,
): MemoryCenterImportUiState {
  if (!pendingReqId || !reqId || reqId !== pendingReqId) return state;
  const ops = new Set([
    "memory_center_export",
    "memory_center_import_preview",
    "memory_center_import_apply",
    "memory_center_import_rollback",
  ]);
  if (!ops.has(message.op)) return state;
  if (!message.ok) {
    return { ...state, busy: false, error: message.error ?? "操作失败。" };
  }
  if (message.op === "memory_center_export") {
    const data = parseMemoryCenterExportData(message.data);
    if (!data) return { ...state, busy: false, error: "导出结果格式无效。" };
    return {
      ...state,
      busy: false,
      error: null,
      exportResult: { relativePath: data.relativePath, sha256: data.sha256, bytes: data.bytes },
    };
  }
  if (message.op === "memory_center_import_preview") {
    const data = parseMemoryCenterImportPreviewData(message.data);
    if (!data) return { ...state, busy: false, error: "预演结果格式无效。" };
    const resolutions: Record<string, "keep_current" | "use_snapshot" | "duplicate"> = {};
    for (const ch of data.changes) {
      if (ch.action === "conflict") resolutions[ch.changeId] = "keep_current";
    }
    return { ...state, busy: false, error: null, preview: data, resolutions };
  }
  if (message.op === "memory_center_import_apply") {
    const data = parseMemoryCenterImportApplyData(message.data);
    if (!data) return { ...state, busy: false, error: "导入结果格式无效。" };
    return { ...state, busy: false, error: null, preview: null, lastImportId: data.importId };
  }
  if (message.op === "memory_center_import_rollback") {
    const data = parseMemoryCenterImportRollbackData(message.data);
    if (!data) return { ...state, busy: false, error: "回滚结果格式无效。" };
    return { ...state, busy: false, error: null, lastImportId: null };
  }
  return state;
}
