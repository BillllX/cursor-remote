// 长会话渲染性能的测量开关：只给界面冒烟和人工排查用，默认关闭、零开销。
// 开启方式：地址带 ?perf=1，或 localStorage["cr-perf"]="1"（改完要刷新，开关在模块加载时读一次）。
// 开启后：window.__crPerf 里有回合行的渲染次数、主线程 longtask 统计，以及造数据 / 灌流式增量的入口。
import type { ServerMessage } from "@shared/protocol";

export const PERF_KEY = "cr-perf";

/** 模块加载时读一次；服务端渲染 / 没开时恒为 false，行渲染里只多一次布尔判断 */
export const PERF: boolean = (() => {
  if (typeof window === "undefined") return false;
  try {
    return (
      new URLSearchParams(window.location.search).get("perf") === "1" || window.localStorage.getItem(PERF_KEY) === "1"
    );
  } catch {
    return false;
  }
})();

export type PerfApi = {
  /** 回合行函数体被执行的次数（= 该行被重渲染的次数），按回合 id 记 */
  rows: Record<string, number>;
  /** 主线程长任务（>50ms）：次数、累计毫秒、最长一次 */
  longtasks: { n: number; total: number; max: number };
  /** React 提交次数不好取，这里记 Thread 本身渲染了多少次 */
  threadRenders: number;
  /** 清零计数器（不动已造的数据） */
  reset: () => void;
  /** 往当前会话末尾追加 count 个已结束回合 + 1 个运行中回合；返回两帧后量到的首次渲染耗时（毫秒） */
  seed: (count: number) => Promise<number>;
  /** 把合成的运行中回合重新置为运行中（被快照结算掉时用），已在跑则什么都不做 */
  arm: () => void;
  /** 把一条服务端消息按真实 ws 到达的路径灌进去（text-delta 会走和线上一样的按帧合并） */
  feed: (message: ServerMessage) => void;
};

type PerfWindow = typeof window & { __crPerf?: PerfApi };

/** 回合行每次渲染调一次；没开 PERF 时调用方不会进来 */
export function perfCountRow(id: string): void {
  const api = (window as PerfWindow).__crPerf;
  if (api) api.rows[id] = (api.rows[id] || 0) + 1;
}

export function perfCountThread(): void {
  const api = (window as PerfWindow).__crPerf;
  if (api) api.threadRenders += 1;
}

/** 挂上 window.__crPerf 并开始统计 longtask；返回卸载函数。只在 PERF 为真时调用 */
export function installPerfApi(actions: Pick<PerfApi, "seed" | "feed" | "arm">): () => void {
  const win = window as PerfWindow;
  const api: PerfApi = {
    rows: {},
    longtasks: { n: 0, total: 0, max: 0 },
    threadRenders: 0,
    reset() {
      api.rows = {};
      api.longtasks = { n: 0, total: 0, max: 0 };
      api.threadRenders = 0;
    },
    ...actions,
  };
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        api.longtasks.n += 1;
        api.longtasks.total += entry.duration;
        api.longtasks.max = Math.max(api.longtasks.max, entry.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    // 浏览器不支持 longtask 时只丢这一项统计
  }
  win.__crPerf = api;
  return () => {
    observer?.disconnect();
    if (win.__crPerf === api) delete win.__crPerf;
  };
}
