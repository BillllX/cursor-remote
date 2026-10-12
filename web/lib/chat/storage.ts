// 浏览器本地存储：键名、最近工作区、已删除会话

const CHATS_KEY = "cursor-remote-chats";

const DELETED_KEY = "cursor-remote-deleted";

export const TOKEN_KEY = "cursor-remote-token";

const RECENT_KEY = "cursor-remote-recent";

export const GROUPS_KEY = "cursor-remote-groups";

const ACTIVE_KEY = "cursor-remote-active";

export const MAX_DELETED = 200;

const MAX_RECENT = 8;

// 每次加载都会调；上次选中的会话（ACTIVE_KEY）要跨刷新留着，不在这里清，退出/换租户时用 forgetActiveChat
export function clearBrowserChatStore() {
  try {
    localStorage.removeItem(CHATS_KEY);
    localStorage.removeItem(DELETED_KEY);
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // private mode
  }
}

/** 上次用户选中的会话 id，刷新后据此回到原会话 */
export function readActiveChat(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) || "";
  } catch {
    return "";
  }
}

export function writeActiveChat(id: string) {
  if (!id) return;
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // 存不下就算了
  }
}

export function forgetActiveChat() {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // private mode
  }
}

export function pushRecent(prev: string[], path: string): string[] {
  if (!path.trim()) return prev;
  return [path, ...prev.filter((item) => item !== path)].slice(0, MAX_RECENT);
}

export function rememberDeleted(prev: Set<string>, id: string): Set<string> {
  return new Set([id, ...[...prev].filter((item) => item !== id)].slice(0, MAX_DELETED));
}
