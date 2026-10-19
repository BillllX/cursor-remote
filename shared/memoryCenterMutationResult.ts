import type { MemoryCenterMutateData, MemoryCenterMutateFailureData } from "./protocol.ts";
import {
  validateMemoryCenterMutateFailureData,
  validateMemoryCenterMutateSuccessData,
} from "./memoryCenterMutateResultValidate.ts";

export type MemoryCenterMutateResultParsed =
  | { ok: true; data: MemoryCenterMutateData }
  | { ok: false; error: string; data: MemoryCenterMutateFailureData };

/** 收窄 memory_center_mutate 的 assistant_result，避免客户端盲 cast。 */
export function parseMemoryCenterMutationResult(message: {
  op: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}): MemoryCenterMutateResultParsed | null {
  if (message.op !== "memory_center_mutate") return null;
  if (message.ok) {
    if (!validateMemoryCenterMutateSuccessData(message.data)) return null;
    return { ok: true, data: message.data };
  }
  const err = typeof message.error === "string" ? message.error : "请求失败";
  if (!validateMemoryCenterMutateFailureData(message.data)) return null;
  return { ok: false, error: err, data: message.data };
}
