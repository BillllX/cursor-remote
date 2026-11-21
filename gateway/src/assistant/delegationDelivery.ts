import { posix } from "node:path";
import type { TurnFile } from "../../../shared/protocol.ts";

/** 只接受子工作区内的相对路径；指定路径无效时让调用方拒绝交办。 */
export function normalizeExpectedFiles(paths: string[] | undefined): string[] | undefined {
  if (paths === undefined) return undefined;
  if (paths.length > 12) throw new Error("一项委派最多指定 12 个验收文件。");
  return [
    ...new Set(
      paths.map((raw) => {
        const path = raw.trim().replaceAll("\\", "/");
        if (
          !path ||
          path.length > 300 ||
          /[\0\r\n:]/.test(path) ||
          path.startsWith("/") ||
          path.split("/").includes("..") ||
          posix.normalize(path) === "."
        ) {
          throw new Error("验收文件必须是工作区内的相对文件路径。");
        }
        return posix.normalize(path);
      }),
    ),
  ];
}

export function assessDelegationDelivery(
  result: string,
  required: { requiresFile?: boolean; expectedFiles?: string[] },
  turnFiles: TurnFile[],
  canOpen: (file: TurnFile) => boolean,
): { ok: boolean; text: string } {
  const expected = required.expectedFiles ?? [];
  let reason = "";
  if (expected.length || required.requiresFile) {
    const files = turnFiles.filter((file) => !file.sourceChatId);
    const missing = expected.filter((path) => !files.some((file) => file.path === path && canOpen(file)));
    if (missing.length) reason = `本轮没有可打开的交付文件：${missing.join("、")}。`;
    else if (!expected.length && !files.some(canOpen)) reason = "本轮没有生成可打开的交付文件。";
  }
  if (!reason && !result.trim()) reason = "本轮没有收到交付说明。";
  return reason
    ? { ok: false, text: [reason, result.trim()].filter(Boolean).join("\n\n") }
    : { ok: true, text: result.trim() };
}
