// 即时消息端到端冒烟：临时目录起真实网关进程（127.0.0.1、随机空闲端口），本地 h2c 模拟 APNs，
// 用 ws 模拟两台 iOS（caps ["im"]、maxMessageBytes 900000）和一个不带 im 的网页连接。
// 不碰 /etc/cursor-remote、线上网关和外网；临时数据结束时清理。
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createH2Server, type Http2Server } from "node:http2";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { ClientMessage, ImTicket, ServerMessage } from "../../../shared/protocol.ts";

const GATEWAY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const dir = mkdtempSync(resolve(tmpdir(), "im-smoke-"));

let passed = 0;
let failed = 0;
function check(ok: boolean, label: string) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function waitFor(pred: () => boolean, ms = 5000) {
  for (let waited = 0; waited < ms && !pred(); waited += 50) await sleep(50);
  return pred();
}

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

type Seen = { token: string; headers: Record<string, string>; body: string };
const apnsSeen: Seen[] = [];
let apns: Http2Server | null = null;
let gateway: ChildProcess | null = null;
let gatewayLog = "";
const sockets: WebSocket[] = [];

type Client = {
  name: string;
  ws: WebSocket;
  got: ServerMessage[];
  send: (message: ClientMessage) => void;
  next: <T extends ServerMessage["type"]>(
    type: T,
    pred?: (message: Extract<ServerMessage, { type: T }>) => boolean,
  ) => Promise<Extract<ServerMessage, { type: T }>>;
};

async function connect(url: string, name: string, token: string, caps: string[]): Promise<Client> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const got: ServerMessage[] = [];
  ws.on("message", (data) => got.push(JSON.parse(String(data)) as ServerMessage));
  await new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  const client: Client = {
    name,
    ws,
    got,
    send: (message) => ws.send(JSON.stringify(message)),
    next: async (type, pred) => {
      const seen = got.length;
      type M = Extract<ServerMessage, { type: typeof type }>;
      const match = (m: ServerMessage): m is M => m.type === type && (!pred || pred(m as never));
      const ok = await waitFor(() => got.slice(seen).some(match));
      if (!ok) throw new Error(`${name} 等 ${type} 超时`);
      return got.slice(seen).find(match) as never;
    },
  };
  client.send({
    type: "hello",
    token,
    client: { name: caps.includes("im") ? "jiebo-ios" : "web", version: "smoke", maxMessageBytes: 900000, caps },
  });
  await client.next("ready");
  return client;
}

/** 发一条请求并等它的回包；回包类型不对（比如 im_error）就照样返回让调用方判断 */
async function ask<T extends ServerMessage["type"]>(client: Client, message: ClientMessage, type: T) {
  const seen = client.got.length;
  client.send(message);
  const ok = await waitFor(() => client.got.slice(seen).some((m) => m.type === type || m.type === "im_error"));
  if (!ok) throw new Error(`${client.name} 等 ${type} 超时`);
  return client.got.slice(seen).find((m) => m.type === type || m.type === "im_error") as
    Extract<ServerMessage, { type: T }> | Extract<ServerMessage, { type: "im_error" }>;
}

const mediaUrl = (base: string, scope: string, blob: string, ticket: ImTicket) =>
  `${base}/media/im?${new URLSearchParams({ scope, blob, exp: String(ticket.exp), sig: ticket.sig })}`;

