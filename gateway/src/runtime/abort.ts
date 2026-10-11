// 取消/超时工具：识别中止错误、给 promise 加超时、安全取消 Cursor run
import { log } from "../log.ts";
import type { RunHandle } from "./types.ts";

export function isAbortError(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name || "";
  const message = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || /aborted/i.test(message);
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function cancelRun(run: RunHandle | null | undefined) {
  if (!run?.supports("cancel")) return;
  try {
    await withTimeout(run.cancel(), 5_000);
  } catch (err) {
    if (!isAbortError(err)) {
      // Cancel failures / hangs should not take down the gateway.
      log.warn("取消运行失败", err instanceof Error ? err.message : err);
    }
  }
}
