import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import {
  checkRepo,
  declaredEnvNames,
  envViolations,
  exampleEnvNames,
  scanEnvReads,
  type EnvFinding,
} from "../../scripts/check-env.mts";

const SRC = "/virtual/gateway/src";

function scan(text: string, rel = "sample.ts"): EnvFinding[] {
  return scanEnvReads([{ fileName: resolve(SRC, rel), text }]);
}

function names(text: string) {
  return scan(text).map((item) => item.name);
}

describe("scanEnvReads 报出的写法", () => {
  test("属性访问、可选链、字符串字面量键", () => {
    assert.deepEqual(
      names(
        [
          "process.env.DOT;",
          "process.env?.OPT;",
          'process.env["BRACKET"];',
          "process?.env?.[`TPL`];",
          "(process.env as NodeJS.ProcessEnv).CAST;",
          "globalThis.process.env.GLOBAL;",
        ].join("\n"),
      ),
      ["DOT", "OPT", "BRACKET", "TPL", "CAST", "GLOBAL"],
    );
  });

  test("解构（含改名、...rest 再读）和解构赋值", () => {
    assert.deepEqual(
      names(
        [
          "const { A, b: B, ...rest } = process.env;",
          "rest.FROM_REST;",
          "let x;",
          "({ ASSIGNED: x } = process.env);",
        ].join("\n"),
      ),
      ["A", "b", "FROM_REST", "ASSIGNED"],
    );
  });

  test("const / let 别名、别名的别名、参数默认值、传给本文件函数", () => {
    assert.deepEqual(
      names(
        [
          "const env = process.env;",
          "env.CONST_ALIAS;",
          "let later;",
          "later = process.env;",
          "later?.LET_ALIAS;",
          "const again = env;",
          'again["ALIAS2"];',
          "function f(src = process.env) { return src.DEFAULT_PARAM; }",
          "function g(src) { return src.PASSED; }",
          "g(process.env);",
          "const h = ({ DESTRUCT_PARAM }) => DESTRUCT_PARAM;",
          "h(process.env);",
        ].join("\n"),
      ),
      ["CONST_ALIAS", "LET_ALIAS", "ALIAS2", "DEFAULT_PARAM", "PASSED", "DESTRUCT_PARAM"],
    );
  });

  test("in 判断和动态键", () => {
    const found = scan(['"IN_CHECK" in process.env;', "const k = 'x';", "process.env[k];"].join("\n"));
    assert.deepEqual(
      found.map((item) => [item.kind, item.name, item.line]),
      [
        ["named", "IN_CHECK", 1],
        ["dynamic", null, 3],
      ],
    );
  });
});

describe("scanEnvReads 不误报", () => {
  test("注释、字符串、模板文本、整份展开、Object.entries、遮蔽的 process", () => {
    assert.deepEqual(
      names(
        [
          "// process.env.IN_COMMENT",
          "/* process.env.IN_BLOCK */",
          'const s = "process.env.IN_STRING";',
          "const t = `process.env.IN_TEMPLATE`;",
          "const copy = { ...process.env };",
          "Object.entries(process.env);",
          "const whole = process.env;",
          "spawn('x', { env: { ...whole } });",
          "function own(process) { return process.env.SHADOWED; }",
          "function other(env) { return env.NOT_ENV; }",
          "other({});",
        ].join("\n"),
      ),
      [],
    );
  });
});

describe("envViolations 白名单", () => {
  test("具名白名单只放行列出的变量；动态键只放行白名单文件", () => {
    const at = (rel: string, name: string | null): EnvFinding => ({
      file: resolve(SRC, rel),
      line: 1,
      name,
      kind: name === null ? "dynamic" : "named",
    });
    const problems = envViolations(
      [
        at("native/mcp.ts", "PATH"),
        at("native/mcp.ts", "CURSOR_API_KEY"),
        at("native/tools/shell.ts", "HOME"),
        at("native/tools/shell.ts", "CURSOR_REMOTE_STATE_DIR"),
        at("native/tools/shell.ts", null),
        at("providers.ts", null),
        at("index.ts", null),
        at("index.ts", "PATH"),
      ],
      SRC,
    );
    assert.equal(problems.length, 4);
    assert.match(problems[0], /native\/mcp\.ts:1 .*CURSOR_API_KEY/);
    assert.match(problems[1], /native\/tools\/shell\.ts:1 .*CURSOR_REMOTE_STATE_DIR/);
    assert.match(problems[2], /index\.ts:1 用动态键/);
    assert.match(problems[3], /index\.ts:1 .*PATH/);
  });
});

describe("声明与模板", () => {
  test("declaredEnvNames 从 ENV_SPECS 字面量取名字", () => {
    const text = [
      "const OTHER = [{ name: 'NOT_ME' }];",
      'export const ENV_SPECS = [{ name: "A_B", doc: "x" }, { doc: "name: \\"FAKE\\"", name: "C" }] as const satisfies readonly X[];',
    ].join("\n");
    assert.deepEqual(declaredEnvNames(text), ["A_B", "C"]);
  });

  test("exampleEnvNames 认注释行和赋值行", () => {
    const set = exampleEnvNames("# 说明 FOO=bar\nA=1\n# B=\n  #  C=x\nlower=1\n");
    assert.deepEqual([...set].sort(), ["A", "B", "C"]);
  });

  test("当前仓库通过检查", () => {
    assert.deepEqual(checkRepo(resolve(import.meta.dirname, "../..")), []);
  });
});
