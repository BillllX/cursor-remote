"use client";

import { useEffect, useState } from "react";
import type { SharedWorkspace, WorkspaceShareRequest } from "@shared/workspaceShare";
import type { ShareCall } from "./Sharing";
import { WORKSPACE_NAV } from "../../lib/productNavigation";
import styles from "./Sharing.module.css";

export type SharedSection = NonNullable<WorkspaceShareRequest["section"]>;
type Snapshot = {
  skills?: { id: string; name: string; summary: string; health: string }[];
  proposals?: { id: string; name: string; status: string }[];
  schedules?: {
    id: string;
    title: string;
    enabled: boolean;
    intervalMinutes: number;
    dailyTimes?: string[];
    nextRunAt?: number;
  }[];
  rules?: string;
  memory?: string;
  name?: string;
  directory?: string;
  ownerName?: string;
};

export function SharedWorkspaceManagement({
  section,
  workspace,
  call,
}: {
  section: SharedSection;
  workspace: SharedWorkspace;
  call: ShareCall;
}) {
  const [data, setData] = useState<Snapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [name, setName] = useState("");
  const [memory, setMemory] = useState("");
  useEffect(() => {
    let current = true;
    void call<Snapshot>({ action: "manage", workspace: workspace.id, section, operation: "list" })
      .then((snapshot) => {
        if (current) {
          setData(snapshot);
          setName(snapshot.name ?? "");
        }
      })
      .catch((failure: Error) => {
        if (current) setError(failure.message);
      });
    return () => {
      current = false;
    };
  }, [call, workspace.id, section, reload]);

  async function submit(operation: WorkspaceShareRequest["operation"], parameters: Record<string, string>) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await call<{ notice: string }>({
        action: "manage",
        workspace: workspace.id,
        section,
        operation,
        parameters,
      });
      setNotice(result.notice);
      setReload((version) => version + 1);
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.managementPanel} aria-label={WORKSPACE_NAV.find((item) => item.id === section)?.label}>
      <h2>{WORKSPACE_NAV.find((item) => item.id === section)?.label}</h2>
      {!data && !error && <p role="status">正在读取工作区设置…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {data && section === "skills" && (
        <>
          {data.skills?.map((skill) => (
            <div key={skill.id} className={styles.managementRow}>
              <strong>{skill.name}</strong>
              <p>{skill.summary}</p>
            </div>
          ))}
          {data.proposals?.length ? (
            <ul aria-label="技能提案">
              {data.proposals.map((proposal) => (
                <li key={proposal.id}>
                  {proposal.name} ·{" "}
                  {proposal.status === "approved" ? "已上架" : proposal.status === "rejected" ? "已拒绝" : "待审批"}
                </li>
              ))}
            </ul>
          ) : null}
          <details>
            <summary>提交技能提案</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const parameters = Object.fromEntries(new FormData(form)) as Record<string, string>;
                void submit("propose", parameters).then((saved) => {
                  if (saved) form.reset();
                });
              }}
            >
              <label>
                技能 ID
                <input className="side-input" name="id" required maxLength={48} />
              </label>
              <label>
                名称
                <input className="side-input" name="name" required maxLength={80} />
              </label>
              <label>
                摘要
                <input className="side-input" name="summary" required maxLength={200} />
              </label>
              <label>
                技能说明
                <textarea className="side-input" name="body" required maxLength={16000} />
              </label>
              <button className="new-chat primary" type="submit" disabled={busy}>
                提交审批
              </button>
            </form>
          </details>
        </>
      )}
      {data && section === "schedules" && (
        <>
          {!data.schedules?.length && <p>这个工作区暂无定时任务</p>}
          {data.schedules?.map((item) => (
            <div key={item.id} className={styles.managementRow}>
              <strong>{item.title}</strong>
              <p>
                {item.enabled ? "已启用" : "已暂停"} ·{" "}
                {item.dailyTimes?.join("、") || `每 ${item.intervalMinutes} 分钟`}
              </p>
              {item.enabled && (
                <button
                  type="button"
                  className="workspace-modal-btn"
                  disabled={busy}
                  onClick={() => void submit("pause", { id: item.id })}
                >
                  暂停任务
                </button>
              )}
            </div>
          ))}
          <p className={styles.muted}>创建、启用或运行使用所有者凭证的任务，由所有者操作。</p>
        </>
      )}
      {data && section === "memory" && (
        <>
          <details open>
            <summary>工作区规则</summary>
            <pre>{data.rules || "暂无规则"}</pre>
          </details>
          <details open>
            <summary>工作区记忆</summary>
            <pre>{data.memory || "暂无记忆"}</pre>
          </details>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit("propose", { text: memory }).then((saved) => {
                if (saved) setMemory("");
              });
            }}
          >
            <label>
              补充工作区记忆
              <textarea
                className="side-input"
                value={memory}
                maxLength={2000}
                onChange={(event) => setMemory(event.target.value)}
              />
            </label>
            <button type="submit" className="new-chat primary" disabled={busy || !memory.trim()}>
              提交审批
            </button>
          </form>
        </>
      )}
      {data && section === "management" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit("rename", { name });
          }}
        >
          <p className={styles.muted}>
            {data.directory} · 所有者 {data.ownerName}
          </p>
          <label>
            工作区显示名称
            <input
              className="side-input"
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="new-chat primary"
            disabled={busy || !name.trim() || name.trim() === data.name}
          >
            保存
          </button>
        </form>
      )}
    </section>
  );
}
