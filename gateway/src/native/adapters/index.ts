import type { Adapter, AdapterKind } from "../types.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { openaiAdapter } from "./openai.ts";
import { xmlAdapter } from "./xml.ts";

export function adapterFor(kind: AdapterKind): Adapter {
  switch (kind) {
    case "openai":
      return openaiAdapter;
    case "anthropic":
      return anthropicAdapter;
    case "xml":
      return xmlAdapter;
    default:
      throw new Error(`还不支持 ${kind} 协议的模型`);
  }
}
