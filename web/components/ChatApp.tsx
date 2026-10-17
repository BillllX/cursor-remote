"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentMode,
  AssistantApproval,
  AssistantState,
  CheckpointInfo,
  ClientMessage,
  PolicyId,
  PromptImage,
  SearchHit,
  ServerMessage,
  LoopState,
  MediaTicket,
  AdminTenantStats,
  CursorBill,
  CanvasVersion,
} from "@shared/protocol";
import { DEFAULT_ASSISTANT_NAME } from "@shared/protocol";
import AssistantPanel from "./AssistantPanel";
import { extractDiff, mutatingTool } from "./ToolCard";
import FilePreview, { PREVIEW_SAVE_LIMIT, type PreviewTab } from "./FilePreview";
import { SAMPLE_CANVAS_PATH, SAMPLE_CANVAS_SOURCE } from "../lib/canvas/sample";
import type { CanvasAction } from "../lib/canvas/host";
import { isWideKind, kindFromPath, mediaSrc, preferHttpText, tabKind } from "../lib/preview";
import { fetchPreviewText, peekPreviewText, putPreviewText } from "../lib/previewCache";
import { clearBodies, dropBody, readBody, writeBody } from "../lib/chatCache";
import { installPerfApi, PERF } from "../lib/chat/perf";
import { armPerfLive, isPerfTurn, keepPerfTurns, makePerfTurns } from "../lib/chat/perfSeed";
import { applyJieboTheme, readThemeChoice, type AppearanceId, type PaletteId } from "../lib/theme";
import {
  DEFAULT_MODEL,
  hasUsableModel,
  modelLabel,
  NO_MODEL_HINT,
  readLastModel,
  resolveModel,
  sessionModel,
  withCurrentModel,
  writeLastModel,
} from "../lib/models";
import { useFocusTrap } from "../lib/useFocusTrap";
import { IconRail } from "./chromeIcons";
import { gatewayUrl, HELLO_CLIENT, uploadUrl, wire } from "../lib/chat/connection";
import { friendlyError } from "../lib/chat/format";
import { useHeldOpen, useSheetDrag } from "../lib/chat/hooks/sheet";
import { useThreadScroll } from "../lib/chat/hooks/useThreadScroll";
import { useWorkspaceGroups } from "../lib/chat/hooks/useWorkspaceGroups";
import { filesToImages, fileToBase64, formatUploadMb, isPromptImageFile, MAX_IMAGES, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, MAX_UPLOAD_MB, shrinkImageFile, sourceLimit } from "../lib/chat/images";
import { attachedFiles, isOpenableMention, mentionAt, mentionHits, stripMention } from "../lib/chat/mentions";
import { appendDraftMention, applyAssistantMessage, applyLoopMessage, applyReadyRuns, applyServerMessage, applySession, chatsToFlush, commitSync, loopsFromReady, markUnread, patchChatIn, serverChatId, workspaceMover, type ChatReduceContext } from "../lib/chat/reducer";
import { chatHasContent, chatMeta, isUntitled, landingChat, mergeSlimChats, metaKey, usableDraft } from "../lib/chat/sessions";
import { clearBrowserChatStore, forgetActiveChat, GROUPS_KEY, MAX_DELETED, pushRecent, readActiveChat, rememberDeleted, TOKEN_KEY, writeActiveChat } from "../lib/chat/storage";
import { pathFromPayload, shellRows } from "../lib/chat/tools";
import { editPathsOf, liveTurn, mergeTurnFileLists, rejectMutatingTools, serverTurn, settleTurn, turnHasOpenTools, uid, withLiveTurns } from "../lib/chat/turns";
import type { BodyState, Chat, ToolCall, Turn } from "../lib/chat/types";
import { gitLetterOf, inWorkspaceRoot, normPath, preferChatCwd, relToCwd, sameCwd, sameFile, saveWorkspaceFile } from "../lib/chat/workspace";
import { AdminOverlay } from "./chat/AdminOverlay";
import { AssistantChatHead } from "./chat/AssistantChatHead";
import { ComposerDock } from "./chat/ComposerDock";
import { EmptyState } from "./chat/EmptyState";
import { FilesOverlay } from "./chat/FilesOverlay";
import { GrepOverlay } from "./chat/GrepOverlay";
import { LoginGate } from "./chat/LoginGate";
import { LoopOverlay } from "./chat/LoopOverlay";
import { markdownComponents } from "./chat/markdown";
import { PadBar } from "./chat/PadBar";
import { PaletteOverlay } from "./chat/PaletteOverlay";
import { SearchOverlay } from "./chat/SearchOverlay";
import { Sidebar } from "./chat/Sidebar";
import { TerminalOverlay } from "./chat/TerminalOverlay";
import { Thread } from "./chat/Thread";
import { WorkspaceOverlay } from "./chat/WorkspaceOverlay";


// 服务端正文覆盖本地回合时，保留“还在跑 / 排队 / 待批”的回合（withLiveTurns）；测量开关打开时再保留合成的回合，
// 否则网关随后推来的正文会把长会话场景造的回合冲掉。没开测量时就是 withLiveTurns 本身。
const mergeBodyTurns = (local: Turn[], server: Turn[]): Turn[] =>
  PERF ? keepPerfTurns(local, withLiveTurns(local, server)) : withLiveTurns(local, server);

