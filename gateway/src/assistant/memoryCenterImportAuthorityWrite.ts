import { durableAtomicWriteFileSync } from "../fsAtomic.ts";
import { journalHookMaybeFail } from "./memoryCenterImportHooks.ts";

/** 所有权威文件与 journal 阶段写统一入口（durable + 可注入失败）。 */
export function authorityDurableWrite(path: string, data: string | Buffer, mode = 0o600, opts?: { bypassTestHook?: boolean }) {
  if (!opts?.bypassTestHook) journalHookMaybeFail("file");
  durableAtomicWriteFileSync(path, data, { mkdir: true, mode });
}

export function authorityDurableWriteJson(path: string, data: unknown) {
  authorityDurableWrite(path, JSON.stringify(data, null, 1));
}
