// 作为网关 OS 用户运行，验证配置、签名及实际 Unix socket 连接。
import { readFileSync } from "node:fs";
import { ProjectStoreClient, type ProjectClientSettings } from "../gateway/src/projects/ipc.ts";

const [config, account] = process.argv.slice(2);
if (!config || !account) throw new Error("用法：project-service-check.mts <网关配置文件> <试点站内账号 ID>");
const client = new ProjectStoreClient(JSON.parse(readFileSync(config, "utf8")) as ProjectClientSettings);
const health = await client.call<{ ok: boolean; schema: number }>(account, "health");
if (!health.ok || health.schema !== 1) throw new Error("共享项目健康检查失败");
console.log("共享项目签名、账号准入及数据库版本检查通过");
