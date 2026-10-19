export type TurnBodyRequest = { key: string; controller: AbortController };

export function startTurnBodyRequest(
  current: TurnBodyRequest | null,
  key: string,
): { request: TurnBodyRequest; started: boolean; canceledKey?: string } {
  if (current?.key === key) return { request: current, started: false };
  current?.controller.abort();
  return {
    request: { key, controller: new AbortController() },
    started: true,
    canceledKey: current?.key,
  };
}

export function cancelTurnBodyRequest(current: TurnBodyRequest | null): string | undefined {
  if (!current) return undefined;
  current.controller.abort();
  return current.key;
}
