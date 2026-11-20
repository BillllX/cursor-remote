import { readFileSync } from "node:fs";
import { startProjectService, type ProjectServiceOptions } from "./service.ts";
const file = process.argv[2];
if (!file) throw new Error("用法：service-main.ts <私有配置文件>");
const service = await startProjectService(JSON.parse(readFileSync(file, "utf8")) as ProjectServiceOptions);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void service.close().then(() => process.exit(0));
  });
console.log("共享项目存储服务已就绪");
