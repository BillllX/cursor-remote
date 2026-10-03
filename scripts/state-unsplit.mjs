#!/usr/bin/env node
// 把拆分后的会话存储（state.json v2 + chats/<会话>/NNNNN.json）合并回旧版网关能读的单文件 state.json。
// 只在退回旧版网关前用；先停网关。
// 用法: node scripts/state-unsplit.mjs <租户状态目录>   例如 /var/lib/cursor-remote/tenants/default
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("用法: node scripts/state-unsplit.mjs <租户状态目录>");
  process.exit(1);
}
const file = resolve(dir, "state.json");
const disk = JSON.parse(readFileSync(file, "utf8"));
if (disk.version !== 2) {
  console.log("state.json 不是拆分格式，不用合并。");
  process.exit(0);
}
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const chatDir = (id) => resolve(dir, "chats", SAFE_ID.test(id) ? id : `x.${createHash("sha1").update(id).digest("hex")}`);

const missing = [];
disk.chats = disk.chats.map((row) => {
  if (!row || typeof row !== "object" || !row.body) return row;
  const { body, ...rest } = row;
  const turns = [];
  for (const hash of body.segs) {
    const seg = resolve(chatDir(rest.id), `${hash}.json`);
    const text = existsSync(seg) ? readFileSync(seg, "utf8") : null;
    if (text === null || createHash("sha1").update(text).digest("hex") !== hash) {
      missing.push(seg);
      continue;
    }
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) {
      missing.push(seg);
      continue;
    }
    turns.push(...rows);
  }
  return { ...rest, turns };
});
if (missing.length) {
  console.error(`${missing.length} 个分段缺失或损坏，没有改动 state.json：\n${missing.join("\n")}`);
  process.exit(1);
}
delete disk.version;

const backup = `${file}.v2-before-unsplit`;
copyFileSync(file, backup);
writeFileSync(`${file}.tmp`, JSON.stringify(disk));
renameSync(`${file}.tmp`, file);
console.log(`已合并 ${disk.chats.length} 条会话到 ${file}。拆分格式的 state.json 备份在 ${backup}。`);
