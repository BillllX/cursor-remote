// 侧栏工作区分组与新对话浮层候选：全是由对话列表和工作区目录派生出来的
import { useMemo } from "react";
import type { Chat } from "../types";
import {
  currentWorkspaceGroupsOf,
  duplicateNamesOf,
  normPath,
  recentWorkspacesOf,
  sameCwd,
  workspaceChoicesOf,
  workspaceGroupsOf,
  type WorkspaceItem,
} from "../workspace";

export function useWorkspaceGroups({
  chats,
  workspaceRoot,
  workspaces,
  assistantName,
  sidebarChats,
  cwd,
  workspaceQuery,
}: {
  chats: Chat[];
  workspaceRoot: string;
  workspaces: WorkspaceItem[];
  assistantName: string;
  sidebarChats: Chat[];
  cwd: string;
  workspaceQuery: string;
}) {
  const recentWorkspaces = useMemo(() => {
    return recentWorkspacesOf(chats, workspaceRoot, workspaces, assistantName);
  }, [assistantName, chats, workspaceRoot, workspaces]);

  const catalogWorkspaces = useMemo(() => {
    const recent = new Set(recentWorkspaces.map((item) => normPath(item.path)));
    return workspaces.filter((item) => !recent.has(normPath(item.path)));
  }, [workspaces, recentWorkspaces]);

  const workspaceGroups = useMemo(() => {
    return workspaceGroupsOf(workspaceRoot, cwd, workspaces, assistantName, sidebarChats);
  }, [assistantName, sidebarChats, workspaces, workspaceRoot, cwd]);

  const duplicateGroupNames = useMemo(() => {
    return duplicateNamesOf(workspaceGroups);
  }, [workspaceGroups]);

  const menuWorkspaces = useMemo(
    () => [...recentWorkspaces, ...catalogWorkspaces],
    [recentWorkspaces, catalogWorkspaces],
  );
  // 新对话只能开在子工作区；USER 根目录留给助理会话
  const otherMenuWorkspaces = useMemo(
    () => menuWorkspaces.filter((item) => !item.user && !(workspaceRoot && sameCwd(item.path, workspaceRoot))),
    [menuWorkspaces, workspaceRoot],
  );

  // 侧栏只属于当前工作区；其它工作区统一从顶部切换器进入。
  const sidebarGroups = useMemo(
    () => currentWorkspaceGroupsOf(workspaceGroups, cwd),
    [workspaceGroups, cwd],
  );
  const moreGroups = useMemo(() => [], []);

  // 新对话浮层的候选：最近用过的排前面，按名字或路径过滤，附带每个工作区已有几个对话
  const workspaceChoices = useMemo(() => {
    return workspaceChoicesOf(workspaceQuery, recentWorkspaces, workspaceGroups, otherMenuWorkspaces);
  }, [workspaceQuery, recentWorkspaces, workspaceGroups, otherMenuWorkspaces]);

  return { duplicateGroupNames, otherMenuWorkspaces, sidebarGroups, moreGroups, workspaceChoices };
}
