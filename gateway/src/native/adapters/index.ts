import type { Adapter, AdapterKind } from "../types.ts";
import { openaiAdapter } from "./openai.ts";

export function adapterFor(kind: AdapterKind): Adapter {
  switch (kind) {
    case "openai":
      return openaiAdapter;
    default:
      throw new Error(`还不支持 ${kind} 协议的模型`);
  }
}
