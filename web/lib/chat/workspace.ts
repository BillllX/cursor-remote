// 工作区与文件路径：路径比较/归一、工作区归属与标签、git 状态字母、下载工作区文件
import { DEFAULT_ASSISTANT_NAME } from "@shared/protocol";
import type { Chat } from "./types";

export function sameFile(a: string, b: string, cwd = "") {
  const n = (path: string) =>
    (relToCwd(path, cwd) || path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const left = n(a);
  const right = n(b);
  if (left === right) return true;
  if (left.startsWith("/") !== right.startsWith("/")) {
    const abs = left.startsWith("/") ? left : right;
    const rel = left.startsWith("/") ? right : left;
    return Boolean(rel) && abs.endsWith(`/${rel}`);
  }
  return false;
}

export function relToCwd(path: string, cwd = "") {
  let p = path.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && (p === root || p.startsWith(`${root}/`))) {
    return p === root ? "" : p.slice(root.length + 1);
  }
  return p;
}

export function normPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function sameCwd(a?: string, b?: string) {
  return normPath(a || "") === normPath(b || "");
}

export function inWorkspaceRoot(path: string, root: string) {
  const abs = normPath(path);
  const base = normPath(root);
  if (!abs || !base) return false;
  return abs === base || abs.startsWith(`${base}/`);
}

export function preferChatCwd(current?: string, incoming?: string) {
  if (!incoming) return current;
  if (!current) return incoming;
  if (sameCwd(current, incoming)) return current;
  if (inWorkspaceRoot(current, incoming)) return current;
  return incoming;
}

export function workspaceLabel(path: string, root: string, rootName = DEFAULT_ASSISTANT_NAME) {
  const abs = normPath(path);
  const base = normPath(root);
  if (!abs) return base ? rootName : "工作区";
  if (!base) return abs.split("/").filter(Boolean).pop() || abs;
  if (abs === base) return rootName;
  if (abs.startsWith(`${base}/`)) return abs.slice(base.length + 1);
  return abs.split("/").filter(Boolean).pop() || abs;
}

