// 浏览器本地存储：键名、最近工作区、已删除会话

const CHATS_KEY = "cursor-remote-chats";

const DELETED_KEY = "cursor-remote-deleted";

export const TOKEN_KEY = "cursor-remote-token";

const RECENT_KEY = "cursor-remote-recent";

export const GROUPS_KEY = "cursor-remote-groups";

export const MAX_DELETED = 200;

const MAX_RECENT = 8;

export function clearBrowserChatStore() {
  try {
    localStorage.removeItem(CHATS_KEY);
    localStorage.removeItem(DELETED_KEY);
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // private mode
  }
}

export function pushRecent(prev: string[], path: string): string[] {
  if (!path.trim()) return prev;
  return [path, ...prev.filter((item) => item !== path)].slice(0, MAX_RECENT);
}

export function rememberDeleted(prev: Set<string>, id: string): Set<string> {
  return new Set([id, ...prev].slice(0, MAX_DELETED));
}
