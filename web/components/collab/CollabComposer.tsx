import { useEffect, useRef, useState } from "react";
import type { ActorRef } from "@shared/protocol";
import type { CollabDraft } from "./collabState";
import styles from "./collab.module.css";

export function CollabComposer({
  convId,
  actors,
  draft,
  online,
  onChange,
  onSend,
}: {
  convId: string;
  actors: ActorRef[];
  draft?: CollabDraft;
  online: boolean;
  onChange: (draft: CollabDraft) => void;
  onSend: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const assistant = actors.find((actor) => actor.kind === "assistant");
  const current = draft ?? { text: "", mentions: assistant ? [assistant.actorId] : [] };

  useEffect(() => {
    if (!draft && assistant) onChange({ text: "", mentions: [assistant.actorId] });
  }, [assistant, draft, onChange]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setPickerOpen(true);
        requestAnimationFrame(() => selectRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = current.mentions
    .map((actorId) => actors.find((actor) => actor.actorId === actorId))
    .filter((actor): actor is ActorRef => Boolean(actor));

  return (
    <div className={styles.composerWrap}>
      <div className={styles.mentionRow} aria-label="消息接收 Agent">
        {selected.map((actor) => (
          <span className={styles.mentionChip} key={actor.actorId}>
            @{actor.displayName}
            <button
              type="button"
              aria-label={`移除 @${actor.displayName}`}
              onClick={() =>
                onChange({
                  ...current,
                  mentions: current.mentions.filter((id) => id !== actor.actorId),
                })
              }
            >
              ×
            </button>
          </span>
        ))}
        <button type="button" className={styles.addMention} onClick={() => setPickerOpen((open) => !open)}>
          + @Agent
        </button>
        {!selected.length ? <span className={styles.directHint}>选择一个工作区 Agent 直接派工</span> : null}
      </div>
      {pickerOpen ? (
        <label className={styles.actorPicker}>
          <span>选择结构化接收人</span>
          <select
            ref={selectRef}
            value=""
            onChange={(event) => {
              const actorId = event.target.value;
              if (actorId && !current.mentions.includes(actorId)) {
                onChange({ ...current, mentions: [...current.mentions, actorId] });
              }
              setPickerOpen(false);
            }}
          >
            <option value="">选择 Agent…</option>
            {actors.map((actor) => (
              <option value={actor.actorId} key={actor.actorId}>
                {actor.kind === "assistant" ? "协调：" : "工作区："}
                {actor.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className={styles.composer}>
        <textarea
          aria-label="协作消息"
          value={current.text}
          rows={2}
          placeholder={
            selected.some((actor) => actor.kind === "assistant")
              ? "描述目标、完成标准和限制…"
              : "先选择要直接交给的工作区 Agent…"
          }
          onChange={(event) => onChange({ ...current, text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (online && current.text.trim() && current.mentions.length) onSend();
            }
          }}
        />
        <button
          type="button"
          className={styles.send}
          disabled={!online || !current.text.trim() || !current.mentions.length}
          onClick={onSend}
          aria-label={online ? "发送协作消息" : "连接恢复后才能发送"}
        >
          发送
        </button>
      </div>
      <div className={styles.composerFoot}>
        <span>{online ? "Enter 发送 · Shift+Enter 换行" : "已离线，草稿已保存，正在重连"}</span>
        <span>{convId ? "状态变化会更新原任务卡" : ""}</span>
      </div>
    </div>
  );
}
