import { useState } from "react";
import { delegationFollowUp } from "@shared/delegationHandoff";
import type { AssistantDelegation, TurnFile } from "@shared/protocol";
import type { TurnRowActions } from "./TurnRow";
import { MemoMarkdown, REMARK_PLUGINS } from "./markdown";

export type DelegationAction = (op: "delegation_recover" | "delegation_cancel" | "delegation_retarget", id: string, attempt: number, path?: string) => Promise<string | undefined>;

export function DelegationActionButton({ item, action, disabled }: {
  item: AssistantDelegation;
  action?: DelegationAction;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [rename, setRename] = useState(false);
  const [path, setPath] = useState("");
  const op = item.status === "queued" ? "delegation_cancel" : item.interrupted ? "delegation_recover" : undefined;
  if (!op || !action) return null;
  return (
    <>
      <button type="button" className="pill" disabled={disabled || busy} onClick={async () => {
        setBusy(true);
        setError(undefined);
        try { setError(await action(op, item.id, item.attempt ?? 1)); }
        finally { setBusy(false); }
      }}>
        {busy ? "正在处理…" : op === "delegation_cancel" ? "取消排队" : "恢复委派"}
      </button>
      {item.status === "queued" && item.waitReason === "等待同一产物更新完成" && item.expectedFiles?.length === 1 && (
        rename ? (
          <form onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              const failure = await action("delegation_retarget", item.id, item.attempt ?? 1, path.trim());
              setError(failure);
              if (!failure) setRename(false);
            } finally { setBusy(false); }
          }}>
            <label>新文件路径 <input value={path} onChange={(event) => setPath(event.target.value)} placeholder={item.expectedFiles[0]} /></label>
            <button type="submit" className="pill" disabled={disabled || busy || !path.trim()}>另存并继续</button>
            <button type="button" className="pill" disabled={busy} onClick={() => setRename(false)}>收起</button>
          </form>
        ) : <button type="button" className="pill" disabled={disabled || busy} onClick={() => setRename(true)}>另存新版本</button>
      )}
      {error && <div role="alert">{error}</div>}
    </>
  );
}

const statusLabels = { queued: "排队中", cancelled: "已取消", running: "进行中", awaiting: "等你处理", done: "已交付", failed: "未交付" };

export function DelegationReceipt({
  item,
  files,
  actions,
  locked,
}: {
  item: AssistantDelegation;
  files: TurnFile[];
  actions: TurnRowActions;
  locked: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const active = item.status === "queued" || item.status === "running" || item.status === "awaiting";
  // 同一路径经过续作后只显示最近版本，已交付的其他文件继续保留。
  const artifacts = [
    ...new Map(
      files.filter((file) => file.sourceChatId === item.childChatId).map((file) => [file.path, file]),
    ).values(),
  ];

  return (
    <section className="assistant-item assistant-delegation-receipt" aria-label={`委派：${item.title}`}>
      <div className="assistant-item-head">
        <strong className="assistant-item-title">{item.title}</strong>
        <span className="chat-mark" role="status">
          {item.interrupted ? "已中断" : statusLabels[item.status] ?? "状态待同步"}
        </span>
      </div>
      <div className="loop-meta">
        {item.workspace}
        {(item.attempt ?? 1) > 1 ? ` · 第 ${item.attempt} 轮` : ""}
      </div>
      {item.waitReason && <div className="loop-meta">{item.waitReason}</div>}
      {item.deliverable ? <div className="assistant-item-body">预期交付：{item.deliverable}</div> : null}
      {item.task ? (
        <details>
          <summary>原任务</summary>
          <div className="assistant-item-body">{item.task}</div>
        </details>
      ) : null}
      {item.result ? (
        <div className="markdown assistant-markdown">
          <MemoMarkdown remarkPlugins={REMARK_PLUGINS}>{item.result}</MemoMarkdown>
        </div>
      ) : null}
      {artifacts.length ? (
        <div className="turn-files">
          <div className="turn-files-title">关联产物 · {artifacts.length}</div>
          {artifacts.map((file) => (
            <div className="turn-file" key={file.path}>
              <button
                type="button"
                title={file.path}
                onClick={() => actions.openFile(file.path, undefined, false, file.sha, file.sourceChatId)}
              >
                {file.path.split("/").pop()}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {item.status === "awaiting" ? (
        <button type="button" className="pill" onClick={() => actions.openDelegation?.(item.id)}>
          查看待处理事项
        </button>
      ) : null}
      <DelegationActionButton item={item} action={actions.onDelegationAction} disabled={locked} />
      {!active && !editing && !item.interrupted ? (
        <button type="button" className="pill" onClick={() => setEditing(true)}>
          继续这项委派
        </button>
      ) : null}
      {!active && editing ? (
        <form
          className="assistant-delegation-followup"
          onSubmit={(event) => {
            event.preventDefault();
            if (locked || !draft.trim()) return;
            actions.submitDelegationFollowUp?.(delegationFollowUp(item.id, draft));
            setDraft("");
            setEditing(false);
          }}
        >
          <label>
            补充要求
            <textarea autoFocus value={draft} maxLength={4000} onChange={(e) => setDraft(e.target.value)} rows={2} />
          </label>
          <div className="loop-actions">
            <button type="submit" className="pill" disabled={locked || !draft.trim()}>
              交给小驳
            </button>
            <button type="button" className="pill" onClick={() => setEditing(false)}>
              收起
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
