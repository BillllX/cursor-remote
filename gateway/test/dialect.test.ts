import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { crewChinesePrompt, dialectOverlay, usesChineseDialect } from "../../shared/dialect.ts";
import { PUBLISH_BUILDER_ZH } from "../../shared/publishPrompt.ts";

describe("usesChineseDialect", () => {
  test("中文系厂商的模型名命中，大小写和首尾空白不影响", () => {
    for (const id of [
      "glm-4.6",
      "GLM-4.5-air",
      " kimi-k2 ",
      "moonshot-v1",
      "deepseek-v3.1",
      "qwen3-coder",
      "zhipu/x",
    ]) {
      assert.equal(usesChineseDialect(id), true, id);
    }
  });

  test("其它模型不命中", () => {
    for (const id of ["gpt-5", "claude-4.5-sonnet", "composer-1", "gemini-2.5-pro", "", "auto"]) {
      assert.equal(usesChineseDialect(id), false, id);
    }
  });

  test("按子串匹配：厂商名出现在路径中间也算", () => {
    assert.equal(usesChineseDialect("openrouter/qwen-max"), true);
    assert.equal(usesChineseDialect("openrouter/glm-4.6"), true);
  });
});

describe("dialectOverlay", () => {
  test("非中文系模型返回空串", () => {
    assert.equal(dialectOverlay("gpt-5"), "");
    assert.equal(dialectOverlay(""), "");
  });

  test("中文系模型带上通用约束：工具名、禁用 shell 改文件、相对路径", () => {
    const text = dialectOverlay("qwen3-coder");
    assert.ok(text.startsWith("用中文回答"));
    assert.ok(text.includes("没有 apply_patch"));
    assert.ok(text.includes("改代码走 edit"));
    assert.ok(text.endsWith("路径只用当前工作目录内的相对路径。"), "qwen 没有厂商附注，以通用句结尾");
  });

  test("各厂商附注只给对应模型", () => {
    assert.ok(dialectOverlay("deepseek-v3").endsWith("不要为了快整段覆盖文件，只改需要改的地方。"));
    assert.ok(dialectOverlay("kimi-k2").endsWith("不要把大段无关文件贴进回复。"));
    assert.ok(dialectOverlay("moonshot-v1").endsWith("不要把大段无关文件贴进回复。"));
    assert.ok(dialectOverlay("GLM-4.6").endsWith("按用户说的范围做，不要顺手重构邻文件。"));
    assert.ok(dialectOverlay("zhipu-glm").endsWith("按用户说的范围做，不要顺手重构邻文件。"));
  });

  test("带路由前缀的模型按去掉前缀后的名字拿厂商附注", () => {
    const glm = "按用户说的范围做，不要顺手重构邻文件。";
    assert.ok(dialectOverlay("openrouter/glm-4.6").endsWith(glm));
    assert.ok(dialectOverlay("z-ai/GLM-4.5").endsWith(glm));
    assert.ok(dialectOverlay("zai:glm-4.6").endsWith(glm));
    assert.ok(dialectOverlay("openrouter/deepseek-v3").endsWith("不要为了快整段覆盖文件，只改需要改的地方。"));
    assert.ok(dialectOverlay("openrouter/moonshotai/kimi-k2").endsWith("不要把大段无关文件贴进回复。"));
  });

  test("glm 只出现在名字中间不算 glm 附注", () => {
    assert.ok(!dialectOverlay("qwen-glm-distill").includes("不要顺手重构邻文件"));
  });
});

describe("crewChinesePrompt", () => {
  test("explore 是只读探路，前缀是 bound", () => {
    const text = crewChinesePrompt("explore", "【边界】", "");
    assert.ok(text.startsWith("【边界】你是只读探路"));
  });

  test("有 overlay 时拼在 bound 后面并补一个空格", () => {
    const text = crewChinesePrompt("reviewer", "B", "O");
    assert.ok(text.startsWith("BO 你交叉审查"));
  });

  test("builder 末尾带发布提示", () => {
    const text = crewChinesePrompt("builder", "", "");
    assert.ok(text.startsWith("你在当前工作目录落地改动"));
    assert.ok(text.endsWith(PUBLISH_BUILDER_ZH));
  });

  test("三种角色的提示各不相同", () => {
    const all = new Set((["explore", "builder", "reviewer"] as const).map((role) => crewChinesePrompt(role, "", "")));
    assert.equal(all.size, 3);
  });
});