try {
  /* ── 假 APNs ── */
  apns = createH2Server();
  apns.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      apnsSeen.push({
        token: String(headers[":path"]).replace("/3/device/", ""),
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      stream.respond({ ":status": 200 });
      stream.end();
    });
  });
  await new Promise<void>((done) => apns!.listen(0, "127.0.0.1", done));
  const apnsPort = (apns.address() as AddressInfo).port;

  /* ── 租户与网关 ── */
  const tok = () => randomBytes(12).toString("hex");
  const T = { a: tok(), b: tok(), c: tok() };
  writeFileSync(
    resolve(dir, "tenants.json"),
    JSON.stringify({
      tenants: [
        { id: "a", name: "Alice", token: T.a },
        { id: "b", name: "Bob", token: T.b },
        { id: "c", name: "Carol", token: T.c, imHidden: true },
      ],
    }),
  );
  const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(APNS_|CURSOR_)/.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    CURSOR_REMOTE_STATE_DIR: resolve(dir, "state"),
    CURSOR_REMOTE_TENANTS_FILE: resolve(dir, "tenants.json"),
    CURSOR_REMOTE_MEDIA_SECRET: "im-smoke-secret",
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(port),
    APNS_TEAM_ID: "TEAM123456",
    APNS_KEY_ID: "KEY1234567",
    APNS_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
    APNS_BUNDLE_ID: "com.example.jiebo",
    APNS_HOST_OVERRIDE: `http://127.0.0.1:${apnsPort}`,
  });
  gateway = spawn(process.execPath, [TSX, GATEWAY], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  gateway.stdout?.on("data", (chunk) => (gatewayLog += String(chunk)));
  gateway.stderr?.on("data", (chunk) => (gatewayLog += String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  const up = await waitFor(() => /cursor-remote gateway/.test(gatewayLog), 30_000);
  check(up, "网关在临时目录启动");
  if (!up) throw new Error(`网关没起来：\n${gatewayLog}`);
  const wsUrl = `ws://127.0.0.1:${port}/bridge`;

  const a = await connect(wsUrl, "a", T.a, ["im"]);
  const b = await connect(wsUrl, "b", T.b, ["im"]);
  const c = await connect(wsUrl, "c", T.c, ["im"]);
  const web = await connect(wsUrl, "web", T.b, ["sync_chat"]);
  const ready = a.got.find((m) => m.type === "ready");
  check(Boolean(ready && ready.type === "ready" && ready.features?.includes("im")), "ready.features 含 im");

  /* ── 可见性 ── */
  const contactsA = await ask(a, { type: "im_contacts" }, "im_contacts");
  check(
    contactsA.type === "im_contacts" && contactsA.users.map((u) => u.id).join(",") === "b",
    "a 的联系人只有 b（看不到 imHidden 的 c）",
  );
  const contactsC = await ask(c, { type: "im_contacts" }, "im_contacts");
  check(contactsC.type === "im_contacts" && contactsC.users.length === 0, "c 看不到正式用户");
  const toC = await ask(a, { type: "im_send", clientId: "x-1", to: "c", kind: "text", body: { text: "hi" } }, "im_ack");
  check(
    toC.type === "im_error" && toC.code === "not_visible" && toC.clientId === "x-1",
    "a 发给 c：im_error not_visible",
  );
  const noCap = await ask(web, { type: "im_list" }, "im_list");
  check(noCap.type === "im_error" && noCap.code === "no_cap", "不带 im cap 的连接请求 im_*：im_error no_cap");
  web.got.length = 0;

  /* ── a → b 文字 ── */
  const bGot = b.next("im_message", (m) => m.message.clientId === "t-1");
  const ack1 = await ask(
    a,
    { type: "im_send", clientId: "t-1", to: "b", kind: "text", body: { text: "你好 b" } },
    "im_ack",
  );
  const conv = ack1.type === "im_ack" ? ack1.convId : "";
  check(ack1.type === "im_ack" && conv === "dm~a~b" && ack1.seq === 1, "a 发文字：im_ack seq=1，convId=dm~a~b");
  const m1 = await bGot;
  check(
    m1.message.from === "a" && (m1.message.body as { text: string }).text === "你好 b" && Boolean(m1.ticket.sig),
    "b 收到 im_message（带票据）",
  );
  check(!a.got.some((m) => m.type === "im_message"), "发件连接不收自己的 im_message（只收 ack）");
  check(apnsSeen.length === 0, "b 在前台：不发 APNs");

  /* ── b 切后台 → 推送不带正文 ── */
  const sub = await ask(
    b,
    {
      type: "assistant_op",
      op: "push_subscribe",
      args: { kind: "apns", token: "ab".repeat(32), bundleId: "com.example.jiebo", environment: "sandbox", im: true },
    },
    "assistant_result",
  );
  check(sub.type === "assistant_result" && sub.ok, "b 订阅 APNs（im: true）");
  b.send({ type: "im_presence", foreground: false });
  await sleep(150);
  const secret = "这是第二条秘密正文";
  await ask(a, { type: "im_send", clientId: "t-2", to: "b", kind: "text", body: { text: secret } }, "im_ack");
  check(await waitFor(() => apnsSeen.length === 1), "b 在后台：模拟 APNs 收到 1 条");
  const p1 = apnsSeen[0] ? JSON.parse(apnsSeen[0].body) : {};
  check(!apnsSeen[0]?.body.includes(secret), "notifyPreview 关：通知不含正文");
  check(
    p1.aps?.alert?.title === "Alice" && p1.aps?.alert?.body === "发来 2 条消息" && p1.aps?.badge === 2,
    "通知：title=发件人昵称，body=发来 2 条消息，badge=2",
  );
  check(
    p1.aps?.["thread-id"] === "im-dm~a~b" &&
      p1.cr?.kind === "im" &&
      p1.cr?.convId === conv &&
      p1.cr?.seq === 2 &&
      apnsSeen[0].headers["apns-priority"] === "10" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(apnsSeen[0].headers["apns-collapse-id"] ?? ""),
    "通知：thread-id、cr、priority 10、collapse-id",
  );

  /* ── 打开预览 ── */
  const prefs = await ask(b, { type: "im_profile", notifyPreview: true }, "im_update");
  check(
    prefs.type === "im_update" && prefs.what === "prefs" && prefs.me?.notifyPreview === true,
    "b 打开 notifyPreview",
  );
  await ask(a, { type: "im_send", clientId: "t-3", to: "b", kind: "text", body: { text: "看得见的正文" } }, "im_ack");
  check(await waitFor(() => apnsSeen.length === 2), "再发一条：APNs 收到第 2 条");
  check(JSON.parse(apnsSeen[1]?.body ?? "{}").aps?.alert?.body === "看得见的正文", "notifyPreview 开：通知带正文");

  /* ── 图片 ── */
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(4096)]);
  const upload = async (token: string, kind: string, mime: string, body: Buffer) => {
    const res = await fetch(`${base}/upload/im?kind=${kind}&mime=${encodeURIComponent(mime)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: new Uint8Array(body),
    });
    return { status: res.status, json: (await res.json()) as { blob?: string; size?: number; mime?: string } };
  };
  const unauth = await upload("wrong", "image", "image/png", png);
  check(unauth.status === 401, "上传：口令不对 401");
  const svg = await upload(T.a, "image", "image/svg+xml", Buffer.from("<svg/>"));
  check(svg.status === 400, "上传：图片不收 svg");
  const big = await upload(T.a, "voice", "audio/m4a", Buffer.alloc(2 * 1024 * 1024 + 1));
  check(big.status === 413, "上传：语音超过 2MB 被拒");
  const img = await upload(T.a, "image", "image/png", png);
  const thumb = await upload(T.a, "thumb", "image/png", png.subarray(0, 1024));
  check(
    img.status === 200 && /^[0-9a-f]{64}$/.test(img.json.blob ?? "") && img.json.size === png.length,
    "上传图片：返回 blob / size / mime",
  );
  const fakePng = await upload(T.a, "image", "image/png", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
  check(fakePng.status === 400, "上传：声明 image/png 但内容不是图片（svg）被拒");

  /* ── 上传鉴权与并发（评审 7） ── */
  const blobDir = resolve(dir, "state", "im", "blobs");
  /** 声明很大的 Content-Length、只发一点就停：网关要是先读 body 就永远不会回 */
  const hanging = (headers: Record<string, string>, declared: number, sent: Buffer) => {
    const req = httpRequest(`${base}/upload/im?kind=file&mime=application%2Foctet-stream`, {
      method: "POST",
      headers: { "content-length": String(declared), ...headers },
    });
    const status = new Promise<number>((done) => {
      req.on("response", (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      });
      req.on("error", () => done(-1));
    });
    req.write(sent);
    return { req, status };
  };
  const within = <T>(work: Promise<T>, ms: number) => Promise.race([work, sleep(ms).then(() => "timeout" as const)]);
  const noAuth = hanging({ "content-type": "application/octet-stream" }, 30 * 1024 * 1024, Buffer.alloc(1024));
  check((await within(noAuth.status, 3000)) === 401, "没有 Authorization 的原始上传：不读 body 直接 401");
  noAuth.req.destroy();
  const badAuth = hanging({ authorization: "Bearer wrong" }, 30 * 1024 * 1024, Buffer.alloc(1024));
  check((await within(badAuth.status, 3000)) === 401, "Authorization 口令不对：不读 body 直接 401");
  badAuth.req.destroy();

  const multipart = (token: string, content: string) => {
    const boundary = `----im${randomBytes(6).toString("hex")}`;
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${token}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    );
    return { body, type: `multipart/form-data; boundary=${boundary}` };
  };
  const postMultipart = async (token: string, content: string) => {
    const form = multipart(token, content);
    const res = await fetch(`${base}/upload/im?kind=file&mime=text%2Fplain`, {
      method: "POST",
      headers: { "content-type": form.type },
      body: new Uint8Array(form.body),
    });
    return { status: res.status, json: (await res.json()) as { blob?: string; size?: number } };
  };
  const formUp = await postMultipart(T.a, "hello multipart");
  check(formUp.status === 200 && formUp.json.size === 15, "multipart（token 在表单里）上传可用");
  check((await postMultipart("wrong", "x")).status === 401, "multipart 表单 token 不对 401");
  const stuck = Array.from({ length: 4 }, () =>
    hanging({ "content-type": "multipart/form-data; boundary=zz" }, 1024 * 1024, Buffer.from("--zz\r\n")),
  );
  await sleep(300);
  const fifth = await within(postMultipart(T.a, "第五个"), 3000);
  check(typeof fifth === "object" && fifth.status === 503, "未鉴权上传同时最多 4 个：第 5 个 503");
  for (const item of stuck) item.req.destroy();
  await sleep(300);
  const released = await postMultipart(T.a, "hello again");
  check(released.status === 200, "未鉴权上传断开后名额归还");
  const authedForms = Array.from({ length: 4 }, () =>
    hanging(
      { authorization: `Bearer ${T.a}`, "content-type": "multipart/form-data; boundary=zz" },
      1024 * 1024,
      Buffer.from("--zz\r\n"),
    ),
  );
  await sleep(300);
  const formBusy = await within(postMultipart(T.b, "带头的也算"), 3000);
  check(typeof formBusy === "object" && formBusy.status === 503, "带 Authorization 的 multipart 也占全局 4 个名额");
  for (const item of authedForms) item.req.destroy();
  await sleep(300);
  const streams = Array.from({ length: 6 }, () =>
    hanging(
      { authorization: `Bearer ${T.b}`, "content-type": "application/octet-stream" },
      1024 * 1024,
      Buffer.alloc(1024),
    ),
  );
  await sleep(300);
  const seventh = await within(upload(T.b, "file", "application/octet-stream", Buffer.from("第七个")), 3000);
  check(typeof seventh === "object" && seventh.status === 429, "已鉴权的流式上传每租户同时最多 6 个：第 7 个 429");
  const otherTenant = await upload(T.a, "file", "application/octet-stream", Buffer.from("别的租户不受影响"));
  check(otherTenant.status === 200, "别的租户的流式上传不受影响");
  for (const item of streams) item.req.destroy();
  await sleep(300);
  const streamAgain = await upload(T.b, "file", "application/octet-stream", Buffer.from("名额归还"));
  check(streamAgain.status === 200, "流式上传断开后名额归还");
  const aborted = hanging(
    { authorization: `Bearer ${T.a}`, "content-type": "application/octet-stream" },
    1024 * 1024,
    Buffer.alloc(64 * 1024),
  );
  await sleep(300);
  aborted.req.destroy();
  await sleep(300);
  check(
    readdirSync(blobDir).every((name) => !name.startsWith(".upload-")),
    "已鉴权的流式上传中途断开：临时文件删掉，blobs 里没有残留",
  );
  const bImg = b.next("im_message", (m) => m.message.kind === "image");
  const imgAck = await ask(
    a,
    {
      type: "im_send",
      clientId: "img-1",
      to: "b",
      kind: "image",
      body: { blob: img.json.blob!, thumb: thumb.json.blob!, w: 64, h: 64, original: true },
    },
    "im_ack",
  );
  check(imgAck.type === "im_ack", "发图片：im_ack");
  const imgMsg = await bImg;
  check(
    (await waitFor(() => apnsSeen.length === 3)) && JSON.parse(apnsSeen[2].body).aps?.alert?.body === "[图片]",
    "图片通知（预览开）：[图片]",
  );
  const getRes = await fetch(mediaUrl(base, conv, img.json.blob!, imgMsg.ticket));
  const bytes = Buffer.from(await getRes.arrayBuffer());
  check(getRes.status === 200 && bytes.equals(png), "b 用会话票据 GET /media/im 拿到同样字节");
  check(
    getRes.headers.get("content-type") === "image/png" &&
      /immutable/.test(getRes.headers.get("cache-control") ?? "") &&
      /sandbox/.test(getRes.headers.get("content-security-policy") ?? ""),
    "下载头：content-type 按记录、cache-control immutable、CSP sandbox",
  );
  const ranged = await fetch(mediaUrl(base, conv, img.json.blob!, imgMsg.ticket), { headers: { range: "bytes=0-7" } });
  const rangedBytes = Buffer.from(await ranged.arrayBuffer());
  check(ranged.status === 206 && rangedBytes.equals(png.subarray(0, 8)), "Range 请求返回 206 和对应字节");
  const cTicket = contactsC.type === "im_contacts" ? contactsC.avatarTicket : { exp: 0, sig: "" };
  const cAvatar = await fetch(mediaUrl(base, "avatars", img.json.blob!, cTicket));
  const cForged = await fetch(mediaUrl(base, conv, img.json.blob!, cTicket));
  check(cAvatar.status === 404 && cForged.status === 401, "c 的票据拿不到这张图（avatars 404，挪用到会话 401）");
  const cHistory = await ask(c, { type: "im_history", convId: conv }, "im_history");
  check(cHistory.type === "im_error" && cHistory.code === "not_found", "c 读不了 a、b 的会话");

  /* ── 撤回 ── */
  const imgSeq = imgAck.type === "im_ack" ? imgAck.seq : 0;
  const imgPush = apnsSeen[2];
  const bRecall = b.next("im_update", (m) => m.what === "recall");
  const recall = await ask(a, { type: "im_recall", convId: conv, seq: imgSeq }, "im_update");
  check(
    recall.type === "im_update" && recall.what === "recall" && recall.seq === imgSeq,
    "a 撤回图片：im_update recall",
  );
  check((await bRecall).seq === imgSeq, "b 收到撤回");
  check(await waitFor(() => apnsSeen.length === 4), "推过的消息撤回后补发替换通知");
  const recallPush = apnsSeen[3]?.body.includes("撤回了一条消息") ? apnsSeen[3] : undefined;
  check(
    Boolean(recallPush && imgPush && recallPush.headers["apns-collapse-id"] === imgPush.headers["apns-collapse-id"]),
    "撤回通知和原通知同一个 collapse-id",
  );
  const hist = await ask(b, { type: "im_history", convId: conv }, "im_history");
  const recalled = hist.type === "im_history" ? hist.messages.find((m) => m.seq === imgSeq) : undefined;
  check(Boolean(recalled?.recalled && recalled.body === undefined), "b 的历史里这条显示已撤回、没有 body");
  const histA = await ask(a, { type: "im_history", convId: conv }, "im_history");
  const aTicket = histA.type === "im_history" ? histA.ticket : { exp: 0, sig: "" };
  const afterRecall = await Promise.all([
    fetch(mediaUrl(base, conv, img.json.blob!, imgMsg.ticket)),
    fetch(mediaUrl(base, conv, thumb.json.blob!, imgMsg.ticket)),
    fetch(mediaUrl(base, conv, img.json.blob!, aTicket)),
  ]);
  check(
    afterRecall.every((res) => res.status === 404),
    "撤回后双方都下载不到原图和缩略图（404）",
  );

  /* ── 重复 clientId ── */
  const dupMsg: ClientMessage = { type: "im_send", clientId: "dup-1", to: "b", kind: "text", body: { text: "只一条" } };
  const d1 = await ask(a, dupMsg, "im_ack");
  const d2 = await ask(a, dupMsg, "im_ack");
  check(
    d1.type === "im_ack" && d2.type === "im_ack" && d1.seq === d2.seq && d1.at === d2.at,
    "重复 clientId：同一个 ack",
  );
  const segDir = resolve(dir, "state", "im", "conversations", conv);
  const lines = readFileSync(resolve(segDir, "00000.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes('"clientId":"dup-1"'));
  check(lines.length === 1, "重复 clientId 只存一条");

  /* ── 已读 → 静默推送 ── */
  const silentBefore = apnsSeen.length;
  const maxSeq = d1.type === "im_ack" ? d1.seq : 0;
  b.send({ type: "im_read", convId: conv, seq: maxSeq });
  check(await waitFor(() => apnsSeen.length === silentBefore + 1), "im_read 后发 1 条静默推送");
  const silent = apnsSeen[silentBefore];
  const silentBody = silent ? JSON.parse(silent.body) : {};
  check(
    silent?.headers["apns-push-type"] === "background" &&
      silent.headers["apns-priority"] === "5" &&
      silentBody.aps?.["content-available"] === 1 &&
      !silentBody.aps?.alert &&
      silentBody.aps?.badge === 0 &&
      silentBody.cr?.kind === "im_read",
    "静默推送：background、priority 5、content-available、无 alert、badge=0",
  );
  const listB = await ask(b, { type: "im_list", limit: 1 }, "im_list");
  check(
    listB.type === "im_list" && listB.convs[0]?.unread === 0 && listB.convs[0]?.readSeq === maxSeq,
    "im_list：已读后未读 0",
  );
  check(
    listB.type === "im_list" && listB.convs.length === 1 && listB.more === false && listB.cursor === undefined,
    "im_list 分页：只有一个会话时 more=false、没有 cursor",
  );

  /* ── 网页连接收不到 im_* ── */
  await sleep(200);
  check(!web.got.some((m) => m.type.startsWith("im_")), "不带 im cap 的网页连接没收到任何 im_* 消息");

  /* ── 日志不含正文 ── */
  const pushLog = resolve(dir, "state", "tenants", "b", "assistant", "push-log.jsonl");
  const pushLogText = existsSync(pushLog) ? readFileSync(pushLog, "utf8") : "";
  check(
    pushLogText.length > 0 && !pushLogText.includes(secret) && !pushLogText.includes("看得见的正文"),
    "推送日志不含消息正文",
  );
  check(!gatewayLog.includes(secret) && !gatewayLog.includes("看得见的正文"), "网关日志不含消息正文");
  check(
    readdirSync(resolve(dir, "state", "im", "blobs")).filter((name) => /^[0-9a-f]{64}$/.test(name)).length === 6,
    "blobs 目录按 sha256 存了 6 个附件（被拒的上传不留文件）",
  );
} catch (err) {
  failed += 1;
  console.log("FAIL  冒烟异常：", err instanceof Error ? err.message : err);
} finally {
  for (const ws of sockets) ws.terminate();
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    await new Promise((done) => {
      gateway!.once("exit", done);
      setTimeout(done, 5000);
    });
  }
  await new Promise<void>((done) => (apns ? apns.close(() => done()) : done()));
  rmSync(dir, { recursive: true, force: true });
}

if (failed && gatewayLog) console.log(`\n--- 网关日志（末尾） ---\n${gatewayLog.slice(-4000)}`);
console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
