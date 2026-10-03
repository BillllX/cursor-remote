// 用法：node scripts/build-icons.mjs
// 输入：生图原稿（brand/vi/icons/explorations/v2/concept-b-chat-terminal.jpg）+ 小尺寸矢量（brand/vi/mark-v2.svg）
// 输出：brand/vi/icons/production/*.png 与 web/public 下全部图标
import { readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require("sharp");
} catch {
  console.error("缺 sharp：它只是 next 的可选依赖，先 npm i -D sharp 再跑。");
  process.exit(1);
}
const root = fileURLToPath(new URL("..", import.meta.url));
const at = (p) => root + p;

const SOURCE = at("brand/vi/icons/explorations/v2/concept-b-chat-terminal.jpg");
const MARK_SVG = at("brand/vi/mark-v2.svg");
const PROD = at("brand/vi/icons/production/");
const PUB = at("web/public/");

// 原稿三色 → 品牌三色。生图的底色偏灰且有噪点，按重心坐标映射，边缘抗锯齿保留。
const SRC = [
  [30, 70, 59],
  [245, 238, 222],
  [195, 156, 81],
];
const DST = [
  [26, 79, 65],
  [243, 238, 228],
  [196, 163, 106],
];
const PINE = { r: 26, g: 79, b: 65 };

function barycentric(p) {
  const [a, b, c] = SRC;
  const v0 = b.map((x, i) => x - a[i]);
  const v1 = c.map((x, i) => x - a[i]);
  const v2 = p.map((x, i) => x - a[i]);
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01;
  let wb = (d11 * d20 - d01 * d21) / den;
  let wc = (d00 * d21 - d01 * d20) / den;
  wb = Math.min(1, Math.max(0, wb));
  wc = Math.min(1, Math.max(0, wc));
  const sum = wb + wc;
  if (sum > 1) {
    wb /= sum;
    wc /= sum;
  }
  // 吸附：小于 6% 的分量视作噪点，平涂区才能被调色板压到很小。
  if (wb < 0.06) wb = 0;
  if (wc < 0.06) wc = 0;
  if (wb > 0.94) wb = 1;
  if (wc > 0.94) wc = 1;
  return [Math.max(0, 1 - wb - wc), wb, wc];
}

async function cleanSource() {
  const { data, info } = await sharp(SOURCE).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 3);
  for (let i = 0, o = 0; i < data.length; i += info.channels, o += 3) {
    const w = barycentric([data[i], data[i + 1], data[i + 2]]);
    for (let k = 0; k < 3; k++) {
      out[o + k] = Math.round(w[0] * DST[0][k] + w[1] * DST[1][k] + w[2] * DST[2][k]);
    }
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}

const png = (img, colours = 64) => img.png({ palette: true, colours, effort: 10, compressionLevel: 9 });

async function maskable(clean) {
  const size = 1024;
  const inner = 820;
  const scaled = await sharp(clean).resize(inner, inner).toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: PINE } })
    .composite([{ input: scaled, left: (size - inner) / 2, top: (size - inner) / 2 }])
    .png()
    .toBuffer();
}

async function fromSvg(size) {
  return png(sharp(readFileSync(MARK_SVG), { density: Math.max(72, (72 * size * 4) / 32) }).resize(size, size), 48).toBuffer();
}

// ICO 直接内嵌 PNG（Vista 起都支持）。
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, buf }, i) => {
    const b = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, b);
    dir.writeUInt8(size >= 256 ? 0 : size, b + 1);
    dir.writeUInt8(0, b + 2);
    dir.writeUInt8(0, b + 3);
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(buf.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

const written = [];
function save(path, buf) {
  writeFileSync(path, buf);
  written.push(path);
}

const clean = await cleanSource();
const mask = await maskable(clean);

save(PROD + "app-icon-1024.png", await png(sharp(clean)).toBuffer());
save(PROD + "maskable-1024.png", await png(sharp(mask)).toBuffer());

save(PUB + "icon-512.png", await png(sharp(clean).resize(512, 512)).toBuffer());
save(PUB + "icon-192.png", await png(sharp(clean).resize(192, 192)).toBuffer());
save(PUB + "icon-maskable-512.png", await png(sharp(mask).resize(512, 512)).toBuffer());
save(PUB + "apple-touch-icon.png", await png(sharp(clean).resize(180, 180)).toBuffer());

const f16 = await fromSvg(16);
const f32 = await fromSvg(32);
const f48 = await fromSvg(48);
save(PUB + "favicon-16.png", f16);
save(PUB + "favicon-32.png", f32);
save(PUB + "favicon-48.png", f48);
save(PUB + "icon.png", await fromSvg(64));
save(PUB + "favicon.ico", ico([
  { size: 16, buf: f16 },
  { size: 32, buf: f32 },
  { size: 48, buf: f48 },
]));
copyFileSync(MARK_SVG, PUB + "favicon.svg");
written.push(PUB + "favicon.svg");

for (const path of written) {
  console.log(`${String(statSync(path).size).padStart(7)}  ${path.slice(root.length)}`);
}
