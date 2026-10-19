"use client";

import { useState, type ReactNode } from "react";
import type { AssistantMemoryEntry, AssistantState } from "@shared/protocol";
import type { BuildAssistantOpMessage } from "@shared/assistantOp";
import styles from "./memoryCenter.module.css";

type Props = {
  name: string;
  memory: NonNullable<AssistantState["memory"]>;
  op: BuildAssistantOpMessage;
  onNotice: (text: string) => void;
  defaultOpen?: boolean;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="assistant-section">
      <div className="side-label">{title}</div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="loop-meta">{children}</div>;
}

export default function PersonalMemoryManage({ memory, op, onNotice, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState<{ id: string; rev: number; topic: string; text: string } | null>(null);
  const [coreDraft, setCoreDraft] = useState<Record<string, string> | null>(null);
  const [showInvalid, setShowInvalid] = useState(false);
  const [memTopic, setMemTopic] = useState("");
  const [memText, setMemText] = useState("");

  const memoryEntries = memory.entries;
  const validEntries = memoryEntries.filter((entry) => !entry.invalidAt);
  const invalidEntries = memoryEntries.filter((entry) => entry.invalidAt);

  function purge(entry: AssistantMemoryEntry) {
    if (!window.confirm(`彻底删除「${entry.topic}」？摘要、简报、收件箱和会话索引里的相关片段会一起抹掉，不能恢复。`))
      return;
    op("memory_purge", { id: entry.id });
  }

  if (!open) {
    return (
      <div className={styles.manageToggle}>
        <button type="button" className="pill" aria-expanded={false} onClick={() => setOpen(true)}>
          管理个人记忆（编辑 / 暂停 / 导出）
        </button>
      </div>
    );
  }

  return (
    <div className={styles.managePanel}>
      <button type="button" className={`pill ${styles.drillBack}`} aria-expanded={true} onClick={() => setOpen(false)}>
        收起管理
      </button>
      <Section title="核心档案">
        {coreDraft ? (
          <form
            className="assistant-col-form"
            onSubmit={(event) => {
              event.preventDefault();
              op("memory_core", { fields: coreDraft, rev: memory.core.rev });
              setCoreDraft(null);
            }}
          >
            {Object.keys(memory.core.fields).map((key) => (
              <label key={key} className="loop-field">
                {key}
                <textarea
                  className="loop-goal"
                  rows={3}
                  value={coreDraft[key] ?? ""}
                  onChange={(e) => setCoreDraft({ ...coreDraft, [key]: e.target.value })}
                />
              </label>
            ))}
            <div className="loop-actions">
              <button type="submit" className="new-chat primary">
                保存档案
              </button>
              <button type="button" className="new-chat" onClick={() => setCoreDraft(null)}>
                取消
              </button>
            </div>
          </form>
        ) : (
          <>
            {Object.entries(memory.core.fields).some(([, value]) => value.trim()) ? (
              <div className="assistant-core">
                {Object.entries(memory.core.fields).map(([key, value]) =>
                  value.trim() ? (
                    <div key={key}>
                      <div className="loop-field">{key}</div>
                      <div className="assistant-item-body">{value}</div>
                    </div>
                  ) : null,
                )}
              </div>
            ) : (
              <Empty>核心档案还是空的。它会在每次对话开头注入。</Empty>
            )}
            <div className="loop-meta">
              约 {memory.coreTokens}/{memory.coreBudget} token
              {memory.settings.paused ? " · 记忆已暂停：模型不写新记忆，对话里也不注入" : ""}
            </div>
            <div className="assistant-row-actions">
              <button type="button" className="pill" onClick={() => setCoreDraft({ ...memory.core.fields })}>
                编辑档案
              </button>
              <button
                type="button"
                className="pill"
                onClick={() => op("memory_settings", { paused: !memory.settings.paused })}
              >
                {memory.settings.paused ? "恢复记忆" : "暂停记忆"}
              </button>
            </div>
          </>
        )}
      </Section>
      <Section title="新增">
        <form
          className="assistant-col-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!memTopic.trim() || !memText.trim()) return;
            op("memory_save", { topic: memTopic.trim(), text: memText.trim() });
            setMemTopic("");
            setMemText("");
            onNotice("已保存。");
          }}
        >
          <input
            className="side-input"
            value={memTopic}
            onChange={(e) => setMemTopic(e.target.value)}
            placeholder="主题，例如：饮食"
          />
          <textarea
            className="loop-goal"
            rows={3}
            value={memText}
            onChange={(e) => setMemText(e.target.value)}
            placeholder="要记住的内容"
          />
          <div className="loop-actions">
            <button type="submit" className="new-chat primary">
              保存
            </button>
          </div>
        </form>
      </Section>
      <Section title={`条目 · ${validEntries.length}`}>
        {validEntries.length ? (
          <ul className="assistant-list">
            {validEntries.slice(0, 200).map((entry) =>
              editing?.id === entry.id ? (
                <li key={entry.id} className="assistant-item">
                  <form
                    className="assistant-col-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!editing.topic.trim() || !editing.text.trim()) return;
                      op("memory_edit", {
                        id: entry.id,
                        rev: editing.rev,
                        topic: editing.topic.trim(),
                        text: editing.text.trim(),
                      });
                      setEditing(null);
                    }}
                  >
                    <input
                      className="side-input"
                      value={editing.topic}
                      onChange={(e) => setEditing({ ...editing, topic: e.target.value })}
                    />
                    <textarea
                      className="loop-goal"
                      rows={3}
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                    />
                    <div className="loop-actions">
                      <button type="submit" className="new-chat primary">
                        保存
                      </button>
                      <button type="button" className="new-chat" onClick={() => setEditing(null)}>
                        取消
                      </button>
                    </div>
                  </form>
                </li>
              ) : (
                <li key={entry.id} className="assistant-item">
                  <div className="assistant-item-head">
                    <span className="assistant-item-title">{entry.topic}</span>
                    <span className={`chat-mark ${entry.basis === "inferred" ? "run" : "ok"}`}>
                      {entry.basis === "inferred" ? "推断" : "你说的"}
                    </span>
                    {entry.validUntil ? <span className="chat-mark">到 {entry.validUntil}</span> : null}
                  </div>
                  <div className="assistant-item-body">{entry.text.slice(0, 300)}</div>
                  <div className="assistant-row-actions">
                    <button
                      type="button"
                      className="pill"
                      onClick={() => setEditing({ id: entry.id, rev: entry.rev, topic: entry.topic, text: entry.text })}
                    >
                      编辑
                    </button>
                    <button type="button" className="pill" onClick={() => op("memory_invalidate", { id: entry.id })}>
                      标失效
                    </button>
                    <button type="button" className="pill" onClick={() => op("memory_forget", { id: entry.id })}>
                      遗忘
                    </button>
                    <button type="button" className="pill danger" onClick={() => purge(entry)}>
                      彻底删除
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
        ) : (
          <Empty>还没有记忆。在对话里说“记住……”，或在上面手动加一条。</Empty>
        )}
        {invalidEntries.length ? (
          <button type="button" className="pill" onClick={() => setShowInvalid(!showInvalid)}>
            {showInvalid ? "收起已失效" : `已失效 · ${invalidEntries.length}`}
          </button>
        ) : null}
        {showInvalid ? (
          <ul className="assistant-list">
            {invalidEntries.slice(0, 100).map((entry) => (
              <li key={entry.id} className="assistant-item muted">
                <div className="assistant-item-head">
                  <span className="assistant-item-title">{entry.topic}</span>
                  <span className="chat-mark">{entry.invalidReason || "已失效"}</span>
                </div>
                <div className="assistant-item-body">{entry.text.slice(0, 200)}</div>
                <div className="assistant-row-actions">
                  <button type="button" className="pill" onClick={() => op("memory_restore", { id: entry.id })}>
                    恢复
                  </button>
                  <button type="button" className="pill danger" onClick={() => purge(entry)}>
                    彻底删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <button type="button" className="new-chat" onClick={() => op("memory_export")}>
          导出只读快照到 .jiebo/memory-export/
        </button>
      </Section>
    </div>
  );
}
