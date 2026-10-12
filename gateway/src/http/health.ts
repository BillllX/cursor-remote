// /health 的内容
import { accessSync, constants, mkdirSync } from "node:fs";
import { gatewayEnv } from "../config.ts";
import { gatewayHost } from "../runtime/env.ts";
import { allTenants, hasAuth } from "../tenants.ts";

function cwdWritable(dir: string) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function healthPayload() {
  const tenants = allTenants();
  const cwdOk = tenants.length ? tenants.every((item) => cwdWritable(item.workspaceRoot)) : false;
  const stateOk = tenants.length ? tenants.every((item) => cwdWritable(item.stateDir)) : false;
  const ready = Boolean(hasAuth() && gatewayEnv.cursorApiKey() && cwdOk && stateOk);
  return {
    ok: ready,
    tenants: tenants.map((item) => item.id),
    cwdWritable: cwdOk,
    stateWritable: stateOk,
    hasApiKey: Boolean(gatewayEnv.cursorApiKey()),
    hasAuth: hasAuth(),
    host: gatewayHost(),
  };
}
