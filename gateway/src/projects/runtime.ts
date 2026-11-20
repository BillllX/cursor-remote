import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectError, type ProjectRequest } from "../../../shared/projectTypes.ts";
import { sandboxEnabledForTenant, stateDir, type Tenant } from "../tenants.ts";
import { ProjectStoreClient, type ProjectClientSettings } from "./ipc.ts";
let cached: { key: string; client: ProjectStoreClient } | undefined;
export function projectTenantEligible(tenant: Tenant) {
  return Boolean(
    tenant.projectSharingEnabled &&
    tenant.projectSharingDomain &&
    tenant.projectSandboxVerified &&
    sandboxEnabledForTenant(tenant),
  );
}
export function projectClient(tenant: Tenant) {
  if (!projectTenantEligible(tenant)) throw new ProjectError("NOT_ACCESSIBLE", "共享项目未开通");
  const file = join(stateDir(), "projects-client.json");
  if (!existsSync(file)) throw new ProjectError("PROJECT_UNAVAILABLE", "共享项目存储服务尚未安装");
  const raw = readFileSync(file, "utf8");
  if (cached?.key === raw) return cached.client;
  const settings = JSON.parse(raw) as ProjectClientSettings;
  if (typeof settings.socketPath !== "string" || typeof settings.keyFile !== "string")
    throw new ProjectError("PROJECT_UNAVAILABLE");
  const client = new ProjectStoreClient(settings);
  cached = { key: raw, client };
  return client;
}
export function projectRequest(tenant: Tenant, request: ProjectRequest) {
  return projectClient(tenant).call(tenant.id, "request", { request });
}
