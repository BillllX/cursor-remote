#!/usr/bin/env node
// 测试用 MCP 服务：stdio（默认）或 Streamable HTTP（--http <port>，--sse 时用 SSE 回包）。
// 工具：add（只读）、shout（非只读，转大写）、fail（返回 isError）、slow（睡眠 ms）。
import { createServer } from "node:http";

const tools = [
  {
    name: "add",
    description: "两个数相加",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "shout",
    description: "把文本转成大写并加感叹号",
    // 故意谎报只读：网关不应据此免审批
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  { name: "fail", description: "总是失败", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "睡眠指定毫秒", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
];

async function handle(msg) {
  if (msg.id == null) return null;
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } });
    case "tools/list":
      // 分页：第一页两个，第二页其余
      if (!msg.params?.cursor) return ok({ tools: tools.slice(0, 2), nextCursor: "p2" });
      return ok({ tools: tools.slice(2) });
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params || {};
      if (name === "add") return ok({ content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] });
      if (name === "shout") return ok({ content: [{ type: "text", text: `${String(args.text || "").toUpperCase()}!` }] });
      if (name === "fail") return ok({ content: [{ type: "text", text: "故意失败" }], isError: true });
      if (name === "slow") {
        await new Promise((r) => setTimeout(r, Number(args.ms) || 1000));
        return ok({ content: [{ type: "text", text: "slept" }] });
      }
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } };
    }
    case "ping":
      return ok({});
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
  }
}

const httpAt = process.argv.indexOf("--http");
if (httpAt > 0) {
  const port = Number(process.argv[httpAt + 1] || 0);
  const sse = process.argv.includes("--sse");
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") return res.writeHead(200).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body || "{}");
    const out = await handle(msg);
    const headers = { "mcp-session-id": "sess-1" };
    if (!out) return res.writeHead(202, headers).end();
    if (msg.method !== "initialize" && req.headers["mcp-session-id"] !== "sess-1") {
      return res.writeHead(400, headers).end("missing session");
    }
    if (sse) {
      res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
      // 回完结果也不关流（合法的长连接服务），客户端应在拿到结果后自己断开
      res.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
      req.on("close", () => res.end());
    } else {
      res.writeHead(200, { ...headers, "content-type": "application/json" }).end(JSON.stringify(out));
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`listening ${server.address().port}`));
} else {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line) continue;
      const out = await handle(JSON.parse(line));
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    }
  });
}
