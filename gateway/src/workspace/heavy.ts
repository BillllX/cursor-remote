// 重任务调度：同租户并发上限与排队、子进程的超时与取消、按连接的“新请求覆盖旧请求”。
// 文件清单、搜索、git diff 这类请求会起子进程或扫大量文件，原来是同步的，会卡住整个网关事件循环；
// 改成异步以后要有三道闸，否则一个租户（或一个反复输入的搜索框）可以同时拉起任意多个 git / rg 进程：
// 1. 并发上限：同一租户同时最多 HEAVY_MAX_RUNNING 个重任务，超出的排队，队列满了直接拒绝并给明确错误；
// 2. 超时：每个子进程自带超时，到点先 SIGTERM（让 git 自己清理 index.lock），宽限期后 SIGKILL；
// 3. 取消：连接断开或同一连接发来同类新请求时，中止旧请求并杀掉它的子进程。
import { spawn } from "node:child_process";
import { setPriority } from "node:os";

/** 同一租户同时运行的重任务数 */
export const HEAVY_MAX_RUNNING = 3;
/** 同一租户排队等待的重任务数；再多就拒绝 */
export const HEAVY_MAX_QUEUE = 16;

/** 排队已满，被拒绝。message 直接给用户看 */
export class HeavyBusyError extends Error {
  constructor(max: number) {
    super(`服务器正忙：同一账号同时最多处理 ${max} 个文件任务，排队也满了，请稍后再试`);
    this.name = "HeavyBusyError";
  }
}

/** 任务被取消（连接断开或被新请求覆盖） */
export class HeavyAbortError extends Error {
  constructor(message = "请求已取消") {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

type Waiter = { start: () => void; reject: (err: unknown) => void; signal?: AbortSignal; onAbort?: () => void };
type Lane = { running: number; waiting: Waiter[] };

/** 按 key（租户）分道的并发限制器：超出 max 的排队，队列满则拒绝 */
export class HeavyLimiter {
  max: number;
  maxQueue: number;
  private lanes = new Map<string, Lane>();

  constructor(max = HEAVY_MAX_RUNNING, maxQueue = HEAVY_MAX_QUEUE) {
    this.max = max;
    this.maxQueue = maxQueue;
  }

  /** 某个 key 当前的运行 / 排队数（测试和日志用） */
  stats(key: string) {
    const lane = this.lanes.get(key);
    return { running: lane?.running ?? 0, waiting: lane?.waiting.length ?? 0 };
  }

  async run<T>(key: string, task: (signal: AbortSignal | undefined) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new HeavyAbortError();
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { running: 0, waiting: [] };
      this.lanes.set(key, lane);
    }
    if (lane.running >= this.max) {
      if (lane.waiting.length >= this.maxQueue) throw new HeavyBusyError(this.max);
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { start: resolve, reject, signal };
        if (signal) {
          waiter.onAbort = () => {
            const at = lane!.waiting.indexOf(waiter);
            if (at >= 0) lane!.waiting.splice(at, 1);
            reject(new HeavyAbortError());
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        lane!.waiting.push(waiter);
      });
      // 被唤醒时名额已经由 release 转交给我们（running 没减），不用再 ++
    } else {
      lane.running += 1;
    }
    try {
      if (signal?.aborted) throw new HeavyAbortError();
      return await task(signal);
    } finally {
      this.release(key, lane);
    }
  }

  private release(key: string, lane: Lane) {
    const next = lane.waiting.shift();
    if (next) {
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      next.start();
      return;
    }
    lane.running -= 1;
    if (lane.running <= 0 && !lane.waiting.length && this.lanes.get(key) === lane) this.lanes.delete(key);
  }
}

/** 全网关共用的限制器（按租户分道） */
export const heavyLimiter = new HeavyLimiter();

// ---------- 子进程 ----------

export class ExecError extends Error {
  /** 退出码；被信号杀掉、超时、起不来时为 null */
  status: number | null;
  /** 已收到的 stdout（rg / git grep 退出码 1 表示没命中，也可能带部分输出） */
  stdout: string;
  code?: string;
  timedOut = false;
  constructor(message: string, status: number | null, stdout: string, code?: string) {
    super(message);
    this.name = "ExecError";
    this.status = status;
    this.stdout = stdout;
    this.code = code;
  }
}

export type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** stdout 上限（字节）；超过就杀进程并报 ENOBUFS，与 execFileSync 一致 */
  maxBuffer: number;
  signal?: AbortSignal;
  /** SIGTERM 之后等多久再 SIGKILL */
  killGraceMs?: number;
  /** 子进程的 nice 值，默认 10：机器核数少时 git / rg 跑满 CPU 也不会把网关主线程的流式输出挤得发抖；传 0 不调整 */
  niceness?: number;
};

