// Cursor 模型列表（10 分钟缓存，失败回落默认模型）
import { Cursor } from "@cursor/sdk";
import { defaultModel } from "../runtime/env.ts";

let modelsCache: { at: number; ids: string[] } | null = null;

/** 不发请求：有缓存（不论是否过期）用缓存，否则默认模型 */
export function cachedModels(): string[] {
  return modelsCache?.ids?.length ? modelsCache.ids : [defaultModel()];
}

export async function listModels(apiKey: string): Promise<string[]> {
  if (modelsCache && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.ids;
  try {
    const listed = await Promise.race([
      Cursor.models.list({ apiKey }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("models timeout")), 4000);
      }),
    ]);
    const ids = listed.map((item) => item.id).filter(Boolean);
    const next = ids.length ? ids : [defaultModel()];
    modelsCache = { at: Date.now(), ids: next };
    return next;
  } catch {
    return modelsCache?.ids || [defaultModel()];
  }
}
