/**
 * 自研 Agent 离线冒烟：本地假 OpenAI SSE 服务 + 临时工作区，不连真实模型。
 * 用法：npm run smoke:native
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openaiAdapter } from "./adapters/openai.ts";
import { ConfineError, resolveInside } from "./confine.ts";
import { runNativeLoop, type NativeHooks } from "./loop.ts";
import { fsTools, globToRegExp, setRgPathForTest } from "./tools/fs.ts";
import { toolsForMode } from "./tools/registry.ts";
import { isReadOnlyCommand, sandboxArgv, shellEnv, shellTool } from "./tools/shell.ts";
import { deleteSession, loadSession, normalizeSequence, noteSession, resumeMessages, saveSession, slimMessages } from "./session.ts";
import type { ChatMessage, ModelEndpoint, ToolCall, ToolSpec } from "./types.ts";

let failed = 0;
let passed = 0;
function check(ok: unknown, label: string, extra = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && extra ? `  — ${extra}` : ""}`);
}

// ---------- 假模型服务 ----------
type Scripted =
  | { kind: "sse"; chunks: unknown[]; delayMs?: number }
  | { kind: "status"; status: number; body: string; headers?: Record<string, string> };

const queue: Scripted[] = [];
const requests: Array<Record<string, unknown>> = [];

function sseText(text: string) {
  return { choices: [{ delta: { content: text } }] };
}
function sseTool(index: number, id: string | undefined, name: string | undefined, args: string) {
  return { choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] };
}
function sseFinish(reason: string, usage?: unknown) {
  return { choices: [{ delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const next = queue.shift();
  if (!next) {
    res.writeHead(500).end("no scripted response");
    return;
  }
  if (next.kind === "status") {
    res.writeHead(next.status, { "content-type": "application/json", ...(next.headers || {}) }).end(next.body);
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of next.chunks) {
    if (res.destroyed) return;
    res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
    if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs));
  }
  res.end("data: [DONE]\n\n");
}

const server = createServer((req, res) => void handle(req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const endpoint: ModelEndpoint = {
  id: "mock",
  name: "Mock",
  baseURL: `http://127.0.0.1:${port}/v1`,
  apiKey: "sk-test",
  model: "mock-1",
  adapter: "openai",
  vision: false,
  echoReasoning: false,
  cache: false,
};

const scratch = resolve(process.env.NATIVE_SMOKE_DIR || ".native-smoke");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "run-"));
const ws = join(root, "ws");
mkdirSync(ws);
const outside = join(root, "outside");
mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "secret");

const ctx = { cwd: ws, signal: new AbortController().signal };
const tool = (name: string) => fsTools.find((t) => t.name === name)!;

try {
  // ---------- glob ----------
  check(globToRegExp("**/*.ts").test("a/b/c.ts"), "glob **/*.ts 匹配深层");
  check(globToRegExp("*.ts").test("deep/x.ts"), "glob 无斜杠匹配任意层级");
  check(!globToRegExp("src/*.ts").test("src/a/b.ts"), "glob 单星不跨目录");
  check(globToRegExp("src/**/index.{js,ts}").test("src/index.ts"), "glob ** 可匹配零层 + 花括号");

  // ---------- confinement ----------
  const throws = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch (err) {
      return err instanceof ConfineError;
    }
  };
  check(throws(() => resolveInside(ws, "../outside/secret.txt")), "拒绝 .. 逃逸");
  check(throws(() => resolveInside(ws, join(outside, "secret.txt"))), "拒绝工作区外绝对路径");
  symlinkSync(outside, join(ws, "link"));
  check(throws(() => resolveInside(ws, "link/secret.txt")), "拒绝符号链接逃逸");
  check(throws(() => resolveInside(ws, ".git/config")), "拒绝 .git 内部");
  check(throws(() => resolveInside(ws, ".cursor/hooks.json", { write: true })), "拒绝写策略保护文件");
  check(resolveInside(ws, "src/new/file.ts").rel === "src/new/file.ts", "不存在的路径正常解析");
  check(resolveInside(ws, join(ws, "a.txt")).rel === "a.txt", "工作区内绝对路径转相对");

  // ---------- fs 工具 ----------
  let r = await tool("write_file").run({ path: "src/app.ts", content: "const a = 1;\nconst b = 2;\nconst a2 = 1;\n" }, ctx);
  check(r.ok && r.changed?.[0] === "src/app.ts" && existsSync(join(ws, "src/app.ts")), "write_file 新建并建父目录");
  r = await tool("read_file").run({ path: "src/app.ts" }, ctx);
  check(r.ok && r.content.startsWith("1|const a = 1;"), "read_file 带行号", r.content);
  r = await tool("read_file").run({ path: "src/app.ts", offset: 2, limit: 1 }, ctx);
  check(r.ok && r.content.startsWith("2|const b = 2;") && r.content.includes("共 4 行"), "read_file 分段", r.content);
  r = await tool("edit_file").run({ path: "src/app.ts", old_string: "= 1;", new_string: "= 10;" }, ctx);
  check(!r.ok && r.content.includes("2 次"), "edit_file 不唯一时拒绝", r.content);
  r = await tool("edit_file").run({ path: "src/app.ts", old_string: "nope", new_string: "x" }, ctx);
  check(!r.ok && r.content.includes("找不到"), "edit_file 找不到时报错");
  r = await tool("edit_file").run({ path: "src/app.ts", old_string: "const b = 2;", new_string: "const b = 3;\nconst c = 4;" }, ctx);
  check(r.ok && readFileSync(join(ws, "src/app.ts"), "utf8").includes("const c = 4;"), "edit_file 唯一替换", r.content);
  r = await tool("edit_file").run({ path: "src/app.ts", old_string: "= 1;", new_string: "= 9;", replace_all: true }, ctx);
  check(r.ok && !readFileSync(join(ws, "src/app.ts"), "utf8").includes("= 1;"), "edit_file replace_all");
  r = await tool("edit_file").run({ path: "src/$x.ts", old_string: "a", new_string: "b" }, ctx);
  check(!r.ok, "edit_file 不存在的文件");
  writeFileSync(join(ws, "src/dollar.ts"), "let v = 'A';\n");
  r = await tool("edit_file").run({ path: "src/dollar.ts", old_string: "'A'", new_string: "'$&$1'" }, ctx);
  check(readFileSync(join(ws, "src/dollar.ts"), "utf8").includes("'$&$1'"), "edit_file 不解释 $ 替换模式");
  r = await tool("list_dir").run({}, ctx);
  check(r.ok && r.content.includes("src/"), "list_dir 根目录", r.content);
  r = await tool("glob").run({ pattern: "**/*.ts" }, ctx);
  check(r.ok && r.content.includes("src/app.ts"), "glob 工具", r.content);
  r = await tool("grep").run({ pattern: "const c", path: "src" }, ctx);
  check(r.ok && /src\/app\.ts:\d+:const c = 4;/.test(r.content), "grep（rg 或自动选择）", r.content);
  setRgPathForTest(null);
  r = await tool("grep").run({ pattern: "CONST C", ignore_case: true, glob: "*.ts" }, ctx);
  check(r.ok && /src\/app\.ts:\d+:const c = 4;/.test(r.content), "grep JS 兜底 + 忽略大小写 + glob", r.content);
  r = await tool("grep").run({ pattern: "const c", path: "src/app.ts" }, ctx);
  check(r.ok && r.content.startsWith("src/app.ts:"), "grep 单文件（JS）", r.content);
  setRgPathForTest(undefined);
  r = await tool("grep").run({ pattern: "const c", path: "src/app.ts" }, ctx);
  check(r.ok && r.content.startsWith("src/app.ts:"), "grep 单文件（rg）", r.content);
  // 评审 M1/M7/M8：遍历不跟随符号链接、符号链接成环不挂死、不写硬链接、大文件不整读
  symlinkSync(".", join(ws, "loop"));
  r = await tool("glob").run({ pattern: "**/*" }, ctx);
  check(r.ok && !r.content.includes("secret.txt") && !r.content.includes("loop/"), "glob 不跟随符号链接（含成环）", r.content);
  setRgPathForTest(null);
  r = await tool("grep").run({ pattern: "secret" }, ctx);
  check(r.ok && r.content === "没有匹配", "grep JS 兜底不读链接外的文件", r.content);
  setRgPathForTest(undefined);
  const { linkSync } = await import("node:fs");
  writeFileSync(join(outside, "hard.txt"), "outside");
  linkSync(join(outside, "hard.txt"), join(ws, "hard.txt"));
  r = await tool("write_file").run({ path: "hard.txt", content: "pwn" }, ctx).catch((err: Error) => ({ ok: false, content: err.message }));
  check(!r.ok && readFileSync(join(outside, "hard.txt"), "utf8") === "outside", "write_file 拒绝多链接文件", r.content);
  symlinkSync(join(outside, "nowhere.txt"), join(ws, "dangling.txt"));
  r = await tool("write_file").run({ path: "dangling.txt", content: "pwn" }, ctx).catch((err: Error) => ({ ok: false, content: err.message }));
  check(!r.ok && !existsSync(join(outside, "nowhere.txt")), "write_file 拒绝悬空符号链接", r.content);
  writeFileSync(join(ws, "big.txt"), "x".repeat(3 * 1024 * 1024));
  r = await tool("read_file").run({ path: "big.txt", limit: 1 }, ctx);
  check(r.ok && r.content.includes("只读了前"), "read_file 大文件只读开头", r.content.slice(-60));
  r = await tool("edit_file").run({ path: "big.txt", old_string: "xx", new_string: "y" }, ctx);
  check(!r.ok && r.content.includes("2MB"), "edit_file 拒绝超大文件", r.content);
  rmSync(join(ws, "loop"));
  rmSync(join(ws, "hard.txt"));
  rmSync(join(ws, "dangling.txt"));
  rmSync(join(ws, "big.txt"));

  r = await tool("delete_file").run({ path: "src/dollar.ts" }, ctx);
  check(r.ok && !existsSync(join(ws, "src/dollar.ts")), "delete_file");
  check(toolsForMode("ask").every((t) => t.category === "read"), "ask 模式只给只读工具");

  // ---------- 适配器 ----------
  queue.push({
    kind: "sse",
    chunks: [
      sseText("<thi"),
      sseText("nk>想一想</think>你"),
      sseText("好"),
      sseTool(0, "call_1", "read_", ""),
      sseTool(0, undefined, "file", '{"pa'),
      sseTool(0, undefined, undefined, 'th":"a"}'),
      sseTool(1, "call_2", "grep", '{"pattern":"x"}'),
      sseFinish("tool_calls", { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } }),
    ],
  });
  let streamedText = "";
  let streamedThink = "";
  const turn = await openaiAdapter({
    endpoint,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "read_file", description: "", parameters: { type: "object" } }],
    signal: new AbortController().signal,
    onText: (d) => (streamedText += d),
    onThinking: (d) => (streamedThink += d),
  });
  check(turn.text === "你好" && streamedText === "你好", "适配器：正文流式拼接", JSON.stringify(turn.text));
  check(turn.reasoning === "想一想" && turn.reasoningInline && streamedThink === "想一想", "适配器：跨帧 <think> 拆到思考");
  check(
    turn.toolCalls.length === 2 && turn.toolCalls[0].name === "read_file" && turn.toolCalls[0].arguments === '{"path":"a"}' && turn.toolCalls[1].id === "call_2",
    "适配器：tool_calls 分片按 index 拼接",
    JSON.stringify(turn.toolCalls),
  );
  check(turn.usage?.inputTokens === 11 && turn.usage?.outputTokens === 7 && turn.usage?.cacheReadTokens === 3, "适配器：usage");
  const sent = requests.at(-1)!;
  check(Array.isArray(sent.tools) && (sent.stream_options as { include_usage?: boolean })?.include_usage === true, "适配器：请求带 tools 和 stream_options");

  queue.push({ kind: "status", status: 400, body: '{"error":"unknown field stream_options"}' });
  queue.push({ kind: "sse", chunks: [sseText("ok"), sseFinish("stop")] });
  const fallback = await openaiAdapter({
    endpoint,
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    signal: new AbortController().signal,
    onText: () => {},
    onThinking: () => {},
  });
  check(fallback.text === "ok" && !("stream_options" in requests.at(-1)!), "适配器：不认 stream_options 时去掉重试");

  // 回传 assistant 时把内联思考包回 <think>
  queue.push({ kind: "sse", chunks: [sseText("done"), sseFinish("stop")] });
  await openaiAdapter({
    endpoint,
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", reasoning: "r", reasoningInline: true, toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "x" },
    ],
    tools: [],
    signal: new AbortController().signal,
    onText: () => {},
    onThinking: () => {},
  });
  const wire = requests.at(-1)!.messages as Array<Record<string, unknown>>;
  check(wire[1].content === "<think>r</think>a" && Array.isArray(wire[1].tool_calls) && wire[2].tool_call_id === "c1", "适配器：消息回传格式");

  // ---------- 循环 ----------
  const events: string[] = [];
  const makeHooks = (over: Partial<NativeHooks> = {}): NativeHooks => ({
    text: () => {},
    thinking: () => {},
    toolStarted: (call: ToolCall) => events.push(`start:${call.name}`),
    toolCompleted: (call: ToolCall, result) => events.push(`done:${call.name}:${result.ok}`),
    needsApproval: () => false,
    approve: async () => true,
    ...over,
  });
  const baseMessages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "改 hello.txt" }];

  queue.push({ kind: "sse", chunks: [sseTool(0, "w1", "write_file", JSON.stringify({ path: "hello.txt", content: "hello\n" })), sseFinish("tool_calls")] });
  queue.push({
    kind: "sse",
    chunks: [
      sseTool(0, "r1", "read_file", '{"path":"hello.txt"}'),
      sseTool(1, "g1", "grep", '{"pattern":"hello"}'),
      sseFinish("tool_calls", { prompt_tokens: 5, completion_tokens: 2 }),
    ],
  });
  queue.push({ kind: "sse", chunks: [sseTool(0, "e1", "edit_file", '{"path":"hello.txt","old_string":"hello","new_string":"hi"}'), sseTool(1, "bad", "write_file", "{broken")] });
  queue.push({ kind: "sse", chunks: [sseText("完成"), sseFinish("stop", { prompt_tokens: 9, completion_tokens: 3 })] });
  let result = await runNativeLoop({
    adapter: openaiAdapter,
    endpoint,
    messages: baseMessages,
    tools: toolsForMode("agent"),
    cwd: ws,
    signal: new AbortController().signal,
    hooks: makeHooks(),
  });
  check(result.status === "completed" && result.steps === 4, "循环：多步跑完", `${result.status} ${result.steps} ${result.error || ""}`);
  check(readFileSync(join(ws, "hello.txt"), "utf8") === "hi\n", "循环：写入并编辑文件");
  check(events.includes("start:read_file") && events.includes("start:grep"), "循环：并行只读工具都执行了");
  check(events.includes("done:write_file:false"), "循环：坏 JSON 参数回报错误而不中断");
  check(result.usage.inputTokens === 14 && result.usage.outputTokens === 5, "循环：usage 累加", JSON.stringify(result.usage));
  const toolMsgs = result.messages.filter((m) => m.role === "tool");
  check(toolMsgs.length === 5, "循环：每个 tool_call 都有结果消息", String(toolMsgs.length));
  const lastAssistant = result.messages.at(-1);
  check(lastAssistant?.role === "assistant" && lastAssistant.content === "完成", "循环：最后一条是助手正文");

  // 审批拒绝
  events.length = 0;
  queue.push({ kind: "sse", chunks: [sseTool(0, "w2", "write_file", '{"path":"denied.txt","content":"x"}'), sseTool(1, "w3", "write_file", '{"path":"d2.txt","content":"x"}')] });
  result = await runNativeLoop({
    adapter: openaiAdapter,
    endpoint,
    messages: baseMessages,
    tools: toolsForMode("agent"),
    cwd: ws,
    signal: new AbortController().signal,
    hooks: makeHooks({ needsApproval: (spec: ToolSpec) => spec.category === "write", approve: async () => false }),
  });
  check(result.status === "denied" && !existsSync(join(ws, "denied.txt")) && !existsSync(join(ws, "d2.txt")), "循环：拒绝审批不写文件并结束");
  check(result.messages.filter((m) => m.role === "tool").length === 2, "循环：拒绝后剩余调用也补上结果");

  // 审批同意
  queue.push({ kind: "sse", chunks: [sseTool(0, "w4", "write_file", '{"path":"ok.txt","content":"x"}')] });
  queue.push({ kind: "sse", chunks: [sseText("好了")] });
  let asked = 0;
  result = await runNativeLoop({
    adapter: openaiAdapter,
    endpoint,
    messages: baseMessages,
    tools: toolsForMode("agent"),
    cwd: ws,
    signal: new AbortController().signal,
    hooks: makeHooks({ needsApproval: (spec: ToolSpec) => spec.category === "write", approve: async () => (asked++, true) }),
  });
  check(result.status === "completed" && asked === 1 && existsSync(join(ws, "ok.txt")), "循环：同意审批后执行");

  // 越界写被工具拒绝，循环继续
  queue.push({ kind: "sse", chunks: [sseTool(0, "x1", "write_file", JSON.stringify({ path: "../outside/pwn.txt", content: "x" }))] });
  queue.push({ kind: "sse", chunks: [sseText("越界了")] });
  result = await runNativeLoop({ adapter: openaiAdapter, endpoint, messages: baseMessages, tools: toolsForMode("agent"), cwd: ws, signal: new AbortController().signal, hooks: makeHooks() });
  const outTool = result.messages.find((m) => m.role === "tool");
  check(result.status === "completed" && !existsSync(join(outside, "pwn.txt")) && outTool?.role === "tool" && outTool.content.includes("不在工作区内"), "循环：越界写被拦截");

  // 取消
  queue.push({ kind: "sse", chunks: Array.from({ length: 50 }, (_, i) => sseText(`片段${i}`)), delayMs: 40 });
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 200);
  const t0 = Date.now();
  result = await runNativeLoop({ adapter: openaiAdapter, endpoint, messages: baseMessages, tools: [], cwd: ws, signal: abort.signal, hooks: makeHooks() });
  check(result.status === "cancelled" && Date.now() - t0 < 1500, "循环：取消能及时停下", `${result.status} ${Date.now() - t0}ms`);
  await new Promise((r) => setTimeout(r, 2200));
  queue.length = 0;

  // 429 退避重试
  let retried = 0;
  queue.push({ kind: "status", status: 429, body: '{"error":"rate"}', headers: { "retry-after": "1" } });
  queue.push({ kind: "sse", chunks: [sseText("重试成功")] });
  result = await runNativeLoop({
    adapter: openaiAdapter,
    endpoint,
    messages: baseMessages,
    tools: [],
    cwd: ws,
    signal: new AbortController().signal,
    hooks: makeHooks({ retrying: () => retried++ }),
  });
  const final = result.messages.at(-1);
  check(result.status === "completed" && retried === 1 && final?.role === "assistant" && final.content === "重试成功", "循环：429 退避后重试成功");

  // 401 不重试
  queue.push({ kind: "status", status: 401, body: '{"error":"bad key sk-abcdefghijkl"}' });
  result = await runNativeLoop({ adapter: openaiAdapter, endpoint, messages: baseMessages, tools: [], cwd: ws, signal: new AbortController().signal, hooks: makeHooks() });
  check(result.status === "error" && /401/.test(result.error || "") && !(result.error || "").includes("abcdefghijkl"), "循环：401 直接报错且脱敏 key", result.error);

  // 步数上限
  for (let i = 0; i < 3; i++) queue.push({ kind: "sse", chunks: [sseTool(0, `l${i}`, "list_dir", "{}")] });
  result = await runNativeLoop({ adapter: openaiAdapter, endpoint, messages: baseMessages, tools: toolsForMode("agent"), cwd: ws, signal: new AbortController().signal, hooks: makeHooks(), maxSteps: 3 });
  check(result.status === "max_steps" && result.steps === 3, "循环：步数上限");

  // vet 拦截：不执行、不审批，原因回给模型
  queue.push({ kind: "sse", chunks: [sseTool(0, "v1", "write_file", JSON.stringify({ path: "vetted.txt", content: "x" }))] });
  queue.push({ kind: "sse", chunks: [sseText("好")] });
  let vetApprovals = 0;
  result = await runNativeLoop({
    adapter: openaiAdapter,
    endpoint,
    messages: baseMessages,
    tools: toolsForMode("agent"),
    cwd: ws,
    signal: new AbortController().signal,
    hooks: makeHooks({ vet: () => "被拦了", needsApproval: () => true, approve: async () => (vetApprovals++, true) }),
  });
  const vetted = result.messages.find((m) => m.role === "tool");
  check(result.status === "completed" && vetApprovals === 0 && !existsSync(join(ws, "vetted.txt")) && vetted?.role === "tool" && vetted.content === "被拦了", "循环：vet 拦截不执行也不审批");

  // ---- shell ----
  const sh = shellTool({ sandbox: false });
  const outputs: string[] = [];
  r = await sh.run({ command: "echo hi; echo err >&2; exit 3" }, { ...ctx, onOutput: (c) => outputs.push(c.stdout ?? c.stderr ?? "") });
  check(!r.ok && r.content.startsWith("退出码 3") && r.content.includes("hi") && r.content.includes("err") && outputs.join("").includes("hi"), "shell：退出码、合并输出、流式回调", r.content);
  mkdirSync(join(ws, "sub"), { recursive: true });
  r = await sh.run({ command: "pwd", working_directory: "sub" }, ctx);
  check(r.ok && r.content.trim().endsWith(`${resolve(ws, "sub")}`), "shell：working_directory 相对工作区", r.content);
  r = await sh.run({ command: "pwd", working_directory: "../outside" }, ctx).catch((err: Error) => ({ ok: false, content: err.message }));
  check(!r.ok, "shell：working_directory 不能出工作区", r.content);
  process.env.NATIVE_SMOKE_SECRET = "sk-should-not-leak";
  r = await sh.run({ command: "env" }, ctx);
  check(r.ok && !r.content.includes("sk-should-not-leak") && r.content.includes("PATH="), "shell：环境变量白名单不漏密钥");
  delete process.env.NATIVE_SMOKE_SECRET;
  let t1 = Date.now();
  r = await sh.run({ command: "sleep 30 & sleep 30", timeout_ms: 1000 }, ctx);
  check(!r.ok && r.content.includes("超时") && Date.now() - t1 < 5000, "shell：超时杀掉整个进程组", `${r.content} ${Date.now() - t1}ms`);
  r = await sh.run({ command: "head -c 200000 /dev/zero | tr '\\0' a" }, ctx);
  check(r.ok && r.content.length < 30_000 && r.content.includes("中间省略"), "shell：长输出保留头尾", String(r.content.length));
  const shAbort = new AbortController();
  t1 = Date.now();
  setTimeout(() => shAbort.abort(), 300);
  const aborted = await sh.run({ command: "sleep 30" }, { cwd: ws, signal: shAbort.signal }).then(
    () => false,
    (err: Error) => err.name === "AbortError",
  );
  check(aborted && Date.now() - t1 < 4000, "shell：取消即终止并抛 AbortError");
  check(toolsForMode("ask", [sh]).every((t) => t.name !== "run_shell") && toolsForMode("agent", [sh]).some((t) => t.name === "run_shell"), "shell：只在 agent 模式提供");
  check(shellEnv({ PATH: "/bin", CURSOR_API_KEY: "x", HOME: "/h" }).CURSOR_API_KEY === undefined, "shell：shellEnv 丢弃非白名单变量");
  const preAborted = new AbortController();
  preAborted.abort();
  const marker = join(ws, "should-not-exist.txt");
  const preResult = await sh.run({ command: `touch ${marker}` }, { cwd: ws, signal: preAborted.signal }).then(
    () => "ran",
    (err: Error) => err.name,
  );
  check(preResult === "AbortError" && !existsSync(marker), "shell：已取消的信号不再执行命令");
  const readOnly = ["ls -la", "git status && git diff HEAD~1", "cat a.txt | grep x | wc -l", "find . -name '*.ts'", "echo hi 2>&1", "rg foo src >/dev/null"];
  const writes = ["echo x > a.txt", "sed -i s/a/b/ f", "python3 x.py", "git commit -m x", "find . -delete", "cat $(which x)", "ls; rm -rf .", "git branch -D main", "echo `id`", "tee out.txt"];
  check(readOnly.every(isReadOnlyCommand), "shell：只读白名单放行", readOnly.filter((c) => !isReadOnlyCommand(c)).join(" | "));
  check(!writes.some(isReadOnlyCommand), "shell：写操作都要审批", writes.filter(isReadOnlyCommand).join(" | "));
  const [, bwArgs] = sandboxArgv("/usr/bin/bwrap", "/var/lib/cursor-remote/workspace/a", "/var/lib/cursor-remote/workspace/a", "ls", ["/var/lib/cursor-remote", "/etc/cursor-remote"]);
  const maskAt = bwArgs.indexOf("/var/lib/cursor-remote");
  const bindAt = bwArgs.indexOf("--bind");
  check(bwArgs[maskAt - 1] === "--tmpfs" && bindAt > maskAt && bwArgs[bindAt + 1] === "/var/lib/cursor-remote/workspace/a" && bwArgs.includes("--die-with-parent"), "shell：bwrap 先遮敏感目录再挂回工作区");

  // ---- 会话持久化 ----
  const stateDir = join(root, "state");
  const turnMsgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "第一问", images: [{ data: "AAAA", mimeType: "image/png" }] },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }, { id: "c2", name: "list_dir", arguments: "{}" }] },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "x".repeat(5000) },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "答" },
  ];
  saveSession(stateDir, "chat-1", { model: "m", userKeys: ["第一问", "第二问"], messages: turnMsgs });
  const stored = loadSession(stateDir, "chat-1");
  const storedTools = stored?.messages.filter((m) => m.role === "tool") ?? [];
  check(stored && !stored.messages.some((m) => m.role === ("system" as string)), "会话：不存 system");
  check(stored?.messages[0].role === "user" && !("images" in stored.messages[0] && stored.messages[0].images) && stored.messages[0].content.includes("图片"), "会话：图片不落盘只留说明");
  check(storedTools.length === 2 && storedTools.some((m) => m.role === "tool" && m.toolCallId === "c2" && m.isError), "会话：补齐没有结果的 tool_call");
  check(storedTools.some((m) => m.role === "tool" && m.toolCallId === "c1" && m.content.length < 2100), "会话：旧轮次工具结果截短");
  let resumed = resumeMessages(stored, []);
  check(resumed.source === "stored" && resumed.messages.length === stored!.messages.length, "会话：客户端不带 history 时用存档");
  resumed = resumeMessages(stored, [{ role: "user", text: "第二问" }, { role: "assistant", text: "答" }]);
  check(resumed.source === "stored", "会话：history 是存档的尾部时用存档");
  resumed = resumeMessages(stored, [{ role: "user", text: "别的问题" }, { role: "assistant", text: "别的答" }]);
  check(resumed.source === "client" && resumed.messages.length === 2 && resumed.userKeys[0] === "别的问题", "会话：history 对不上时以客户端为准");
  noteSession(stateDir, "chat-1", "已还原");
  check(loadSession(stateDir, "chat-1")?.notes?.[0] === "已还原" && resumeMessages(loadSession(stateDir, "chat-1"), []).notes[0] === "已还原", "会话：旁白随下一轮带出");
  saveSession(stateDir, "../evil", { model: "m", userKeys: [], messages: [{ role: "user", content: "x" }] });
  check(!existsSync(join(root, "evil.json")) && loadSession(stateDir, "../evil") !== null, "会话：chatId 不能做路径穿越");
  deleteSession(stateDir, "chat-1");
  check(loadSession(stateDir, "chat-1") === null, "会话：删除");
  const big: ChatMessage[] = [];
  for (let i = 0; i < 30; i++) big.push({ role: "user", content: `q${i}` }, { role: "assistant", content: "y".repeat(20_000) });
  const slim = slimMessages(big as never);
  check(slim.droppedTurns > 0 && slim.messages[0].role === "user" && slim.messages.at(-1)?.content === "y".repeat(20_000), "会话：超量时丢最早的整轮");
  const messy = normalizeSequence([
    { role: "assistant", content: "开头的助手" },
    { role: "tool", toolCallId: "orphan", name: "x", content: "孤儿" },
    { role: "user", content: "u1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a1" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
  ] as never);
  const roles = messy.map((m) => m.role).join(",");
  check(roles === "user,assistant,user,assistant,user,assistant", "会话：整理出合法序列", roles);
  check(messy[3].content === "a1\n\na2" && messy.at(-1)?.content.includes("中断"), "会话：合并连续助手、结尾补占位");
  resumed = resumeMessages(null, [{ role: "assistant", text: "前导" }, { role: "user", text: "q" }]);
  check(resumed.messages[0].role === "user" && resumed.messages.at(-1)?.role === "assistant", "会话：客户端 history 也会整理");
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
