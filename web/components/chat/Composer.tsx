// 输入框：提及芯片、图片/文件附件、模式与模型选择、发送/停止
import type { AgentMode, CheckpointInfo, PolicyId, PromptImage } from "@shared/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { isOpenableMention, mentionChips } from "../../lib/chat/mentions";
import { IconAgent, IconAsk, IconPlan, IconShield, IconWrite } from "../chromeIcons";
import ModelPicker from "../ModelPicker";

export function Composer({
  draft,
  epoch,
  images,
  uploading,
  notice,
  error,
  model,
  models,
  setModel,
  mode,
  setMode,
  confirmWrites,
  setConfirmWrites,
  policy,
  setPolicy,
  busy,
  connected,
  onSubmit,
  onStop,
  onUndo,
  onRestore,
  onOpenMenu,
  checkpoints,
  onAddImages,
  onDropFiles,
  onRemoveImage,
  fileHits,
  mentionQuery,
  onDraftChange,
  onPickFile,
  onOpenFile,
  onRemoveMention,
  onDismissMention,
  caret,
  onCaretApplied,
  centered,
}: {
  draft: string;
  epoch: number;
  images: PromptImage[];
  uploading?: number;
  notice?: string;
  error?: string;
  model: string;
  models: string[];
  setModel: (value: string) => void;
  mode: AgentMode;
  setMode: (value: AgentMode) => void;
  confirmWrites: boolean;
  setConfirmWrites: (value: boolean) => void;
  policy: PolicyId;
  setPolicy: (value: PolicyId) => void;
  busy: boolean;
  connected: boolean;
  onSubmit: (text?: string) => void;
  onStop: () => void;
  onUndo: () => void;
  onRestore: (id: string) => void;
  onOpenMenu?: () => void;
  checkpoints: CheckpointInfo[];
  onAddImages: (files: FileList | File[]) => void;
  onDropFiles?: (files: FileList | File[]) => void;
  onRemoveImage: (index: number) => void;
  fileHits: string[];
  mentionQuery: string | null;
  onDraftChange: (value: string, caret: number) => void;
  onPickFile: (path: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onRemoveMention: (token: string) => void;
  onDismissMention: () => void;
  caret?: number | null;
  onCaretApplied?: () => void;
  centered?: boolean;
}) {
  const mentioning = mentionQuery != null;
  const mentionListId = useId();
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionHitsKey = fileHits.join("\n");
  useEffect(() => setMentionIndex(0), [mentionHitsKey, mentionQuery]);
  const mentionPick = Math.min(mentionIndex, Math.max(0, fileHits.length - 1));
  useEffect(() => {
    if (!mentioning) return;
    document.getElementById(`${mentionListId}-${mentionPick}`)?.scrollIntoView({ block: "nearest" });
  }, [mentioning, mentionPick, mentionListId]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const composingRef = useRef(false);
  const sendLockRef = useRef(false);
  const [text, setText] = useState(draft);
  const [moreOpen, setMoreOpen] = useState(false);
  const [density, setDensity] = useState<"full" | "mid" | "compact" | "tight">("full");
  const modesRef = useRef<HTMLDivElement | null>(null);
  const thumbLive = useRef(false);
  const [thumb, setThumb] = useState({ x: 0, w: 0, live: false });
  const chips = mentionChips(text);
  const canSend = Boolean(text.trim() || images.length) && !uploading;
  useLayoutEffect(() => {
    setText(draft);
    const el = inputRef.current;
    if (el && el.value !== draft) el.value = draft;
  }, [epoch, draft]);
  useEffect(() => {
    if (caret == null || !inputRef.current) return;
    inputRef.current.focus();
    inputRef.current.setSelectionRange(caret, caret);
    onCaretApplied?.();
  }, [caret, epoch, onCaretApplied]);
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const apply = () => {
      const width = el.getBoundingClientRect().width;
      const next = width <= 400 ? "tight" : width <= 480 ? "compact" : width <= 780 ? "mid" : "full";
      setDensity((prev) => (prev === next ? prev : next));
    };
    apply();
    // Some embedded Chromium views never fire ResizeObserver / container queries.
    const interval = window.setInterval(apply, 200);
    window.addEventListener("resize", apply);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(apply);
      observer.observe(el);
    }
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", apply);
      observer?.disconnect();
    };
  }, []);
  useEffect(() => {
    const root = modesRef.current;
    if (!root) return;
    const applyThumb = () => {
      const activeBtn = root.querySelector<HTMLElement>(".mode-btn.on");
      if (!activeBtn) return;
      setThumb({ x: activeBtn.offsetLeft, w: activeBtn.offsetWidth, live: thumbLive.current });
      if (!thumbLive.current) {
        requestAnimationFrame(() => {
          thumbLive.current = true;
          setThumb((prev) => ({ ...prev, live: true }));
        });
      }
    };
    applyThumb();
    const ro = new ResizeObserver(applyThumb);
    ro.observe(root);
    root.querySelectorAll(".mode-btn").forEach((btn) => ro.observe(btn));
    root.addEventListener("transitionend", applyThumb);
    return () => {
      ro.disconnect();
      root.removeEventListener("transitionend", applyThumb);
    };
  }, [mode, density]);
  function flushDraft() {
    const el = inputRef.current;
    const value = el ? el.value : text;
    composingRef.current = false;
    setText(value);
    onDraftChange(value, el?.selectionStart ?? value.length);
    return value;
  }
  function sendNow() {
    if (!canSend || sendLockRef.current) return;
    sendLockRef.current = true;
    onSubmit(flushDraft());
    queueMicrotask(() => {
      sendLockRef.current = false;
    });
  }
  return (
    <>
      <form
        ref={composerRef}
        className={`composer density-${density}${centered ? " centered" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          sendNow();
        }}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const list = Array.from(event.dataTransfer.files);
          if (!list.length) return;
          if (onDropFiles) onDropFiles(list);
          else onAddImages(list);
        }}
      >
        <div className="composer-body">
          {mentioning ? (
            <div className="mention-list" id={mentionListId} role="listbox" aria-label="引用文件">
              {fileHits.length ? (
                fileHits.map((path, index) => (
                  <button
                    key={path}
                    id={`${mentionListId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === mentionPick}
                    tabIndex={-1}
                    className={`mention-item${index === mentionPick ? " active" : ""}`}
                    onMouseEnter={() => setMentionIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onPickFile(path)}
                  >
                    {path}
                  </button>
                ))
              ) : (
                <div className="mention-item muted">没有匹配的文件</div>
              )}
            </div>
          ) : null}
          {chips.length ? (
            <div className="mention-chips">
              {chips.map((chip) => (
                <span className="mention-chip" key={chip.key}>
                  <button
                    type="button"
                    className="mention-chip-open"
                    title={chip.token}
                    onClick={() => {
                      if (!isOpenableMention(chip.path)) return;
                      onOpenFile(chip.path, chip.line);
                    }}
                  >
                    @{/^diff$/i.test(chip.path) ? "Diff" : chip.path.split("/").pop()}
                    {chip.line ? `:${chip.line}` : ""}
                    {chip.endLine ? `-${chip.endLine}` : ""}
                  </button>
                  <button
                    type="button"
                    className="mention-chip-drop"
                    title="去掉这个引用"
                    onClick={() => onRemoveMention(chip.token)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {error ? <div className="error-line">{error}</div> : null}
          {notice && !error ? <div className="notice-line">{notice}</div> : null}
          {uploading ? <div className="composer-upload">正在上传 {uploading} 个文件…</div> : null}
          {images.length ? (
            <div className="composer-thumbs">
              {images.map((img, index) => (
                <button
                  key={`${img.mimeType}-${index}`}
                  type="button"
                  className="composer-thumb"
                  onClick={() => onRemoveImage(index)}
                  title="去掉这张图"
                >
                  <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            className="composer-input"
            aria-label="输入消息"
            aria-controls={mentioning ? mentionListId : undefined}
            aria-activedescendant={mentioning && fileHits.length ? `${mentionListId}-${mentionPick}` : undefined}
            defaultValue={draft}
            placeholder={
              !connected
                ? "正在连服务器…"
                : busy
                  ? "正在动手，Enter 会排队"
                  : mode === "ask"
                    ? "问一句，不改文件，@ 引用"
                    : mode === "plan"
                      ? "描述任务，只出方案，@ 引用"
                      : "交代要做的事，@ 引用文件"
            }
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="send"
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (!files.length) return;
              event.preventDefault();
              if (onDropFiles) onDropFiles(files);
              else onAddImages(files);
            }}
            onInput={(event) => {
              const el = event.currentTarget;
              const value = el.value;
              if (!composingRef.current) setText(value);
              onDraftChange(value, el.selectionStart ?? value.length);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              const el = inputRef.current;
              if (el) {
                setText(el.value);
                onDraftChange(el.value, el.selectionStart ?? el.value.length);
              }
            }}
            onKeyDown={(event) => {
              const composing = composingRef.current || event.nativeEvent.isComposing;
              if (
                mentioning &&
                !composing &&
                fileHits.length &&
                (event.key === "ArrowDown" || event.key === "ArrowUp")
              ) {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setMentionIndex((mentionPick + step + fileHits.length) % fileHits.length);
                return;
              }
              if (mentioning && (event.key === "Enter" || event.key === "Tab") && !composing) {
                if (fileHits[mentionPick]) {
                  event.preventDefault();
                  onPickFile(fileHits[mentionPick]);
                }
                return;
              }
              if (event.key === "Escape" && mentionQuery != null) {
                event.preventDefault();
                onDismissMention();
                return;
              }
              if (event.key === "Escape" && busy) {
                event.preventDefault();
                onStop();
                return;
              }
              if (event.key !== "Enter" || event.shiftKey) return;
              if (composing) return;
              event.preventDefault();
              sendNow();
            }}
          />
        </div>
        <div className="composer-bar">
          <label className="pill icon composer-attach" title="添加文件或图片" aria-label="添加文件或图片">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input
              type="file"
              multiple
              className="composer-file-input"
              onClick={(event) => {
                event.currentTarget.value = "";
              }}
              onChange={(event) => {
                const list = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
                if (!list.length) return;
                if (onDropFiles) onDropFiles(list);
                else onAddImages(list);
              }}
            />
          </label>
          <div className="mode-switch" role="tablist" aria-label="工作方式" ref={modesRef}>
            <span
              className={`mode-thumb${thumb.live ? " live" : ""}`}
              style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
              aria-hidden="true"
            />
            {(["agent", "plan", "ask"] as AgentMode[]).map((item) => (
              <button
                key={item}
                type="button"
                className={`mode-btn${mode === item ? " on" : ""}`}
                title={item === "agent" ? "动手" : item === "plan" ? "方案" : "只问"}
                aria-label={item === "agent" ? "动手" : item === "plan" ? "方案" : "只问"}
                onClick={() => setMode(item)}
              >
                {item === "agent" ? <IconAgent /> : item === "plan" ? <IconPlan /> : <IconAsk />}
                <span className="mode-label">{item === "agent" ? "动手" : item === "plan" ? "方案" : "只问"}</span>
              </button>
            ))}
          </div>
          <ModelPicker
            model={model}
            models={models}
            onChange={setModel}
            dismiss={moreOpen}
            onOpen={() => setMoreOpen(false)}
          />
          <button
            type="button"
            className={`mode-btn confirm-btn policy-btn${policy === "plane" ? " on" : ""}`}
            title={policy === "plane" ? "策略层：Ask 硬只读、按条放行、方言 overlay" : "现状路径，用于对照"}
            aria-label={policy === "plane" ? "策略层" : "现状"}
            onClick={() => setPolicy(policy === "plane" ? "baseline" : "plane")}
          >
            <span className="confirm-label">{policy === "plane" ? "策略层" : "现状"}</span>
          </button>
          <button
            type="button"
            className={`mode-btn confirm-btn${confirmWrites ? " on" : ""}`}
            title={confirmWrites ? "写入前先问你" : "直接写入"}
            aria-label={confirmWrites ? "确认写" : "直写"}
            onClick={() => setConfirmWrites(!confirmWrites)}
          >
            {confirmWrites ? <IconShield /> : <IconWrite />}
            <span className="confirm-label">{confirmWrites ? "确认写" : "直写"}</span>
          </button>
          <span className="grow" />
          <div className="composer-more">
            <button
              type="button"
              className="pill icon"
              title="更多"
              onClick={() => {
                setMoreOpen((open) => {
                  const next = !open;
                  if (next) onOpenMenu?.();
                  return next;
                });
              }}
            >
              ···
            </button>
            {moreOpen ? (
              <div className="composer-menu">
                <button
                  type="button"
                  className={confirmWrites ? "on" : ""}
                  onClick={() => {
                    setConfirmWrites(!confirmWrites);
                    setMoreOpen(false);
                  }}
                >
                  {confirmWrites ? "确认写入 · 开" : "确认写入"}
                </button>
                <button
                  type="button"
                  className={`narrow-only${policy === "plane" ? " on" : ""}`}
                  onClick={() => {
                    setPolicy(policy === "plane" ? "baseline" : "plane");
                    setMoreOpen(false);
                  }}
                >
                  {policy === "plane" ? "策略层 · 开（点一下切回现状）" : "现状路径（点一下切到策略层）"}
                </button>
                {!busy ? (
                  <button
                    type="button"
                    onClick={() => {
                      onUndo();
                      setMoreOpen(false);
                    }}
                  >
                    撤销上一次
                  </button>
                ) : null}
                {checkpoints.length ? (
                  <>
                    <div className="composer-menu-label">检查点 · {checkpoints.length}</div>
                    {checkpoints.map((item) => (
                      <button
                        key={`${item.id}-${item.createdAt}`}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (busy) return;
                          onRestore(item.id);
                          setMoreOpen(false);
                        }}
                      >
                        还原 · {item.label}
                      </button>
                    ))}
                  </>
                ) : (
                  <button type="button" disabled>
                    {mode === "ask" ? "只问不会打检查点" : "动手或出方案时会记下检查点"}
                  </button>
                )}
              </div>
            ) : null}
          </div>
          {busy ? (
            <button className="send stop" type="button" onClick={onStop} title="Esc 停止">
              ■
            </button>
          ) : null}
          <button className="send" type="submit" disabled={!canSend}>
            ↑
          </button>
        </div>
      </form>
      {centered ? <div className="hint desk-only">⌘N 新对话 · ⌘K 搜会话 · ⌘P 打开文件 · 可粘贴或上传文件</div> : null}
    </>
  );
}
