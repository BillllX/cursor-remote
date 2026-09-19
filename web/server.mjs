import { createServer } from "node:http";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 3020);
const hostname = process.env.HOST || "127.0.0.1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const gatewayWs = process.env.GATEWAY_WS_URL || "ws://127.0.0.1:8787";
const bridgePath = `${basePath}/bridge`;

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end("web error");
  });
});

const wss = new WebSocketServer({ noServer: true });

function pipeSockets(left, right) {
  const forward = (from, to) => {
    from.on("message", (data, isBinary) => {
      if (to.readyState === WebSocket.OPEN) to.send(data, { binary: Boolean(isBinary) });
    });
    from.on("close", () => {
      if (to.readyState === WebSocket.OPEN || to.readyState === WebSocket.CONNECTING) to.close();
    });
    from.on("error", () => {
      if (to.readyState === WebSocket.OPEN || to.readyState === WebSocket.CONNECTING) to.close();
    });
  };
  forward(left, right);
  forward(right, left);
}

server.on("upgrade", (req, socket, head) => {
  const path = (req.url || "").split("?")[0];
  if (path !== bridgePath && path !== `${bridgePath}/`) {
    socket.destroy();
    return;
  }
  const upstream = new WebSocket(gatewayWs);
  const fail = () => {
    try {
      upstream.close();
    } catch {
      // ignore
    }
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  };
  const timer = setTimeout(fail, 20000);
  upstream.once("error", fail);
  upstream.once("open", () => {
    clearTimeout(timer);
    wss.handleUpgrade(req, socket, head, (client) => {
      pipeSockets(client, upstream);
      client.on("error", fail);
    });
  });
});

server.listen(port, hostname, () => {
  console.log(`jiebo web  http://${hostname}:${port}${basePath || "/"}`);
  console.log(`bridge             ${bridgePath} -> ${gatewayWs}`);
});
