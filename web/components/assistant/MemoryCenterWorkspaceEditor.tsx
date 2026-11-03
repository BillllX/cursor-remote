"use client";

import { useEffect, useMemo, useState } from "react";
import type { MemoryCenterMutateArgs, WorkspaceMemoryItem } from "@shared/protocol";
import { MEMORY_CENTER_CSS } from "./memoryCenterLabels";
import styles from "./memoryCenter.module.css";

const SECTIONS = ["约定", "命令", "坑", "决定", "进行中"] as const;

type Props = {
  scopeId: string;
  item: WorkspaceMemoryItem | null;
  busy: boolean;
  error: string;
  conflict: boolean;
  mode?: "create" | "edit";
  onMutate: (args: MemoryCenterMutateArgs) => void;
  onClearSelection: () => void;
  onCreated: () => void;
  onCancel?: () => void;
};

export default function MemoryCenterWorkspaceEditor({
  scopeId,
  item,
  busy,
  error,
  conflict,
  mode,
  onMutate,
  onClearSelection,
  onCreated,
  onCancel,
}: Props) {
  const [creating, setCreating] = useState(mode === "create");
  const [section, setSection] = useState<string>("约定");
  const [text, setText] = useState("");
  const [refsText, setRefsText] = useState("");
  const [expires, setExpires] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (mode === "create") setCreating(true);
  }, [mode]);

  useEffect(() => {
    if (!item) return;
    setSection(item.section ?? "约定");
    setText(item.text);
    setRefsText(item.refs.join(", "));
    setExpires(item.expires ?? "");
    setConfirmDelete(false);
  }, [item?.id, item?.revision]);

  const refsList = useMemo(
    () =>
      refsText
        .split(/[\n,，、]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [refsText],
  );

  const dirty =
    item &&
    (section !== (item.section ?? "约定") ||
      text.trim() !== item.text ||
      refsList.join(",") !== item.refs.join(",") ||
      (expires || "") !== (item.expires ?? ""));

  if (!item && !creating) return null;

  if (creating && !item) {
    return (
      <div className={styles.editorBlock}>
        <div className="side-label">记一条</div>
        <label className={styles.editorField}>
          章节
          <select value={section} disabled={busy} onChange={(e) => setSection(e.target.value)}>
            {SECTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.editorField}>
          正文
          <textarea value={text} disabled={busy} rows={4} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className={styles.editorField}>
          引用（逗号或换行分隔）
          <textarea value={refsText} disabled={busy} rows={2} onChange={(e) => setRefsText(e.target.value)} />
        </label>
        <label className={styles.editorField}>
          过期日（可选）
          <input type="date" value={expires} disabled={busy} onChange={(e) => setExpires(e.target.value)} />
        </label>
        {error ? <div className={MEMORY_CENTER_CSS.statusError}>{error}</div> : null}
        <div className={styles.editorActions}>
          <button
            type="button"
            className={styles.pineBtn}
            data-mc-save
            disabled={busy || !text.trim()}
            onClick={() => {
              onMutate({
                scope: scopeId,
                mutation: {
                  action: "create",
                  section,
                  text: text.trim(),
                  refs: refsList.length ? refsList : undefined,
                  expires: expires || undefined,
                },
              });
              setCreating(false);
              setText("");
              setRefsText("");
              setExpires("");
              onCreated();
            }}
          >
            {busy ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            className="pill ghost"
            disabled={busy}
            onClick={() => {
              setCreating(false);
              setText("");
              onCancel?.();
            }}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  if (!item?.id) {
    return <div className="loop-meta">该条目没有稳定 id，暂不支持在此编辑。</div>;
  }

  const revision = item.revision;

  return (
    <div className={styles.editorBlock}>
      <div className="side-label">改这一条</div>
      {conflict ? <div className={MEMORY_CENTER_CSS.statusError}>内容已变化，已刷新列表，请核对后重试。</div> : null}
      {error && !conflict ? <div className={MEMORY_CENTER_CSS.statusError}>{error}</div> : null}
      <label className={styles.editorField}>
        章节
        <select value={section} disabled={busy} onChange={(e) => setSection(e.target.value)}>
          {SECTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.editorField}>
        正文
        <textarea value={text} disabled={busy} rows={5} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className={styles.editorField}>
        引用
        <textarea value={refsText} disabled={busy} rows={2} onChange={(e) => setRefsText(e.target.value)} />
      </label>
      <label className={styles.editorField}>
        过期日
        <input type="date" value={expires} disabled={busy} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <div className={styles.editorActions}>
        <button
          type="button"
          className={styles.pineBtn}
          data-mc-save
          disabled={busy || !dirty}
          onClick={() =>
            onMutate({
              scope: scopeId,
              mutation: {
                action: "update",
                id: item.id!,
                revision,
                patch: {
                  section,
                  text: text.trim(),
                  refs: refsList,
                  expires: expires || null,
                },
              },
            })
          }
        >
          {busy ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          className="pill"
          disabled={busy}
          onClick={() =>
            onMutate({
              scope: scopeId,
              mutation: { action: "set_pinned", id: item.id!, revision, pinned: !item.pinned },
            })
          }
        >
          {item.pinned ? "不再始终带上" : "始终带上"}
        </button>
        {item.effectiveState === "done" ? (
          <button
            type="button"
            className="pill"
            disabled={busy}
            onClick={() =>
              onMutate({
                scope: scopeId,
                mutation: { action: "set_state", id: item.id!, revision, state: "hot" },
              })
            }
          >
            再拿来用
          </button>
        ) : (
          <>
            <button
              type="button"
              className="pill"
              disabled={busy || item.pinned}
              onClick={() =>
                onMutate({
                  scope: scopeId,
                  mutation: { action: "set_state", id: item.id!, revision, state: "done" },
                })
              }
            >
              标成已办完
            </button>
            <button
              type="button"
              className="pill ghost"
              disabled={busy}
              onClick={() =>
                onMutate({
                  scope: scopeId,
                  mutation: {
                    action: "set_state",
                    id: item.id!,
                    revision,
                    state: item.state === "cold" ? "hot" : "cold",
                  },
                })
              }
            >
              {item.state === "cold" ? "再拿来用" : "标成很久没用"}
            </button>
          </>
        )}
        {!confirmDelete ? (
          <button type="button" className="pill danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
            彻底删除…
          </button>
        ) : (
          <>
            <span className="loop-meta">确认永久删除？</span>
            <button
              type="button"
              className="pill danger"
              disabled={busy}
              onClick={() => {
                onMutate({
                  scope: scopeId,
                  mutation: { action: "delete", id: item.id!, revision },
                });
                onClearSelection();
              }}
            >
              确认删除
            </button>
            <button type="button" className="pill ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
              取消
            </button>
          </>
        )}
      </div>
      <div className="loop-meta">文件夹规则在「更多」里，这里改不了。</div>
    </div>
  );
}
