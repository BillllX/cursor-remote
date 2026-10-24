import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const ALLOWED_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"]);

export class ControlledWebError extends Error {}

const ipv4Number = (address: string) =>
  address.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);

function ipv6Number(rawAddress: string): bigint | undefined {
  let address = rawAddress
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!;
  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    const ipv4 = address.slice(separator + 1);
    if (separator < 0 || isIP(ipv4) !== 4) return undefined;
    const value = ipv4Number(ipv4);
    address = `${address.slice(0, separator)}:${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6InRange(value: bigint, base: string, bits: number) {
  const baseValue = ipv6Number(base);
  if (baseValue === undefined) return false;
  const shift = BigInt(128 - bits);
  return value >> shift === baseValue >> shift;
}

export function isPublicAddress(rawAddress: string): boolean {
  // WHATWG URL 对 IPv6 literal 保留方括号；DNS 返回值则没有，统一后再判断。
  const address = rawAddress
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4Number(address);
    const inRange = (base: string, bits: number) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4Number(base) & mask);
    };
    return ![
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, bits]) => inRange(base as string, bits as number));
  }
  if (version === 6) {
    const value = ipv6Number(address);
    if (value === undefined) return false;
    // ORCHIDv2 是 RFC 7343 的 2001:20::/28；不用已废弃的旧 ORCHID 2001:10::/28。
    return ![
      ["::", 128],
      ["::1", 128],
      ["64:ff9b::", 96], // NAT64 well-known prefix
      ["2002::", 16], // 6to4
      ["2001:20::", 28], // ORCHIDv2
      ["2001:db8::", 32], // 文档地址
      ["fc00::", 7],
      ["fe80::", 10],
      ["ff00::", 8],
    ].some(([base, bits]) => ipv6InRange(value, base as string, bits as number));
  }
  return false;
}

export function validateControlledURL(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlledWebError("网址格式无效。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ControlledWebError("只允许读取 http 或 https 网页。");
  }
  if (url.username || url.password) throw new ControlledWebError("网址不能包含账号或密码。");
  if (!url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new ControlledWebError("不能读取本机地址。");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new ControlledWebError("只允许网页标准端口。");
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) && !isPublicAddress(url.hostname)) {
    throw new ControlledWebError("不能读取私网或本地地址。");
  }
  return url;
}

type Address = { address: string; family: 4 | 6 };
type WebStep = { status: number; headers: Record<string, string | undefined>; body: Buffer };
export type ControlledWebDeps = {
  resolve?: (hostname: string) => Promise<Address[]>;
  request?: (
    url: URL,
    address: Address,
    timeoutMs: number,
    maximumBytes: number,
    signal: AbortSignal,
  ) => Promise<WebStep>;
  /** 仅供定向测试缩短总截止；生产固定为 10 秒。 */
  wallClockTimeoutMs?: number;
};

async function resolvePublic(
  url: URL,
  resolve: NonNullable<ControlledWebDeps["resolve"]>,
  signal: AbortSignal,
): Promise<Address> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(hostname);
  const addresses: Address[] = literal ? [{ address: hostname, family: literal as 4 | 6 }] : await resolve(hostname);
  if (signal.aborted) throw new ControlledWebError("网页读取超时。");
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    // 一个主机同时解析到公网和私网也拒绝，避免轮转记录绕过检查。
    throw new ControlledWebError("网址解析到了私网、本机或保留地址。");
  }
  return addresses[0]!;
}

function defaultRequest(
  url: URL,
  pinned: Address,
  timeoutMs: number,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<WebStep> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(
      url,
      {
        method: "GET",
        signal,
        headers: { accept: "text/html,text/plain;q=0.9", "user-agent": "Jiebo-WebReader/1" },
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maximumBytes) {
            request.destroy(new ControlledWebError("网页超过 1 MB 限制。"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              location: response.headers.location,
              "content-type": Array.isArray(response.headers["content-type"])
                ? response.headers["content-type"][0]
                : response.headers["content-type"],
            },
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new ControlledWebError("网页读取超时。")));
    request.on("error", reject);
    request.end();
  });
}

const decodeEntities = (text: string) =>
  text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

function extractText(body: string, html: boolean) {
  if (!html) return body.trim();
  return decodeEntities(
    body
      // 标题单独返回，正文不重复标题。
      .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, " ")
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

async function readControlledWebWithinDeadline(rawURL: string, deps: ControlledWebDeps, signal: AbortSignal) {
  const resolve =
    deps.resolve ??
    (async (hostname: string) =>
      (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => ({
        address: entry.address,
        family: entry.family as 4 | 6,
      })));
  const request = deps.request ?? defaultRequest;
  let url = validateControlledURL(rawURL);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (signal.aborted) throw new ControlledWebError("网页读取超时。");
    const address = await resolvePublic(url, resolve, signal);
    const response = await request(url, address, TIMEOUT_MS, MAX_BYTES, signal);
    if (response.status >= 300 && response.status < 400) {
      if (!response.headers.location || redirect === MAX_REDIRECTS) {
        throw new ControlledWebError("网页重定向次数过多或缺少目标。");
      }
      url = validateControlledURL(new URL(response.headers.location, url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ControlledWebError(`网页返回 HTTP ${response.status}。`);
    }
    const contentType = (response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) throw new ControlledWebError("网页内容类型不受支持。");
    if (response.body.length > MAX_BYTES) throw new ControlledWebError("网页超过 1 MB 限制。");
    const source = response.body.toString("utf8");
    const title =
      contentType === "text/plain"
        ? undefined
        : decodeEntities(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300) || undefined;
    return {
      url: url.toString(),
      title,
      text: extractText(source, contentType !== "text/plain").slice(0, 80_000),
      truncated: source.length > 80_000,
    };
  }
  throw new ControlledWebError("网页重定向次数过多。");
}

/** DNS、所有重定向和正文读取共用一个 10 秒 wall-clock 截止；socket timeout 仍作为连接级第二道保护。 */
export async function readControlledWeb(rawURL: string, deps: ControlledWebDeps = {}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ControlledWebError("网页读取超时。"));
      controller.abort();
    }, deps.wallClockTimeoutMs ?? TIMEOUT_MS);
  });
  try {
    return await Promise.race([readControlledWebWithinDeadline(rawURL, deps, controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
