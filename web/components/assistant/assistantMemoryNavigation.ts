export type AssistantMemorySource = "assistant" | "workspace";

export type AssistantMemoryNavigation = {
  source: AssistantMemorySource;
  target: string;
  request: number;
};

export function initialAssistantMemoryNavigation(): AssistantMemoryNavigation {
  return { source: "assistant", target: "personal", request: 0 };
}

/** 每次打开助理面板都固定本轮记忆入口的来源和目标。 */
export function openAssistantMemoryNavigation(
  current: AssistantMemoryNavigation,
  source: AssistantMemorySource,
  workspaceScopeId?: string,
): AssistantMemoryNavigation {
  return {
    source,
    target: source === "workspace" && workspaceScopeId ? workspaceScopeId : "personal",
    request: current.request + 1,
  };
}

/** 重点同一个记忆入口也递增 request，要求记忆中心重新定位。 */
export function revisitAssistantMemoryNavigation(
  current: AssistantMemoryNavigation,
): AssistantMemoryNavigation {
  return { ...current, request: current.request + 1 };
}

export function assistantMemoryEntryText(navigation: AssistantMemoryNavigation) {
  return navigation.source === "workspace"
    ? { label: "记忆工作台", ariaLabel: "打开当前工作区的记忆工作台" }
    : { label: "个人记忆", ariaLabel: "打开个人记忆" };
}
