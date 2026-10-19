/** 搜索 debounce 纯控制器（hook 与单测共用）。 */

export type SearchDebounceParams = {
  query: string;
  scope: string;
  kind: string;
  state: string;
};

export function searchDebounceKey(p: SearchDebounceParams): string {
  return `${p.query.trim()}\t${p.scope}\t${p.kind}\t${p.state}`;
}

export function searchDebounceShouldRun(active: boolean, query: string): boolean {
  return active && query.trim().length > 0;
}

export type Clock = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

export function createSearchDebouncer(onFire: (key: string) => void, delayMs: number, clock: Clock) {
  let timer: unknown = null;
  let armedKey: string | null = null;
  /** flush 后仅抑制与本次 flush 相同 key 的下一次 schedule（一次），不同 key 清抑制并正常 debounce。 */
  let suppressKey: string | null = null;

  /** 放弃当前搜索周期：timer、待 fire 的 key、flush 抑制一并清除。 */
  function cancel() {
    if (timer != null) clock.clearTimeout(timer);
    timer = null;
    armedKey = null;
    suppressKey = null;
  }

  function schedule(key: string) {
    if (suppressKey != null) {
      if (suppressKey === key) {
        suppressKey = null;
        return;
      }
      suppressKey = null;
    }
    if (timer != null) clock.clearTimeout(timer);
    armedKey = key;
    timer = clock.setTimeout(() => {
      timer = null;
      const fireKey = armedKey;
      armedKey = null;
      if (fireKey) onFire(fireKey);
    }, delayMs);
  }

  function flush(key: string) {
    cancel();
    suppressKey = key;
    onFire(key);
  }

  return {
    schedule,
    flush,
    cancel,
    get armedKey() {
      return armedKey;
    },
    get hasTimer() {
      return timer != null;
    },
  };
}
