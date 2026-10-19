"use client";

import { useEffect, useRef, useState } from "react";
import type { BuildAssistantOpMessage } from "@shared/assistantOp";
import type { AssistantResultMessage } from "@shared/protocol";
import styles from "./memoryCenter.module.css";
import type { MemoryCenterScopeSummary } from "@shared/protocol";
import {
  defaultMemoryCenterExportScopes,
  MEMORY_CENTER_EXPORT_VIRTUAL_SCOPES,
  workspaceExportScopeIdsFromOverview,
} from "@shared/memoryCenterExportScopeOptions";
import {
  initialMemoryCenterImportUiState,
  reduceMemoryCenterImportResult,
} from "./memoryCenterImportReducer";

type Props = {
  op: BuildAssistantOpMessage;
  lastResult: AssistantResultMessage | null;
  resultTick: number;
  onNotice: (text: string) => void;
  overviewScopes?: MemoryCenterScopeSummary[];
};

export default function MemoryCenterImportPane({ op, lastResult, resultTick, onNotice, overviewScopes = [] }: Props) {
  const [ui, setUi] = useState(initialMemoryCenterImportUiState);
  const [importPath, setImportPath] = useState("");
  const pendingReq = useRef<string | null>(null);
  const workspaceIds = workspaceExportScopeIdsFromOverview(overviewScopes);
  const [exportScopes, setExportScopes] = useState<string[]>(() => defaultMemoryCenterExportScopes(overviewScopes));

  useEffect(() => {
    setExportScopes((prev) => {
      const allowed = new Set([...MEMORY_CENTER_EXPORT_VIRTUAL_SCOPES, ...workspaceIds]);
      const kept = prev.filter((s) => allowed.has(s));
      return kept.length ? kept : defaultMemoryCenterExportScopes(overviewScopes);
    });
  }, [overviewScopes, workspaceIds.join(",")]);

  useEffect(() => {
    if (!lastResult) return;
    const reqId = lastResult.reqId;
    const pending = pendingReq.current;
    if (pending && reqId && reqId !== pending) return;
    setUi((prev) => reduceMemoryCenterImportResult(prev, lastResult, reqId, pending ?? undefined));
    if (!pending || !reqId || reqId === pending) pendingReq.current = null;
  }, [lastResult, resultTick]);

  function toggleExportScope(id: string) {
    setExportScopes((prev) => {
      const has = prev.includes(id);
      const next = has ? prev.filter((s) => s !== id) : [...prev, id];
      return next.length ? next : prev;
    });
  }

  function runExport() {
    if (!exportScopes.length) {
      onNotice("请至少选择一个导出范围。");
      return;
    }
    setUi((s) => ({ ...s, busy: true, error: null }));
    const msg = op("memory_center_export", { scopes: exportScopes });
    pendingReq.current = msg.reqId ?? null;
  }

  function runPreview() {
    const path = importPath.trim();
    if (!path) {
      onNotice("请填写服务器内导出/导入路径。");
      return;
    }
    setUi((s) => ({ ...s, busy: true, error: null }));
    const msg = op("memory_center_import_preview", { path });
    pendingReq.current = msg.reqId ?? null;
  }

  function runApply() {
    if (!ui.preview) return;
    const conflicts = ui.preview.changes.filter((c) => c.action === "conflict");
    const resolutions = [
      ...conflicts.map((c) => ({
        changeId: c.changeId,
        resolution: ui.resolutions[c.changeId] ?? ("keep_current" as const),
      })),
      ...ui.preview.changes
        .filter((c) => c.action === "add")
        .map((c) => ({ changeId: c.changeId, resolution: "use_snapshot" as const })),
    ];
    if (!window.confirm("确认应用导入？将写入个人与工作区记忆，并可在成功后回滚最近一次。")) return;
    setUi((s) => ({ ...s, busy: true, error: null }));
    const msg = op("memory_center_import_apply", { planId: ui.preview.planId, resolutions });
    pendingReq.current = msg.reqId ?? null;
  }

  function runRollback() {
    if (!ui.lastImportId) return;
    if (!window.confirm("确认回滚最近一次导入？")) return;
    setUi((s) => ({ ...s, busy: true, error: null }));
    const msg = op("memory_center_import_rollback", { importId: ui.lastImportId });
    pendingReq.current = msg.reqId ?? null;
  }

  return (
    <section className="assistant-section">
      <div className="side-label">导入 / 导出</div>
      <div className={styles.importRow}>
        <fieldset className="loop-meta">
          <legend>导出范围（至少一项）</legend>
          {MEMORY_CENTER_EXPORT_VIRTUAL_SCOPES.map((id) => (
            <label key={id} className="loop-meta">
              <input type="checkbox" checked={exportScopes.includes(id)} onChange={() => toggleExportScope(id)} />{" "}
              {id === "personal" ? "个人记忆" : id === "work_preference" ? "工作偏好 (W0)" : "个人设置"}
            </label>
          ))}
          {workspaceIds.map((id) => (
            <label key={id} className="loop-meta">
              <input type="checkbox" checked={exportScopes.includes(id)} onChange={() => toggleExportScope(id)} /> 工作区 {id}
            </label>
          ))}
        </fieldset>
        <button type="button" className="pill" disabled={ui.busy} onClick={runExport}>
          导出记忆中心快照
        </button>
        {ui.exportResult ? (
          <div className="loop-meta">
            路径：{ui.exportResult.relativePath}
            <br />
            SHA-256：{ui.exportResult.sha256.slice(0, 16)}…（{ui.exportResult.bytes} 字节）
          </div>
        ) : null}
      </div>
      <label className="loop-field">
        导入文件路径（仅 .jiebo/memory-export/ 或 memory-import/）
        <input className="loop-goal" value={importPath} onChange={(e) => setImportPath(e.target.value)} />
      </label>
      <div className={styles.importRow}>
        <button type="button" className="pill" disabled={ui.busy} onClick={runPreview}>
          预演
        </button>
        <button type="button" className="new-chat" disabled={ui.busy || !ui.preview} onClick={runApply}>
          应用
        </button>
        <button type="button" className="pill" disabled={ui.busy || !ui.lastImportId} onClick={runRollback}>
          回滚
        </button>
      </div>
      {ui.error ? <div className="loop-meta">{ui.error}</div> : null}
      {ui.preview ? (
        <div className={styles.importPreview}>
          <div className="loop-meta">计划 {ui.preview.planId.slice(0, 12)}… · {ui.preview.changes.length} 项变更</div>
          {ui.preview.warnings.map((w) => (
            <div key={`${w.code}-${w.scope ?? ""}-${w.message}`} className="loop-meta">
              ⚠ {w.message}
            </div>
          ))}
          <ul className={styles.importChangeList}>
            {ui.preview.changes.slice(0, 40).map((ch) => (
              <li key={ch.changeId}>
                [{ch.layer}] {ch.action} {ch.scope ?? ""} {ch.id ?? ""}
                {ch.action === "conflict" ? (
                  <select
                    value={ui.resolutions[ch.changeId] ?? "keep_current"}
                    onChange={(e) =>
                      setUi((s) => ({
                        ...s,
                        resolutions: {
                          ...s.resolutions,
                          [ch.changeId]: e.target.value as "keep_current" | "use_snapshot" | "duplicate",
                        },
                      }))
                    }
                  >
                    <option value="keep_current">保留当前</option>
                    <option value="use_snapshot">使用快照</option>
                    {ch.allowedResolutions.includes("duplicate") ? (
                      <option value="duplicate">复制为新条目</option>
                    ) : null}
                  </select>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {ui.lastImportId ? <div className="loop-meta">最近导入：{ui.lastImportId}（可回滚）</div> : null}
    </section>
  );
}
