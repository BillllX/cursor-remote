// 工作区与文件路径：路径比较/归一、工作区归属与标签、git 状态字母、下载工作区文件
import { DEFAULT_ASSISTANT_NAME } from "@shared/protocol";

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
