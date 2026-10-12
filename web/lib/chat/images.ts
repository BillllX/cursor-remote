// 图片与上传：大小/格式上限、浏览器本地压图、转 base64
import type { PromptImage } from "@shared/protocol";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/jpg"]);

export const MAX_IMAGES = 5;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export const MAX_UPLOAD_FILES = 10;

export const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);

export async function filesToImages(files: FileList | File[]): Promise<PromptImage[]> {
  const list = [...files].filter((file) => isPromptImageFile(file));
  const out: PromptImage[] = [];
  for (const raw of list) {
    const file = await shrinkImageFile(raw);
    const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
    if (!IMAGE_MIME.has(mime) || file.size > MAX_IMAGE_BYTES) continue;
    const data = await fileToBase64(file);
    if (data) out.push({ data, mimeType: mime });
  }
  return out;
}

/** 能直传的格式，或压完能变成 jpeg 的格式；大小先按上传上限放，压完再按 MAX_IMAGE_BYTES 卡 */
export function isPromptImageFile(file: File) {
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (!IMAGE_MIME.has(mime) && !SHRINKABLE_IMAGE.has(mime)) return false;
  const limit = SHRINKABLE_IMAGE.has(mime) && !shrunkFiles.has(file) ? MAX_IMAGE_SOURCE_BYTES : MAX_IMAGE_BYTES;
  return file.size > 0 && file.size <= limit;
}

/** 选文件时的源文件上限：能压的图先压再按 MAX_UPLOAD_BYTES 判 */
export function sourceLimit(file: File) {
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  return SHRINKABLE_IMAGE.has(mime) ? MAX_IMAGE_SOURCE_BYTES : MAX_UPLOAD_BYTES;
}

/** 与 iOS MediaShrink 同口径：长边 1600 转 jpeg，截图里的字和照片里的文档仍读得出 */
const IMAGE_MAX_EDGE = 1600;

const IMAGE_JPEG_QUALITY = 0.72;

const SHRINK_MIN_BYTES = 300 * 1024;

const MAX_IMAGE_SOURCE_BYTES = 128 * 1024 * 1024;

const SHRINKABLE_IMAGE = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/heic",
  "image/heif",
  "image/avif",
]);

const shrunkFiles = new WeakSet<File>();

/** 浏览器本地压图；带透明（多半是素材/图标）、解不开、省不到 20% 都返回原件 */
export async function shrinkImageFile(file: File): Promise<File> {
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (shrunkFiles.has(file) || !SHRINKABLE_IMAGE.has(mime) || file.size < SHRINK_MIN_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height, 1));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    if (mime !== "image/jpeg" && hasTransparency(ctx.getImageData(0, 0, width, height).data)) return file;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", IMAGE_JPEG_QUALITY));
    if (!blob || blob.size >= file.size * 0.8) return file;
    const name = `${(file.name || "image").replace(/\.[^./]+$/, "")}.jpg`;
    const out = new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
    shrunkFiles.add(out);
    return out;
  } catch {
    return file;
  }
}

function hasTransparency(pixels: Uint8ClampedArray) {
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) return true;
  }
  return false;
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export function formatUploadMb(bytes: number) {
  if (!bytes) return "0MB";
  return `${Math.max(0.1, bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
}
