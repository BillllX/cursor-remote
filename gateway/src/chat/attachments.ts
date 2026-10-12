// 附件：@ 引用文件展开、图片校验
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { formatBytes } from "../../../shared/preview.ts";
import { log } from "../log.ts";
import { readWorkspaceFile, walkFiles, workspacePath } from "../workspace/files.ts";
import { git, gitRoot, shadowGitEnv } from "../workspace/git.ts";

function mentionBase(raw: string) {
  return raw.replace(/:\d+(?:-\d+)?$/, "").replace(/\/+$/, "");
}

export function expandAttachments(cwd: string, files: string[]): string {
  const parts: string[] = [];
  for (const raw of files.slice(0, 20)) {
    if (/^diff$/i.test(raw)) {
      try {
        const extra = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
        const out = git(cwd, ["diff", "HEAD"], extra);
        parts.push(
          out ? `Current uncommitted diff:\n\`\`\`diff\n${out.slice(0, 30_000)}\n\`\`\`` : "No uncommitted diff.",
        );
      } catch {
        parts.push("Not a git workspace (no Diff).");
      }
      continue;
    }
    const path = workspacePath(cwd, mentionBase(raw));
    if (!path) continue;
    const abs = resolve(cwd, path);
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        const kids: string[] = [];
        walkFiles(abs, abs, kids, 0);
        parts.push(
          `Folder ${path}/ (${kids.length} files):\n${kids
            .slice(0, 80)
            .map((kid) => `- ${path}/${kid}`)
            .join("\n")}`,
        );
        continue;
      }
      if (parts.filter((item) => item.startsWith("File ") || item.startsWith("Attached ")).length >= 4) continue;
      const file = readWorkspaceFile(cwd, path);
      if (file.content != null) {
        parts.push(`File ${path}:\n\`\`\`\n${file.content.slice(0, 20_000)}\n\`\`\``);
      } else if (!file.error) {
        parts.push(
          `Attached workspace file ${path} (${file.kind || "binary"}${file.size != null ? `, ${formatBytes(file.size)}` : ""}). It is already in the working directory; read it with tools.`,
        );
      }
    } catch (err) {
      // skip unreadable attachment
      log.debug("附件读不了", raw, err instanceof Error ? err.message : err);
    }
  }
  return parts.join("\n\n");
}

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function sanitizeImages(
  images: Array<{ data: string; mimeType: string }> | undefined,
): Array<{ data: string; mimeType: string }> {
  if (!images?.length) return [];
  return images
    .filter(
      (img) =>
        IMAGE_MIME.has(img.mimeType) &&
        typeof img.data === "string" &&
        img.data.length > 24 &&
        img.data.length < 12_000_000,
    )
    .slice(0, 5)
    .map((img) => ({
      data: img.data.replace(/^data:[^;]+;base64,/, ""),
      mimeType: img.mimeType,
    }));
}
