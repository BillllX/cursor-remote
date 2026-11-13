import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isPresentationPath } from "../../shared/preview.ts";
import { ensureSafePathInWorkspace } from "./ingest/contract.ts";

const runFile = promisify(execFile);
const MAX_BYTES = 40 * 1024 * 1024;

export class PresentationPreviewError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 打开后再次核对路径与 inode，并按已核定大小读取，避免符号链接和增长文件绕过限制。 */
export async function readPresentation(cwd: string, path: string): Promise<Buffer> {
  const safe = ensureSafePathInWorkspace(cwd, path, { expectLeaf: "file" });
  if (!safe.ok) throw new PresentationPreviewError(403, "无法读取此工作区文件");
  const file = await open(safe.absPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    const again = ensureSafePathInWorkspace(cwd, path, { expectLeaf: "file" });
    const leaf = again.ok ? await lstat(again.absPath) : null;
    if (!info.isFile() || info.nlink !== 1 || !leaf || leaf.ino !== info.ino || leaf.dev !== info.dev) {
      throw new PresentationPreviewError(403, "文件路径已变化，请重新打开");
    }
    if (info.size > MAX_BYTES) throw new PresentationPreviewError(413, "PPT 超过 40MB，暂不支持在线预览");
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return data.subarray(0, offset);
  } finally {
    await file.close();
  }
}

/** 本机转换，不向外部服务发送文档；缓存按租户和内容隔离，限制并发与总内存。 */
export class PresentationConverter {
  private cache = new Map<string, Buffer>();
  private pending = new Map<string, Promise<Buffer>>();
  private cacheBytes = 0;

  constructor(
    private command = existsSync("/Applications/LibreOffice.app/Contents/MacOS/soffice")
      ? "/Applications/LibreOffice.app/Contents/MacOS/soffice"
      : "libreoffice",
    private timeoutMs = 60_000,
  ) {}

  async convert(tenantId: string, path: string, input: Buffer): Promise<Buffer> {
    if (!isPresentationPath(path)) throw new PresentationPreviewError(400, "仅支持 PPT 和 PPTX 预览");
    if (input.length > MAX_BYTES) throw new PresentationPreviewError(413, "PPT 超过 40MB，暂不支持在线预览");
    const extension = path.toLowerCase().endsWith(".pptx") ? ".pptx" : ".ppt";
    const key = createHash("sha256").update(tenantId).update("\0").update(extension).update(input).digest("hex");
    const cached = this.cache.get(key);
    if (cached) return cached;
    const running = this.pending.get(key);
    if (running) return running;
    if (this.pending.size >= 2) throw new PresentationPreviewError(503, "PPT 预览正在处理其他文件，请稍后重试");
    const task = this.render(input, extension).then((pdf) => {
      while (this.cacheBytes + pdf.length > 64 * 1024 * 1024 || this.cache.size >= 8) {
        const oldest = this.cache.keys().next().value;
        if (!oldest) break;
        this.cacheBytes -= this.cache.get(oldest)!.length;
        this.cache.delete(oldest);
      }
      this.cache.set(key, pdf);
      this.cacheBytes += pdf.length;
      return pdf;
    });
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }

  private async render(input: Buffer, extension: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), "jiebo-ppt-"));
    try {
      const profile = join(dir, "profile");
      await mkdir(join(profile, "user"), { recursive: true });
      // 独立配置目录防止抢占桌面进程，并禁止宏运行和自动更新外部链接。
      await writeFile(
        join(profile, "user", "registrymodifications.xcu"),
        '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">' +
          '<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>' +
          '<item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item></oor:items>',
      );
      const source = join(dir, `slides${extension}`);
      await writeFile(source, input, { mode: 0o600 });
      await runFile(
        this.command,
        [
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          "--headless",
          "--nologo",
          "--nodefault",
          "--norestore",
          "--convert-to",
          "pdf:impress_pdf_Export",
          "--outdir",
          dir,
          source,
        ],
        { timeout: this.timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024 },
      );
      const output = join(dir, "slides.pdf");
      if ((await stat(output)).size > MAX_BYTES)
        throw new PresentationPreviewError(413, "转换后的 PPT 过大，请下载原文件查看");
      const pdf = await readFile(output);
      if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("invalid PDF");
      return pdf;
    } catch (error) {
      if (error instanceof PresentationPreviewError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && (error as NodeJS.ErrnoException).syscall?.startsWith("spawn")) {
        throw new PresentationPreviewError(503, "服务器尚未安装 PPT 预览组件 LibreOffice，请联系管理员安装");
      }
      throw new PresentationPreviewError(422, "PPT 转换失败或超时，请检查文件是否损坏、加密，或下载原文件查看");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export const presentationConverter = new PresentationConverter();