// react-markdown 以 children 和插件数组为依赖重新解析；插件和 components 引用稳定后，
// 已经写完的回答在父组件重渲染时直接跳过，只有正在流式输出的那一条重新解析。
/** 拉取工作区文件并交给浏览器保存；超限或失败时用 notify 说明原因 */
export async function saveWorkspaceFile(path: string, href: string, notify: (text: string) => void) {
  const name = path.split("/").pop() || "file";
  const saveAs = (url: string) => {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  try {
    const res = await fetch(href, { cache: "no-store" });
    if (!res.ok) {
      notify(
        res.status === 413
          ? `${name} 太大，网页端下载上限：普通文件 2MB、图片 20MB、PDF/音频 40MB、视频 80MB`
          : res.status === 404
            ? `${name} 已不在工作区`
            : `下载失败（${res.status}）`,
      );
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    saveAs(url);
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    notify(`已下载 ${name}`);
  } catch {
    // 跨域等原因读不到内容时退回直接打开链接
    saveAs(href);
  }
}

export function gitLetterOf(path: string, gitStatus: Record<string, string>, cwd = "") {
  const rel = relToCwd(path, cwd) || path;
  if (gitStatus[rel]) return gitStatus[rel];
  if (gitStatus[path]) return gitStatus[path];
  const hit = Object.entries(gitStatus).find(([item]) => sameFile(item, rel) || sameFile(item, path));
  return hit?.[1];
}

/** 侧栏“更多工作区”最多直接列几个，其余去“新对话”浮层里搜 */
export const MORE_GROUPS_SHOWN = 8;

export type WorkspaceItem = { path: string; name: string; user?: boolean };

/** 对话里出现过的工作区（按对话顺序去重，只算工作区根以内的） */
export function recentWorkspacesOf(
  chats: Chat[],
  workspaceRoot: string,
  workspaces: WorkspaceItem[],
  assistantName: string,
) {
  const seen = new Set<string>();
  const out: { path: string; name: string; user?: boolean }[] = [];
  for (const chat of chats) {
    const path = chat.cwd || workspaceRoot;
    if (!path) continue;
    const key = normPath(path);
    if (seen.has(key) || !inWorkspaceRoot(path, workspaceRoot || path)) continue;
    seen.add(key);
    const known = workspaces.find((item) => sameCwd(item.path, path));
    const user = Boolean(known?.user) || sameCwd(path, workspaceRoot);
    out.push({
      path,
      name: user ? assistantName : known?.name || workspaceLabel(path, workspaceRoot, assistantName),
      user,
    });
  }
  return out;
}

/** 侧栏的工作区分组：已知工作区 + 对话所在目录，各自带上对话与最近动过的时间 */
export function workspaceGroupsOf(
  workspaceRoot: string,
  cwd: string,
  workspaces: WorkspaceItem[],
  assistantName: string,
  sidebarChats: Chat[],
) {
  const root = workspaceRoot || cwd;
  const known = workspaces.length
    ? workspaces
    : root
      ? [{ path: root, name: workspaceLabel(root, root, assistantName) }]
      : [];
  const byPath = new Map(known.map((item) => [normPath(item.path), { ...item, chats: [] as Chat[] }]));
  for (const chat of sidebarChats) {
    const key = normPath(chat.cwd || root);
    const cur = byPath.get(key);
    if (cur) cur.chats.push(chat);
    else {
      const path = chat.cwd || root;
      const user = sameCwd(path, root);
      byPath.set(key, {
        path,
        name: user ? assistantName : workspaceLabel(path, root, assistantName),
        user,
        chats: [chat],
      });
    }
  }
  const groups = [...byPath.values()].map((group) => {
    const user = Boolean(group.user) || sameCwd(group.path, root);
    const touched = group.chats.reduce((max, chat) => Math.max(max, chat.touchedAt || 0), 0);
    return { ...group, user, touched, name: user ? assistantName : group.name };
  });
  // USER 根目录只承载助理会话，由侧栏置顶入口代替，不进工作区分组
  return (
    groups
      .filter((group) => !group.user && (!root || !sameCwd(group.path, root)))
      // 最近动过的工作区排前面；没有时间的保持原来的顺序（sort 是稳定的）
      .sort((a, b) => b.touched - a.touched)
  );
}

export type WorkspaceGroup = ReturnType<typeof workspaceGroupsOf>[number];

/** 出现不止一次的分组名（重名的要带路径才分得清） */
export function duplicateNamesOf(workspaceGroups: WorkspaceGroup[]) {
  const counts = new Map<string, number>();
  for (const group of workspaceGroups) counts.set(group.name, (counts.get(group.name) || 0) + 1);
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
}

/** 按 workspaceQuery 过滤、排序后的新对话候选，带 recent / chats / touched / dup */
export function workspaceChoicesOf(
  workspaceQuery: string,
  recentWorkspaces: WorkspaceItem[],
  workspaceGroups: WorkspaceGroup[],
  otherMenuWorkspaces: WorkspaceItem[],
) {
  const q = workspaceQuery.trim().toLowerCase();
  const recent = new Set(recentWorkspaces.map((item) => normPath(item.path)));
  const counts = new Map(workspaceGroups.map((group) => [normPath(group.path), group.chats.length]));
  const touchedBy = new Map(workspaceGroups.map((group) => [normPath(group.path), group.touched]));
  const names = new Map<string, number>();
  for (const item of otherMenuWorkspaces) names.set(item.name, (names.get(item.name) || 0) + 1);
  return otherMenuWorkspaces
    .filter((item) => !q || item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q))
    .map((item) => ({
      ...item,
      recent: recent.has(normPath(item.path)),
      chats: counts.get(normPath(item.path)) || 0,
      touched: touchedBy.get(normPath(item.path)) || 0,
      // 重名的工作区必须带路径才分得清
      dup: (names.get(item.name) || 0) > 1,
    }))
    .sort((a, b) => Number(b.recent) - Number(a.recent) || b.touched - a.touched);
}
