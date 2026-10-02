"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { JieboMark as Mark } from "../../components/JieboMark";

type Mode = "动手" | "方案" | "只问";

type ToolState = "idle" | "running" | "done";

type Turn = {
  id: string;
  user: string;
  assistant: string;
  tool?: { kind: string; path: string; del: string; add: string };
};

const STARTERS = [
  { text: "梳理仓库", icon: "folder" as const },
  { text: "查一段报错", icon: "bug" as const },
  { text: "写一个脚本", icon: "script" as const },
];

const SEED: Turn = {
  id: "seed",
  user: "把输入框窄屏时收成图标。",
  assistant: "已按宽度切换模式，窄屏只留下图标。发送按钮保持圆形，避免工具栏被挤掉。",
  tool: {
    kind: "Edit",
    path: "composer.tsx",
    del: "padding: 0 14px;",
    add: "padding: 0 8px;",
  },
};


function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 12.4V3.6" />
      <path d="M4.4 7.2 8 3.6 11.6 7.2" />
    </svg>
  );
}

function ChipIcon({ name }: { name: "folder" | "bug" | "script" }) {
  if (name === "folder") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 4.5h4l1.2 1.5H13.5v6.5H2.5z" />
      </svg>
    );
  }
  if (name === "bug") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="4.2" />
        <path d="M8 6.2v2.4M8 10.6h.01" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.2 4.5 6.4 8 3.2 11.5" />
      <path d="M8.2 11.5h4.6" />
    </svg>
  );
}

