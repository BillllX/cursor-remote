export type CollabRoute = {
  active: boolean;
  convId?: string;
  runId?: string;
  taskId?: string;
  file?: string;
};

export function readCollabRoute(search: string): CollabRoute {
  const params = new URLSearchParams(search);
  return {
    active: params.get("domain") === "collab",
    convId: params.get("conv") || undefined,
    runId: params.get("run") || undefined,
    taskId: params.get("task") || undefined,
    file: params.get("file") || undefined,
  };
}

export function writeCollabRoute(
  href: string,
  route: Pick<CollabRoute, "active" | "convId" | "runId" | "taskId" | "file">,
) {
  const url = new URL(href);
  const values: Array<[string, string | undefined]> = [
    ["domain", route.active ? "collab" : undefined],
    ["conv", route.active ? route.convId : undefined],
    ["run", route.active ? route.runId : undefined],
    ["task", route.active ? route.taskId : undefined],
    ["file", route.active ? route.file : undefined],
  ];
  for (const [key, value] of values) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  return url.toString();
}

export function replaceCollabRoute(route: CollabRoute) {
  if (typeof window === "undefined") return;
  const next = writeCollabRoute(window.location.href, route);
  if (next !== window.location.href) window.history.replaceState(window.history.state, "", next);
}

export function pushCollabRoute(route: CollabRoute) {
  if (typeof window === "undefined") return;
  const next = writeCollabRoute(window.location.href, route);
  if (next !== window.location.href) window.history.pushState(window.history.state, "", next);
}