/**
 * 异步 execFile：只收 stdout（utf8），stderr 丢弃，stdin 关闭。
 * 退出码 0 返回 stdout；非 0 抛 ExecError（带 status 与 stdout）；超时抛 ExecError(timedOut)；
 * 取消抛 AbortError。超时、取消、超出缓冲都会先 SIGTERM 再宽限后 SIGKILL，
 * 并且等子进程真的退出后才结算，调用方拿到结果时进程已经没了（并发名额才不会虚占）。
 */
export function execText(file: string, args: string[], opts: ExecOptions): Promise<string> {
  const { signal } = opts;
  if (signal?.aborted) return Promise.reject(new HeavyAbortError());
  const grace = opts.killGraceMs ?? 2000;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "ignore"] });
    const nice = opts.niceness ?? 10;
    if (nice && child.pid) {
      try {
        setPriority(child.pid, nice);
      } catch {
        // 进程已退出或系统不允许调整优先级：不影响结果
      }
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let exited = false;
    let pending: ExecError | HeavyAbortError | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let failSafe: NodeJS.Timeout | undefined;

    const text = () => Buffer.concat(chunks).toString("utf8");
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(failSafe);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const terminate = (why: ExecError | HeavyAbortError) => {
      if (pending || settled) return;
      pending = why;
      child.stdout?.destroy();
      if (!exited) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, grace);
        // 兜底：SIGKILL 之后仍收不到 close（极端情况），也不能让调用方一直等
        failSafe = setTimeout(() => finish(() => reject(why)), grace + 1500);
      } else {
        finish(() => reject(why));
      }
    };
    const onAbort = () => terminate(new HeavyAbortError());
    const timer = setTimeout(() => {
      const err = new ExecError(`spawnSync ${file} ETIMEDOUT`, null, text(), "ETIMEDOUT");
      err.timedOut = true;
      terminate(err);
    }, opts.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (pending) return;
      size += chunk.length;
      if (size > opts.maxBuffer) {
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - opts.maxBuffer))));
        terminate(new ExecError(`spawnSync ${file} ENOBUFS`, null, text(), "ENOBUFS"));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      exited = true;
      finish(() => reject(new ExecError(`spawnSync ${file} ${err.code || err.message}`, null, "", err.code)));
    });
    child.on("close", (code) => {
      exited = true;
      if (pending) {
        const why = pending;
        finish(() => reject(why));
        return;
      }
      if (code === 0) finish(() => resolve(text()));
      else finish(() => reject(new ExecError(`Command failed: ${file} ${args.join(" ")}`, code, text())));
    });
  });
}

// ---------- 按连接的“新请求覆盖旧请求” ----------

/** 够用就行的连接形状：ws 的 WebSocket 与测试里的假连接都满足 */
export type ConnLike = { once(event: "close", listener: () => void): unknown; readyState?: number };

const inflight = new WeakMap<object, Map<string, AbortController>>();
let requestSeq = 0;

/**
 * 登记一个按连接的请求。默认同一连接上同 key 的旧请求会被中止（新请求覆盖旧请求）；
 * supersede=false 时不覆盖任何请求，只拿连接断开的信号（pushWorkspace 这类按序执行的任务用）。
 * 连接关闭时该连接所有未完成的请求一并中止。返回的 end 在请求结束时调用。
 */
export function beginRequest(
  conn: ConnLike,
  key: string,
  opts: { supersede?: boolean } = {},
): { signal: AbortSignal; end: () => void } {
  let map = inflight.get(conn);
  if (!map) {
    const own = new Map<string, AbortController>();
    map = own;
    inflight.set(conn, own);
    conn.once("close", () => {
      for (const ctl of own.values()) ctl.abort();
      own.clear();
    });
  }
  const slot = opts.supersede === false ? `${key}#${++requestSeq}` : key;
  map.get(slot)?.abort();
  const ctl = new AbortController();
  // readyState 2/3 = CLOSING/CLOSED：连接已经断了，直接中止，不去占名额
  if (conn.readyState === 2 || conn.readyState === 3) ctl.abort();
  map.set(slot, ctl);
  const own = map;
  return {
    signal: ctl.signal,
    end: () => {
      if (own.get(slot) === ctl) own.delete(slot);
    },
  };
}
