#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { basename, dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const op = args[0];

function usage() {
  console.log("用法：\n  jiebo-publish start -- <启动命令>\n  jiebo-publish status\n  jiebo-publish stop");
  process.exit(1);
}

if (op !== "start" && op !== "status" && op !== "stop") usage();

let command = "";
if (op === "start") {
  const sep = args.indexOf("--");
  command = (sep >= 0 ? args.slice(sep + 1) : []).join(" ").trim();
  if (!command) usage();
}

function readToken(file) {
  try {
    if (!existsSync(file)) return "";
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function workspaceToken(cwd) {
  let dir = resolve(cwd);
  for (let i = 0; i < 12; i += 1) {
    if (basename(dir) === "workspace") {
      const token = readToken(resolve(dirname(dir), "publish-token"));
      if (token) return token;
    }
    const mirrored = readToken(resolve(dir, ".cursor-remote", "publish-token"));
    if (mirrored) return mirrored;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

const token = workspaceToken(process.cwd());
if (!token) {
  console.log("找不到这个工作区的发布口令。确认当前目录在租户工作区里，并且 gateway 已启动。");
  process.exit(1);
}

const port = Number(process.env.GATEWAY_PORT || 8787);
const host = (process.env.GATEWAY_HOST || "127.0.0.1").trim();
if (host !== "127.0.0.1" && host !== "localhost") {
  console.log("jiebo-publish 只连接本机 gateway。");
  process.exit(1);
}

const body = JSON.stringify({ cwd: process.cwd(), command });
const req = httpRequest(
  {
    hostname: "127.0.0.1",
    port,
    path: `/jiebo-publish/v1/${op}`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      authorization: `Bearer ${token}`,
    },
  },
  (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      console.log(parsed?.message || raw || "没有返回。");
      process.exit(parsed?.ok ? 0 : 1);
    });
  },
);
req.setTimeout(70_000, () => {
  console.log("等 gateway 超时。");
  req.destroy();
  process.exit(1);
});
req.on("error", () => {
  console.log(`连不上本机 gateway（127.0.0.1:${port}）。`);
  process.exit(1);
});
req.end(body);
