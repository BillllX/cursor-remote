// 零依赖 stdio 转发器：stdout 只输出 JSON-RPC，网关断连或取消立即退出，stdin EOF 有界收尾。
import { connect } from "node:net";
const limit = 1024 * 1024;
const token = process.env.JIEBO_MCP_TOKEN;
const path = process.env.JIEBO_MCP_SOCKET;
if (!token || !path) process.exit(1);
const socket = connect(path);
let stopped = false;
let inputEnded = false;
const pending = new Set();
function finishInput() {
  if (inputEnded && pending.size === 0) process.stdout.write("", () => stop());
}
function stop(code = 0) {
  if (stopped) return;
  stopped = true;
  socket.destroy();
  process.stdin.destroy();
  process.exit(code);
}
const timer = setTimeout(() => stop(1), 10_000);
socket.on("connect", () => clearTimeout(timer));
socket.on("error", () => stop(1));
socket.on("close", () => stop());
process.stdin.on("end", () => {
  inputEnded = true;
  // EOF 后给已接收的请求一个有界收尾窗口，避免管道客户端丢失最后一个响应。
  if (pending.size) setTimeout(() => stop(1), 5_000).unref();
  finishInput();
});
process.stdin.on("error", () => stop(1));
process.stdout.on("error", () => stop(1));
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
function lines(stream, consume) {
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > limit) return stop(1);
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      consume(line);
    }
  });
}
lines(process.stdin, (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "无效 JSON" } }) + "\n",
    );
    return;
  }
  const frame = JSON.stringify({ token, message }) + "\n";
  if (Buffer.byteLength(frame) > limit || socket.writableLength > limit * 2) return stop(1);
  if (message && Object.hasOwn(message, "id") && (typeof message.id === "string" || typeof message.id === "number")) {
    pending.add(JSON.stringify(message.id));
    if (pending.size > 16) return stop(1);
  }
  if (!socket.write(frame)) process.stdin.pause();
});
socket.on("drain", () => process.stdin.resume());
lines(socket, (line) => {
  try {
    pending.delete(JSON.stringify(JSON.parse(line).id));
  } catch {
    return stop(1);
  }
  if (process.stdout.writableLength > limit * 2) return stop(1);
  if (!process.stdout.write(line + "\n", finishInput)) socket.pause();
});
process.stdout.on("drain", () => socket.resume());