export default function LabPage() {
  const [chats, setChats] = useState([
    { id: "new", title: "新对话", turns: [] as Turn[] },
    { id: "composer", title: "修 composer 密度", turns: [SEED] },
    { id: "repo", title: "看仓库结构", turns: [] as Turn[], unread: true },
  ]);
  const [activeId, setActiveId] = useState("new");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("动手");
  const [toolOpen, setToolOpen] = useState(true);
  const [toolState, setToolState] = useState<ToolState>("done");
  const [justDone, setJustDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modesRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const [thumb, setThumb] = useState({ x: 0, w: 0, live: false });

  const active = chats.find((chat) => chat.id === activeId) || chats[0];
  const empty = active.turns.length === 0 && !busy;

  useEffect(() => {
    return () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [active.turns, busy, toolState]);

  const later = (ms: number, fn: () => void) => {
    const id = window.setTimeout(fn, ms);
    timers.current.push(id);
  };

  const replyFor = (text: string) => {
    if (text.includes("报错")) {
      return {
        assistant: "测试页里这条只演示样式，不会真的跑 Agent。",
        tool: { kind: "Read", path: "gateway/index.ts", del: "catch (err) { throw err }", add: "catch (err) { log(err) }" },
      };
    }
    if (text.includes("脚本")) {
      return {
        assistant: "可以先写一个最小脚本把重复步骤收掉。",
        tool: { kind: "Write", path: "scripts/lab.sh", del: "", add: "echo ok" },
      };
    }
    return {
      assistant: "已按宽度切换模式，窄屏只留下图标。这是测试页的假回复。",
      tool: { kind: "Edit", path: "composer.tsx", del: "padding: 0 14px;", add: "padding: 0 8px;" },
    };
  };

  const send = (raw?: string) => {
    const text = (raw ?? draft).trim();
    if (!text || busy) return;
    const id = crypto.randomUUID();
    const pending: Turn = { id, user: text, assistant: "" };
    setDraft("");
    setBusy(true);
    setJustDone(false);
    setToolState("idle");
    setToolOpen(false);
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === activeId
          ? { ...chat, title: chat.turns.length ? chat.title : text.slice(0, 16), turns: [...chat.turns, pending], unread: false }
          : chat,
      ),
    );

    later(420, () => {
      setToolState("running");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setToolOpen(true));
      });
    });
    later(2200, () => {
      const next = replyFor(text);
      setToolState("done");
      setJustDone(true);
      setChats((prev) =>
        prev.map((chat) =>
          chat.id === activeId
            ? {
                ...chat,
                turns: chat.turns.map((turn) => (turn.id === id ? { ...turn, ...next } : turn)),
              }
            : chat,
        ),
      );
      setBusy(false);
    });
  };

  const newChat = () => {
    const id = crypto.randomUUID();
    setChats((prev) => [{ id, title: "新对话", turns: [] }, ...prev.map((chat) => ({ ...chat, unread: false }))]);
    setActiveId(id);
    setDraft("");
    setBusy(false);
    setJustDone(false);
    setToolState("done");
    inputRef.current?.focus();
  };

  const modes = useMemo(() => ["动手", "方案", "只问"] as Mode[], []);
  const thumbLive = useRef(false);

  useEffect(() => {
    const root = modesRef.current;
    if (!root) return;

    const apply = () => {
      const activeBtn = root.querySelector<HTMLElement>(".lab-mode.on");
      if (!activeBtn) return;
      setThumb({ x: activeBtn.offsetLeft, w: activeBtn.offsetWidth, live: thumbLive.current });
      if (!thumbLive.current) {
        requestAnimationFrame(() => {
          thumbLive.current = true;
          setThumb((prev) => ({ ...prev, live: true }));
        });
      }
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(root);
    return () => ro.disconnect();
  }, [mode]);

  return (
    <div className="lab">
      <aside className="lab-side">
        <div className="lab-brand">
          <Mark className="lab-logo" />
          <div>
            <div className="lab-brand-title">接驳</div>
            <div className="lab-brand-sub">远端动手</div>
          </div>
        </div>
        <button type="button" className="lab-new" onClick={newChat}>
          <PlusIcon />
          新对话
        </button>
        <div className="lab-chats">
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={`lab-chat${chat.id === activeId ? " on" : ""}${chat.unread ? " unread" : ""}`}
              onClick={() => {
                setActiveId(chat.id);
                setBusy(false);
                setJustDone(false);
                setToolOpen(true);
                setToolState(chat.turns.some((turn) => turn.tool) ? "done" : "idle");
              }}
            >
              {chat.title}
            </button>
          ))}
        </div>
        <div className="lab-foot">
          <span className="lab-dot" />
          已连接
          <span className="lab-tag">prompt-kit</span>
        </div>
      </aside>

      <main className="lab-main">
        {empty ? (
          <div className="lab-empty">
            <h1>从这里开始</h1>
            <p>网页说话，远端动手。</p>
            <div className="lab-chips">
              {STARTERS.map((item, index) => (
                <button
                  key={item.text}
                  type="button"
                  className="lab-chip"
                  style={{ animationDelay: `${140 + index * 70}ms` }}
                  onClick={() => send(item.text)}
                >
                  <ChipIcon name={item.icon} />
                  {item.text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="lab-thread" ref={threadRef}>
            <div className="lab-inner">
              {active.turns.map((turn, index) => {
                const latest = index === active.turns.length - 1;
                const state = latest ? toolState : "done";
                const showTool = Boolean(turn.tool) || (latest && state !== "idle");
                const tool = turn.tool || { kind: "Edit", path: "composer.tsx", del: "padding: 0 14px;", add: "padding: 0 8px;" };
                return (
                  <article key={turn.id} className="lab-turn">
                    <div className="lab-user">{turn.user}</div>
                    {showTool ? (
                      <div
                        className={`lab-tool${toolOpen && latest ? " open" : ""}${state === "running" ? " running" : ""}${latest && justDone ? " just-done" : ""}`}
                      >
                        <button type="button" className="lab-tool-head" onClick={() => latest && setToolOpen((open) => !open)}>
                          <span className="lab-tool-mark" aria-hidden="true">
                            {state === "running" ? (
                              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
                                <path d="M8 2.4a5.6 5.6 0 1 1-4.6 2.4" strokeLinecap="round" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
                                <circle cx="8" cy="8" r="5.2" />
                                <path d="m5.4 8.1 1.8 1.8 3.4-3.6" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </span>
                          <span className="lab-kind">{tool.kind}</span>
                          <span className="lab-path">{tool.path}</span>
                          <span className="lab-badge">
                            {state === "running" ? <span className="lab-shimmer">Processing</span> : "Completed"}
                          </span>
                          <span className="lab-chevron" />
                        </button>
                        {latest && state !== "idle" ? (
                          <div className="lab-tool-body">
                            <div>
                              <pre className="lab-diff">
                                {tool.del ? <div className="del">- {tool.del}</div> : null}
                                <div className="add">+ {tool.add}</div>
                              </pre>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {latest && !turn.assistant ? (
                      <div className="lab-think">
                        <span className="lab-avatar">接</span>
                        <span className="lab-shimmer">正在思考</span>
                      </div>
                    ) : null}
                    {turn.assistant ? (
                      <div className="lab-bot">
                        <span className="lab-avatar">接</span>
                        <div className="lab-assistant">
                          <p>{turn.assistant}</p>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </div>
        )}

        <div className="lab-dock">
          <form
            className="lab-composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <textarea
              ref={inputRef}
              className="lab-input"
              rows={1}
              placeholder="问一句…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="lab-bar">
              <button type="button" className="lab-icon-btn" aria-label="附件">
                <PlusIcon />
              </button>
              <div className="lab-modes" ref={modesRef}>
                <span
                  className={`lab-mode-thumb${thumb.live ? " live" : ""}`}
                  style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
                  aria-hidden="true"
                />
                {modes.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`lab-mode${mode === item ? " on" : ""}`}
                    onClick={() => setMode(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <span className="lab-grow" />
              <button type="button" className="lab-model">
                Auto
              </button>
              <button type="submit" className="lab-send" disabled={!draft.trim() || busy} aria-label="发送">
                <SendIcon />
              </button>
            </div>
          </form>
          <p className="lab-hint">prompt-kit 风格测试 · 不接真实 Agent · /lab</p>
        </div>
      </main>
    </div>
  );
}
