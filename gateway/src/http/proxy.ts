// 反代本机 Next 网页（HTTP 与 websocket upgrade）
import { type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { peerIp } from "../auth/login.ts";
import { webUrl } from "../runtime/env.ts";

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function proxyWeb(req: IncomingMessage, res: ServerResponse) {
  const headers: Record<string, string | string[] | number | undefined> = {
    host: webUrl().host,
    "x-forwarded-host": String(req.headers.host || ""),
    "x-forwarded-proto": String(req.headers["x-forwarded-proto"] || "http"),
    "x-forwarded-for": peerIp(req),
  };
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  const upstream = httpRequest(
    {
      protocol: webUrl().protocol,
      hostname: webUrl().hostname,
      port: webUrl().port || (webUrl().protocol === "https:" ? 443 : 80),
      path: req.url,
      method: req.method,
      headers,
    },
    (incoming) => {
      const outHeaders = { ...incoming.headers };
      delete outHeaders["transfer-encoding"];
      res.writeHead(incoming.statusCode || 502, outHeaders);
      incoming.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("网页没起来。请先启动 Next（本机 npm run dev，或 VPS 上的 cursor-remote 服务）。");
  });
  req.pipe(upstream);
}

export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const headers = { ...req.headers, host: webUrl().host };
  const upstream = httpRequest({
    protocol: webUrl().protocol,
    hostname: webUrl().hostname,
    port: webUrl().port || (webUrl().protocol === "https:" ? 443 : 80),
    path: req.url,
    method: "GET",
    headers,
  });
  upstream.on("upgrade", (incoming, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}`];
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${key}: ${item}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upSocket.write(head);
    if (upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
}
