import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  turnIndexIds,
} from "../src/assistant/memory.ts";
import { assistantPath, type TenantRef } from "../src/assistant/store.ts";
import { addTodo, setTodoDone } from "../src/assistant/todos.ts";
import { planMemoryInjection, tidyWorkspaceMemories } from "../src/assistant/workspaceMemory.ts";

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
    const kept = saveMemory(tenant, { topic: "生日", text: "用户生日是 10 月 21 日", kind: "事实", basis: "user_said" }, "page");
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
    writeFileSync(resolve(project, "lib", "Gate.swift"), "x");
    writeFileSync(
      resolve(project, ".jiebo", "memory.md"),
      [
        "# 工作区记忆",
        "## 命令",
        "- 运行 npm test",
        "- 运行 npm test",
        "- 看 Gate.swift <!-- refs=old/Gate.swift -->",
      ].join("\n"),
    );
    const stats = tidyWorkspaceMemories(workspace, "2026-11-04");
    assert.equal(stats.dropped, 1);
    assert.equal(stats.dated, 2);
    assert.equal(stats.refs, 1);
    const text = readFileSync(resolve(project, ".jiebo", "memory.md"), "utf8");
    assert.equal(text.split("运行 npm test").length - 1, 1);
    assert.match(text, /at=2026-11-04/);
    assert.match(text, /refs=lib\/Gate\.swift/);
    assert.match(text, /看 Gate\.swift/);
  });

  test("四点任务自己整理，不再调用模型", async () => {
    const tenant = ref("job");
    saveMemory(tenant, { topic: "工作", text: "用户计划在 2020-01-02 交报告", kind: "事件", basis: "user_said" }, "page");
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
    assert.deepEqual(personalWriteRoute("用户计划在 2026-10-06 练习网球", "事件", undefined, "2026-11-04"), { route: "memory" });
    assert.deepEqual(personalWriteRoute("用户生日是 10 月 21 日", "事实", undefined, "2026-11-04"), { route: "memory" });
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
    const payload = JSON.parse(block.split("\n").find((line) => line.startsWith("{")) ?? "{}") as { entries: { text: string }[] };
    assert.equal(payload.entries.length, 1);
    assert.match(payload.entries[0].text, /口头交流/);
    saveMemory(tenant, { topic: "语言", text: "用户不希望所有面向自己的回复都使用中文", basis: "user_said" }, "page");
    const both = JSON.parse(renderMemoryBlock(tenant).split("\n").find((line) => line.startsWith("{")) ?? "{}") as {
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
    saveMemory(tenant, { topic: "运动", text: "用户计划在 2026-12-20 练习网球", kind: "事件", basis: "user_said" }, "page");
    saveMemory(tenant, { topic: "运动", text: "用户计划在 2027-03-10 练习网球", kind: "事件", basis: "user_said" }, "page");
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
    const payload = JSON.parse(renderMemoryBlock(tenant).split("\n").find((line) => line.startsWith("{")) ?? "{}") as {
      entries: { text: string }[];
    };
    assert.equal(payload.entries.length, 1);
    assert.match(payload.entries[0].text, /不希望/);
    assert.equal(listMemory(tenant).entries.length, 2);
  });

  test("项目命令对上唯一文件夹才归过去，对不上就不进个人记忆", () => {
    assert.equal(projectFactTarget("在 cursorremote 里部署时先跑 deploy.sh", ["cursorremote", "tennis"]), "cursorremote");
    assert.equal(projectFactTarget("先跑 deploy.sh", ["cursorremote", "tennis"]), "ambiguous");
    assert.equal(projectFactTarget("用户喜欢用中文", ["cursorremote"]), null);
    assert.equal(projectFactTarget("我在 acme/web 组带三个人", ["web"]), null);
    assert.equal(projectFactTarget("我们准备 deploy 一个新版本", ["cursorremote"]), null);
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
      const body = Array.from({ length: 160 }, (_, index) => String.fromCharCode(0x4e00 + ((seed + index * 3) % 180))).join("");
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
    assert.equal(before?.selected.some((row) => row.line.id === "gone"), false);
    assert.equal(before?.diagnostics.skippedReasons?.some((row) => row.reason === "missing_ref"), true);
    const stats = tidyWorkspaceMemories(workspace, "2026-11-04");
    const text = readFileSync(resolve(project, ".jiebo", "memory.md"), "utf8");
    assert.match(text, /重启 nginx/);
    assert.match(text, /不要重启 nginx/);
    assert.equal(stats.dropped, 0);
    assert.match(text, /id=h3[^>]*state=cold|state=cold[^>]*id=h3/);
  });
});
