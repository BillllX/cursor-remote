// 只调用生产安装的技能核验/列表/正文加载函数，不执行手册中的任何动作。
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
const [installation, stateDir, workspaceRoot, output] = process.argv.slice(2);
if (!installation || !stateDir || !workspaceRoot || !output) throw new Error("需要生产安装目录、租户状态目录、工作区根目录及证据输出路径");
const { verifySkill, listSkills, useSkill } = await import(pathToFileURL(resolve(installation, "gateway/src/assistant/skills.ts")).href);
const tenant = { id: "default", stateDir, workspaceRoot };
const results = [];
for (const [name, id] of [["AI探索工作区", "pptx-executive-deck"], ["[workSpace]cursorremote", "cursorremote-git-ops"], ["[workSpace]cursorremote", "ios-client-architecture"], ["智能家居工作区", "ecovacs-safe-control"]]) {
  const cwd = resolve(workspaceRoot, name!);
  const verify = verifySkill(tenant, cwd, id);
  const list = listSkills(tenant, cwd).filter((row: { id: string }) => row.id === id).map(({ body, ...row }: { body: string }) => row);
  const pages = []; let cursor: string | undefined;
  do {
    const page = useSkill(tenant, cwd, id, { cursor }); pages.push(page);
    if (!page.ok) throw new Error(`正文加载失败：${id} ${page.error}`);
    cursor = page.truncated ? page.nextCursor : undefined;
    if (page.truncated && !cursor) throw new Error("分页缺少游标");
    if (pages.length > 100) throw new Error("分页异常");
  } while (cursor);
  results.push({ id, cwd, verify, list, pages });
  console.log(JSON.stringify({ id, health: verify.health, pages: pages.length, complete: true }));
  if (!verify.ok) throw new Error(`核验失败：${id}`);
}
writeFileSync(output, JSON.stringify({ evidenceType: "生产安装代码在独立进程按所属工作区调用；不是运行中网关 MCP 传输证据", installation, timestamp: new Date().toISOString(), results }, null, 2) + "\n");
