import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PolicyId } from "../../../shared/protocol.ts";
import { gatewayEnv } from "../config.ts";
import type { Tenant } from "../tenants.ts";
import type { CollabExecutionProfile } from "./types.ts";

export type CollabSettings = CollabExecutionProfile & { timezone: string };

/** 临时连接不参与执行配置；Run 创建时从租户持久配置复制一份。 */
export function readCollabSettings(tenant: Tenant): CollabSettings {
  let raw: Partial<CollabSettings> = {};
  try {
    raw = JSON.parse(readFileSync(resolve(tenant.stateDir, "collab-settings.json"), "utf8"));
  } catch {
    // 没配置时使用服务端稳定默认值。
  }
  const policy: PolicyId = raw.policy === "baseline" ? "baseline" : "plane";
  const timezone = typeof raw.timezone === "string" && raw.timezone.length <= 64 ? raw.timezone : "UTC";
  return {
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : gatewayEnv.defaultModel(),
    mode: "agent",
    policy,
    dialect: raw.dialect !== false,
    timezone,
  };
}