export default function ChatApp() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [modelUsable, setModelUsable] = useState(true);
  const [cwd, setCwd] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaces, setWorkspaces] = useState<{ path: string; name: string; user?: boolean }[]>([]);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceCreating, setWorkspaceCreating] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [workspaceIndex, setWorkspaceIndex] = useState(0);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  /** 侧栏里“更多工作区”（还没有对话的）是否展开 */
  const [moreOpen, setMoreOpen] = useState(false);
  /** 工作区分组头上打开的“···”菜单；记目录路径 */
  const [groupMenu, setGroupMenu] = useState<{ path: string; name: string } | null>(null);
  const groupMenuRef = useRef<{ path: string; name: string } | null>(null);
  groupMenuRef.current = groupMenu;
  const [groupPrefsReady, setGroupPrefsReady] = useState(false);
  const [token, setToken] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  /** null = 还没读本地令牌；true = 有上次登录的令牌，先进主界面、后台自动登录，网关拒绝或退出登录才回登录页 */
  const [resuming, setResuming] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [mode, setMode] = useState<AgentMode>("agent");
  const [models, setModels] = useState<string[]>([DEFAULT_MODEL]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [composerEpoch, setComposerEpoch] = useState(0);
  const [draftCaret, setDraftCaret] = useState<number | null>(null);
  const [images, setImages] = useState<PromptImage[]>([]);
  const [uploading, setUploading] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQ, setPaletteQ] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [threadFindOpen, setThreadFindOpen] = useState(false);
  const [threadFindQ, setThreadFindQ] = useState("");
  const [threadFindIndex, setThreadFindIndex] = useState(0);
  const [grepOpen, setGrepOpen] = useState(false);
  const [loopOpen, setLoopOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantName, setAssistantName] = useState(DEFAULT_ASSISTANT_NAME);
  const [assistantChatId, setAssistantChatId] = useState("");
  // 助理会话：每个租户唯一，固定在 USER 根目录，不能删、不能换工作区
  const assistantChatIdRef = useRef("");
  const isAssistantChat = (id?: string) => Boolean(id) && id === assistantChatIdRef.current;
  // 自动选中（非用户点选）的会话；助理会话就绪后可被它替换
  const autoPickedIdRef = useRef("");
  const [assistantState, setAssistantState] = useState<AssistantState | null>(null);
  const [inboxDeepLink, setInboxDeepLink] = useState<string | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    return new URLSearchParams(window.location.search).get("inbox") || undefined;
  });
  // onServer 回调常驻，读 state 会拿到首屏的旧值；用 ref 判断深链是否还没处理
  const inboxDeepLinkRef = useRef(inboxDeepLink);
  const clearInboxDeepLink = () => {
    inboxDeepLinkRef.current = undefined;
    setInboxDeepLink(undefined);
    const url = new URL(window.location.href);
    if (url.searchParams.has("inbox")) {
      url.searchParams.delete("inbox");
      window.history.replaceState(window.history.state, "", url.toString());
    }
  };
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sidePane, setSidePane] = useState<"chats" | "files" | "search" | "git" | "terminal" | "loop" | "assistant">("chats");
  const [wideIDE, setWideIDE] = useState(false);
  const wideIDERef = useRef(false);
  wideIDERef.current = wideIDE;
  const [loopGoal, setLoopGoal] = useState("");
  const [loopInterval, setLoopInterval] = useState("900");
  const [loopMax, setLoopMax] = useState("");
  const [loops, setLoops] = useState<Record<string, LoopState & { tickStatus?: string }>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminStats, setAdminStats] = useState<AdminTenantStats[]>([]);
  const [adminStatsAt, setAdminStatsAt] = useState<number | null>(null);
  const [cursorBill, setCursorBill] = useState<CursorBill | null>(null);
  const [grepQ, setGrepQ] = useState("");
  const searchShown = useHeldOpen(searchOpen);
  const paletteShown = useHeldOpen(paletteOpen);
  const workspaceShown = useHeldOpen(workspaceMenuOpen);
  const grepShown = useHeldOpen(grepOpen);
  const terminalShown = useHeldOpen(terminalOpen);
  const [filesOpen, setFilesOpen] = useState(false);
  const filesShown = useHeldOpen(filesOpen);
  const [filesQuery, setFilesQuery] = useState("");
  const [grepHits, setGrepHits] = useState<SearchHit[]>([]);
  const [grepIndex, setGrepIndex] = useState(0);
  const [grepWait, setGrepWait] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [previewDrafts, setPreviewDrafts] = useState<Record<string, string>>({});
  const previewDraftsRef = useRef<Record<string, string>>({});
  const draftsByChatRef = useRef<Record<string, Record<string, string>>>({});
  const saveSnapshotRef = useRef<Record<string, string>>({});
  previewDraftsRef.current = previewDrafts;
  const [previewPath, setPreviewPath] = useState("");
  const [previewMax, setPreviewMax] = useState(false);
  const [canvasVersions, setCanvasVersions] = useState<Record<string, CanvasVersion[]>>({});
  const [fileHits, setFileHits] = useState<string[]>([]);
  const [treePaths, setTreePaths] = useState<string[]>([]);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const treePathsRef = useRef<string[]>([]);
  treePathsRef.current = treePaths;
  const [gitStatus, setGitStatus] = useState<Record<string, string>>({});
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [chats, setChats] = useState<Chat[]>([
    { id: "boot", title: "新对话", turns: [] },
  ]);
  const [activeId, setActiveId] = useState("boot");
  const loopsRef = useRef(loops);
  loopsRef.current = loops;
  useEffect(() => {
    if (!loopOpen) return;
    const row = loopsRef.current[activeId];
    if (row && row.status !== "stopped" && row.status !== "idle") {
      setLoopGoal(row.goal);
      setLoopInterval(String(row.intervalSec));
      setLoopMax(row.maxTicks ? String(row.maxTicks) : "");
    } else {
      setLoopGoal("");
      setLoopInterval("900");
      setLoopMax("");
    }
  }, [loopOpen, activeId]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeChoice, setThemeChoice] = useState<{ palette: PaletteId; appearance: AppearanceId } | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [navReady, setNavReady] = useState(false);
  const [demoCanvas, setDemoCanvas] = useState(false);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setNavReady(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    setThemeChoice(readThemeChoice());
  }, []);

  useEffect(() => {
    if (!themeChoice) return;
    applyJieboTheme(themeChoice.palette, themeChoice.appearance);
  }, [themeChoice]);

  const closeNav = useCallback(() => setNavOpen(false), []);
  const closePreview = useCallback(() => setPreviewMax(false), []);
  const navDrag = useSheetDrag(navOpen, closeNav, "left");
  const previewDrag = useSheetDrag(previewMax, closePreview, "right");

  const active = useMemo(
    () => chats.find((chat) => chat.id === activeId) ?? chats[0],
    [chats, activeId],
  );
  const shellEntries = useMemo(() => shellRows(active?.turns ?? []), [active?.turns]);
  const shellTail = shellEntries.at(-1);
  const shellTailKey = shellTail ? `${shellTail.id}\0${shellTail.output}` : "";
  useEffect(() => {
    if (!terminalOpen) return;
    const node = terminalLogRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [terminalOpen, shellTailKey]);
  const sidebarChats = useMemo(() => {
    const keep = new Set<string>();
    const seenEmpty = new Set<string>();
    for (const chat of chats) {
      if (assistantChatId && chat.id === assistantChatId) continue;
      const empty = chat.title === "新对话" && !chatHasContent(chat);
      if (!empty) {
        keep.add(chat.id);
        continue;
      }
      const key = normPath(chat.cwd || workspaceRoot);
      if (chat.id === activeId || !seenEmpty.has(key)) {
        keep.add(chat.id);
        seenEmpty.add(key);
      }
    }
    return chats.filter((chat) => keep.has(chat.id));
  }, [chats, activeId, workspaceRoot, assistantChatId]);

  const assistantChat = useMemo(
    () => (assistantChatId ? chats.find((chat) => chat.id === assistantChatId) : undefined),
    [chats, assistantChatId],
  );
  const assistantPreview = useMemo(() => {
    const turns = assistantChat?.turns || [];
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const text = (turns[i].assistant.trim() || turns[i].user.trim()).replace(/\s+/g, " ");
      if (text) return text.slice(0, 80);
    }
    return assistantChat?.preview?.trim().slice(0, 80) || "今日 · 收件箱 · 记忆";
  }, [assistantChat?.turns, assistantChat?.preview]);

  const { duplicateGroupNames, otherMenuWorkspaces, sidebarGroups, moreGroups, workspaceChoices } = useWorkspaceGroups({
    chats,
    workspaceRoot,
    workspaces,
    assistantName,
    sidebarChats,
    cwd,
    workspaceQuery,
  });
  const workspacePick = Math.min(workspaceIndex, Math.max(0, workspaceChoices.length - 1));
  const workspaceExact = workspaceChoices.some(
    (item) => item.name.toLowerCase() === workspaceQuery.trim().toLowerCase(),
  );
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const draftRef = useRef(draft);
  const imagesRef = useRef<Record<string, PromptImage[]>>({});
  const newChatRef = useRef<() => void>(() => {});
  const startChatInRef = useRef<(path: string) => void>(() => {});
  const searchOpenRef = useRef(false);
  const paletteOpenRef = useRef(false);
  const threadFindOpenRef = useRef(false);
  const grepOpenRef = useRef(false);
  const loopOpenRef = useRef(false);
  const terminalOpenRef = useRef(false);
  const adminOpenRef = useRef(false);
  const terminalLogRef = useRef<HTMLDivElement>(null);
  const filesOpenRef = useRef(false);
  /** 最近一次收到的媒体票据（按对话），右键下载直接拿来签地址 */
  const mediaTicketRef = useRef<{ chatId: string; media: MediaTicket } | null>(null);
  /** 还没拿到票据时先发 read_file 换一张，reqId → 路径 */
  const pendingDownloadRef = useRef<Map<string, string>>(new Map());
  const pendingHistoricalRef = useRef<
    Map<string, { path: string; chatId: string; ownerActiveChatId: string }>
  >(new Map());
  const grepQRef = useRef("");
  const appliedStoreRef = useRef(false);
  const stateRevRef = useRef(0);
  const deletedIdsRef = useRef<Set<string>>(new Set());
  // 同步 v2（docs/chat-sync.md）：正文以网关为准，网页只传元数据
  const chatRevsRef = useRef<Record<string, number>>({});
  /// 每个会话最后一次和网关对齐的元数据快照（metaKey）
  const syncedMetaRef = useRef<Map<string, string>>(new Map());
  /// 已发出、等 sync_ack 的元数据上传，按发送顺序；base 是发送时的服务端 chatRev
  const inflightMetaRef = useRef<Map<string, { key: string; base: number | undefined }[]>>(new Map());
  const bodyRef = useRef<Map<string, BodyState>>(new Map());
  const loadNonceRef = useRef(0);
  const cacheTimersRef = useRef<Map<string, number>>(new Map());
  const stateTimerRef = useRef<number | undefined>(undefined);
  /// load_state 已发、stored_state 还没回：先别上传元数据，否则旧字段会盖掉别处的改动
  const stateWaitRef = useRef(0);
  const [bodyTick, setBodyTick] = useState(0);
  const [syncTick, setSyncTick] = useState(0);
  const renameSkipRef = useRef(false);
  const previewTabsRef = useRef(previewTabs);
  previewTabsRef.current = previewTabs;
  const previewPathRef = useRef(previewPath);
  previewPathRef.current = previewPath;
  const previewMaxRef = useRef(previewMax);
  previewMaxRef.current = previewMax;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const pendingUploadsRef = useRef(
    new Map<string, { resolve: (path: string) => void; reject: (err: Error) => void; timer: number }>(),
  );
  const unlockedRef = useRef(unlocked);
  unlockedRef.current = unlocked;
  const outboxRef = useRef<ClientMessage[]>([]);
  const pendingHelloRef = useRef<Extract<ClientMessage, { type: "hello" }> | null>(null);
  const verifyTimerRef = useRef<number | undefined>(undefined);
  const lastProgressRef = useRef<Record<string, number>>({});
  const stallNoticedRef = useRef<Set<string>>(new Set());
  const tenantIdRef = useRef("");

  function resetTenantSession() {
    const boot: Chat = { id: "boot", title: "新对话", turns: [] };
    chatsRef.current = [boot];
    setChats([boot]);
    activeIdRef.current = "boot";
    setActiveId("boot");
    assistantChatIdRef.current = "";
    setAssistantChatId("");
    autoPickedIdRef.current = "";
    forgetActiveChat();
    appliedStoreRef.current = false;
    stateRevRef.current = 0;
    deletedIdsRef.current = new Set();
    chatRevsRef.current = {};
    syncedMetaRef.current = new Map();
    inflightMetaRef.current = new Map();
    bodyRef.current = new Map();
    stateWaitRef.current = 0;
    for (const timer of cacheTimersRef.current.values()) window.clearTimeout(timer);
    cacheTimersRef.current = new Map();
    void clearBodies();
    lastProgressRef.current = {};
    stallNoticedRef.current.clear();
    outboxRef.current = [];
    draftRef.current = "";
    setDraft("");
    setCwd("");
    setWorkspaceRoot("");
    setWorkspaces([]);
    setPreviewTabs([]);
    setPreviewPath("");
    setCheckpoints([]);
    setRecentFiles([]);
    setTreePaths([]);
    setGitStatus({});
    setImages([]);
    setError("");
    setPreviewDrafts({});
    draftsByChatRef.current = {};
    setIsAdmin(false);
    setAdminOpen(false);
    setAdminStats([]);
    setAdminStatsAt(null);
    setCursorBill(null);
  }

  const send = useCallback((message: ClientMessage) => {
    if (
      (message.type === "delete_session" || message.type === "set_workspace") &&
      message.chatId &&
      message.chatId === assistantChatIdRef.current
    ) {
      return;
    }
    if (message.type !== "hello" && !unlockedRef.current) {
      outboxRef.current = [...outboxRef.current, message].slice(-50);
      return;
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(wire(message));
      return;
    }
    if (message.type === "hello") {
      pendingHelloRef.current = message;
      return;
    }
    outboxRef.current = [...outboxRef.current, message].slice(-50);
  }, []);

  const flushOutbox = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const pending = outboxRef.current;
    outboxRef.current = [];
    for (const message of pending) {
      if (message.type === "hello") continue;
      ws.send(wire(message));
    }
  }, []);

  const rememberRecent = useCallback((path: string) => {
    if (!path.trim() || !isOpenableMention(path)) return;
    setRecentFiles((prev) => pushRecent(prev, path));
  }, []);

  // 会话列表的写入都走这里（或同样先写 chatsRef 再 setChats(值)），不要再用 setChats(updater)，见 commitSync
  const applyChats = useCallback((reduce: (chats: Chat[]) => Chat[]) => {
    commitSync(chatsRef, setChats, reduce);
  }, []);

  const patchChat = useCallback(
    (chatId: string, updater: (chat: Chat) => Chat) => {
      applyChats((prev) => prev.map((chat) => (chat.id === chatId ? updater(chat) : chat)));
    },
    [applyChats],
  );

  const patchActive = useCallback(
    (updater: (chat: Chat) => Chat) => {
      patchChat(activeIdRef.current, updater);
    },
    [patchChat],
  );

  const stopChat = useCallback(
    (chatId: string) => {
      send({ type: "cancel", chatId });
      patchChat(chatId, (chat) => ({
        ...chat,
        turns: chat.turns.map((turn) =>
          turn.running || turnHasOpenTools(turn) ? settleTurn(turn, "cancelled") : turn,
        ),
      }));
    },
    [patchChat, send],
  );

  const busy = Boolean(active?.turns.some((turn) => turn.running));
  const modelRef = useRef(model);
  modelRef.current = model;
  const lastModelRef = useRef("");
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const confirmWritesRef = useRef(false);
  confirmWritesRef.current = Boolean(active?.confirmWrites);
  const policyRef = useRef<PolicyId>("baseline");
  policyRef.current = active?.policy === "plane" ? "plane" : "baseline";
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const workspaceMenuOpenRef = useRef(false);
  workspaceMenuOpenRef.current = workspaceMenuOpen;
  const mentionQueryRef = useRef(mentionQuery);
  mentionQueryRef.current = mentionQuery;
  const mentionRangeRef = useRef<{ query: string; start: number } | null>(null);
  const draftSaveTimerRef = useRef(0);
  const mentionSearchTimerRef = useRef(0);
  const peekDiffAtRef = useRef<Record<string, number>>({});
  const replayQuietUntilRef = useRef(0);
  const previewWantedRef = useRef<Set<string>>(new Set());
  const previewTriesRef = useRef<Record<string, number>>({});
  const httpHydratedRef = useRef<Set<string>>(new Set());
  const runningIdsRef = useRef<Set<string>>(new Set());
  const holdSnapshotRef = useRef<Set<string>>(new Set());
  const sawSnapshotRef = useRef<Set<string>>(new Set());
  const resumedRef = useRef<Set<string>>(new Set());

  const flushQueue = useCallback(
    (chatId: string) => {
      const chat = chatsRef.current.find((item) => item.id === chatId);
      if (!chat || chat.turns.some((turn) => turn.running)) return;
      const next = chat.turns.find((turn) => turn.queued);
      if (!next) return;
      patchChat(chatId, (current) => {
        const index = current.turns.findIndex((turn) => turn.id === next.id && turn.queued);
        if (index < 0) return current;
        const turns = current.turns.slice();
        turns[index] = { ...turns[index], queued: false, running: true };
        return { ...current, turns };
      });
      send({
        type: "prompt",
        text: next.user,
        model: next.model || modelRef.current,
        mode: next.mode || modeRef.current,
        chatId,
        files: attachedFiles(next.user),
        images: next.images,
        confirmWrites: Boolean(chat.confirmWrites),
        policy: policyRef.current,
        nameChat: isUntitled(chat.title),
        turnId: next.id,
      });
    },
    [patchChat, send],
  );

  const sendQueued = useCallback(
    (turnId: string) => {
      if (busyRef.current) return;
      const chatId = activeIdRef.current;
      const chat = chatsRef.current.find((item) => item.id === chatId);
      const next = chat?.turns.find((turn) => turn.id === turnId && turn.queued);
      if (!next) return;
      patchChat(chatId, (current) => {
        const index = current.turns.findIndex((turn) => turn.id === turnId && turn.queued);
        if (index < 0) return current;
        const turns = current.turns.slice();
        turns[index] = { ...turns[index], queued: false, running: true };
        return { ...current, turns };
      });
      send({
        type: "prompt",
        text: next.user,
        model: next.model || modelRef.current,
        mode: next.mode || modeRef.current,
        chatId,
        files: attachedFiles(next.user),
        images: next.images,
        confirmWrites: Boolean(chat?.confirmWrites),
        policy: policyRef.current,
        nameChat: isUntitled(chat?.title),
        turnId: next.id,
      });
    },
    [patchChat, send],
  );

  const dropQueued = useCallback(
    (turnId: string) => {
      const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
      const turn = chat?.turns.find((item) => item.id === turnId && item.queued);
      patchActive((item) => ({
        ...item,
        turns: item.turns.map((row) =>
          row.id === turnId && row.queued
            ? { ...row, queued: false, running: false, status: "cancelled" }
            : row,
        ),
      }));
      send({ type: "drop_queued", chatId: activeIdRef.current, text: turn?.user });
    },
    [patchActive, send],
  );

  const onServer = useCallback(
    (message: ServerMessage) => {
      const ctx: ChatReduceContext = { activeId: activeIdRef.current };
      const chatId = serverChatId(message, ctx.activeId);
      const reduceChats = () => applyChats((prev) => applyServerMessage(prev, message, ctx));
      if (
        chatId &&
        (message.type === "text-delta" ||
          message.type === "thinking-delta" ||
          message.type === "tool-started" ||
          message.type === "tool-completed" ||
          message.type === "tool-output" ||
          message.type === "task" ||
          (message.type === "status" &&
            (message.status === "RUNNING" || message.status === "CREATING")))
      ) {
        lastProgressRef.current[chatId] = Date.now();
        stallNoticedRef.current.delete(chatId);
      }
      if (chatId && (message.type === "done" || message.type === "error")) {
        delete lastProgressRef.current[chatId];
        stallNoticedRef.current.delete(chatId);
      }
      if (
        chatId &&
        chatId !== activeIdRef.current &&
        (message.type === "text-delta" ||
          message.type === "thinking-delta" ||
          message.type === "tool-started" ||
          message.type === "done" ||
          message.type === "error" ||
          message.type === "approval")
      ) {
        applyChats((prev) => markUnread(prev, chatId));
      }
      switch (message.type) {
        case "ready":
          {
            const nextTenant = message.tenantId || "";
            if (tenantIdRef.current && nextTenant && tenantIdRef.current !== nextTenant) {
              resetTenantSession();
            }
            if (nextTenant) tenantIdRef.current = nextTenant;
            setIsAdmin(Boolean(message.admin));
            if (!message.admin) {
              setAdminOpen(false);
              setAdminStats([]);
              setAdminStatsAt(null);
              setCursorBill(null);
            }
            const reconnected = unlockedRef.current;
            if (reconnected) setNotice("已重新连上服务器");
            unlockedRef.current = true;
            setUnlocked(true);
            setVerifying(false);
            if (verifyTimerRef.current) window.clearTimeout(verifyTimerRef.current);
            setAuthError("");
            if (tokenRef.current) localStorage.setItem(TOKEN_KEY, tokenRef.current);
            setModelUsable(hasUsableModel(message.hasApiKey, message.models));
            if (message.policy === "plane" || message.policy === "baseline") {
              policyRef.current = message.policy;
              patchActive((chat) =>
                chat.policy === message.policy ? chat : { ...chat, policy: message.policy },
              );
            }
            {
              const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
              setCwd(chat?.cwd || message.cwd);
            }
            if (message.workspaceRoot) setWorkspaceRoot(message.workspaceRoot);
            else setWorkspaceRoot((prev) => prev || message.cwd);
            setAssistantName(message.assistantName?.trim() || DEFAULT_ASSISTANT_NAME);
            assistantChatIdRef.current = message.assistantChatId || "";
            setAssistantChatId(message.assistantChatId || "");
            send({ type: "assistant_get" });
            if (inboxDeepLinkRef.current) {
              if (wideIDERef.current) chooseSide("assistant");
              else setAssistantOpen(true);
            }
            setLoops(loopsFromReady(message.loops));
            applyChats((prev) => applyReadyRuns(prev, message));
            {
              const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
              const preferred =
                sessionModel(chat) || lastModelRef.current || modelRef.current || "";
              const catalog = withCurrentModel(
                withCurrentModel(message.models, preferred),
                modelRef.current,
              );
              const nextModel = resolveModel(preferred, catalog, message.model);
              if (nextModel) {
                modelRef.current = nextModel;
                setModel(nextModel);
                if (preferred) rememberLastModel(nextModel);
                if (chat && chat.model !== nextModel) {
                  patchChat(chat.id, (item) =>
                    item.model === nextModel ? item : { ...item, model: nextModel },
                  );
                }
                if (chat) send({ type: "set_model", model: nextModel, chatId: chat.id });
              }
              if (chat?.mode) {
                modeRef.current = chat.mode;
                setMode(chat.mode);
              }
              if (chat?.cwd && chat.cwd !== message.cwd) {
                send({ type: "set_workspace", cwd: chat.cwd, chatId: chat.id });
              }
              const liveIds = new Set(message.runningChatIds || []);
              runningIdsRef.current = liveIds;
              for (const id of liveIds) {
                if (!sawSnapshotRef.current.has(id)) holdSnapshotRef.current.add(id);
              }
              const live = liveIds.has(chat?.id || "");
              if (chat?.agentId && !live && !resumedRef.current.has(chat.id)) {
                resumedRef.current.add(chat.id);
                send({ type: "resume_session", chatId: chat.id, agentId: chat.agentId });
              }
            }
            if (message.models.length) {
              const preferred =
                sessionModel(chatsRef.current.find((item) => item.id === activeIdRef.current)) ||
                lastModelRef.current ||
                modelRef.current;
              setModels(withCurrentModel(withCurrentModel(message.models, preferred), modelRef.current));
            }
            setError("");
            send({ type: "list_files", query: "", chatId: activeIdRef.current });
            for (const tab of previewTabsRef.current) {
              if (tab.sha) continue;
              previewWantedRef.current.add(tab.path);
              send({ type: "read_file", path: tab.path, chatId: activeIdRef.current, diff: tab.diff || undefined });
            }
            flushOutbox();
            if (!reconnected) {
              for (const id of chatsToFlush(chatsRef.current, message.queuedChatIds)) flushQueue(id);
            }
          }
          break;
        case "auth":
          unlockedRef.current = false;
          setUnlocked(false);
          setResuming(false);
          setVerifying(false);
          if (verifyTimerRef.current) window.clearTimeout(verifyTimerRef.current);
          if (!message.ok) {
            outboxRef.current = [];
            setAuthError(message.message || "密码不对。");
            localStorage.removeItem(TOKEN_KEY);
          }
          break;
        case "stored_state":
          {
            if (!Array.isArray(message.chats)) break;
            const remoteRev = typeof message.rev === "number" ? message.rev : 0;
            appliedStoreRef.current = true;
            stateWaitRef.current = 0;
            if (remoteRev > stateRevRef.current) stateRevRef.current = remoteRev;
            if (Array.isArray(message.deletedIds)) {
              deletedIdsRef.current = new Set(
                [...deletedIdsRef.current, ...message.deletedIds].slice(0, MAX_DELETED),
              );
            }
            chatRevsRef.current = { ...(message.chatRevs ?? {}) };
            let merged = mergeSlimChats(
              chatsRef.current,
              message.chats as Chat[],
              deletedIdsRef.current,
              syncedMetaRef.current,
            );
            if (!merged.length) {
              const boot = chatsRef.current.find((chat) => chat.id === "boot");
              merged = [boot || { id: "boot", title: "新对话", turns: [] }];
            }
            const keepIds = new Set(merged.map((chat) => chat.id));
            for (const id of [...bodyRef.current.keys()]) {
              if (!keepIds.has(id)) bodyRef.current.delete(id);
            }
            chatsRef.current = merged;
            setChats(merged);
            setSyncTick((n) => n + 1);
            setBodyTick((n) => n + 1);
            const current = merged.find((item) => item.id === activeIdRef.current);
            const landing = current ? null : landingChat(merged, readActiveChat(), isAssistantChat);
            const keep = current || landing?.chat;
            if (keep && !current) {
              autoPickedIdRef.current = landing?.auto ? keep.id : "";
              setActiveId(keep.id);
              {
                const value = usableDraft(keep);
                draftRef.current = value;
                setDraft(value);
                setComposerEpoch((n) => n + 1);
              }
              {
                const nextModel = sessionModel(keep) || lastModelRef.current || modelRef.current;
                if (nextModel) {
                  modelRef.current = nextModel;
                  setModel(nextModel);
                  rememberLastModel(nextModel);
                  if (keep.model !== nextModel) {
                    patchChat(keep.id, (item) =>
                      item.model === nextModel ? item : { ...item, model: nextModel },
                    );
                  }
                }
              }
              if (keep.mode) {
                modeRef.current = keep.mode;
                setMode(keep.mode);
              }
              if (keep.cwd) {
                setCwd(keep.cwd);
              }
              const tabs = keep.previewTabs || [];
              if (tabs.length) {
                setPreviewTabs(
                  tabs.map((tab) => ({
                    path: tab.path,
                    line: tab.line,
                    kind: kindFromPath(tab.path),
                    pinned: true,
                  })),
                );
                setPreviewPath(keep.previewPath || tabs[0].path);
                setPreviewMax(false);
              }
            }
            if (keep?.agentId && !runningIdsRef.current.has(keep.id) && !resumedRef.current.has(keep.id)) {
              resumedRef.current.add(keep.id);
              send({ type: "resume_session", chatId: keep.id, agentId: keep.agentId });
            }
          }
          break;
        // sync_chat（元数据）、tool_review、truncate_turns 被网关接受后的回执
        case "sync_ack": {
          const revs = message.chatRevs ?? {};
          for (const [id, rev] of Object.entries(revs)) {
            if (typeof rev !== "number") continue;
            const before = chatRevsRef.current[id];
            chatRevsRef.current[id] = rev;
            const body = bodyRef.current.get(id);
            if (message.truncated === false) {
              // 网关没截成，本地截过的正文作废，按服务端重拉
              if (body?.state === "complete") body.rev = undefined;
              continue;
            }
            if (message.reviewOnly || message.truncated) {
              // 本地已经做了同样的改动：正文跟着前进，不用重拉
              if (body?.state === "complete" && body.rev === before) body.rev = rev;
              scheduleBodyCache(id);
              continue;
            }
            const queue = inflightMetaRef.current.get(id);
            const sent = queue?.shift();
            if (queue && !queue.length) inflightMetaRef.current.delete(id);
            if (!sent) continue;
            syncedMetaRef.current.set(id, sent.key);
            // 只改了元数据：发出时正文是最新的，并且中途没有别的版本插进来，正文才算跟着前进
            const chat = chatsRef.current.find((item) => item.id === id);
            if (
              body?.state === "complete" &&
              body.rev === sent.base &&
              before === sent.base &&
              !chat?.turns.some(liveTurn)
            ) {
              body.rev = rev;
              scheduleBodyCache(id);
            }
          }
          if (typeof message.rev === "number" && message.rev > stateRevRef.current) {
            stateRevRef.current = message.rev;
          }
          setBodyTick((n) => n + 1);
          break;
        }
        // 网关版本前进（别的设备、跑完一轮、或本端上传因 rev 落后被拒）
        case "stored_digest": {
          // 被拒的上传不会再有 ack：清掉在途，元数据仍和快照不同，下一轮重推。
          // 别处写入后的广播（changed）不影响本端在途，ack 照常会到
          if (message.reason !== "changed") inflightMetaRef.current = new Map();
          const remoteRev = typeof message.rev === "number" ? message.rev : 0;
          if (remoteRev > stateRevRef.current) stateRevRef.current = remoteRev;
          if (Array.isArray(message.deletedIds)) {
            deletedIdsRef.current = new Set(
              [...deletedIdsRef.current, ...message.deletedIds].slice(0, MAX_DELETED),
            );
          }
          const serverRevs = message.chatRevs ?? {};
          // 和网关对齐过、现在不在目录里 = 别处删了；本地新建还没上传的保留
          const gone = chatsRef.current.filter(
            (chat) =>
              chat.id !== "boot" &&
              !(chat.id in serverRevs) &&
              (syncedMetaRef.current.has(chat.id) || deletedIdsRef.current.has(chat.id)),
          );
          if (gone.length) {
            const goneIds = new Set(gone.map((chat) => chat.id));
            for (const id of goneIds) forgetLocalChat(id);
            const kept = chatsRef.current.filter((chat) => !goneIds.has(chat.id));
            chatsRef.current = kept.length ? kept : [{ id: "boot", title: "新对话", turns: [] }];
            setChats(chatsRef.current);
          }
          let listStale = false;
          for (const [id, rev] of Object.entries(serverRevs)) {
            if (deletedIdsRef.current.has(id)) continue;
            if (chatRevsRef.current[id] !== rev || !chatsRef.current.some((chat) => chat.id === id)) {
              listStale = true;
            }
          }
          chatRevsRef.current = { ...serverRevs };
          if (listStale) requestState();
          setSyncTick((n) => n + 1);
          setBodyTick((n) => n + 1);
          break;
        }
        // load_chat 的分页应答：from 是这一页在全量里的起点，从后往前翻
        case "chat_turns": {
          onChatTurns(message);
          break;
        }
        case "session":
          if (message.chatId) {
            const chat = chatsRef.current.find((item) => item.id === message.chatId);
            const nextCwd = preferChatCwd(chat?.cwd, message.cwd);
            if (message.chatId === activeIdRef.current && nextCwd) setCwd(nextCwd);
            applyChats((prev) => applySession(prev, message, ctx.activeId, nextCwd));
          } else if (message.cwd) {
            const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
            const nextCwd = preferChatCwd(chat?.cwd, message.cwd);
            if (nextCwd) setCwd(nextCwd);
            applyChats((prev) => applySession(prev, message, ctx.activeId));
          }
          if (
            !message.chatId ||
            (message.chatId === activeIdRef.current && !message.agentId)
          ) {
            send({
              type: "list_files",
              query: "",
              chatId: message.chatId || activeIdRef.current,
            });
          }
          break;
        case "files":
          if (message.chatId && message.chatId !== activeIdRef.current) break;
          if (message.mention) {
            if (mentionQueryRef.current == null || message.query !== mentionQueryRef.current) break;
            setFileHits(
              mentionHits(
                treePathsRef.current.length ? treePathsRef.current : message.paths,
                message.query,
                message.paths,
              ),
            );
          } else {
            setTreePaths(message.paths);
            setGitStatus(message.status || {});
            setTreeTruncated(Boolean(message.truncated));
          }
          break;
        case "search_hits":
          if (message.chatId && message.chatId !== activeIdRef.current) break;
          if (message.query.trim() === grepQRef.current.trim()) {
            setGrepHits(message.hits);
            setGrepWait(false);
          }
          break;
        case "tool-output":
          if (holdSnapshotRef.current.has(chatId)) break;
          reduceChats();
          break;
        case "pong":
          break;
        case "loop_state":
        case "loop_tick":
          setLoops((prev) => applyLoopMessage(prev, message));
          break;
        case "assistant_state":
          setAssistantState(message.state);
          if (message.state.name?.trim()) setAssistantName(message.state.name.trim());
          break;
        case "inbox_item":
        case "delegation_state":
          setAssistantState((prev) => applyAssistantMessage(prev, message));
          break;
        case "assistant_result":
          if (!message.ok && message.error) setNotice(message.error);
          break;
        case "memory_written":
          if (message.entry?.topic) setNotice(`已记住：${message.entry.topic}`);
          break;
        case "admin_stats":
          setAdminStats(message.tenants || []);
          setAdminStatsAt(message.serverTime || Date.now());
          setCursorBill(message.cursor ?? null);
          break;
        case "chat_title":
          reduceChats();
          break;
        case "history":
          // 正文还没对齐服务端时不掺 Cursor 端历史，免得和随后到的分页打架
          if (bodyRef.current.get(chatId)?.state !== "complete") break;
          reduceChats();
          break;
        case "status":
          if (message.message) setNotice(message.message);
          reduceChats();
          break;
        case "run_snapshot":
          holdSnapshotRef.current.delete(message.chatId);
          sawSnapshotRef.current.add(message.chatId);
          reduceChats();
          break;
        case "text-delta":
        case "thinking-delta":
          if (holdSnapshotRef.current.has(chatId)) break;
          reduceChats();
          break;
        case "tool-started":
          if (holdSnapshotRef.current.has(chatId)) break;
          reduceChats();
          {
            const args = message.args;
            if (args && typeof args === "object") {
              const record = args as Record<string, unknown>;
              for (const key of ["path", "file", "target", "file_path"]) {
                if (typeof record[key] === "string" && record[key]) {
                  rememberRecent(record[key]);
                  break;
                }
              }
            }
            if (mutatingTool(message.name) && chatId === activeIdRef.current && !confirmWritesRef.current) {
              const path = relToCwd(pathFromPayload(message.args), cwdRef.current);
              const kind = path ? kindFromPath(path) : "text";
              const skipDiff =
                kind === "canvas" || kind === "markdown" || kind === "html" || kind === "pdf" || kind === "audio";
              if (path && !skipDiff) {
                const now = Date.now();
                if ((peekDiffAtRef.current[path] || 0) < now - 400) {
                  peekDiffAtRef.current[path] = now;
                  setPreviewTabs((prev) => {
                    const existing = prev.find((tab) => sameFile(tab.path, path, cwdRef.current));
                    if (existing) {
                      return prev.map((tab) =>
                        sameFile(tab.path, path, cwdRef.current)
                          ? { ...tab, diff: true, content: existing.diff ? tab.content : undefined, error: undefined }
                          : tab,
                      );
                    }
                    return [...prev, { path, diff: true }].slice(-8);
                  });
                  setPreviewPath(path);
                  send({ type: "read_file", path, chatId, diff: true });
                }
              }
            }
          }
          break;
        case "tool-completed":
          if (holdSnapshotRef.current.has(chatId)) break;
          reduceChats();
          if (chatId === activeIdRef.current) {
            const running = chatsRef.current
              .find((chat) => chat.id === chatId)
              ?.turns.find((turn) => turn.running);
            const args = running?.tools.find((tool) => tool.callId === message.callId)?.args;
            const path = relToCwd(
              pathFromPayload(args) || pathFromPayload(message.result),
              cwdRef.current,
            );
            if (path && mutatingTool(message.name || running?.tools.find((tool) => tool.callId === message.callId)?.name || "")) {
              send({ type: "list_files", query: "", chatId });
              const kind = kindFromPath(path);
              const skipDiff =
                kind === "canvas" ||
                kind === "markdown" ||
                kind === "html" ||
                kind === "pdf" ||
                kind === "audio";
              const tab = previewTabsRef.current.find((item) => sameFile(item.path, path, cwdRef.current));
              previewWantedRef.current.add(tab?.path || path);
              if (!tab) {
                setPreviewTabs((prev) =>
                  prev.some((item) => sameFile(item.path, path, cwdRef.current))
                    ? prev
                    : [...prev, { path, diff: !skipDiff, kind }].slice(-8),
                );
                setPreviewPath(path);
              }
              if (!tab?.sha) {
                send({
                  type: "read_file",
                  path: tab?.path || path,
                  chatId,
                  diff: skipDiff ? undefined : true,
                });
              }
            } else if (path) {
              const tab = previewTabsRef.current.find((item) => sameFile(item.path, path, cwdRef.current));
              if (tab && !tab.sha) {
                send({
                  type: "read_file",
                  path: tab.path,
                  chatId,
                  diff: tab.diff || undefined,
                });
              }
            }
          }
          break;
        case "task":
        case "approval":
          if (holdSnapshotRef.current.has(chatId)) break;
          reduceChats();
          break;
        case "error":
          setError(message.message);
          reduceChats();
          break;
        case "done":
          reduceChats();
          {
            if (chatId === activeIdRef.current && mentionQueryRef.current == null) {
              send({ type: "list_files", query: "", chatId });
              for (const tab of previewTabsRef.current) {
                if (tab.sha) continue;
                send({
                  type: "read_file",
                  path: tab.path,
                  chatId,
                  diff: tab.diff || undefined,
                });
              }
            }
          }
          break;
        case "turn_files":
          patchChat(message.chatId, (chat) => ({
            ...chat,
            turns: chat.turns.map((turn) =>
              turn.id === message.turnId
                ? { ...turn, files: mergeTurnFileLists(turn.files || [], message.files) }
                : turn,
            ),
          }));
          break;
        case "file_changed":
          if (message.chatId === activeIdRef.current) {
            send({ type: "list_files", query: "", chatId: message.chatId });
            const tab = previewTabsRef.current.find((item) => sameFile(item.path, message.path, cwdRef.current));
            if (tab && !tab.sha && previewDraftsRef.current[tab.path] == null) {
              send({
                type: "read_file",
                path: tab.path,
                chatId: tab.sourceChatId || message.chatId,
                diff: tab.diff || undefined,
              });
            }
          }
          break;
        case "canvas_versions":
          setCanvasVersions((prev) => ({ ...prev, [message.path]: message.versions }));
          break;
        case "canvas_published":
          setNotice(message.error || (message.url ? `分享地址：${message.url}` : "Canvas 已发布"));
          send({ type: "canvas_versions", chatId: message.chatId, path: message.path });
          break;
        case "canvas_restored":
          setNotice(message.error || "Canvas 版本已恢复");
          if (!message.error) openFile(message.path);
          break;
        case "undone":
          setNotice(
            message.error
              ? message.error
              : message.paths.length
                ? `已还原 ${message.paths.join(", ")}`
                : "没有可还原的改动",
          );
          if (!message.chatId || message.chatId === activeIdRef.current) {
            send({ type: "list_files", query: "", chatId: activeIdRef.current });
            for (const tab of previewTabsRef.current) {
              if (tab.sha) continue;
              send({
                type: "read_file",
                path: tab.path,
                chatId: activeIdRef.current,
                diff: tab.diff || undefined,
              });
            }
          }
          break;
        case "run_meta":
          reduceChats();
          break;
        case "policy":
          if (message.policy) {
            policyRef.current = message.policy;
            reduceChats();
          }
          break;
        case "checkpoints":
          reduceChats();
          if (message.chatId === activeIdRef.current) {
            setCheckpoints(message.items);
            const newest = message.items[0];
            if (newest && Date.now() - newest.createdAt < 5000) {
              setNotice(`已记下检查点 ${newest.label}`);
            }
          }
          break;
        case "restored":
          if (message.silent) {
            replayQuietUntilRef.current = Date.now() + 12_000;
            send({ type: "list_files", query: "", chatId: activeIdRef.current });
            break;
          }
          setNotice(
            message.error
              ? message.error
              : `已还原检查点 ${message.label || message.checkpointId || ""}`,
          );
          send({ type: "list_files", query: "", chatId: activeIdRef.current });
          for (const tab of previewTabsRef.current) {
            if (tab.sha) continue;
            send({ type: "read_file", path: tab.path, chatId: activeIdRef.current, diff: tab.diff || undefined });
          }
          break;
        case "file_content":
          {
            const ticketChat = message.chatId || activeIdRef.current;
            if (message.media && ticketChat) mediaTicketRef.current = { chatId: ticketChat, media: message.media };
            const downloadPath = message.reqId ? pendingDownloadRef.current.get(message.reqId) : undefined;
            if (message.reqId && downloadPath != null) {
              pendingDownloadRef.current.delete(message.reqId);
              const href = message.media && ticketChat ? mediaSrc(downloadPath, ticketChat, message.media) : "";
              if (href) void saveWorkspaceFile(downloadPath, href, setNotice);
              else setNotice("下载失败：没拿到下载凭证");
              break;
            }
            const cwd = cwdRef.current;
            const match = (path: string) => sameFile(path, message.path, cwd);
            const historical = message.reqId ? pendingHistoricalRef.current.get(message.reqId) : undefined;
            if (message.reqId && historical) pendingHistoricalRef.current.delete(message.reqId);
            if (historical && historical.ownerActiveChatId !== activeIdRef.current) break;
            if (!historical && message.chatId && message.chatId !== activeIdRef.current) break;
            const matchTab = (tab: PreviewTab) =>
              match(tab.path) &&
              (tab.sourceChatId || activeIdRef.current) === ticketChat &&
              (!message.sha || tab.sha === message.sha);
            if (message.diff && message.error === "没有未提交的改动") {
              send({ type: "read_file", path: message.path, chatId: activeIdRef.current });
              setPreviewTabs((prev) =>
                prev.map((tab) => (matchTab(tab) ? { ...tab, diff: false, error: undefined } : tab)),
              );
              break;
            }
            if (message.error && /读不了|不是文件|不在工作区/.test(message.error)) {
              if (Date.now() < replayQuietUntilRef.current) break;
              const had = previewTabsRef.current.find(matchTab);
              if (had?.content) break;
              setPreviewTabs((prev) =>
                prev.map((tab) =>
                  matchTab(tab)
                    ? { ...tab, error: "文件已不在当前工作区，换工作区后再打开，或关掉这个预览。" }
                    : tab,
                ),
              );
              setNotice(`${message.path} 已不在工作区`);
              break;
            }
            const patch = {
              content: message.content,
              error: message.error,
              diff: kindFromPath(message.path) === "canvas" ? false : Boolean(message.diff),
              kind: message.kind || kindFromPath(message.path),
              mime: message.mime,
              size: message.size,
              url: message.url,
              headUrl: message.headUrl,
              media: message.media,
              sha: message.sha,
            };
            if (typeof message.content === "string" && !message.sha) putPreviewText(message.path, message.content);
            const rel = relToCwd(message.path, cwd) || message.path;
            const draft = previewDraftsRef.current[rel] ?? previewDraftsRef.current[message.path];
            if (
              typeof message.content === "string" &&
              draft != null &&
              draft !== message.content &&
              message.content !== saveSnapshotRef.current[rel] &&
              message.content !== saveSnapshotRef.current[message.path]
            ) {
              const name = rel.split("/").pop() || rel;
              setNotice(`${name} 在磁盘上有新内容，未保存的修改还留着`);
            }
            setPreviewTabs((prev) => {
              const idx = prev.findIndex(matchTab);
              if (idx < 0) {
                if (historical) return prev;
                const wanted =
                  match(previewPathRef.current) ||
                  [...previewWantedRef.current].some((path) => match(path));
                if (!wanted) return prev;
                return [
                  ...prev,
                  {
                    path: relToCwd(message.path, cwd) || message.path,
                    ...patch,
                    content: message.content,
                  },
                ].slice(-8);
              }
              previewWantedRef.current.delete(prev[idx].path);
              delete previewTriesRef.current[prev[idx].path];
              return prev.map((tab, index) =>
                index === idx
                  ? {
                      ...tab,
                      ...patch,
                      content: message.content ?? tab.content,
                      kind: message.kind || tab.kind || kindFromPath(message.path),
                      mime: message.mime ?? tab.mime,
                      size: message.size ?? tab.size,
                      url: message.url ?? tab.url,
                      media: message.media ?? tab.media,
                    }
                  : tab,
              );
            });
          }
          break;
        case "file_written":
          if (message.error) {
            setError(message.error);
            break;
          }
          {
            const rel = relToCwd(message.path, cwd) || message.path;
            const pending = saveSnapshotRef.current[rel] ?? saveSnapshotRef.current[message.path];
            const draft = previewDraftsRef.current[rel] ?? previewDraftsRef.current[message.path];
            delete saveSnapshotRef.current[rel];
            delete saveSnapshotRef.current[message.path];
            if (pending != null) saveSnapshotRef.current[rel] = pending;
            if (pending != null && (draft == null || draft === pending)) {
              setPreviewDrafts((prev) => {
                if (!(rel in prev) && !(message.path in prev)) return prev;
                const next = { ...prev };
                delete next[rel];
                delete next[message.path];
                return next;
              });
              setNotice(`已保存 ${rel}`);
            } else if (pending != null) {
              setNotice(`已保存 ${rel}。之后的修改还没写入`);
            } else {
              setNotice(`已保存 ${message.path}`);
            }
          }
          send({ type: "list_files", query: "", chatId: activeIdRef.current });
          send({
            type: "read_file",
            path: message.path,
            chatId: activeIdRef.current,
          });
          break;
        case "file_uploaded": {
          const pending = message.id ? pendingUploadsRef.current.get(message.id) : undefined;
          if (pending) {
            pendingUploadsRef.current.delete(message.id!);
            window.clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(message.error));
            else if (message.path) pending.resolve(message.path);
            else pending.reject(new Error("上传失败"));
            break;
          }
          setUploading((n) => Math.max(0, n - 1));
          if (message.error) {
            setError(message.name ? `${message.name}：${message.error}` : message.error);
            break;
          }
          if (message.path) {
            const path = message.path;
            const token = `@${path} `;
            if (message.chatId && message.chatId !== activeIdRef.current) {
              const target = message.chatId;
              applyChats((prev) => appendDraftMention(prev, target, path));
            } else {
              const current = draftRef.current;
              if (!current.includes(`@${path}`)) {
                const next = `${current}${current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : ""}${token}`;
                draftRef.current = next;
                setDraft(next);
                setComposerEpoch((n) => n + 1);
                setDraftCaret(next.length);
                patchChat(activeIdRef.current, (chat) =>
                  chat.draft === next ? chat : { ...chat, draft: next },
                );
              }
            }
            rememberRecent(path);
            send({ type: "list_files", query: "", chatId: message.chatId || activeIdRef.current });
            setNotice(`已添加 ${path}`);
          }
          break;
        }
        case "fs_done":
          if (message.error) {
            setError(message.error);
            break;
          }
          setNotice(
            message.op === "delete"
              ? `已删除 ${message.path}`
              : message.op === "rename"
                ? `已重命名为 ${message.to || message.path}`
                : `已创建 ${message.to || message.path}`,
          );
          send({ type: "list_files", query: "", chatId: activeIdRef.current });
          if (message.op === "delete") {
            setPreviewTabs((prev) => prev.filter((tab) => !sameFile(tab.path, message.path)));
            setPreviewPath((prev) => (sameFile(prev, message.path) ? "" : prev));
          } else if (message.op === "rename" && message.to) {
            setPreviewTabs((prev) =>
              prev.map((tab) => (sameFile(tab.path, message.path) ? { ...tab, path: message.to! } : tab)),
            );
            setPreviewPath((prev) => (sameFile(prev, message.path) ? message.to! : prev));
            send({ type: "read_file", path: message.to, chatId: activeIdRef.current });
          } else if (message.op === "create") {
            send({ type: "read_file", path: message.path, chatId: activeIdRef.current });
            setPreviewTabs((prev) =>
              prev.some((tab) => sameFile(tab.path, message.path))
                ? prev
                : [...prev, { path: message.path, content: "" }].slice(-8),
            );
            setPreviewPath(message.path);
          }
          break;
        case "workspaces":
          setWorkspaceRoot(message.root);
          setWorkspaces(message.items);
          setCwd((prev) => (prev && inWorkspaceRoot(prev, message.root) ? prev : message.root));
          break;
        case "workspace_created":
          setWorkspaces((prev) =>
            prev.some((item) => sameCwd(item.path, message.path))
              ? prev
              : [...prev, { path: message.path, name: message.name }],
          );
          setWorkspaceCreating(false);
          setWorkspaceNameDraft("");
          startChatInRef.current(message.path);
          break;
        case "workspace_renamed": {
          // 网关已把会话的目录改到新路径；本地先照改，再拉一次存档对齐版本号
          const move = workspaceMover(message);
          reduceChats();
          setCwd((prev) => move(prev) || prev);
          setExpandedGroups((prev) => {
            const from = normPath(message.from);
            const next = new Set([...prev].map((key) => (key === from ? normPath(message.path) : key)));
            return next;
          });
          setNotice(`已改名为「${message.name}」`);
          send({ type: "load_state" });
          break;
        }
        case "workspace_removed":
          setExpandedGroups((prev) => {
            const next = new Set(prev);
            next.delete(normPath(message.path));
            return next;
          });
          setNotice(
            message.mode === "deleted"
              ? `已删除工作区「${message.name}」`
              : `「${message.name}」里有文件，已从列表隐藏（文件没动）`,
          );
          break;
        default:
          break;
      }
    },
    [applyChats, flushQueue, flushOutbox, patchChat, rememberRecent, send],
  );

  const onServerRef = useRef(onServer);
  onServerRef.current = onServer;

  useEffect(() => {
    if (!connected || !unlocked) return;
    const pending = previewTabs.filter((tab) => {
      if (tab.error || tab.content != null) return false;
      const kind = tabKind(tab.path, tab.kind);
      if (kind === "image" || kind === "pdf" || kind === "audio" || kind === "video") return false;
      if (kind === "svg" && tab.url) return false;
      return true;
    });
    if (!pending.length) return;
    const timer = window.setTimeout(() => {
      for (const tab of pending) {
        const tries = (previewTriesRef.current[tab.path] || 0) + 1;
        previewTriesRef.current[tab.path] = tries;
        if (tries > 4) {
          setPreviewTabs((prev) =>
            prev.map((item) =>
              sameFile(item.path, tab.path, cwdRef.current)
                ? { ...item, error: "预览超时。关掉这个页签再点一次文件。" }
                : item,
            ),
          );
          continue;
        }
        previewWantedRef.current.add(tab.path);
        const reqId = tab.sha ? uid() : undefined;
        if (reqId) {
          pendingHistoricalRef.current.set(reqId, {
            path: tab.path,
            chatId: tab.sourceChatId || activeIdRef.current,
            ownerActiveChatId: activeIdRef.current,
          });
        }
        send({
          type: "read_file",
          path: tab.path,
          chatId: tab.sourceChatId || activeIdRef.current,
          diff: tab.diff || undefined,
          sha: tab.sha,
          reqId,
        });
      }
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [previewTabs, connected, unlocked, send]);

  useEffect(() => {
    if (!unlocked) return;
    const jobs = previewTabs.filter((tab) => {
      if (tab.diff || !tab.url) return false;
      const kind = tabKind(tab.path, tab.kind);
      if (!preferHttpText(kind)) return false;
      return tab.content == null;
    });
    for (const tab of jobs) {
      const key = `${tab.path}|${tab.url}`;
      if (httpHydratedRef.current.has(key)) continue;
      httpHydratedRef.current.add(key);
      const cached = tab.sha ? undefined : peekPreviewText(tab.path);
      if (cached != null && tab.content == null) {
        setPreviewTabs((prev) =>
          prev.map((item) =>
            sameFile(item.path, tab.path, cwdRef.current) && item.content == null
              ? { ...item, content: cached }
              : item,
          ),
        );
      }
      fetchPreviewText(tab.url as string)
        .then((text) => {
          if (!tab.sha) putPreviewText(tab.path, text);
          setPreviewTabs((prev) =>
            prev.map((item) =>
              sameFile(item.path, tab.path, cwdRef.current)
                ? { ...item, content: text, error: undefined }
                : item,
            ),
          );
        })
        .catch(() => {
          httpHydratedRef.current.delete(key);
          if (!tab.sha && peekPreviewText(tab.path) != null) return;
          previewWantedRef.current.add(tab.path);
          const reqId = tab.sha ? uid() : undefined;
          if (reqId) {
            pendingHistoricalRef.current.set(reqId, {
              path: tab.path,
              chatId: tab.sourceChatId || activeIdRef.current,
              ownerActiveChatId: activeIdRef.current,
            });
          }
          send({
            type: "read_file",
            path: tab.path,
            chatId: tab.sourceChatId || activeIdRef.current,
            diff: tab.diff || undefined,
            sha: tab.sha,
            reqId,
          });
        });
    }
  }, [
    unlocked,
    send,
    previewTabs
      .map((tab) => `${tab.sourceChatId || ""}:${tab.path}:${tab.sha || ""}:${tab.url || ""}:${tab.diff ? 1 : 0}`)
      .join("|"),
  ]);

  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY)?.trim() || "";
    if (saved) setToken(saved);
    setResuming(Boolean(saved));
    const last = readLastModel();
    if (last) {
      lastModelRef.current = last;
      modelRef.current = last;
      setModel(last);
    }
    clearBrowserChatStore();
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("canvas") !== "demo") return;
    setDemoCanvas(true);
    setPreviewTabs([
      { path: SAMPLE_CANVAS_PATH, kind: "canvas", content: SAMPLE_CANVAS_SOURCE, diff: false },
    ]);
    setPreviewPath(SAMPLE_CANVAS_PATH);
    setPreviewMax(true);
  }, []);

  // 元数据和最后一次对齐的快照不同就上传；不带 turns 键，网关保留磁盘正文
  useEffect(() => {
    if (!unlockedRef.current) return;
    const timer = window.setTimeout(() => {
      if (!appliedStoreRef.current) return;
      if (stateWaitRef.current && Date.now() - stateWaitRef.current < 5000) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      for (const chat of chatsRef.current) {
        if (chat.id === "boot" || deletedIdsRef.current.has(chat.id)) continue;
        const key = metaKey(chat);
        const queue = inflightMetaRef.current.get(chat.id) ?? [];
        const latest = queue.length ? queue[queue.length - 1].key : syncedMetaRef.current.get(chat.id);
        if (latest === key) continue;
        stateRevRef.current += 1;
        queue.push({ key, base: chatRevsRef.current[chat.id] });
        inflightMetaRef.current.set(chat.id, queue);
        send({ type: "sync_chat", chat: chatMeta(chat), rev: stateRevRef.current });
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [chats, send, syncTick]);

  useEffect(() => {
    if (connected && unlocked) ensureBody(activeId);
  }, [activeId, bodyTick, connected, unlocked]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const chat of chatsRef.current) {
        if (!chat.turns.some((turn) => turn.running || turnHasOpenTools(turn))) continue;
        const last = lastProgressRef.current[chat.id];
        if (!last || now - last < 90_000 || stallNoticedRef.current.has(chat.id)) continue;
        stallNoticedRef.current.add(chat.id);
        if (chat.id === activeIdRef.current) {
          setNotice("这一轮没有新进展。如果一直转圈，点停止再发一次。");
        }
      }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (chats.length === 1 && chats[0].id === "boot") return;
    const slim = previewTabs.map(({ path, line }) => ({ path, line }));
    patchActive((chat) => {
      const same =
        JSON.stringify(chat.previewTabs || []) === JSON.stringify(slim) &&
        (chat.previewPath || "") === previewPath;
      return same ? chat : { ...chat, previewTabs: slim, previewPath };
    });
  }, [previewTabs, previewPath, patchActive]);

  // 会话开始或结束回复时记一下时间：侧栏按它给工作区排序、显示“几分钟前”
  const runSeenRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    const seen = runSeenRef.current;
    const stamp = new Set<string>();
    for (const chat of chats) {
      const run = chat.turns.some((turn) => turn.running);
      const before = seen.get(chat.id);
      seen.set(chat.id, run);
      if (before !== undefined && before !== run && chat.id !== "boot") stamp.add(chat.id);
    }
    if (!stamp.size) return;
    const now = Date.now();
    applyChats((prev) => prev.map((chat) => (stamp.has(chat.id) ? { ...chat, touchedAt: now } : chat)));
  }, [applyChats, chats]);

  // 侧栏的“几分钟前”每分钟重算一次；页面在后台时不走
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setClockTick((n) => n + 1);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // 侧栏分组的展开状态记在本机，刷新后保持
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) || "{}") as { open?: unknown; more?: unknown };
      if (Array.isArray(raw.open)) {
        setExpandedGroups(new Set(raw.open.filter((item): item is string => typeof item === "string")));
      }
      if (raw.more === true) setMoreOpen(true);
    } catch {
      // 坏数据忽略
    }
    setGroupPrefsReady(true);
  }, []);
  useEffect(() => {
    if (!groupPrefsReady) return;
    try {
      localStorage.setItem(
        GROUPS_KEY,
        JSON.stringify({ open: [...expandedGroups].slice(0, 200), more: moreOpen }),
      );
    } catch {
      // 存不下就算了
    }
  }, [groupPrefsReady, expandedGroups, moreOpen]);

  // 分组“···”菜单：点菜单外面就关
  useEffect(() => {
    if (!groupMenu) return;
    const onDown = (event: MouseEvent) => {
      const node = event.target;
      if (node instanceof Element && node.closest(".chat-group-menu, .chat-group-act")) return;
      setGroupMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [groupMenu]);

  const layerSeqRef = useRef<Record<string, number>>({});
  const layerOpen: Record<string, boolean> = {
    groupMenu: groupMenu != null,
    admin: adminOpen,
    workspace: workspaceMenuOpen,
    palette: paletteOpen,
    grep: grepOpen,
    loop: loopOpen,
    terminal: terminalOpen,
    files: filesOpen,
    search: searchOpen,
    find: threadFindOpen,
    previewMax,
  };
  const layerOpenKey = Object.keys(layerOpen)
    .filter((id) => layerOpen[id])
    .join("|");
  useEffect(() => {
    const seqs = layerSeqRef.current;
    const open = new Set(layerOpenKey ? layerOpenKey.split("|") : []);
    let next = Math.max(0, ...Object.values(seqs));
    // 同一次渲染里一起打开的几层，排在前面的拿更大的序号，和原来的优先级一致
    for (const id of [...open].reverse()) if (!seqs[id]) seqs[id] = ++next;
    for (const id of Object.keys(seqs)) if (!open.has(id)) delete seqs[id];
  }, [layerOpenKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        // 同时开着几层时先关最后打开的那层；打开时间一样时按这里的先后
        const layers: [string, boolean, () => void][] = [
          [
            "groupMenu",
            groupMenuRef.current != null,
            () => {
              const path = groupMenuRef.current?.path;
              setGroupMenu(null);
              if (path) focusGroupTrigger(path);
            },
          ],
          ["admin", adminOpenRef.current, () => setAdminOpen(false)],
          [
            "workspace",
            workspaceMenuOpenRef.current,
            () => {
              setWorkspaceMenuOpen(false);
              setWorkspaceCreating(false);
            },
          ],
          ["palette", paletteOpenRef.current, () => setPaletteOpen(false)],
          [
            "grep",
            grepOpenRef.current,
            () => {
              setGrepOpen(false);
              if (wideIDERef.current) setSidePane("chats");
            },
          ],
          [
            "loop",
            loopOpenRef.current,
            () => {
              setLoopOpen(false);
              if (wideIDERef.current) setSidePane("chats");
            },
          ],
          [
            "terminal",
            terminalOpenRef.current,
            () => {
              setTerminalOpen(false);
              if (wideIDERef.current) setSidePane("chats");
            },
          ],
          [
            "files",
            filesOpenRef.current,
            () => {
              setFilesOpen(false);
              setFilesQuery("");
              if (wideIDERef.current) setSidePane("chats");
            },
          ],
          ["search", searchOpenRef.current, () => setSearchOpen(false)],
          ["find", threadFindOpenRef.current, () => setThreadFindOpen(false)],
          ["previewMax", previewMaxRef.current && previewTabsRef.current.length > 0, () => setPreviewMax(false)],
        ];
        let top: (() => void) | null = null;
        let topSeq = -1;
        for (const [id, open, close] of layers) {
          const seq = layerSeqRef.current[id] ?? 0;
          if (open && seq > topSeq) {
            top = close;
            topSeq = seq;
          }
        }
        if (top) {
          top();
          return;
        }
        // 这里是捕获阶段，比输入框先拿到 Esc；提及列表开着时交给输入框收起列表，不停任务
        if (mentionQueryRef.current != null) return;
        if (busyRef.current) stopChat(activeIdRef.current);
      }
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newChatRef.current();
      }
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(false);
        setThreadFindOpen(false);
        setGrepOpen(false);
        setLoopOpen(false);
        setTerminalOpen(false);
        setSearchOpen(true);
        setSearchQ("");
      }
      if (meta && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setSearchOpen(false);
        setThreadFindOpen(false);
        setGrepOpen(false);
        setLoopOpen(false);
        setTerminalOpen(false);
        setPaletteOpen((open) => !open);
        setPaletteQ("");
        setPaletteIndex(0);
      }
      if (meta && event.key.toLowerCase() === "f") {
        if (event.shiftKey) {
          event.preventDefault();
          setSearchOpen(false);
          setPaletteOpen(false);
          setThreadFindOpen(false);
          setLoopOpen(false);
          setTerminalOpen(false);
          setGrepOpen(true);
          if (wideIDERef.current) setSidePane("search");
          return;
        }
        const node = event.target;
        const inPreview =
          node instanceof Element && node.closest(".file-preview")
            ? true
            : Boolean(document.activeElement?.closest(".file-preview"));
        if (inPreview) return;
        event.preventDefault();
        setSearchOpen(false);
        setPaletteOpen(false);
        setThreadFindOpen(true);
        setThreadFindIndex(0);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [send, stopChat]);

  useEffect(() => {
    if (!paletteOpen) return;
    if (!treePaths.length) send({ type: "list_files", query: "", chatId: activeIdRef.current });
  }, [paletteOpen, send, treePaths.length]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 960px)");
    const apply = () => setWideIDE(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!filesOpen) return;
    if (!treePaths.length) send({ type: "list_files", query: "", chatId: activeIdRef.current });
  }, [filesOpen, send, treePaths.length]);

  useEffect(() => {
    if (!grepOpen) return;
    if (!treePaths.length) send({ type: "list_files", query: "", chatId: activeIdRef.current });
    if (!grepQ.trim()) {
      setGrepHits([]);
      setGrepWait(false);
      return;
    }
    setGrepWait(true);
    setGrepHits([]);
    const timer = window.setTimeout(() => {
      send({ type: "search_text", query: grepQ.trim(), chatId: activeIdRef.current });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [grepOpen, grepQ, send, treePaths.length]);

  useEffect(() => {
    return () => {
      if (draftSaveTimerRef.current) window.clearTimeout(draftSaveTimerRef.current);
      if (mentionSearchTimerRef.current) window.clearTimeout(mentionSearchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    let raf = 0;
    let lastKb = -1;
    let lastOpen = false;
    const measure = () => {
      const vv = window.visualViewport;
      // Hardware keyboards pan visualViewport.scroll on every caret move.
      // Only the occluded height from a software keyboard should shift layout.
      const occluded = vv ? Math.max(0, window.innerHeight - vv.height) : 0;
      const kb = occluded > 100 ? Math.round(occluded) : 0;
      const open = kb > 100;
      if (kb === lastKb && open === lastOpen) return;
      lastKb = kb;
      lastOpen = open;
      root.style.setProperty("--kb", `${kb}px`);
      root.classList.toggle("kb-open", open);
    };
    const sync = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    measure();
    window.visualViewport?.addEventListener("resize", sync);
    window.addEventListener("resize", sync);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.visualViewport?.removeEventListener("resize", sync);
      window.removeEventListener("resize", sync);
      root.style.removeProperty("--kb");
      root.classList.remove("kb-open");
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;
    let heartbeat: number | undefined;
    // 文字增量按帧合并后再进 onServer：长回复每个 token 都 setChats 会让整条线程反复重渲染。
    // 其他消息到达前先把攒下的增量冲出去，保证事件先后不变；后台标签页 rAF 不跑，用定时器兜底。
    let deltas: Extract<ServerMessage, { type: "text-delta" | "thinking-delta" }>[] = [];
    let deltaFrame = 0;
    let deltaTimer = 0;
    const flushDeltas = () => {
      if (deltaFrame) window.cancelAnimationFrame(deltaFrame);
      if (deltaTimer) window.clearTimeout(deltaTimer);
      deltaFrame = 0;
      deltaTimer = 0;
      const batch = deltas;
      deltas = [];
      for (const delta of batch) onServerRef.current(delta);
    };
    const queueDelta = (delta: Extract<ServerMessage, { type: "text-delta" | "thinking-delta" }>) => {
      const last = deltas[deltas.length - 1];
      if (last && last.type === delta.type && last.chatId === delta.chatId) {
        deltas[deltas.length - 1] = { ...last, text: last.text + delta.text };
      } else {
        deltas.push(delta);
      }
      if (!deltaFrame) deltaFrame = window.requestAnimationFrame(flushDeltas);
      if (!deltaTimer) deltaTimer = window.setTimeout(flushDeltas, 120);
    };

    const connect = () => {
      if (retry) {
        window.clearTimeout(retry);
        retry = undefined;
      }
      const prev = wsRef.current;
      if (prev) {
        prev.onclose = null;
        prev.onerror = null;
        prev.onopen = null;
        prev.onmessage = null;
        if (prev.readyState === WebSocket.OPEN || prev.readyState === WebSocket.CONNECTING) {
          prev.close();
        }
      }
      const ws = new WebSocket(gatewayUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        if (closed || wsRef.current !== ws) return;
        setConnected(true);
        setAuthError((prev) => (prev.startsWith("还没连上") ? "" : prev));
        const queued = pendingHelloRef.current;
        pendingHelloRef.current = null;
        const saved = queued?.token || localStorage.getItem(TOKEN_KEY) || tokenRef.current.trim();
        if (saved) {
          if (!unlockedRef.current) setVerifying(true);
          send({ type: "hello", token: saved, client: HELLO_CLIENT });
          if (!unlockedRef.current) {
            if (verifyTimerRef.current) window.clearTimeout(verifyTimerRef.current);
            verifyTimerRef.current = window.setTimeout(() => {
              if (unlockedRef.current) return;
              setVerifying(false);
              setAuthError("验证超时，请再试一次。");
            }, 20000);
          }
        }
      };
      ws.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if ((message.type === "text-delta" || message.type === "thinking-delta") && message.chatId) {
          queueDelta(message);
          return;
        }
        flushDeltas();
        try {
          onServerRef.current(message);
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        flushDeltas();
        setConnected(false);
        holdSnapshotRef.current.clear();
        sawSnapshotRef.current.clear();
        resumedRef.current.clear();
        // 在途的上传和分页都等不到应答了：元数据重连后按快照重推，正文退回加载前的状态
        inflightMetaRef.current = new Map();
        stateWaitRef.current = 0;
        for (const [id, body] of [...bodyRef.current]) {
          if (body.state !== "loading") continue;
          if (body.prev === "complete") bodyRef.current.set(id, { state: "complete", rev: body.rev });
          else bodyRef.current.delete(id);
        }
        if (!unlockedRef.current) {
          setVerifying(false);
        } else {
          setNotice("正在重连服务器…");
        }
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
    };

    connect();
    heartbeat = window.setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "ping" }));
    }, 25000);
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      if (heartbeat) window.clearInterval(heartbeat);
      if (deltaFrame) window.cancelAnimationFrame(deltaFrame);
      if (deltaTimer) window.clearTimeout(deltaTimer);
      deltas = [];
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [send]);

  // 长会话渲染测量入口：只有 ?perf=1 或 localStorage cr-perf=1 才挂上，默认整段不执行（界面冒烟的“长会话”场景用）
  useEffect(() => {
    if (!PERF) return;
    return installPerfApi({
      seed: (count) => {
        const started = performance.now();
        patchChat(activeIdRef.current, (chat) => ({ ...chat, turns: [...chat.turns, ...makePerfTurns(count)] }));
        return new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started))),
        );
      },
      arm: () =>
        applyChats((prev) =>
          patchChatIn(prev, activeIdRef.current, (chat) => {
            const turns = armPerfLive(chat.turns);
            return turns === chat.turns ? chat : { ...chat, turns };
          }),
        ),
      // 走和线上一样的 ws.onmessage 路径，text-delta 会经过同样的按帧合并
      feed: (message) => {
        const ws = wsRef.current;
        ws?.onmessage?.call(ws, { data: JSON.stringify(message) } as MessageEvent);
      },
    });
  }, [patchChat, applyChats]);

  const { threadRef, scrollMap, stickRef, restoreRef, jumpState, scrollThreadToEnd, onThreadScroll } = useThreadScroll({
    activeIdRef,
    active,
    activeId,
    threadFindOpen,
  });

  function submit(raw?: string) {
    if (raw != null) draftRef.current = raw;
    const text = draftRef.current.trim();
    if (!text && !images.length) return;
    // 自动登录还没完成：会话列表还没同步，先不发，草稿留着
    if (!unlockedRef.current) {
      setNotice("正在登录，稍后再发");
      return;
    }
    const target = chatsRef.current.find((item) => item.id === activeIdRef.current);
    if (
      target &&
      !isAssistantChat(target.id) &&
      !chatHasContent(target) &&
      workspaceRoot &&
      sameCwd(target.cwd || workspaceRoot, workspaceRoot)
    ) {
      // USER 根目录不开新的普通会话：等助理会话同步，或先选子工作区
      const home = chatsRef.current.find((item) => isAssistantChat(item.id));
      if (!home) {
        setNotice("助理会话还在同步，稍后再发；要开普通对话请先选一个子工作区。");
        return;
      }
      // 输入的文字和图片跟着搬到助理会话，不留在看不见的占位里
      const carryText = draftRef.current;
      const carryImages = images;
      selectChat(home);
      imagesRef.current[target.id] = [];
      imagesRef.current[home.id] = carryImages;
      patchChat(target.id, (item) => ({ ...item, draft: "", draftImages: [] }));
      patchChat(home.id, (item) => ({ ...item, draft: carryText, draftImages: carryImages }));
      syncComposer(carryText);
      setImages(carryImages);
      return;
    }
    const attached = images.slice(0, MAX_IMAGES);
    scrollThreadToEnd();
    syncComposer("");
    setImages([]);
    imagesRef.current[activeIdRef.current] = [];
    setError("");
    setNotice("");
    lastProgressRef.current[activeIdRef.current] = Date.now();
    stallNoticedRef.current.delete(activeIdRef.current);
    const turn: Turn = {
      id: uid(),
      user: text || "（附图）",
      assistant: "",
      thinking: "",
      tools: [],
      running: !busyRef.current,
      queued: busyRef.current,
      images: attached.length ? attached : undefined,
      mode: modeRef.current,
      model: modelRef.current,
    };
    const current = chatsRef.current.find((item) => item.id === activeIdRef.current);
    patchActive((chat) => ({
      ...chat,
      draft: "",
      turns: [
        ...chat.turns.map((item) => (item.pendingTool ? { ...item, pendingTool: undefined } : item)),
        turn,
      ],
    }));
    send({
      type: "prompt",
      text: text || "请看附图。",
      model: modelRef.current,
      mode: modeRef.current,
      chatId: activeIdRef.current,
      files: attachedFiles(text),
      images: attached.length ? attached : undefined,
      confirmWrites: confirmWritesRef.current,
      policy: policyRef.current,
      nameChat: isUntitled(current?.title),
      turnId: turn.id,
    });
  }

  function submitNewWorkspace() {
    const name = workspaceNameDraft.trim();
    if (!name) return;
    send({ type: "create_workspace", name });
  }

  function stashView() {
    if (draftSaveTimerRef.current) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = 0;
    }
    const id = activeIdRef.current;
    if (threadRef.current && restoreRef.current == null) {
      scrollMap.current[id] = stickRef.current ? -1 : threadRef.current.scrollTop;
    }
    const text = draftRef.current;
    imagesRef.current[id] = images;
    applyChats((prev) =>
      prev.map((chat) =>
        chat.id === id
          ? { ...chat, draft: text, draftImages: images, model: modelRef.current, mode: modeRef.current, cwd: chat.cwd, previewTabs: previewTabsRef.current.map(({ path, line }) => ({ path, line })), previewPath: previewPathRef.current }
          : chat,
      ),
    );
  }

  function startChatIn(path: string) {
    const next = path.trim();
    if (!next || (workspaceRoot && sameCwd(next, workspaceRoot))) {
      openNewChatMenu();
      return;
    }
    persistMode("agent");
    const nextModel = lastModelRef.current || modelRef.current;
    const empties = chatsRef.current.filter(
      (chat) =>
        !isAssistantChat(chat.id) &&
        chat.title === "新对话" &&
        !chatHasContent(chat) &&
        sameCwd(chat.cwd || workspaceRoot, next),
    );
    setWorkspaceMenuOpen(false);
    setWorkspaceCreating(false);
    setWorkspaceNameDraft("");
    setNavOpen(false);
    if (empties.length) {
      const keep = {
        ...empties[0],
        mode: "agent" as AgentMode,
        cwd: next,
        model: empties[0].model || nextModel,
      };
      if (empties.length > 1) {
        const drop = new Set(empties.slice(1).map((chat) => chat.id));
        applyChats((prev) => prev.filter((chat) => !drop.has(chat.id)));
      }
      patchChat(keep.id, (chat) => ({
        ...chat,
        mode: "agent",
        cwd: next,
        model: chat.model || nextModel,
      }));
      selectChat({ ...keep, cwd: next });
      return;
    }
    const leavingId = activeIdRef.current;
    const leaving = chatsRef.current.find((item) => item.id === leavingId);
    const cross = Boolean(leaving) && !sameCwd(leaving?.cwd || workspaceRoot, next);
    const dirty = dirtyDraftMap();
    if (cross && Object.keys(dirty).length) {
      setNotice("未保存的修改已丢掉");
      draftsByChatRef.current[leavingId] = {};
    } else {
      draftsByChatRef.current[leavingId] = dirty;
    }
    setPreviewDrafts({});
    stashView();
    const chat = {
      id: uid(),
      title: "新对话",
      turns: [],
      draft: "",
      model: nextModel,
      mode: "agent" as AgentMode,
      cwd: next,
      confirmWrites: confirmWritesRef.current,
      policy: policyRef.current,
      touchedAt: Date.now(),
    };
    applyChats((prev) => [chat, ...prev]);
    autoPickedIdRef.current = "";
    setActiveId(chat.id);
    if (nextModel) {
      modelRef.current = nextModel;
      setModel(nextModel);
    }
    syncComposer("");
    setImages([]);
    setSearchOpen(false);
    setCheckpoints([]);
    setPreviewTabs([]);
    setPreviewPath("");
    setPreviewMax(false);
    setThreadFindOpen(false);
    setGrepOpen(false);
    send({ type: "new_session", chatId: chat.id, cwd: next });
    if (nextModel) send({ type: "set_model", model: nextModel, chatId: chat.id });
  }
  startChatInRef.current = startChatIn;

  function openNewChatMenu() {
    send({ type: "list_workspaces" });
    setWorkspaceCreating(false);
    setWorkspaceQuery("");
    setWorkspaceIndex(0);
    setSearchOpen(false);
    setPaletteOpen(false);
    // 窄屏抽屉的层级比浮层高，先收起抽屉
    setNavOpen(false);
    setWorkspaceMenuOpen(true);
  }
  newChatRef.current = openNewChatMenu;

  function newChat() {
    if (workspaceMenuOpen) {
      setWorkspaceMenuOpen(false);
      setWorkspaceCreating(false);
      return;
    }
    openNewChatMenu();
  }

  function openFilesBrowser() {
    setFilesQuery("");
    setGrepOpen(false);
    setLoopOpen(false);
    setTerminalOpen(false);
    setPaletteOpen(false);
    setSearchOpen(false);
    if (wideIDERef.current) setSidePane("files");
    setFilesOpen(true);
  }

  function closeFiles() {
    setFilesOpen(false);
    setFilesQuery("");
    if (wideIDERef.current) setSidePane("chats");
  }

  /** 右键“下载”：有未过期的票据直接取，没有就先读一次文件换票据 */
  function downloadWorkspaceFile(path: string) {
    const chatId = activeIdRef.current;
    if (!chatId) {
      setNotice("没有打开的对话，没法下载");
      return;
    }
    const ticket = mediaTicketRef.current;
    if (ticket && ticket.chatId === chatId && ticket.media.exp - Date.now() > 5 * 60_000) {
      void saveWorkspaceFile(path, mediaSrc(path, chatId, ticket.media), setNotice);
      return;
    }
    const reqId = `dl:${crypto.randomUUID()}`;
    pendingDownloadRef.current.set(reqId, path);
    send({ type: "read_file", path, chatId, reqId });
    setNotice("正在准备下载…");
  }

  function chooseSide(pane: "chats" | "files" | "search" | "git" | "terminal" | "loop" | "assistant") {
    if (!wideIDERef.current) {
      if (pane === "chats") setNavOpen(true);
      if (pane === "files" || pane === "git") openFilesBrowser();
      if (pane === "search") {
        setPaletteOpen(false);
        setLoopOpen(false);
        setAssistantOpen(false);
        setTerminalOpen(false);
        setGrepOpen(true);
      }
      if (pane === "loop") {
        setGrepOpen(false);
        setTerminalOpen(false);
        setAssistantOpen(false);
        setLoopOpen(true);
      }
      if (pane === "assistant") {
        setGrepOpen(false);
        setLoopOpen(false);
        setTerminalOpen(false);
        setAssistantOpen(true);
      }
      if (pane === "terminal") {
        setGrepOpen(false);
        setLoopOpen(false);
        setAssistantOpen(false);
        setTerminalOpen(true);
      }
      return;
    }
    setSidePane(pane);
    setNavOpen(false);
    setSearchOpen(false);
    setPaletteOpen(false);
    setThreadFindOpen(false);
    setFilesOpen(pane === "files" || pane === "git");
    setGrepOpen(pane === "search");
    setLoopOpen(pane === "loop");
    setAssistantOpen(pane === "assistant");
    setTerminalOpen(pane === "terminal");
    if (pane === "files") setFilesQuery("");
  }

  /** 主区切到助理会话；还没同步到本机时返回 false */
  function openAssistantChat() {
    const chat = chatsRef.current.find((row) => isAssistantChat(row.id));
    if (!chat) {
      if (assistantChatIdRef.current) setNotice("助理会话还没同步到本机，稍后再试。");
      return false;
    }
    if (chat.id === activeIdRef.current) setNavOpen(false);
    else selectChat(chat);
    return true;
  }

  function openAssistantFromRail() {
    openAssistantChat();
    chooseSide("assistant");
  }

  function openChatById(chatId: string) {
    if (!chatId) {
      if (openAssistantChat() && !wideIDERef.current) setAssistantOpen(false);
      return;
    }
    const chat = chatsRef.current.find((row) => row.id === chatId);
    if (!chat) {
      setNotice("这个会话还没同步到本机，稍后再试。");
      return;
    }
    selectChat(chat);
    // 和收件箱一致：宽屏助理留在侧栏列，窄屏关掉浮层才能看见会话
    if (!wideIDERef.current) setAssistantOpen(false);
  }

  function answerDelegation(approval: AssistantApproval, allow: boolean) {
    send({ type: "assistant_op", op: "approval_answer", args: { chatId: approval.chatId, callId: approval.callId, allow }, reqId: crypto.randomUUID() });
  }

  function openAssistantInboxItem(item: { chatId?: string; id: string }) {
    clearInboxDeepLink();
    const chat = item.chatId ? chatsRef.current.find((row) => row.id === item.chatId) : undefined;
    if (!chat) {
      // 没有关联会话（提醒、简报）：回助理会话；助理会话也没同步时留在收件箱里看正文
      if (!item.chatId && openAssistantChat()) {
        if (wideIDERef.current) chooseSide("assistant");
        else setAssistantOpen(false);
        return;
      }
      if (wideIDERef.current) chooseSide("assistant");
      else setAssistantOpen(true);
      return;
    }
    selectChat(chat);
    // 宽屏时助理留在侧栏列，主区换成这个会话；窄屏关掉浮层才能看见会话
    if (!wideIDERef.current) setAssistantOpen(false);
  }

  function selectChat(chat: Chat) {
    if (chat.id !== activeIdRef.current) {
      const leaving = chatsRef.current.find((item) => item.id === activeIdRef.current);
      const cross =
        Boolean(leaving) && !sameCwd(leaving?.cwd || workspaceRoot, chat.cwd || workspaceRoot);
      if (cross && !confirmDiscardDirty()) return;
      draftsByChatRef.current[activeIdRef.current] = cross ? {} : dirtyDraftMap();
      setPreviewDrafts({ ...(draftsByChatRef.current[chat.id] || {}) });
    }
    stashView();
    setNavOpen(false);
    autoPickedIdRef.current = "";
    setActiveId(chat.id);
    if (chat.unread) patchChat(chat.id, (item) => ({ ...item, unread: false }));
    const draft = usableDraft(chat);
    syncComposer(draft);
    if (draft !== (chat.draft || "")) {
      patchChat(chat.id, (item) => ({ ...item, draft }));
    }
    setImages(imagesRef.current[chat.id] || chat.draftImages || []);
    setSearchOpen(false);
    setCheckpoints(chat.checkpoints || []);
    send({ type: "list_checkpoints", chatId: chat.id });
    send({ type: "list_files", query: "", chatId: chat.id });
    applySessionModel(chat);
    if (chat.mode) {
      modeRef.current = chat.mode;
      setMode(chat.mode);
    }
    if (chat.cwd) {
      setCwd(chat.cwd);
      if (chat.cwd !== cwdRef.current) {
        send({ type: "set_workspace", cwd: chat.cwd, chatId: chat.id });
      }
    } else if (workspaceRoot) {
      setCwd(workspaceRoot);
    }
    const savedTabs = chat.previewTabs || [];
    if (savedTabs.length) {
      const next = savedTabs.map((tab) => ({
        path: tab.path,
        line: tab.line,
        kind: kindFromPath(tab.path),
        pinned: true,
      }));
      setPreviewTabs(next);
      setPreviewPath(chat.previewPath || savedTabs[0]?.path || "");
      for (const tab of next) {
        previewWantedRef.current.add(tab.path);
        send({ type: "read_file", path: tab.path, chatId: chat.id, diff: undefined });
      }
      setPreviewMax(false);
    } else {
      setPreviewTabs([]);
      setPreviewPath("");
      setPreviewMax(false);
    }
    setThreadFindOpen(false);
    if (chat.agentId) {
      send({ type: "resume_session", chatId: chat.id, agentId: chat.agentId });
    }
  }

  async function addImages(files: FileList | File[]) {
    const next = await filesToImages(files);
    if (!next.length) return 0;
    setImages((prev) => {
      const merged = [...prev, ...next].slice(0, MAX_IMAGES);
      imagesRef.current[activeIdRef.current] = merged;
      patchActive((chat) => ({ ...chat, draftImages: merged }));
      return merged;
    });
    return next.length;
  }

  function attachUploadedPath(chatId: string, path: string) {
    const token = `@${path} `;
    rememberRecent(path);
    if (chatId && chatId !== activeIdRef.current) {
      patchChat(chatId, (chat) => {
        const draft = chat.draft || "";
        if (draft.includes(`@${path}`)) return chat;
        return {
          ...chat,
          draft: `${draft}${draft && !draft.endsWith(" ") ? " " : ""}${token}`,
        };
      });
      return;
    }
    const current = draftRef.current;
    if (current.includes(`@${path}`)) return;
    const next = `${current}${current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : ""}${token}`;
    draftRef.current = next;
    setDraft(next);
    setComposerEpoch((n) => n + 1);
    setDraftCaret(next.length);
    patchChat(activeIdRef.current, (chat) => (chat.draft === next ? chat : { ...chat, draft: next }));
  }

  function removeImage(index: number) {
    setImages((prev) => {
      const merged = prev.filter((_, i) => i !== index);
      imagesRef.current[activeIdRef.current] = merged;
      return merged;
    });
  }

  function clearDraftTimers() {
    if (draftSaveTimerRef.current) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = 0;
    }
    if (mentionSearchTimerRef.current) {
      window.clearTimeout(mentionSearchTimerRef.current);
      mentionSearchTimerRef.current = 0;
    }
  }

  function syncComposer(value: string, caret?: number) {
    clearDraftTimers();
    draftRef.current = value;
    setDraft(value);
    setComposerEpoch((n) => n + 1);
    if (caret != null) setDraftCaret(caret);
  }

  function updateMentions(value: string, caret: number) {
    const mention = mentionAt(value, caret);
    mentionRangeRef.current = mention;
    const query = mention ? mention.query : null;
    setMentionQuery((prev) => (prev === query ? prev : query));
    if (!mention) {
      setFileHits((prev) => (prev.length ? [] : prev));
      if (mentionSearchTimerRef.current) {
        window.clearTimeout(mentionSearchTimerRef.current);
        mentionSearchTimerRef.current = 0;
      }
      return;
    }
    const hits = mentionHits(treePathsRef.current, mention.query);
    setFileHits((prev) =>
      prev.length === hits.length && prev.every((item, i) => item === hits[i]) ? prev : hits,
    );
    if (mentionSearchTimerRef.current) window.clearTimeout(mentionSearchTimerRef.current);
    mentionSearchTimerRef.current = window.setTimeout(() => {
      mentionSearchTimerRef.current = 0;
      send({ type: "list_files", query: mention.query, chatId: activeIdRef.current, mention: true });
    }, 120);
  }

  function handleDraftChange(value: string, caret: number) {
    draftRef.current = value;
    if (draftSaveTimerRef.current) window.clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = 0;
      const text = draftRef.current;
      patchActive((chat) => (chat.draft === text ? chat : { ...chat, draft: text }));
    }, 400);
    updateMentions(value, caret);
  }

  function applyDraft(value: string, caret?: number) {
    syncComposer(value, caret);
    patchActive((chat) => (chat.draft === value ? chat : { ...chat, draft: value }));
    updateMentions(value, caret ?? value.length);
  }

  function dismissMention() {
    mentionRangeRef.current = null;
    setMentionQuery(null);
    setFileHits([]);
  }

  function submitLogin() {
    const next = token.trim();
    if (!next) return;
    setVerifying(true);
    setAuthError("");
    tokenRef.current = next;
    send({ type: "hello", token: next, client: HELLO_CLIENT });
    if (verifyTimerRef.current) window.clearTimeout(verifyTimerRef.current);
    verifyTimerRef.current = window.setTimeout(() => {
      if (unlockedRef.current) return;
      setVerifying(false);
      const open = wsRef.current?.readyState === WebSocket.OPEN;
      setAuthError(
        open
          ? "验证超时，请再试一次。"
          : "还没连上服务器。请稍后再试。",
      );
    }, 20000);
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    tokenRef.current = "";
    tenantIdRef.current = "";
    setToken("");
    unlockedRef.current = false;
    setUnlocked(false);
    setResuming(false);
    setVerifying(false);
    setAuthError("");
    resetTenantSession();
    pendingHelloRef.current = null;
    wsRef.current?.close();
  }

  function openAdminStats() {
    if (!isAdmin) return;
    setAdminOpen(true);
    send({ type: "admin_stats" });
  }

  function rememberLastModel(value: string) {
    const id = value.trim();
    if (!id) return;
    lastModelRef.current = id;
    writeLastModel(id);
  }

  function applySessionModel(chat: Chat) {
    const preferred = sessionModel(chat) || lastModelRef.current || modelRef.current;
    const catalog = withCurrentModel(withCurrentModel(models, preferred), modelRef.current);
    const next = resolveModel(preferred, catalog, DEFAULT_MODEL);
    if (!next) return;
    modelRef.current = next;
    setModel(next);
    if (sessionModel(chat)) rememberLastModel(next);
    if (chat.model !== next) {
      patchChat(chat.id, (item) => (item.model === next ? item : { ...item, model: next }));
    }
    send({ type: "set_model", model: next, chatId: chat.id });
  }

  function persistModel(value: string) {
    modelRef.current = value;
    setModel(value);
    rememberLastModel(value);
    patchActive((chat) => (chat.model === value ? chat : { ...chat, model: value }));
    send({ type: "set_model", model: value, chatId: activeIdRef.current });
    const label = modelLabel(value);
    setNotice(busyRef.current ? `跑完后下一条用 ${label}` : `下一条用 ${label}`);
  }

  function persistMode(value: AgentMode) {
    modeRef.current = value;
    setMode(value);
    patchActive((chat) => (chat.mode === value ? chat : { ...chat, mode: value }));
    setNotice(value === "ask" ? "只问，不改文件" : value === "plan" ? "先出方案，再动手" : "可以直接改文件、跑命令");
  }

  function handlePickFile(path: string, line?: number, endLine?: number, snippet?: string) {
    const token =
      line && endLine && endLine !== line
        ? `${path}:${line}-${endLine}`
        : line
          ? `${path}:${line}`
          : path;
    const mention = mentionRangeRef.current;
    const at = mention ? mention.start : -1;
    const fence =
      snippet?.trim() && at < 0
        ? `\n\`\`\`${path.split(".").pop() || ""}\n${snippet.trimEnd()}\n\`\`\`\n`
        : "";
    const inserted = `@${token} `;
    const current = draftRef.current;
    const next =
      mention && at >= 0
        ? `${current.slice(0, at)}${inserted}${current.slice(at + 1 + mention.query.length)}${fence}`
        : `${current}${current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : ""}${inserted}${fence}`;
    const caret = at >= 0 ? at + inserted.length : next.length;
    applyDraft(next, caret);
    mentionRangeRef.current = null;
    setMentionQuery(null);
    setFileHits([]);
    if (isOpenableMention(path)) {
      rememberRecent(path);
      openFile(path);
    }
  }

  function handleAskRange(path: string, start: number, end: number, text: string) {
    handlePickFile(path, start, end, text);
  }

  function handleTreeCreate(path: string, kind: "file" | "dir") {
    send({
      type: "fs_op",
      op: kind === "dir" ? "mkdir" : "create",
      path,
      chatId: activeIdRef.current,
    });
  }

  function handleTreeRename(from: string, to: string) {
    send({ type: "fs_op", op: "rename", path: from, to, chatId: activeIdRef.current });
  }

  function handleTreeDelete(path: string, dir: boolean) {
    if (!window.confirm(dir ? `删除空目录 ${path}？` : `删除文件 ${path}？`)) return;
    send({ type: "fs_op", op: "delete", path, chatId: activeIdRef.current });
  }

  function handleComposerFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) {
      setError("没有选到文件");
      return;
    }
    setNotice(`已选 ${list[0].name || "文件"}${list.length > 1 ? ` 等 ${list.length} 个` : ""}，正在上传…`);
    void ingestComposerFiles(list);
  }

  async function ingestComposerFiles(list: File[]) {
    if (!list.length) {
      setError("没有选到文件");
      return;
    }
    const tooBig = list.filter((file) => file.size > sourceLimit(file));
    const ok = list.filter((file) => !(file.size > sourceLimit(file))).slice(0, MAX_UPLOAD_FILES);
    if (tooBig.length) {
      const file = tooBig[0];
      setError(`${file.name || "文件"} 有 ${formatUploadMb(file.size)}，上限 ${formatUploadMb(sourceLimit(file))}`);
    }
    if (!ok.length) return;
    const shrunk = await Promise.all(ok.map((file) => shrinkImageFile(file)));
    const pics = shrunk.filter((file) => isPromptImageFile(file));
    if (pics.length) void addImages(pics);
    for (const file of shrunk) {
      void uploadComposerFile(file);
    }
  }

  async function uploadComposerFile(file: File) {
    const chatId = activeIdRef.current;
    const name = file.name || "file";
    setUploading((n) => n + 1);
    setNotice(`正在上传 ${name}`);
    try {
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new Error(`有 ${formatUploadMb(file.size)}，上限 ${MAX_UPLOAD_MB}MB`);
      }
      let path = "";
      try {
        path = await uploadComposerFileHttp(chatId, name, file);
      } catch (httpErr) {
        const buf = await file.arrayBuffer();
        if (!buf.byteLength) {
          throw httpErr instanceof Error ? httpErr : new Error("上传失败");
        }
        if (buf.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(`有 ${formatUploadMb(buf.byteLength)}，上限 ${MAX_UPLOAD_MB}MB`);
        }
        path = await uploadComposerFileSocket(chatId, name, buf);
      }
      attachUploadedPath(chatId, path);
      send({ type: "list_files", query: "", chatId });
      setNotice(`已添加 ${path}`);
    } catch (err) {
      setError(`${name}：${err instanceof Error ? err.message : "上传失败"}`);
    } finally {
      setUploading((n) => Math.max(0, n - 1));
    }
  }

  async function uploadComposerFileHttp(chatId: string, name: string, file: File) {
    const token = tokenRef.current || (typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) || "" : "");
    const form = new FormData();
    if (token) form.append("token", token);
    form.append("file", file, name);
    const res = await fetch(uploadUrl(chatId, name), {
      method: "POST",
      body: form,
    });
    const payload = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
    if (!res.ok || payload.error || !payload.path) {
      throw new Error(payload.error || `上传失败（${res.status}）`);
    }
    return payload.path;
  }

  function uploadComposerFileSocket(chatId: string, name: string, buf: ArrayBuffer) {
    return new Promise<string>((resolve, reject) => {
      const id = uid();
      const timer = window.setTimeout(() => {
        pendingUploadsRef.current.delete(id);
        reject(new Error("上传超时"));
      }, 90_000);
      pendingUploadsRef.current.set(id, { resolve, reject, timer });
      void fileToBase64(new Blob([buf]))
        .then((data) => {
          if (!data) throw new Error("文件读不出来");
          send({ type: "upload_file", chatId, name, data, id });
        })
        .catch((err) => {
          pendingUploadsRef.current.delete(id);
          window.clearTimeout(timer);
          reject(err instanceof Error ? err : new Error("上传失败"));
        });
    });
  }

  function removeDraftMention(token: string) {
    applyDraft(stripMention(draftRef.current, token));
  }

  function openFile(path: string, line?: number, asDiff?: boolean, sha?: string, sourceChatId?: string) {
    const lineHash = /#L(\d+)(?:-L?\d+)?$/i.exec(path);
    const cleanPath = lineHash ? path.slice(0, lineHash.index) : path;
    const targetLine = line ?? (lineHash ? Number(lineHash[1]) : undefined);
    const rel = relToCwd(cleanPath, cwdRef.current) || cleanPath;
    const kind = kindFromPath(rel);
    const dirty = Boolean(gitLetterOf(rel, gitStatus, cwdRef.current));
    const diff =
      kind === "canvas"
        ? false
        : asDiff != null
          ? asDiff
          : line == null &&
            dirty &&
            (kind === "text" || kind === "image" || kind === "svg");
    const current = previewTabsRef.current.find((tab) => sameFile(tab.path, rel, cwdRef.current));
    const sendPath = current?.path || rel;
    const cached = !diff && !sha ? peekPreviewText(rel) : undefined;
    previewWantedRef.current.add(sendPath);
    previewWantedRef.current.add(rel);
    previewTriesRef.current[sendPath] = 0;
    for (const item of [...httpHydratedRef.current]) {
      if (item.startsWith(`${sendPath}|`) || item.startsWith(`${rel}|`)) {
        httpHydratedRef.current.delete(item);
      }
    }
    setPreviewTabs((prev) => {
      const existing = prev.find((tab) => sameFile(tab.path, rel, cwdRef.current));
      if (existing) {
        return prev.map((tab) =>
          sameFile(tab.path, rel, cwdRef.current)
            ? {
                ...tab,
                line: targetLine,
                diff,
                kind,
                sha,
                sourceChatId,
                content: diff !== tab.diff ? cached : tab.content ?? cached,
                url: diff !== tab.diff ? undefined : tab.url,
                headUrl: diff !== tab.diff ? undefined : tab.headUrl,
                error: undefined,
              }
            : tab,
        );
      }
      const tab: PreviewTab = {
        path: rel,
        line: targetLine,
        diff,
        kind,
        content: cached,
        sha,
        sourceChatId,
      };
      const previewIndex = prev.findIndex((item) => !item.pinned);
      if (previewIndex >= 0) {
        const replaced = prev[previewIndex];
        previewWantedRef.current.delete(replaced.path);
        delete previewTriesRef.current[replaced.path];
        return prev.map((item, index) => index === previewIndex ? tab : item);
      }
      return [...prev, tab].slice(-8);
    });
    setPreviewPath(sendPath);
    rememberRecent(rel);
    setNavOpen(false);
    setPreviewMax(true);
    const requestChatId = sourceChatId || activeIdRef.current;
    const reqId = sha ? uid() : undefined;
    if (reqId) {
      pendingHistoricalRef.current.set(reqId, {
        path: sendPath,
        chatId: requestChatId,
        ownerActiveChatId: activeIdRef.current,
      });
    }
    send({ type: "read_file", path: sendPath, chatId: requestChatId, diff: diff || undefined, sha, reqId });
  }

  function handleCanvasAction(action: CanvasAction, canvasPath: string) {
    if (action.type === "openFile") {
      openFile(action.path, action.selection?.startLineNumber);
      return;
    }
    if (action.type === "newComposerChat") {
      const token = `@${canvasPath}`;
      const extra = action.userPrompt?.trim() || "";
      const next = extra ? `${token} ${extra}` : `${token} `;
      applyDraft(next, next.length);
      return;
    }
    if (action.type === "openAgent") {
      const hit = chatsRef.current.find((chat) => chat.agentId === action.agentId);
      if (hit) selectChat(hit);
    }
  }

  function togglePreviewDiff(path: string, diff: boolean) {
    const tab = previewTabsRef.current.find((item) => sameFile(item.path, path, cwdRef.current));
    openFile(path, undefined, diff, undefined, tab?.sourceChatId);
  }

  function revertFile(path: string, silent = false) {
    if (!silent && !window.confirm(`还原 ${path}？未提交的改动会丢掉。`)) return;
    send({ type: "revert_file", chatId: activeIdRef.current, path });
  }

  function keepFile(path: string) {
    openFile(path, undefined, false);
  }

  function revertHunk(path: string, hunk: string) {
    send({ type: "revert_hunk", chatId: activeIdRef.current, path, hunk });
  }

  function requestState() {
    stateWaitRef.current = Date.now();
    if (stateTimerRef.current) return;
    stateTimerRef.current = window.setTimeout(() => {
      stateTimerRef.current = undefined;
      send({ type: "load_state" });
    }, 300);
  }

  function forgetLocalChat(id: string) {
    bodyRef.current.delete(id);
    syncedMetaRef.current.delete(id);
    inflightMetaRef.current.delete(id);
    delete chatRevsRef.current[id];
    const timer = cacheTimersRef.current.get(id);
    if (timer) window.clearTimeout(timer);
    cacheTimersRef.current.delete(id);
    void dropBody(tenantIdRef.current, id);
  }

  /** 正文完整、和服务端同版本、没有在跑的回合时，写进浏览器缓存 */
  function scheduleBodyCache(id: string) {
    const tenant = tenantIdRef.current;
    if (!tenant) return;
    const old = cacheTimersRef.current.get(id);
    if (old) window.clearTimeout(old);
    cacheTimersRef.current.set(
      id,
      window.setTimeout(() => {
        cacheTimersRef.current.delete(id);
        if (tenantIdRef.current !== tenant) return;
        const body = bodyRef.current.get(id);
        const chat = chatsRef.current.find((item) => item.id === id);
        if (!chat || body?.state !== "complete" || body.rev == null) return;
        if (body.rev !== chatRevsRef.current[id] || chat.turns.some(liveTurn)) return;
        // 超大回合分页时是截断副本，不能当完整正文缓存
        if (chat.turns.some((turn) => (turn as { clipped?: boolean }).clipped)) return;
        // 测量开关下合成的回合不能进缓存，否则关掉开关后刷新还会读到它们
        if (PERF && chat.turns.some(isPerfTurn)) return;
        void writeBody(tenant, id, body.rev, chat.turns);
      }, 1500),
    );
  }

  function commitBody(id: string, turns: Turn[], rev: number) {
    bodyRef.current.set(id, { state: "complete", rev });
    applyChats((prev) =>
      prev.map((chat) => (chat.id === id ? { ...chat, turns: mergeBodyTurns(chat.turns, turns) } : chat)),
    );
    setBodyTick((n) => n + 1);
    scheduleBodyCache(id);
  }

  /**
   * 让会话正文对齐服务端 chatRev。有旧正文（内存或缓存）时先只拉最后一页拼接，
   * 对不上再从后往前整段拉；整段加载和 iOS 一致，查找、终端、编辑定位都依赖全量。
   */
  function ensureBody(id: string) {
    if (!id || id === "boot" || !appliedStoreRef.current || !unlockedRef.current) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const target = chatRevsRef.current[id];
    const body = bodyRef.current.get(id);
    if (body?.state === "loading") return;
    if (target == null) {
      // 网关还不知道这个会话（本地新建）：本地就是全部
      if (!body) bodyRef.current.set(id, { state: "complete", rev: undefined });
      return;
    }
    if (body?.state === "complete" && body.rev === target) return;
    const chat = chatsRef.current.find((item) => item.id === id);
    if (!chat) return;
    const nonce = ++loadNonceRef.current;
    bodyRef.current.set(id, {
      state: "loading",
      rev: body?.rev,
      prev: body ? "complete" : "none",
      nonce,
      target,
      base: body ? chat.turns : null,
      buf: [],
      progressive: false,
    });
    setBodyTick((n) => n + 1);
    if (body) {
      send({ type: "load_chat", chatId: id, nonce });
      return;
    }
    void readBody<Turn>(tenantIdRef.current, id).then((cached) => {
      const cur = bodyRef.current.get(id);
      if (cur?.state !== "loading" || cur.nonce !== nonce) return;
      if (cached && cached.rev === target) {
        commitBody(id, cached.turns, target);
        return;
      }
      if (cached) {
        cur.base = cached.turns;
        applyChats((prev) =>
          prev.map((item) =>
            item.id === id ? { ...item, turns: mergeBodyTurns(item.turns, cached.turns) } : item,
          ),
        );
      }
      send({ type: "load_chat", chatId: id, nonce });
    });
  }

  function onChatTurns(message: Extract<ServerMessage, { type: "chat_turns" }>) {
    const id = message.chatId;
    const cur = bodyRef.current.get(id);
    if (cur?.state !== "loading" || cur.nonce !== message.nonce) return;
    const page = (Array.isArray(message.turns) ? message.turns : [])
      .map(serverTurn)
      .filter((turn): turn is Turn => Boolean(turn));
    const from = typeof message.from === "number" ? message.from : 0;
    if (cur.base) {
      const base = cur.base;
      cur.base = null;
      if (!message.hasMore) {
        commitBody(id, page, cur.target);
        return;
      }
      if (page.length && base[from]?.id === page[0].id) {
        commitBody(id, [...base.slice(0, from), ...page], cur.target);
        return;
      }
      // 前面的回合对不上（别处编辑过）：整段重拉，旧内容先留着显示
    } else if (!cur.buf.length) {
      const chat = chatsRef.current.find((item) => item.id === id);
      cur.progressive = !chat?.turns.some((turn) => !liveTurn(turn));
    }
    cur.buf = [...page, ...cur.buf];
    if (!message.hasMore) {
      commitBody(id, cur.buf, cur.target);
      return;
    }
    if (cur.progressive) {
      const shown = cur.buf;
      applyChats((prev) =>
        prev.map((chat) => (chat.id === id ? { ...chat, turns: mergeBodyTurns(chat.turns, shown) } : chat)),
      );
    }
    setBodyTick((n) => n + 1);
    send({ type: "load_chat", chatId: id, from, nonce: cur.nonce });
  }

  /** 编辑、重试要按全量定位回合，正文没加载完时先挡住 */
  function bodyReady(id: string): boolean {
    const body = bodyRef.current.get(id);
    if (!body || body.state === "complete") return true;
    setNotice("正在加载完整记录，稍后再试");
    return false;
  }

  function applyToolReviews(turnId: string, reviews: { callId: string; review: "accepted" | "rejected" }[]) {
    if (!reviews.length) return;
    const want = new Map(reviews.map((item) => [item.callId, item.review]));
    const chatId = activeIdRef.current;
    patchChat(chatId, (chat) => {
      const next = {
        ...chat,
        turns: chat.turns.map((item) =>
          item.id !== turnId
            ? item
            : {
                ...item,
                tools: item.tools.map((tool) => {
                  const review = want.get(tool.callId);
                  return review ? { ...tool, review } : tool;
                }),
              },
        ),
      };
      return next;
    });
    send({ type: "tool_review", chatId, turnId, reviews });
  }

  function setToolReview(turnId: string, callId: string, review: "accepted" | "rejected") {
    applyToolReviews(turnId, [{ callId, review }]);
  }

  function keepTool(turnId: string, tool: ToolCall) {
    const path = relToCwd(pathFromPayload(tool.args) || pathFromPayload(tool.result), cwdRef.current);
    setToolReview(turnId, tool.callId, "accepted");
    if (path) keepFile(path);
  }

  function rejectTool(turn: Turn, tool: ToolCall) {
    const diff = extractDiff(tool);
    const path = relToCwd(diff.path || pathFromPayload(tool.args) || pathFromPayload(tool.result), cwdRef.current);
    if (!path) return;
    if (diff.unified) revertHunk(path, diff.unified);
    else revertFile(path, true);
    setToolReview(turn.id, tool.callId, "rejected");
  }

  function keepTurnFiles(turn: Turn) {
    applyToolReviews(
      turn.id,
      turn.tools
        .filter((tool) => mutatingTool(tool.name) && !tool.review)
        .map((tool) => ({ callId: tool.callId, review: "accepted" as const })),
    );
    for (const path of editPathsOf(turn)) keepFile(relToCwd(path, cwdRef.current) || path);
  }

  function restoreTurnFiles(turn: Turn) {
    const paths = editPathsOf(turn).map((path) => relToCwd(path, cwdRef.current) || path);
    if (!paths.length) return;
    if (!window.confirm(`还原这一轮的 ${paths.length} 个文件？`)) return;
    const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
    const last = [...(chat?.turns || [])].reverse().find((item) => !item.queued && editPathsOf(item).length);
    if (last?.id === turn.id) send({ type: "undo", chatId: activeIdRef.current });
    else {
      for (const path of paths) revertFile(path, true);
    }
    applyToolReviews(
      turn.id,
      turn.tools
        .filter((tool) => mutatingTool(tool.name))
        .map((tool) => ({ callId: tool.callId, review: "rejected" as const })),
    );
  }

  function saveFile(path: string, content: string) {
    if (content.length > PREVIEW_SAVE_LIMIT) {
      setNotice("内容超过 500KB，不在这里保存");
      return;
    }
    const chatId = activeIdRef.current;
    if (!chatsRef.current.some((chat) => chat.id === chatId)) {
      setNotice("这个会话已经不在了，没法保存");
      return;
    }
    const rel = relToCwd(path, cwdRef.current) || path;
    saveSnapshotRef.current[rel] = content;
    send({ type: "write_file", path, content, chatId });
  }

  function dirtyDraftMap() {
    const out: Record<string, string> = {};
    for (const tab of previewTabsRef.current) {
      const draft = previewDraftsRef.current[tab.path];
      if (draft != null && draft !== (tab.content ?? "")) out[tab.path] = draft;
    }
    return out;
  }

  function confirmDiscardDirty() {
    const dirty = previewTabsRef.current.filter((tab) => previewDraftDirty(tab.path));
    if (!dirty.length) return true;
    const ok =
      dirty.length === 1
        ? window.confirm("放弃未保存的修改？这个文件里还有没保存的修改。")
        : window.confirm(`放弃未保存的修改？有 ${dirty.length} 个文件还没保存。`);
    if (!ok) return false;
    const drop = new Set(dirty.map((tab) => tab.path));
    setPreviewDrafts((prev) => {
      const next = { ...prev };
      for (const path of drop) delete next[path];
      return next;
    });
    return true;
  }

  function dropPreviewDraft(path: string) {
    setPreviewDrafts((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }

  function previewDraftDirty(path: string) {
    const draft = previewDraftsRef.current[path];
    if (draft == null) return false;
    const tab = previewTabsRef.current?.find((item) => sameFile(item.path, path));
    return draft !== (tab?.content ?? "");
  }

  function retryTurn(turn: Turn) {
    if (!connected) return;
    if (busyRef.current) {
      setNotice("等当前这条跑完再重试");
      return;
    }
    const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
    if (!chat || !bodyReady(chat.id)) return;
    const index = chat.turns.findIndex((item) => item.id === turn.id);
    if (index < 0) return;
    stateRevRef.current += 1;
    send({ type: "truncate_turns", chatId: chat.id, turnId: turn.id, rev: stateRevRef.current });
    const next: Turn = {
      ...turn,
      assistant: "",
      thinking: "",
      tools: [],
      todos: undefined,
      error: undefined,
      status: undefined,
      durationMs: undefined,
      pendingTool: undefined,
      running: true,
      queued: false,
    };
    patchActive((item) => ({
      ...item,
      turns: [...item.turns.slice(0, index), next],
      agentId: undefined,
    }));
    lastProgressRef.current[activeIdRef.current] = Date.now();
    stallNoticedRef.current.delete(activeIdRef.current);
    send({
      type: "prompt",
      text: turn.user || "请看附图。",
      model: turn.model || modelRef.current,
      mode: turn.mode || modeRef.current,
      chatId: activeIdRef.current,
      files: attachedFiles(turn.user),
      images: turn.images,
      confirmWrites: confirmWritesRef.current,
      policy: policyRef.current,
      fresh: true,
      nameChat: isUntitled(chat.title),
      turnId: next.id,
    });
  }

  function editTurn(turn: Turn) {
    if (busyRef.current) {
      setNotice("等当前这条跑完再编辑");
      return;
    }
    const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
    if (!chat || !bodyReady(chat.id)) return;
    const index = chat.turns.findIndex((item) => item.id === turn.id);
    if (index < 0) return;
    stateRevRef.current += 1;
    send({ type: "truncate_turns", chatId: chat.id, turnId: turn.id, rev: stateRevRef.current });
    patchActive((item) => ({
      ...item,
      turns: item.turns.slice(0, index),
      preview: index === 0 ? undefined : item.preview,
      agentId: undefined,
    }));
    send({ type: "new_session", chatId: activeIdRef.current });
    applyDraft(turn.user, turn.user.length);
    if (turn.images?.length) {
      setImages(turn.images);
      imagesRef.current[activeIdRef.current] = turn.images;
    }
  }

  function startRename(chat: Chat) {
    if (isAssistantChat(chat.id)) return;
    setRenameId(chat.id);
    setRenameDraft(chat.title);
  }

  function commitRename() {
    if (renameSkipRef.current) {
      renameSkipRef.current = false;
      setRenameId(null);
      return;
    }
    const id = renameId;
    const title = renameDraft.trim();
    setRenameId(null);
    if (!id || !title) return;
    patchChat(id, (chat) => {
      if (chat.title === title) return chat;
      if (title === "新对话" && !isUntitled(chat.title)) return chat;
      return { ...chat, title };
    });
  }

  /** 关掉分组菜单后把焦点还给它的“···”按钮，键盘用户不会掉到页面开头 */
  function focusGroupTrigger(path: string) {
    window.setTimeout(() => {
      const all = document.querySelectorAll<HTMLElement>("[data-group-trigger]");
      for (const node of all) {
        if (sameCwd(node.dataset.groupTrigger, path)) {
          node.focus();
          return;
        }
      }
    }, 0);
  }

  /** 是不是根目录下的一级工作区：只有这些能改名、删除 */
  function isTopLevelWorkspace(path: string) {
    const rel = relToCwd(path, workspaceRoot);
    return Boolean(rel) && !rel.includes("/") && !rel.startsWith(".") && rel !== path;
  }

  function renameWorkspacePrompt(path: string, name: string) {
    const next = window.prompt(`把工作区「${name}」改名为：`, name)?.trim();
    if (!next || next === name) return;
    send({ type: "rename_workspace", path, name: next });
  }

  function deleteWorkspaceConfirm(path: string, name: string) {
    const ok = window.confirm(
      `删除工作区「${name}」？\n目录是空的会直接删掉；里面有文件的只从列表里隐藏，文件不动（以后同名新建就能找回）。`,
    );
    if (ok) send({ type: "delete_workspace", path });
  }

  /** 工作区的“···”菜单：侧栏分组头和“更多工作区”共用 */
  function groupMenuNode(path: string, name: string, chatCount: number) {
    const manage = isTopLevelWorkspace(path);
    return (
      <div
        className="chat-group-menu"
        role="menu"
        aria-label={`「${name}」的操作`}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          const step = event.key === "ArrowDown" ? 1 : -1;
          items[(at + step + items.length) % items.length]?.focus();
        }}
      >
        <button
          type="button"
          role="menuitem"
          autoFocus
          onClick={() => {
            setGroupMenu(null);
            startChatIn(path);
          }}
        >
          新对话
        </button>
        {manage ? (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setGroupMenu(null);
              renameWorkspacePrompt(path, name);
            }}
          >
            重命名…
          </button>
        ) : null}
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setGroupMenu(null);
            copyPath(path);
            focusGroupTrigger(path);
          }}
        >
          复制路径
        </button>
        <button
          type="button"
          role="menuitem"
          className="danger"
          disabled={!chatCount}
          onClick={() => {
            setGroupMenu(null);
            clearWorkspaceChats(path, name);
          }}
        >
          清空对话{chatCount ? `（${chatCount}）` : ""}
        </button>
        {manage ? (
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={chatCount > 0}
            title={chatCount > 0 ? "里面还有对话，先清空对话" : "空目录直接删除，有文件的只隐藏"}
            onClick={() => {
              setGroupMenu(null);
              deleteWorkspaceConfirm(path, name);
            }}
          >
            删除工作区…
          </button>
        ) : null}
      </div>
    );
  }

  function copyPath(path: string) {
    const clip = navigator.clipboard;
    if (!clip?.writeText) {
      setNotice("复制失败");
      return;
    }
    void clip.writeText(path).then(
      () => setNotice("已复制路径"),
      () => setNotice("复制失败"),
    );
  }

  /** 清空某个工作区下的全部对话（目录和文件不动）。有对话在跑时不处理，免得误伤。 */
  function clearWorkspaceChats(path: string, name: string) {
    const ids = chatsRef.current
      .filter((chat) => !isAssistantChat(chat.id) && chat.id !== "boot" && sameCwd(chat.cwd || workspaceRoot, path))
      .map((chat) => chat.id);
    if (!ids.length) {
      setNotice("这个工作区里没有对话");
      return;
    }
    if (chatsRef.current.some((chat) => ids.includes(chat.id) && chat.turns.some((turn) => turn.running))) {
      setNotice("有对话正在运行，先停掉再清空");
      return;
    }
    if (!window.confirm(`清空「${name}」下的 ${ids.length} 个对话？\n只删对话，目录里的文件不动，删除后不能恢复。`)) {
      return;
    }
    // 当前打开的最后删：它被删时才会切到别的会话，前面删的都不会影响选中项
    const current = activeIdRef.current;
    const order = [...ids.filter((id) => id !== current), ...ids.filter((id) => id === current)];
    let removed = 0;
    for (const id of order) {
      deleteChat(id);
      // 有未保存的修改时 deleteChat 会让用户取消，没删成就别往下删了，也别报“已清空”
      if (!deletedIdsRef.current.has(id)) break;
      removed += 1;
    }
    setNotice(removed === ids.length ? `已清空 ${ids.length} 个对话` : `已删除 ${removed} 个，其余因有未保存的修改保留`);
  }

  function deleteChat(id: string) {
    if (isAssistantChat(id)) return;
    const stored = draftsByChatRef.current[id] || {};
    const activeDirty = id === activeIdRef.current && Object.keys(dirtyDraftMap()).length > 0;
    const storedDirty = id !== activeIdRef.current && Object.keys(stored).length > 0;
    if (activeDirty && !confirmDiscardDirty()) return;
    if (storedDirty) {
      const count = Object.keys(stored).length;
      const ok =
        count === 1
          ? window.confirm("放弃未保存的修改？这个文件里还有没保存的修改。")
          : window.confirm(`放弃未保存的修改？有 ${count} 个文件还没保存。`);
      if (!ok) return;
    }
    delete draftsByChatRef.current[id];
    if (renameId === id) setRenameId(null);
    deletedIdsRef.current = rememberDeleted(deletedIdsRef.current, id);
    const doomed = chatsRef.current.find((chat) => chat.id === id);
    if (doomed?.turns.some((turn) => turn.running)) {
      send({ type: "cancel", chatId: id });
    }
    send({ type: "delete_session", chatId: id });
    forgetLocalChat(id);
    const rest = chatsRef.current.filter((chat) => chat.id !== id);
    delete imagesRef.current[id];
    if (!rest.length) {
      const nextModel = lastModelRef.current || modelRef.current;
      // 占位落在 USER 根目录时复用 boot 空壳：不同步、不开会话，助理会话到了就替换它
      const atRoot = !cwdRef.current || Boolean(workspaceRoot && sameCwd(cwdRef.current, workspaceRoot));
      const chat = {
        id: atRoot ? "boot" : uid(),
        title: "新对话",
        turns: [],
        draft: "",
        model: nextModel,
        mode: modeRef.current,
        cwd: cwdRef.current,
        confirmWrites: confirmWritesRef.current,
      policy: policyRef.current,
      };
      chatsRef.current = [chat];
      setChats([chat]);
      autoPickedIdRef.current = chat.id;
      setActiveId(chat.id);
      if (nextModel) {
        modelRef.current = nextModel;
        setModel(nextModel);
      }
      syncComposer("");
      setImages([]);
      setCheckpoints([]);
      setPreviewTabs([]);
      setPreviewDrafts({});
      setPreviewPath("");
      setPreviewMax(false);
      if (atRoot) return;
      send({ type: "new_session", chatId: chat.id, cwd: chat.cwd });
      if (nextModel) send({ type: "set_model", model: nextModel, chatId: chat.id });
      return;
    }
    chatsRef.current = rest;
    setChats(rest);
    if (id !== activeIdRef.current) return;
    const chat = rest.find((item) => isAssistantChat(item.id)) || rest[0];
    autoPickedIdRef.current = "";
    setActiveId(chat.id);
    if (chat.unread) patchChat(chat.id, (item) => ({ ...item, unread: false }));
    const draft = usableDraft(chat);
    syncComposer(draft);
    if (draft !== (chat.draft || "")) {
      patchChat(chat.id, (item) => ({ ...item, draft }));
    }
    setImages(imagesRef.current[chat.id] || chat.draftImages || []);
    setCheckpoints(chat.checkpoints || []);
    send({ type: "list_checkpoints", chatId: chat.id });
    send({ type: "list_files", query: "", chatId: chat.id });
    applySessionModel(chat);
    if (chat.mode) {
      modeRef.current = chat.mode;
      setMode(chat.mode);
    }
    if (chat.cwd) {
      setCwd(chat.cwd);
      if (chat.cwd !== cwdRef.current) {
        send({ type: "set_workspace", cwd: chat.cwd, chatId: chat.id });
      }
    } else if (workspaceRoot) {
      setCwd(workspaceRoot);
    }
    setPreviewTabs([]);
    setPreviewDrafts({ ...(draftsByChatRef.current[chat.id] || {}) });
    setPreviewPath("");
    setPreviewMax(false);
    setThreadFindOpen(false);
    if (chat.agentId) {
      send({ type: "resume_session", chatId: chat.id, agentId: chat.agentId });
    }
  }

  function closePreviewTab(path: string) {
    if (previewDraftDirty(path)) {
      const name = path.split("/").pop() || path;
      if (!window.confirm(`关掉 ${name}？未保存的修改会丢掉。`)) return;
    }
    dropPreviewDraft(path);
    setPreviewTabs((prev) => {
      const next = prev.filter((tab) => !sameFile(tab.path, path));
      if (!next.length) setPreviewMax(false);
      setPreviewPath((current) =>
        sameFile(current, path) ? next.at(-1)?.path || "" : current,
      );
      return next;
    });
  }

  function applyPlan(turn: Turn) {
    if (!connected || busyRef.current) return;
    setMode("agent");
    modeRef.current = "agent";
    persistMode("agent");
    setNotice("按计划开始执行");
    const text = `请按你上一条计划开始执行，直接改文件，不要再只出方案。\n\n${turn.assistant.slice(0, 4000)}`;
    const next: Turn = {
      id: uid(),
      user: "执行这个计划",
      assistant: "",
      thinking: "",
      tools: [],
      running: true,
      mode: "agent",
      model: modelRef.current,
    };
    const current = chatsRef.current.find((item) => item.id === activeIdRef.current);
    patchActive((chat) => ({ ...chat, turns: [...chat.turns, next] }));
    lastProgressRef.current[activeIdRef.current] = Date.now();
    stallNoticedRef.current.delete(activeIdRef.current);
    send({
      type: "prompt",
      text,
      model: modelRef.current,
      mode: "agent",
      chatId: activeIdRef.current,
      confirmWrites: confirmWritesRef.current,
      policy: policyRef.current,
      nameChat: isUntitled(current?.title),
      turnId: next.id,
    });
  }

  function persistConfirmWrites(value: boolean) {
    confirmWritesRef.current = value;
    patchActive((chat) => (chat.confirmWrites === value ? chat : { ...chat, confirmWrites: value }));
    setNotice(value ? "写入前会先问你" : "写入不再确认");
  }

  function persistPolicy(value: PolicyId) {
    policyRef.current = value;
    patchActive((chat) => (chat.policy === value ? chat : { ...chat, policy: value }));
    send({ type: "set_policy", policy: value, chatId: activeIdRef.current });
    setNotice(value === "plane" ? "策略层：工具集限制 + 按条放行" : "现状路径：和现在一样");
  }

  function resolveApproval(allow: boolean) {
    const turn = [...(chatsRef.current.find((item) => item.id === activeIdRef.current)?.turns || [])]
      .reverse()
      .find((item) => item.pendingTool);
    const tool = turn?.pendingTool;
    if (!tool || !turn) return;
    const rejectedPaths = allow ? [] : editPathsOf(turn);
    patchChat(activeIdRef.current, (chat) => ({
      ...chat,
      turns: chat.turns.map((item) =>
        item.id === turn.id
          ? allow
            ? { ...item, pendingTool: undefined }
            : rejectMutatingTools(item)
          : item,
      ),
    }));
    if (!allow && rejectedPaths.length) {
      setPreviewTabs((prev) => {
        const next = prev.filter((tab) => {
          const rel = relToCwd(tab.path, cwdRef.current) || tab.path;
          const hit = rejectedPaths.some(
            (path) => sameFile(path, tab.path) || sameFile(relToCwd(path, cwdRef.current) || path, rel),
          );
          if (!hit) return true;
          return treePathsRef.current.some((item) => sameFile(item, rel) || sameFile(item, tab.path));
        });
        if (next.length !== prev.length && !next.some((tab) => sameFile(tab.path, previewPathRef.current))) {
          queueMicrotask(() => setPreviewPath(next[0]?.path || ""));
        }
        return next;
      });
    }
    setNotice(allow ? "已允许，正在按确认后重跑" : "已拒绝写入，正在还原到发送前");
    send({
      type: "approval_reply",
      chatId: activeIdRef.current,
      callId: tool.callId,
      allow,
    });
  }

  const activeBody = active ? bodyRef.current.get(active.id) : undefined;
  // 正文还没对齐：有 preview 说明服务端有内容，先显示加载中而不是欢迎页
  const bodyPending =
    Boolean(active) &&
    (activeBody?.state === "loading" || (!activeBody && active?.preview !== undefined));
  const loadingOlder =
    activeBody?.state === "loading" && activeBody.progressive && Boolean(active?.turns.length);
  const empty = !active?.turns.length && !bodyPending;
  searchOpenRef.current = searchOpen;
  paletteOpenRef.current = paletteOpen;
  threadFindOpenRef.current = threadFindOpen;
  grepOpenRef.current = grepOpen;
  loopOpenRef.current = loopOpen;
  terminalOpenRef.current = terminalOpen;
  adminOpenRef.current = adminOpen;
  filesOpenRef.current = filesOpen;
  grepQRef.current = grepQ;
  const searchHits = searchQ.trim()
    ? chats.filter((chat) => {
        const q = searchQ.trim().toLowerCase();
        return (
          chat.title.toLowerCase().includes(q) ||
          Boolean(chat.preview?.toLowerCase().includes(q)) ||
          chat.turns.some((turn) => turn.user.toLowerCase().includes(q))
        );
      })
    : chats;
  const paletteHits = (() => {
    const q = paletteQ.trim().toLowerCase();
    const match = (path: string) => {
      if (!q) return true;
      const base = path.split("/").pop() || path;
      return path.toLowerCase().includes(q) || base.toLowerCase().includes(q);
    };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const path of [...recentFiles, ...treePaths]) {
      if (seen.has(path) || !match(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out.slice(0, 80);
  })();
  const paletteHi = Math.min(paletteIndex, Math.max(0, paletteHits.length - 1));
  const grepNameHits = (() => {
    const q = grepQ.trim().toLowerCase();
    if (!q) return [] as string[];
    return treePaths.filter((path) => path.toLowerCase().includes(q)).slice(0, 40);
  })();
  const grepHi = Math.min(grepIndex, Math.max(0, grepNameHits.length + grepHits.length - 1));
  const threadFindHits =
    threadFindOpen && threadFindQ.trim() && active
      ? active.turns.filter((turn) => {
          const q = threadFindQ.trim().toLowerCase();
          return (
            turn.user.toLowerCase().includes(q) ||
            turn.assistant.toLowerCase().includes(q) ||
            turn.thinking.toLowerCase().includes(q)
          );
        })
      : [];
  const threadFindHi = Math.min(threadFindIndex, Math.max(0, threadFindHits.length - 1));

  useEffect(() => {
    if (!threadFindOpen) return;
    const id = threadFindHits[threadFindHi]?.id;
    if (!id || !threadRef.current) return;
    threadRef.current.querySelector(`[data-turn="${id}"]`)?.scrollIntoView({ block: "center" });
  }, [threadFindOpen, threadFindHi, threadFindQ, activeId, threadRef]);

  // 读屏播报：提示信息直接读；当前会话一轮跑完时补一句“回复完成”
  // 每次播报换一个 key，同一句话第二次出现时读屏也会再读
  const [liveAnnounce, setLiveAnnounce] = useState({ text: "", seq: 0 });
  const announce = useCallback((text: string) => setLiveAnnounce((prev) => ({ text, seq: prev.seq + 1 })), []);
  const wasBusyRef = useRef({ chatId: activeId, busy });
  useEffect(() => {
    const prev = wasBusyRef.current;
    wasBusyRef.current = { chatId: activeId, busy };
    if (prev.chatId === activeId && prev.busy && !busy) announce("回复完成");
  }, [activeId, busy, announce]);
  useEffect(() => {
    if (notice) announce(notice);
  }, [notice, announce]);

  // 宽屏 IDE 模式下循环、终端、搜索是侧栏面板，不算模态，不圈焦点
  const adminTrap = useFocusTrap<HTMLDivElement>(adminOpen);
  const searchTrap = useFocusTrap<HTMLDivElement>(searchOpen);
  const paletteTrap = useFocusTrap<HTMLDivElement>(paletteOpen);
  const workspaceTrap = useFocusTrap<HTMLDivElement>(workspaceMenuOpen);
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    document.getElementById(`workspace-choice-${workspacePick}`)?.scrollIntoView({ block: "nearest" });
  }, [workspaceMenuOpen, workspacePick]);
  const loopTrap = useFocusTrap<HTMLFormElement>(loopOpen && !(wideIDE && sidePane === "loop"));
  const terminalTrap = useFocusTrap<HTMLDivElement>(terminalOpen && !(wideIDE && sidePane === "terminal"));
  const grepTrap = useFocusTrap<HTMLDivElement>(grepOpen && !(wideIDE && sidePane === "search"));
  // 只有 Git 面板还嵌在侧栏里；文件浏览器是浮层
  const filesDocked = wideIDE && sidePane === "git";
  const filesTrap = useFocusTrap<HTMLDivElement>(filesOpen && !filesDocked);

  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const openFileStable = useCallback((path: string, line?: number) => openFileRef.current(path, line), []);
  const mdFindQuery = threadFindOpen ? threadFindQ : undefined;
  const mdComponents = useMemo(() => markdownComponents(openFileStable, mdFindQuery), [openFileStable, mdFindQuery]);

  const loopRow = loops[activeId];
  const loopLive = loopRow?.status === "armed" || loopRow?.status === "running";
  const assistantBadge = (assistantState?.inbox.filter((item) => !item.read).length ?? 0) + (assistantState?.approvals.length ?? 0);
  const assistantActive = Boolean(assistantChatId) && activeId === assistantChatId;

  // 用户选中的会话记在本机，刷新后 stored_state 据此落回原会话；自动挑的不记，免得下次被当成用户选的
  useEffect(() => {
    if (activeId !== "boot" && activeId !== autoPickedIdRef.current) writeActiveChat(activeId);
  }, [activeId]);

  // 默认落点：没有用户选过的会话（boot 空壳、已删、同步时自动挑的）就进助理会话
  useEffect(() => {
    if (!assistantChat || activeId === assistantChat.id) return;
    const current = chats.find((chat) => chat.id === activeId);
    const idle =
      !current ||
      (current.id === "boot" && !current.turns.length) ||
      current.id === autoPickedIdRef.current;
    if (idle && !Object.keys(dirtyDraftMap()).length) selectChat(assistantChat);
  }, [assistantChat, activeId, chats]);

  if (!unlocked && resuming === null && !demoCanvas) return <div className="login-gate" />;
  if (!unlocked && !resuming && !demoCanvas) {
    return (
      <LoginGate
        connected={connected}
        verifying={verifying}
        error={authError}
        value={token}
        onChange={(value) => {
          setToken(value);
          setAuthError("");
        }}
        onSubmit={submitLogin}
      />
    );
  }

  return (
    <div className={`app${navOpen ? " nav-open" : ""}${navReady ? " nav-ready" : ""}${wideIDE ? ` ide pane-${sidePane}` : ""}${previewTabs.length ? " has-editor" : ""}`}>
      <div className="sr-only" role="status" aria-live="polite">
        {liveAnnounce.text ? <span key={liveAnnounce.seq}>{liveAnnounce.text}</span> : null}
      </div>
      <div className="sr-only" role="alert">
        {error ? friendlyError(error) : ""}
      </div>
      <nav className="activity-bar" aria-label="活动栏">
        {(
          [
            ["assistant", `${assistantName} · 助理`],
            ["chats", "对话"],
            ["files", "文件"],
            ["search", "搜索"],
            ["git", "Git"],
            ["terminal", "终端"],
            ["loop", "Loop"],
          ] as const
        ).map(([pane, label]) => {
          const marked = (pane === "loop" && loopLive) || (pane === "assistant" && assistantBadge > 0);
          return (
            <button
              key={pane}
              type="button"
              className={`${sidePane === pane ? "on" : ""}${marked ? " live" : ""}`}
              aria-pressed={sidePane === pane}
              aria-label={label}
              title={label}
              onClick={() => (pane === "assistant" ? openAssistantFromRail() : chooseSide(pane))}
            >
              <IconRail name={pane} />
              {marked ? <span className="loop-live" /> : null}
            </button>
          );
        })}
        {isAdmin ? (
          <button type="button" className="activity-admin" aria-label="查看使用统计" onClick={openAdminStats}>
            <IconRail name="stats" />
          </button>
        ) : null}
      </nav>
      {adminOpen ? <AdminOverlay
        setAdminOpen={setAdminOpen}
        adminTrap={adminTrap}
        openAdminStats={openAdminStats}
        adminStats={adminStats}
        cursorBill={cursorBill}
        adminStatsAt={adminStatsAt}
      /> : null}
      {searchShown ? <SearchOverlay
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
        searchTrap={searchTrap}
        searchQ={searchQ}
        setSearchQ={setSearchQ}
        searchHits={searchHits}
        selectChat={selectChat}
        activeId={activeId}
        isAssistantChat={isAssistantChat}
        assistantName={assistantName}
      /> : null}
      {workspaceShown ? <WorkspaceOverlay
        workspaceMenuOpen={workspaceMenuOpen}
        setWorkspaceMenuOpen={setWorkspaceMenuOpen}
        setWorkspaceCreating={setWorkspaceCreating}
        workspaceTrap={workspaceTrap}
        otherMenuWorkspaces={otherMenuWorkspaces}
        workspaceQuery={workspaceQuery}
        workspaceChoices={workspaceChoices}
        workspacePick={workspacePick}
        setWorkspaceQuery={setWorkspaceQuery}
        setWorkspaceIndex={setWorkspaceIndex}
        startChatIn={startChatIn}
        send={send}
        workspaceRoot={workspaceRoot}
        cwd={cwd}
        workspaceCreating={workspaceCreating}
        submitNewWorkspace={submitNewWorkspace}
        workspaceNameDraft={workspaceNameDraft}
        setWorkspaceNameDraft={setWorkspaceNameDraft}
        workspaceExact={workspaceExact}
      /> : null}
      {paletteShown ? <PaletteOverlay
        paletteOpen={paletteOpen}
        setPaletteOpen={setPaletteOpen}
        paletteTrap={paletteTrap}
        paletteQ={paletteQ}
        setPaletteQ={setPaletteQ}
        setPaletteIndex={setPaletteIndex}
        paletteHits={paletteHits}
        paletteHi={paletteHi}
        openFile={openFile}
      /> : null}
      <AssistantPanel
        open={assistantOpen}
        docked={wideIDE && sidePane === "assistant"}
        onClose={() => {
          clearInboxDeepLink();
          if (wideIDE && sidePane === "assistant") chooseSide("chats");
          else setAssistantOpen(false);
        }}
        name={assistantName}
        state={assistantState}
        send={send}
        initialInboxId={inboxDeepLink}
        basePath={process.env.NEXT_PUBLIC_BASE_PATH || ""}
        onOpenInboxItem={(item) => openAssistantInboxItem(item)}
        onOpenChat={openChatById}
      />
      {loopOpen ? <LoopOverlay
        wideIDE={wideIDE}
        sidePane={sidePane}
        setLoopOpen={setLoopOpen}
        loopTrap={loopTrap}
        loopGoal={loopGoal}
        loopInterval={loopInterval}
        loopMax={loopMax}
        setNotice={setNotice}
        send={send}
        activeId={activeId}
        model={model}
        mode={mode}
        setLoopGoal={setLoopGoal}
        setLoopInterval={setLoopInterval}
        setLoopMax={setLoopMax}
        loops={loops}
      /> : null}
      {terminalShown ? <TerminalOverlay
        terminalOpen={terminalOpen}
        wideIDE={wideIDE}
        sidePane={sidePane}
        setTerminalOpen={setTerminalOpen}
        terminalTrap={terminalTrap}
        shellEntries={shellEntries}
        terminalLogRef={terminalLogRef}
      /> : null}
      {grepShown ? <GrepOverlay
        grepOpen={grepOpen}
        wideIDE={wideIDE}
        sidePane={sidePane}
        setGrepOpen={setGrepOpen}
        grepTrap={grepTrap}
        grepQ={grepQ}
        setGrepQ={setGrepQ}
        setGrepIndex={setGrepIndex}
        grepNameHits={grepNameHits}
        grepHits={grepHits}
        grepHi={grepHi}
        openFile={openFile}
        wideIDERef={wideIDERef}
        grepWait={grepWait}
      /> : null}
      {filesShown ? <FilesOverlay
        filesOpen={filesOpen}
        filesDocked={filesDocked}
        closeFiles={closeFiles}
        filesTrap={filesTrap}
        sidePane={sidePane}
        wideIDE={wideIDE}
        cwd={cwd}
        workspaceRoot={workspaceRoot}
        assistantName={assistantName}
        filesQuery={filesQuery}
        setFilesQuery={setFilesQuery}
        gitStatus={gitStatus}
        previewPath={previewPath}
        openFile={openFile}
        treePaths={treePaths}
        treeTruncated={treeTruncated}
        handlePickFile={handlePickFile}
        setNotice={setNotice}
        downloadWorkspaceFile={downloadWorkspaceFile}
        handleTreeCreate={handleTreeCreate}
        handleTreeRename={handleTreeRename}
        handleTreeDelete={handleTreeDelete}
      /> : null}
      <button
        type="button"
        className="nav-scrim"
        aria-label="关闭对话列表"
        aria-hidden={!navOpen}
        tabIndex={navOpen ? 0 : -1}
        ref={(node) => {
          navDrag.scrimRef.current = node;
        }}
        onClick={() => setNavOpen(false)}
      />
      <Sidebar
        navDrag={navDrag}
        cwd={cwd}
        workspaceRoot={workspaceRoot}
        assistantName={assistantName}
        assistantChatId={assistantChatId}
        assistantActive={assistantActive}
        assistantChat={assistantChat}
        openAssistantChat={openAssistantChat}
        assistantBadge={assistantBadge}
        assistantPreview={assistantPreview}
        workspaceMenuOpen={workspaceMenuOpen}
        newChat={newChat}
        wideIDE={wideIDE}
        sidePane={sidePane}
        grepOpen={grepOpen}
        terminalOpen={terminalOpen}
        loopOpen={loopOpen}
        filesOpen={filesOpen}
        chooseSide={chooseSide}
        loopLive={loopLive}
        sidebarGroups={sidebarGroups}
        moreGroups={moreGroups}
        activeId={activeId}
        expandedGroups={expandedGroups}
        groupMenu={groupMenu}
        startChatIn={startChatIn}
        setExpandedGroups={setExpandedGroups}
        duplicateGroupNames={duplicateGroupNames}
        setGroupMenu={setGroupMenu}
        groupMenuNode={groupMenuNode}
        renameId={renameId}
        renameDraft={renameDraft}
        setRenameDraft={setRenameDraft}
        commitRename={commitRename}
        renameSkipRef={renameSkipRef}
        setRenameId={setRenameId}
        selectChat={selectChat}
        startRename={startRename}
        deleteChat={deleteChat}
        moreOpen={moreOpen}
        setMoreOpen={setMoreOpen}
        openNewChatMenu={openNewChatMenu}
        openFilesBrowser={openFilesBrowser}
        gitStatus={gitStatus}
        treePaths={treePaths}
        isAdmin={isAdmin}
        openAdminStats={openAdminStats}
        setSettingsOpen={setSettingsOpen}
        connected={connected}
        unlocked={unlocked}
        busy={busy}
        settingsOpen={settingsOpen}
        themeChoice={themeChoice}
        setThemeChoice={setThemeChoice}
        logout={logout}
      />

      <main className={`main${previewTabs.length ? " with-preview" : ""}${previewMax ? " preview-max" : ""}${previewTabs.some((tab) => isWideKind(tabKind(tab.path, tab.kind)) && sameFile(tab.path, previewPath)) ? " with-canvas" : ""}`}>
        <div className="main-col">
        <PadBar
          navOpen={navOpen}
          setNavOpen={setNavOpen}
          setPreviewMax={setPreviewMax}
          assistantActive={assistantActive}
          assistantName={assistantName}
          active={active}
          assistantOpen={assistantOpen}
          chooseSide={chooseSide}
          assistantBadge={assistantBadge}
          openFilesBrowser={openFilesBrowser}
          newChat={newChat}
        />
        {assistantActive ? (
          <AssistantChatHead
            assistantName={assistantName}
            wideIDE={wideIDE}
            sidePane={sidePane}
            chooseSide={chooseSide}
            assistantBadge={assistantBadge}
          />
        ) : null}
        {empty ? (
          <EmptyState
            error={error}
            notice={notice}
            openFilesBrowser={openFilesBrowser}
            applyDraft={applyDraft}
          />
        ) : (
            <Thread
              threadRef={threadRef}
              onThreadScroll={onThreadScroll}
              threadFindOpen={threadFindOpen}
              error={error}
              notice={notice}
              bodyPending={bodyPending}
              active={active}
              loadingOlder={loadingOlder}
              threadFindHits={threadFindHits}
              threadFindHi={threadFindHi}
              openFile={openFile}
              threadFindQ={threadFindQ}
              editTurn={editTurn}
              connected={connected}
              busy={busy}
              retryTurn={retryTurn}
              submit={submit}
              keepTool={keepTool}
              rejectTool={rejectTool}
              mdComponents={mdComponents}
              lastProgressRef={lastProgressRef}
              activeId={activeId}
              stopChat={stopChat}
              applyPlan={applyPlan}
              keepTurnFiles={keepTurnFiles}
              restoreTurnFiles={restoreTurnFiles}
              setThreadFindQ={setThreadFindQ}
              setThreadFindIndex={setThreadFindIndex}
              setThreadFindOpen={setThreadFindOpen}
            />
        )}
        </div>
        {previewTabs.length ? (
          <>
            <button
              type="button"
              className="preview-scrim"
              aria-label="收起预览"
              ref={(node) => {
                previewDrag.scrimRef.current = node;
              }}
              onClick={() => setPreviewMax(false)}
            />
            <FilePreview
            sheetRef={previewDrag.ref}
            tabs={previewTabs}
            activePath={previewPath}
            onSelect={setPreviewPath}
            onPinTab={(path) => setPreviewTabs((prev) => prev.map((tab) => sameFile(tab.path, path, cwdRef.current) ? { ...tab, pinned: true } : tab))}
            onCloseTab={closePreviewTab}
            onCloseAll={() => {
              const dirty = previewTabsRef.current.filter((tab) => previewDraftDirty(tab.path));
              if (dirty.length && !window.confirm(`关掉 ${dirty.length} 个未保存的标签？修改会丢掉。`)) return;
              setPreviewDrafts({});
              setPreviewTabs([]);
              setPreviewPath("");
              setPreviewMax(false);
            }}
            drafts={previewDrafts}
            onDraft={(path, value) => {
              setPreviewDrafts((prev) => {
                if (value == null) {
                  if (!(path in prev)) return prev;
                  const next = { ...prev };
                  delete next[path];
                  return next;
                }
                if (prev[path] === value) return prev;
                return { ...prev, [path]: value };
              });
            }}
            expanded={previewMax}
            onToggleExpand={() => setPreviewMax((open) => !open)}
            onCite={handlePickFile}
            onAskRange={handleAskRange}
            onToggleDiff={togglePreviewDiff}
            onRevert={revertFile}
            onKeep={keepFile}
            onRejectHunk={revertHunk}
            onSave={saveFile}
            chatId={activeId}
            onCanvasAction={handleCanvasAction}
            onOpenFile={openFile}
            onComposerInsert={(text) => applyDraft(text, text.length)}
            canvasVersions={canvasVersions[relToCwd(previewPath, cwd) || previewPath] || []}
            onCanvasVersions={(path) => send({ type: "canvas_versions", chatId: activeIdRef.current, path })}
            onCanvasSaveVersion={(path, sourceSha, html) => send({ type: "canvas_version_save", chatId: activeIdRef.current, path, sourceSha, html })}
            onCanvasPublish={(path, sha) => send({ type: "canvas_publish", chatId: activeIdRef.current, path, sha })}
            onCanvasRestore={(path, sha) => {
              if (window.confirm("恢复这个 Canvas 版本？当前文件会被覆盖。")) send({ type: "canvas_restore", chatId: activeIdRef.current, path, sha });
            }}
            canRevert={Boolean(
              gitLetterOf(previewPath, gitStatus, cwd) ||
                previewTabs.find((tab) => sameFile(tab.path, previewPath))?.diff,
            )}
            />
            <button
              type="button"
              className="preview-reopen"
              onClick={() => {
                setNavOpen(false);
                setPreviewMax(true);
              }}
            >
              {(previewTabs.find((tab) => sameFile(tab.path, previewPath)) || previewTabs[0]).path
                .split("/")
                .pop()}{" "}
              · 预览
            </button>
          </>
        ) : null}
            <ComposerDock
              jumpState={jumpState}
              empty={empty}
              scrollThreadToEnd={scrollThreadToEnd}
              assistantState={assistantState}
              activeId={activeId}
              answerDelegation={answerDelegation}
              openChatById={openChatById}
              active={active}
              resolveApproval={resolveApproval}
              busy={busy}
              sendQueued={sendQueued}
              dropQueued={dropQueued}
              draft={draft}
              composerEpoch={composerEpoch}
              images={images}
              uploading={uploading}
              notice={notice}
              error={error || (modelUsable ? "" : NO_MODEL_HINT)}
              model={model}
              models={models}
              persistModel={persistModel}
              mode={mode}
              persistMode={persistMode}
              persistConfirmWrites={persistConfirmWrites}
              policyRef={policyRef}
              persistPolicy={persistPolicy}
              connected={connected}
              submit={submit}
              stopChat={stopChat}
              send={send}
              checkpoints={checkpoints}
              addImages={addImages}
              handleComposerFiles={handleComposerFiles}
              removeImage={removeImage}
              fileHits={fileHits}
              mentionQuery={mentionQuery}
              handleDraftChange={handleDraftChange}
              handlePickFile={handlePickFile}
              openFile={openFile}
              removeDraftMention={removeDraftMention}
              dismissMention={dismissMention}
              draftCaret={draftCaret}
              setDraftCaret={setDraftCaret}
            />
      </main>
    </div>
  );
}

