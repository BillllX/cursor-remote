import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, test } from "node:test";
import { runMaintenance, tidyMemoriesNow } from "../src/assistant/jobs.ts";
import {
  addWorkPreference,
  closeMatchingPlans,
  isValid,
  listMemory,
  personalWriteRoute,
  projectFactTarget,
  renderMemoryBlock,
  saveMemory,
  setCore,
  supplementMemory,
  tidyPersonalMemory,
  today,
  turnIndexIds,
  writeSettings,
} from "../src/assistant/memory.ts";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import { assistantPath, type TenantRef } from "../src/assistant/store.ts";
import { addTodo, setTodoDone } from "../src/assistant/todos.ts";
import { assistantTools } from "../src/assistant/tools.ts";
import { buildMovedRefIndex, planMemoryInjection, tidyWorkspaceMemories } from "../src/assistant/workspaceMemory.ts";

const root = mkdtempSync(resolve(tmpdir(), "cr-memory-tidy-"));
after(() => rmSync(root, { recursive: true, force: true }));
const ref = (id: string): TenantRef => ({ id, stateDir: resolve(root, id) });

describe("凌晨整理记忆", () => {
  test("过了日期的安排退出常驻索引，原文还在", () => {
    const tenant = ref("plan");
    const saved = saveMemory(
      tenant,
      { topic: "工作", text: "用户计划在 2026-10-06 练习网球", kind: "事件", basis: "user_said" },
      "page",
    );
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(isValid(saved.value, "2026-11-04"), true);
    assert.equal(renderMemoryBlock(tenant).includes("练习网球"), false);
    const kept = saveMemory(
      tenant,
      { topic: "生日", text: "用户生日是 10 月 21 日", kind: "事实", basis: "user_said" },
      "page",
    );
    assert.equal(kept.ok, true);
    assert.equal(renderMemoryBlock(tenant).includes("生日"), true);
  });

  test("复述性补充删掉，条目原文不动", () => {
    const tenant = ref("sup");
    const saved = saveMemory(tenant, { topic: "网球", text: "用户一周至少练两次网球", basis: "user_said" }, "page");
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const again = supplementMemory(tenant, saved.value.id, "用户一周至少练两次网球。", "integrator");
    assert.equal(again.ok, true);
    assert.deepEqual(listMemory(tenant).entries[0]?.supplements ?? [], []);
    const file = assistantPath(tenant, "memory", "entries.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.entries[0].supplements = ["比赛丢分最多的是网前", "比赛丢分最多的是网前。", "发球还不稳"];
    writeFileSync(file, JSON.stringify(data));
    const tidied = tidyPersonalMemory(tenant);
    assert.equal(tidied.supplements, 1);
    const entry = listMemory(tenant).entries[0];
    assert.equal(entry?.text, "用户一周至少练两次网球");
    assert.deepEqual(entry?.supplements, ["比赛丢分最多的是网前", "发球还不稳"]);
  });

  test("工作偏好折叠后相同的句子只留第一句", () => {
    const tenant = ref("pref");
    const written = setCore(tenant, { 工作偏好: "- 回答默认用中文\n- 回答默认用中文\n- 提交说明用中文" }, "page");
    assert.equal(written.ok, true);
    const tidied = tidyPersonalMemory(tenant);
    assert.equal(tidied.preferences, 1);
    const text = readFileSync(assistantPath(tenant, "memory", "core.json"), "utf8");
    assert.match(String(text), /回答默认用中文/);
    assert.equal(String(text).split("回答默认用中文").length - 1, 1);
  });

  test("文件夹记忆去掉第二遍，没写日期的行从今天起算", () => {
    const workspace = resolve(root, "ws");
    const project = resolve(workspace, "app");
    mkdirSync(resolve(project, ".jiebo"), { recursive: true });
    mkdirSync(resolve(project, "lib"), { recursive: true });
    mkdirSync(resolve(project, "dupA"), { recursive: true });
    mkdirSync(resolve(project, "dupB"), { recursive: true });
    writeFileSync(resolve(project, "lib", "Gate.swift"), "x");
    writeFileSync(resolve(project, "dupA", "Same.swift"), "x");
    writeFileSync(resolve(project, "dupB", "Same.swift"), "x");
    const outside = resolve(root, "outside-secret.swift");
    writeFileSync(outside, "x");
    symlinkSync(outside, resolve(project, "lib", "LinkSecret.swift"));
    // 符号链接目录指向外部含 .jiebo/memory.md 的目录时，collectMemoryDirs 绝不进入
    const extDir = resolve(root, "outside-ws");
    mkdirSync(resolve(extDir, ".jiebo"), { recursive: true });
    writeFileSync(resolve(extDir, ".jiebo", "memory.md"), "# 工作区记忆\n## 命令\n- 外部条目\n- 外部条目\n");
    symlinkSync(extDir, resolve(workspace, "linked-ws"));
    writeFileSync(
      resolve(project, ".jiebo", "memory.md"),
      [
        "# 工作区记忆",
        "## 命令",
        "- 运行 npm test",
        "- 运行 npm test",
        "- 看 Gate.swift <!-- refs=old/Gate.swift -->",
        "- 看重名文件 <!-- refs=old/Same.swift -->",
        "- 看链接文件 <!-- refs=old/LinkSecret.swift -->",
      ].join("\r\n"),
    );
    const stats = tidyWorkspaceMemories(workspace, "2026-11-04");
    assert.equal(stats.files, 1);
    assert.equal(stats.dropped, 1);
    assert.equal(stats.dated, 4);
    assert.equal(stats.refs, 1);
    // 外部目录的 memory.md 完全未被触碰
    assert.equal(
      readFileSync(resolve(extDir, ".jiebo", "memory.md"), "utf8"),
      "# 工作区记忆\n## 命令\n- 外部条目\n- 外部条目\n",
    );
    const text = readFileSync(resolve(project, ".jiebo", "memory.md"), "utf8");
    assert.equal(text.split("运行 npm test").length - 1, 1);
    assert.match(text, /at=2026-11-04/);
    assert.match(text, /refs=lib\/Gate\.swift/);
    // 同名文件多于一处或目标是符号链接时，不自动替换引用
    assert.match(text, /refs=old\/Same\.swift/);
    assert.match(text, /refs=old\/LinkSecret\.swift/);
    assert.match(text, /看 Gate\.swift/);
    // CRLF 文件整理后仍保持 CRLF 换行符，不产生混合 LF
    const lines = text.split("\n");
    for (let i = 0; i < lines.length - 1; i += 1) {
      assert.equal(lines[i]?.endsWith("\r"), true);
    }

    // 扫描达到上限截断时，不能将部分扫描结果误判为唯一新位置
    const cappedIndex = buildMovedRefIndex(project, 2);
    assert.equal(cappedIndex.truncated, true);
    const cappedWs = resolve(root, "ws-capped");
    const cappedProj = resolve(cappedWs, "app");
    mkdirSync(resolve(cappedProj, ".jiebo"), { recursive: true });
    mkdirSync(resolve(cappedProj, "a"), { recursive: true });
    mkdirSync(resolve(cappedProj, "b"), { recursive: true });
    writeFileSync(resolve(cappedProj, "a", "Target.swift"), "1");
    writeFileSync(resolve(cappedProj, "b", "Target.swift"), "2");
    writeFileSync(
      resolve(cappedProj, ".jiebo", "memory.md"),
      "# 工作区记忆\n## 命令\n- 看 Target.swift <!-- refs=old/Target.swift -->\n",
    );
    const cappedStats = tidyWorkspaceMemories(cappedWs, "2026-11-04", 2);
    assert.equal(cappedStats.refs, 0);
    assert.match(readFileSync(resolve(cappedProj, ".jiebo", "memory.md"), "utf8"), /refs=old\/Target\.swift/);
  });

  test("四点任务自己整理，不再调用模型", async () => {
    const tenant = ref("job");
    saveMemory(
      tenant,
      { topic: "工作", text: "用户计划在 2020-01-02 交报告", kind: "事件", basis: "user_said" },
      "page",
    );
    let runs = 0;
    const result = await runMaintenance(
      tenant,
      async () => {
        runs += 1;
        return { ok: true, runId: "x", text: "" };
      },
      Date.parse("2026-11-04T05:00:00+08:00"),
      "Asia/Shanghai",
    );
    assert.equal(result.ran, true);
    assert.equal(runs, 0);
    assert.equal(renderMemoryBlock(tenant).includes("交报告"), false);
    assert.equal(isValid(listMemory(tenant).entries[0]!, "2026-11-04"), true);
  });

  test("手动梳理不看钟点，也不占用当天的四点名额", async () => {
    const tenant = ref("manual");
    const workspace = resolve(root, "manual-ws");
    const project = resolve(workspace, "notes");
    mkdirSync(resolve(project, ".jiebo"), { recursive: true });
    writeFileSync(resolve(project, ".jiebo", "memory.md"), ["# 工作区记忆", "## 命令", "- 部署前先跑测试"].join("\n"));
    const report = tidyMemoriesNow(tenant, Date.parse("2026-11-04T01:00:00+08:00"), "Asia/Shanghai", workspace);
    assert.equal(report.dated, 1);
    assert.match(report.note, /补上日期 1 条/);
    assert.match(readFileSync(resolve(project, ".jiebo", "memory.md"), "utf8"), /at=2026-11-04/);
    let runs = 0;
    const nightly = await runMaintenance(
      tenant,
      async () => {
        runs += 1;
        return { ok: true, runId: "x", text: "" };
      },
      Date.parse("2026-11-04T05:00:00+08:00"),
      "Asia/Shanghai",
      undefined,
      workspace,
    );
    assert.equal(nightly.ran, true);
    assert.equal(runs, 0);
  });

  test("没有要改的就直接说已经整齐", () => {
    const report = tidyMemoriesNow(ref("plain"), Date.parse("2026-11-04T01:00:00+08:00"), "Asia/Shanghai");
    assert.equal(report.changed, false);
    assert.equal(report.note, "已经整齐，没有要改的。");
    // 北京时间凌晨 01:00（UTC 前一天 17:00），today() 仍按本地时区返回当天日期，避免跨日偏差
    assert.equal(today(Date.parse("2026-11-04T01:00:00+08:00"), "Asia/Shanghai"), "2026-11-04");
    const tzTenant = ref("tz-midnight");
    const expiring = saveMemory(
      tzTenant,
      { topic: "臨時", text: "优惠码只在十月底前有效", basis: "user_said", validUntil: "2026-11-03" },
      "page",
    );
    assert.equal(expiring.ok, true);
    const midnightReport = tidyMemoriesNow(tzTenant, Date.parse("2026-11-04T01:00:00+08:00"), "Asia/Shanghai");
    assert.equal(midnightReport.expired, 1);
  });

  test("被更新句盖住的旧句不在这一轮", () => {
    const tenant = ref("index");
    const older = saveMemory(tenant, { topic: "习惯", text: "希望默认用中文回答", basis: "user_said" }, "page");
    const newer = saveMemory(tenant, { topic: "习惯", text: "不希望默认用中文回答", basis: "user_said" }, "page");
    assert.equal(older.ok && newer.ok, true);
    if (!older.ok || !newer.ok) return;
    const ids = turnIndexIds(listMemory(tenant).entries);
    assert.equal(ids.has(newer.value.id), true);
    assert.equal(ids.has(older.value.id), false);
  });
});

describe("记忆自动归位", () => {
  test("还没到的安排改记待办，过去的经历仍是记忆", () => {
    assert.deepEqual(personalWriteRoute("用户计划在 2026-12-01 交报告", "事件", undefined, "2026-11-04"), {
      route: "todo",
      due: "2026-12-01",
    });
    assert.deepEqual(personalWriteRoute("用户计划在 2026-10-06 练习网球", "事件", undefined, "2026-11-04"), {
      route: "memory",
    });
    assert.deepEqual(personalWriteRoute("用户生日是 10 月 21 日", "事实", undefined, "2026-11-04"), {
      route: "memory",
    });
  });

  test("同一句话注入只留更新的那句，反义的两句都留", () => {
    const tenant = ref("newer");
    saveMemory(tenant, { topic: "语言", text: "用户希望所有面向自己的回复都使用中文", basis: "user_said" }, "page");
    saveMemory(
      tenant,
      { topic: "语言", text: "用户希望所有面向自己的回复都使用中文并且包括口头交流", basis: "user_said" },
      "page",
    );
    const block = renderMemoryBlock(tenant);
    const payload = JSON.parse(block.split("\n").find((line) => line.startsWith("{")) ?? "{}") as {
      entries: { text: string }[];
    };
    assert.equal(payload.entries.length, 1);
    assert.match(payload.entries[0].text, /口头交流/);
    saveMemory(tenant, { topic: "语言", text: "用户不希望所有面向自己的回复都使用中文", basis: "user_said" }, "page");
    const both = JSON.parse(
      renderMemoryBlock(tenant)
        .split("\n")
        .find((line) => line.startsWith("{")) ?? "{}",
    ) as {
      entries: { text: string }[];
    };
    assert.equal(both.entries.length, 2);
  });

  test("待办完成后，对得上的未来安排退出索引，原文还在", () => {
    const tenant = ref("done-plan");
    const saved = saveMemory(
      tenant,
      { topic: "工作", text: "用户计划在 2026-12-20 练习网球", kind: "事件", basis: "user_said" },
      "page",
    );
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(renderMemoryBlock(tenant).includes("练习网球"), true);
    const todo = addTodo(tenant, { text: "练习网球", due: "2026-12-20" });
    assert.equal(todo.ok, true);
    if (!todo.ok) return;
    assert.equal(setTodoDone(tenant, todo.value.id, true).ok, true);
    assert.equal(closeMatchingPlans(tenant, "练习网球") >= 0, true);
    assert.equal(renderMemoryBlock(tenant).includes("练习网球"), false);
    assert.equal(isValid(listMemory(tenant).entries[0]!, "2026-11-04"), true);
    assert.equal(listMemory(tenant).entries[0]?.text, "用户计划在 2026-12-20 练习网球");
    setTodoDone(tenant, todo.value.id, false);
    assert.equal(renderMemoryBlock(tenant).includes("2026-12-20"), true);
  });

  test("待办只关掉同一天的安排", () => {
    const tenant = ref("done-dates");
    saveMemory(
      tenant,
      { topic: "运动", text: "用户计划在 2026-12-20 练习网球", kind: "事件", basis: "user_said" },
      "page",
    );
    saveMemory(
      tenant,
      { topic: "运动", text: "用户计划在 2027-03-10 练习网球", kind: "事件", basis: "user_said" },
      "page",
    );
    const todo = addTodo(tenant, { text: "练习网球", due: "2026-12-20" });
    assert.equal(todo.ok, true);
    if (!todo.ok) return;
    assert.equal(setTodoDone(tenant, todo.value.id, true).ok, true);
    const block = renderMemoryBlock(tenant);
    assert.equal(block.includes("2026-12-20"), false);
    assert.equal(block.includes("2027-03-10"), true);
  });

  test("整句只差否定时，注入较新的那句，原文都还在", () => {
    const tenant = ref("contradict");
    saveMemory(tenant, { topic: "语言", text: "用户希望所有面向自己的回复都使用中文", basis: "user_said" }, "page");
    saveMemory(tenant, { topic: "语言", text: "用户不希望所有面向自己的回复都使用中文", basis: "user_said" }, "page");
    const payload = JSON.parse(
      renderMemoryBlock(tenant)
        .split("\n")
        .find((line) => line.startsWith("{")) ?? "{}",
    ) as {
      entries: { text: string }[];
    };
    assert.equal(payload.entries.length, 1);
    assert.match(payload.entries[0].text, /不希望/);
    assert.equal(listMemory(tenant).entries.length, 2);

    // 含「别人 / 特别 / 不错 / 没问题 / 不只是 / 别人动」等非否定词时，极性判断与矛盾消解仍准确
    const compoundCases = [
      ["用户特别喜欢听别人的真实反馈意见", "用户特别不喜欢听别人的真实反馈意见", /不喜欢/],
      ["用户认为错峰出行没问题而且体验很不错", "用户不认为错峰出行没问题而且体验很不错", /不认为/],
      ["用户不只是关注前端而且重视后端稳定性", "用户不只是关注前端而且不重视后端稳定性", /不重视/],
      ["用户允许别人动测试环境里的临时配置文件", "用户不允许别人动测试环境里的临时配置文件", /不允许/],
      ["不论证据来源如何都要求先保留现场日志", "不论证据来源如何都不要求先保留现场日志", /不要求/],
      ["每次发布后自动重启后台同步服务", "每次发布后不要自动重启后台同步服务", /不要自动重启/],
    ] as const;
    for (const [idx, [pos, neg, expected]] of compoundCases.entries()) {
      const compoundTenant = ref(`contradict-compound-${idx}`);
      saveMemory(compoundTenant, { topic: "沟通", text: pos, basis: "user_said" }, "page");
      saveMemory(compoundTenant, { topic: "沟通", text: neg, basis: "user_said" }, "page");
      const compoundPayload = JSON.parse(
        renderMemoryBlock(compoundTenant)
          .split("\n")
          .find((line) => line.startsWith("{")) ?? "{}",
      ) as { entries: { text: string }[] };
      assert.equal(compoundPayload.entries.length, 1);
      assert.match(compoundPayload.entries[0].text, expected);
    }

    // 「不同意 / 没准备 / 别处理 / 没收到 / 不管理 / 不妨碍 / 不论证」等前缀冲突否定词不被误吞掉
    const prefixNegCases = [
      ["用户同意在周三发布这个新版本方案", "用户不同意在周三发布这个新版本方案", /不同意/],
      ["用户准备在明天上午提交季度总结", "用户没准备在明天上午提交季度总结", /没准备/],
      ["用户要求处理掉旧分支的冲突文件", "用户要求别处理掉旧分支的冲突文件", /别处理/],
      ["用户收到来自上海站的告警通知", "用户没收到来自上海站的告警通知", /没收到/],
      ["用户管理这个海外业务团队的排期", "用户不管理这个海外业务团队的排期", /不管理/],
      ["这次改动妨碍移动端冷启动的速度", "这次改动不妨碍移动端冷启动的速度", /不妨碍/],
      ["用户在周报里论证这个技术选型的优劣", "用户在周报里不论证这个技术选型的优劣", /不论证/],
    ] as const;
    for (const [idx, [pos, neg, expected]] of prefixNegCases.entries()) {
      const prefixTenant = ref(`contradict-prefix-${idx}`);
      saveMemory(prefixTenant, { topic: "方案", text: pos, basis: "user_said" }, "page");
      saveMemory(prefixTenant, { topic: "方案", text: neg, basis: "user_said" }, "page");
      const prefixPayload = JSON.parse(
        renderMemoryBlock(prefixTenant)
          .split("\n")
          .find((line) => line.startsWith("{")) ?? "{}",
      ) as { entries: { text: string }[] };
      assert.equal(prefixPayload.entries.length, 1);
      assert.match(prefixPayload.entries[0].text, expected);
    }

    // 补充内容与原文极性相反时，supplementMemory 与 tidyPersonalMemory 都不会把它当成重复补充吞掉
    const supPolarityTenant = ref("sup-polarity");
    const baseSup = saveMemory(
      supPolarityTenant,
      { topic: "饮食", text: "用户在周末不喝冰美式咖啡", basis: "user_said" },
      "page",
    );
    assert.equal(baseSup.ok, true);
    if (baseSup.ok) {
      const added = supplementMemory(supPolarityTenant, baseSup.value.id, "在周末喝冰美式咖啡", "integrator");
      assert.equal(added.ok, true);
      assert.deepEqual(listMemory(supPolarityTenant).entries[0]?.supplements, ["在周末喝冰美式咖啡"]);
      const tidiedSup = tidyPersonalMemory(supPolarityTenant);
      assert.equal(tidiedSup.supplements, 0);
      assert.deepEqual(listMemory(supPolarityTenant).entries[0]?.supplements, ["在周末喝冰美式咖啡"]);
    }
  });

  test("项目命令对上唯一文件夹才归过去，对不上就不进个人记忆", async () => {
    assert.equal(
      projectFactTarget("在 cursorremote 里部署时先跑 deploy.sh", ["cursorremote", "tennis"]),
      "cursorremote",
    );
    assert.equal(projectFactTarget("先跑 deploy.sh", ["cursorremote", "tennis"]), "ambiguous");
    assert.equal(
      projectFactTarget("在 cursorremote 和 tennis 里都跑 deploy.sh", ["cursorremote", "tennis"]),
      "ambiguous",
    );
    assert.equal(
      projectFactTarget("所有项目包管理统一用 pnpm，不要用 yarn", ["cursorremote", "tennis"]),
      "work_preference",
    );
    assert.equal(projectFactTarget("所有项目默认用 TypeScript", ["cursorremote", "tennis"]), "work_preference");
    assert.equal(projectFactTarget("每个项目统一用英文写提交说明", ["cursorremote", "tennis"]), "work_preference");
    assert.equal(projectFactTarget("平时写脚本一律用 .sh", ["cursorremote", "tennis"]), "work_preference");
    assert.equal(projectFactTarget("用户的个人博客是 https://example.com/index.html", ["cursorremote"]), null);
    assert.equal(
      projectFactTarget("文档见 https://example.com/a.html，部署前在 cursorremote 跑 deploy.sh", [
        "cursorremote",
        "tennis",
      ]),
      "cursorremote",
    );
    assert.equal(
      projectFactTarget("文档见 https://example.com/a.html，部署前跑 deploy.sh", ["cursorremote", "tennis"]),
      "ambiguous",
    );
    assert.equal(
      projectFactTarget("参考 https://github.com/org/cursorremote/blob/main/README.md，部署前先跑 deploy.sh", [
        "cursorremote",
        "tennis",
      ]),
      "ambiguous",
    );
    assert.equal(projectFactTarget("用户喜欢用中文", ["cursorremote"]), null);
    assert.equal(projectFactTarget("我在 acme/web 组带三个人", ["web"]), null);
    assert.equal(projectFactTarget("我们准备 deploy 一个新版本", ["cursorremote"]), null);

    // 验证 memory_save 工具对跨项目习惯、个人网址、以及前台明确 ambiguous 命令的处理
    const toolTenant = ref("tool-route");
    const chatTools = assistantTools({
      ref: toolTenant,
      role: "chat",
      workspaces: () => ["cursorremote", "tennis"],
    });
    const runTool = async (t: SDKCustomTool, args: Record<string, SDKJsonValue>) => {
      const raw = await t.execute(args, { toolCallId: "inv" });
      return JSON.parse(String(raw));
    };
    const globalRes = (await runTool(chatTools.memory_save, {
      topic: "工具",
      text: "所有项目统一用 pnpm 安装依赖",
      basis: "user_said",
    })) as { ok: boolean; routed?: string; lines?: string[] };
    assert.equal(globalRes.ok, true);
    assert.equal(globalRes.routed, "work_preference");
    assert.equal(globalRes.lines?.includes("所有项目统一用 pnpm 安装依赖"), true);

    const globalTsRes = (await runTool(chatTools.memory_save, {
      topic: "语言",
      text: "所有项目默认用 TypeScript",
      basis: "user_said",
    })) as { ok: boolean; routed?: string; lines?: string[] };
    assert.equal(globalTsRes.ok, true);
    assert.equal(globalTsRes.routed, "work_preference");
    assert.equal(globalTsRes.lines?.includes("所有项目默认用 TypeScript"), true);

    const globalInferredRes = (await runTool(chatTools.memory_save, {
      topic: "语言",
      text: "所有项目默认用 Rust",
      basis: "inferred",
    })) as { ok: boolean; routed?: string };
    assert.equal(globalInferredRes.ok, true);
    assert.equal(globalInferredRes.routed, "skipped");

    const urlRes = (await runTool(chatTools.memory_save, {
      topic: "主页",
      text: "用户的博客地址是 https://example.com/post/a.html",
      basis: "user_said",
    })) as { ok: boolean; id?: string };
    assert.equal(urlRes.ok, true);
    assert.equal(typeof urlRes.id, "string");

    const ambigChatRes = (await runTool(chatTools.memory_save, {
      topic: "命令",
      text: "先跑 deploy.sh",
      basis: "user_said",
    })) as { ok: boolean; error?: string };
    assert.equal(ambigChatRes.ok, false);
    assert.match(ambigChatRes.error ?? "", /没有对上唯一的项目文件夹/);

    const failPlaceTools = assistantTools({
      ref: toolTenant,
      role: "chat",
      workspaces: () => ["cursorremote", "tennis"],
      placeProjectFact: () => ({ ok: false, error: "目录只读，无法写入" }),
    });
    const failPlaceChatRes = (await runTool(failPlaceTools.memory_save, {
      topic: "命令",
      text: "在 cursorremote 里先跑 deploy.sh",
      basis: "user_said",
    })) as { ok: boolean; error?: string };
    assert.equal(failPlaceChatRes.ok, false);
    assert.equal(failPlaceChatRes.error, "目录只读，无法写入");

    const integratorTools = assistantTools({
      ref: toolTenant,
      role: "integrator",
      workspaces: () => ["cursorremote", "tennis"],
      placeProjectFact: () => ({ ok: false, error: "目录只读，无法写入" }),
    });
    const ambigBgRes = (await runTool(integratorTools.memory_save, {
      topic: "命令",
      text: "先跑 deploy.sh",
      basis: "inferred",
    })) as { ok: boolean; routed?: string };
    assert.equal(ambigBgRes.ok, true);
    assert.equal(ambigBgRes.routed, "skipped");

    const failPlaceBgRes = (await runTool(integratorTools.memory_save, {
      topic: "命令",
      text: "在 cursorremote 里先跑 deploy.sh",
      basis: "user_said",
    })) as { ok: boolean; routed?: string };
    assert.equal(failPlaceBgRes.ok, true);
    assert.equal(failPlaceBgRes.routed, "skipped");

    const okBgPref = (await runTool(integratorTools.memory_save, {
      topic: "规范",
      text: "所有项目统一用中文写提交说明",
      basis: "user_said",
    })) as { ok: boolean; routed?: string; lines?: string[] };
    assert.equal(okBgPref.ok, true);
    assert.equal(okBgPref.routed, "work_preference");
    assert.equal(okBgPref.lines?.includes("所有项目统一用中文写提交说明"), true);

    writeSettings(toolTenant, { paused: true, allowSensitive: {} });
    const pausedBgPref = (await runTool(integratorTools.memory_save, {
      topic: "规范",
      text: "所有项目默认用 Go",
      basis: "user_said",
    })) as { ok: boolean; error?: string };
    assert.equal(pausedBgPref.ok, false);
    assert.match(pausedBgPref.error ?? "", /记忆已暂停/);

    const longerPref = ref("pref-longer");
    const shortPref = addWorkPreference(longerPref, "代码提交前一定要先跑完整测试套件", "page");
    const longPref = addWorkPreference(longerPref, "代码提交前一定要先跑完整测试套件和类型检查", "page");
    assert.equal(shortPref.ok, true);
    assert.equal(longPref.ok, true);
    if (longPref.ok) assert.equal(longPref.value.length, 2);
    assert.equal(tidyPersonalMemory(longerPref).preferences, 0);
    const kept = addWorkPreference(ref("pref-merge"), "回答默认用中文", "page");
    assert.equal(kept.ok, true);
    const again = addWorkPreference(ref("pref-merge"), "回答默认用中文。", "page");
    assert.equal(again.ok, true);
    if (kept.ok && again.ok) assert.equal(again.value.length, 1);
    const other = addWorkPreference(ref("pref-merge"), "提交说明用中文", "page");
    assert.equal(other.ok, true);
    if (other.ok) assert.equal(other.value.length, 2);
  });

  test("引用对不上的行不进这一轮，反义命令不合并，预算太满就把最少用的标冷", () => {
    const workspace = resolve(root, "ws-rules");
    const project = resolve(workspace, "proj");
    mkdirSync(resolve(project, ".jiebo"), { recursive: true });
    const line = (id: string, uses: number) => {
      const seed = id.charCodeAt(1) * 80;
      const body = Array.from({ length: 160 }, (_, index) =>
        String.fromCharCode(0x4e00 + ((seed + index * 3) % 180)),
      ).join("");
      return `- ${body} <!-- id=${id} at=2026-11-04 uses=${uses} -->`;
    };
    writeFileSync(
      resolve(project, ".jiebo", "memory.md"),
      [
        "# 工作区记忆",
        "## 命令",
        "- 重启 nginx <!-- id=a at=2026-11-04 -->",
        "- 不要重启 nginx <!-- id=b at=2026-11-04 -->",
        "- 入口在 src/main.ts <!-- id=gone refs=src/missing.ts -->",
        line("h1", 1),
        line("h2", 2),
        line("h3", 0),
        line("h4", 4),
        line("h5", 3),
      ].join("\n"),
    );
    const before = planMemoryInjection(project, 600, "", workspace);
    assert.equal(
      before?.selected.some((row) => row.line.id === "gone"),
      false,
    );
    assert.equal(
      before?.diagnostics.skippedReasons?.some((row) => row.reason === "missing_ref"),
      true,
    );
    const stats = tidyWorkspaceMemories(workspace, "2026-11-04");
    const text = readFileSync(resolve(project, ".jiebo", "memory.md"), "utf8");
    assert.match(text, /重启 nginx/);
    assert.match(text, /不要重启 nginx/);
    assert.equal(stats.dropped, 0);
    assert.match(text, /id=h3[^>]*state=cold|state=cold[^>]*id=h3/);
  });
});
