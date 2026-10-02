/** SSE 读取：兼容 \n\n 与 \r\n\r\n 分帧，长时间无数据判定停滞断开。onEvent 返回 true 时立即停止读取。 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  label: string,
  onEvent: (data: string, event: string) => void | boolean,
  idleMs = 120_000,
  maxBytes = Infinity,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const FRAME_RE = /\r?\n\r?\n/;
  let stopped = false;
  let total = 0;
  const handle = (frame: string) => {
    let event = "";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      else if (line.startsWith("event:")) event = line.slice(6).trim();
    }
    const joined = data.join("\n");
    if (!joined || joined.trim() === "[DONE]") return;
    if (onEvent(joined, event) === true) stopped = true;
  };
  const readChunk = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void reader.cancel().catch(() => {});
            reject(new Error(`${label} 流 ${idleMs / 1000}s 无数据，判定停滞断开`));
          }, idleMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let buffer = "";
  for (;;) {
    const { done, value } = await readChunk();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new Error(`${label} 返回内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB，已断开`);
    }
    buffer += decoder.decode(value, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = FRAME_RE.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      handle(frame);
      if (stopped) {
        void reader.cancel().catch(() => {});
        return;
      }
    }
  }
  if (buffer.trim()) handle(buffer);
}

export function redactSecrets(text: string) {
  return text
    .slice(0, 300)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/eyJ[A-Za-z0-9_.-]{10,}/g, "eyJ***");
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export async function httpError(res: Response, label: string): Promise<HttpError> {
  const body = await res.text().catch(() => "");
  const retry = Number(res.headers.get("retry-after"));
  return new HttpError(
    `${label} 接口 ${res.status}：${redactSecrets(body) || res.statusText}`,
    res.status,
    Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
  );
}
