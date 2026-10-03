import { generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * APNs 冒烟：不依赖外网。本地起 h2c（明文 HTTP/2）mock 服务代替 api.push.apple.com，
 * 验证 JWT、请求头、payload、410/500 处理、订阅文件迁移与上限、未配置时安静跳过。
 * 临时数据都放 os.tmpdir() 并在结束时清理。
 */

const dir = mkdtempSync(resolve(tmpdir(), "apns-smoke-"));
process.env.CURSOR_REMOTE_STATE_DIR = dir;
for (const key of Object.keys(process.env)) if (key.startsWith("APNS_")) delete process.env[key];

let passed = 0;
let failed = 0;
function check(ok: boolean, label: string) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

type Seen = { token: string; headers: Record<string, string>; body: string };
const seen: Seen[] = [];
const reply = new Map<string, { status: number; reason?: string }>();
let server: Http2Server | null = null;

const tok = (ch: string, len = 64) => ch.repeat(len);
const T_OK = tok("a");
const T_GONE = tok("b");
const T_BAD = tok("c");
const T_ERR = tok("d");
const T_OTHER400 = tok("e");
reply.set(T_GONE, { status: 410, reason: "Unregistered" });
reply.set(T_BAD, { status: 400, reason: "BadDeviceToken" });
reply.set(T_ERR, { status: 500, reason: "InternalServerError" });
reply.set(T_OTHER400, { status: 400, reason: "PayloadTooLarge" });

try {
  const apns = await import("./assistant/apns.ts");
  const push = await import("./assistant/push.ts");
  const inbox = await import("./assistant/inbox.ts");
  const service = await import("./assistant/service.ts");
  const { writeJson, assistantPath } = await import("./assistant/store.ts");

  const ref = (id: string) => ({ id, stateDir: resolve(dir, id) });
  const subsOf = (r: { id: string; stateDir: string }) => JSON.parse(readFileSync(assistantPath(r, "push-subs.json"), "utf8")) as { web: unknown[]; apns: Array<{ token: string; environment?: string; ua?: string; bundleId: string }>; subs?: unknown };
  const logOf = (r: { id: string; stateDir: string }) =>
    readFileSync(assistantPath(r, "push-log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { endpoint: string; ok: boolean; status: number; reason?: string });
  const message = { itemId: "i_1", kind: "reminder", title: "提醒", body: "喝水" };

  /* ── 未配置：安静跳过 ── */
  check(apns.apnsReady() === false, "未配置：pushApns 为 false");
  const r0 = ref("t0");
  push.addApnsSubscription(r0, { token: T_OK, bundleId: "com.example.jiebo", environment: "sandbox" });
  let threw = false;
  let none = { sent: -1, total: -1 };
  try {
    none = await apns.sendApns(r0, message);
  } catch {
    threw = true;
  }
  check(!threw && none.sent === 0 && none.total === 0, "未配置：sendApns 不抛错、不发送");
  check(!existsSync(assistantPath(r0, "push-log.jsonl")), "未配置：不写推送日志");

  /* ── 配置：自己生成 .p8（PKCS8 EC P-256） ── */
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.APNS_TEAM_ID = "TEAM123456";
  process.env.APNS_KEY_ID = "KEY1234567";
  process.env.APNS_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----";
  apns.resetApnsCache();
  const origError = console.error;
  console.error = () => undefined;
  check(apns.apnsReady() === false, "私钥无效：pushApns 为 false 且不抛错");
  console.error = origError;
  process.env.APNS_PRIVATE_KEY = pem.replace(/\n/g, "\\n");
  apns.resetApnsCache();
  check(apns.apnsReady() === true, "APNS_PRIVATE_KEY 允许 \\n 转义，配置后 pushApns 为 true");
  const keyFile = resolve(dir, "AuthKey_TEST.p8");
  writeFileSync(keyFile, pem);
  delete process.env.APNS_PRIVATE_KEY;
  process.env.APNS_PRIVATE_KEY_PATH = keyFile;
  apns.resetApnsCache();
  check(apns.apnsReady() === true, "APNS_PRIVATE_KEY_PATH 也能读");

  /* ── JWT ── */
  const cfg = apns.apnsConfig()!;
  const t0 = 1_800_000_000_000;
  const jwt = apns.apnsJwt(cfg, t0);
  const [h, c, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  check(header.alg === "ES256" && header.kid === "KEY1234567", "JWT：header 为 ES256 + kid");
  check(claims.iss === "TEAM123456" && claims.iat === Math.floor(t0 / 1000), "JWT：claims 为 iss=teamId、iat");
  const sigBytes = Buffer.from(s, "base64url");
  check(sigBytes.length === 64 && verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sigBytes), "JWT：签名为 64 字节 P1363，公钥可验证");
  check(apns.apnsJwt(cfg, t0 + 49 * 60_000) === jwt, "JWT：49 分钟内复用缓存");
  const jwt2 = apns.apnsJwt(cfg, t0 + 51 * 60_000);
  check(jwt2 !== jwt && JSON.parse(Buffer.from(jwt2.split(".")[1], "base64url").toString()).iat === Math.floor((t0 + 51 * 60_000) / 1000), "JWT：超过 50 分钟刷新");

  /* ── 主机名 ── */
  check(apns.apnsHost("sandbox", "") === "https://api.sandbox.push.apple.com" && apns.apnsHost("production", "") === "https://api.push.apple.com", "主机：sandbox / production 对应正确域名");
  check(apns.apnsHost("production", "http://127.0.0.1:1") === "http://127.0.0.1:1", "主机：APNS_HOST_OVERRIDE 可覆盖");

  /* ── mock h2c 服务 ── */
  server = createServer();
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const token = String(headers[":path"]).replace("/3/device/", "");
      seen.push({ token, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])), body: Buffer.concat(chunks).toString("utf8") });
      const out = reply.get(token) ?? { status: 200 };
      stream.respond({ ":status": out.status, "content-type": "application/json" });
      stream.end(out.reason ? JSON.stringify({ reason: out.reason }) : "");
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  process.env.APNS_HOST_OVERRIDE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /* ── 发送：头、payload、410/500 ── */
  const r1 = ref("t1");
  for (const [token, env] of [[T_OK, "sandbox"], [T_GONE, "production"], [T_BAD, undefined], [T_ERR, "sandbox"], [T_OTHER400, "sandbox"]] as const) {
    push.addApnsSubscription(r1, { token, bundleId: "com.example.jiebo", environment: env });
  }
  const full = { itemId: "i_abc", kind: "approval", title: "有一项待你批准", body: "新建工作区 notes · 整理讲稿", chatId: "c_1", delegationId: "d_1" };
  const res = await apns.sendApns(r1, full);
  check(res.total === 5 && res.sent === 1, "发送：5 个订阅，仅 1 个成功");
  const first = seen.find((row) => row.token === T_OK)!;
  const hd = first.headers;
  check(hd["apns-topic"] === "com.example.jiebo" && hd["apns-push-type"] === "alert", "头：apns-topic 取订阅 bundleId，push-type=alert");
  check(hd["apns-priority"] === "10", "头：approval 的 apns-priority=10");
  check(hd["apns-collapse-id"] === "i_abc" && /^\d+$/.test(hd["apns-expiration"] ?? ""), "头：collapse-id / expiration");
  check(hd.authorization === `bearer ${apns.apnsJwt(cfg)}` && hd["content-type"] === "application/json", "头：authorization 为 bearer provider token");
  check(hd[":method"] === "POST" && hd[":path"] === `/3/device/${T_OK}`, "请求：POST /3/device/<token>");
  const body = JSON.parse(first.body);
  check(
    JSON.stringify(body) ===
      JSON.stringify({
        aps: { alert: { title: "有一项待你批准", body: "新建工作区 notes · 整理讲稿" }, sound: "default", "thread-id": "assistant-inbox" },
        cr: { itemId: "i_abc", kind: "approval", chatId: "c_1", delegationId: "d_1" },
      }),
    "payload：aps.alert / sound / thread-id 与 cr 结构正确",
  );
  const left = subsOf(r1).apns.map((row) => row.token);
  check(!left.includes(T_GONE), "410 Unregistered：订阅被删");
  check(!left.includes(T_BAD), "400 BadDeviceToken：订阅被删");
  check(left.includes(T_ERR) && left.includes(T_OTHER400) && left.includes(T_OK), "500 和其它 400：订阅保留");
  const logs = logOf(r1);
  check(logs.length === 5 && logs.some((row) => row.endpoint === `apns:${T_OK.slice(0, 8)}` && row.ok && row.status === 200), "日志：同一个 push-log.jsonl，endpoint=apns:<前 8 位>");
  check(logs.some((row) => row.endpoint === `apns:${T_ERR.slice(0, 8)}` && !row.ok && row.status === 500), "日志：500 记录失败");
  seen.length = 0;
  await apns.sendApns(r1, { ...full, kind: "reminder", chatId: undefined, delegationId: undefined });
  const plain = seen.find((row) => row.token === T_OK)!;
  check(plain.headers["apns-priority"] === "5" && !("chatId" in JSON.parse(plain.body).cr) && !("delegationId" in JSON.parse(plain.body).cr), "非 approval：priority=5，cr 不带空的 chatId/delegationId");

  /* ── 订阅登记校验（走 handleOp） ── */
  const tenantDir = resolve(dir, "t2");
  const tenant = { id: "t2", stateDir: tenantDir, name: "测试", workspaceRoot: resolve(dir, "ws") };
  const op = (name: string, args: Record<string, unknown>) => service.handleOp(tenant, name as never, args);
  check(!(await op("push_subscribe", { kind: "apns", token: "xyz", bundleId: "com.example.jiebo", environment: "sandbox" })).ok, "校验：非 hex token 被拒");
  check(!(await op("push_subscribe", { kind: "apns", token: tok("a", 63), bundleId: "com.example.jiebo" })).ok, "校验：过短 / 奇数长度 token 被拒");
  check(!(await op("push_subscribe", { kind: "apns", token: tok("a", 65), bundleId: "com.example.jiebo" })).ok, "校验：奇数长度 token 被拒");
  check(!(await op("push_subscribe", { kind: "apns", token: tok("a", 202), bundleId: "com.example.jiebo" })).ok, "校验：超过 200 位被拒");
  check(!(await op("push_subscribe", { kind: "apns", token: T_OK, bundleId: "" })).ok, "校验：bundleId 为空被拒");
  check(!(await op("push_subscribe", { kind: "apns", token: T_OK, bundleId: "x".repeat(300) })).ok, "校验：bundleId 过长被拒");
  check(!(await op("push_subscribe", { kind: "apns", token: T_OK, bundleId: "com.example.jiebo", environment: "staging" })).ok, "校验：environment 只能 sandbox/production");
  check((await op("push_subscribe", { kind: "apns", token: tok("A", 80), bundleId: "com.example.jiebo", environment: "sandbox", ua: "iPhone" })).ok, "校验：80 位（更长）hex token 可接受");
  check(!(await op("push_subscribe", { kind: "sms" })).ok, "校验：未知 kind 被拒");
  check(!(await op("push_subscribe", { subscription: { endpoint: "http://x" } })).ok, "兼容：旧网页客户端不带 kind 仍按 web 校验");

  /* ── 同 token 更新 / unsubscribe ── */
  await op("push_subscribe", { kind: "apns", token: T_OK, bundleId: "com.example.jiebo", environment: "sandbox", ua: "ua1" });
  await op("push_subscribe", { kind: "apns", token: T_OK, bundleId: "com.example.jiebo", environment: "production", ua: "ua2" });
  const rows = subsOf(tenant).apns.filter((row) => row.token === T_OK);
  check(rows.length === 1 && rows[0].environment === "production" && rows[0].ua === "ua2", "同 token 重复注册：更新 environment / ua，不重复");
  const un = await op("push_unsubscribe", { kind: "apns", token: T_OK });
  check(un.ok && (un.data as { removed: number }).removed === 1 && !subsOf(tenant).apns.some((row) => row.token === T_OK), "push_unsubscribe kind=apns 删除订阅");

  /* ── 旧格式迁移 ── */
  const r3 = ref("t3");
  const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "p", auth: "a" }, createdAt: n });
  writeJson(assistantPath(r3, "push-subs.json"), { subs: [sub(1), sub(2)] });
  check(push.listSubscriptions(r3).length === 2, "迁移：读旧格式 { subs } 得到 web 订阅");
  const migrated = subsOf(r3);
  check(Array.isArray(migrated.web) && migrated.web.length === 2 && Array.isArray(migrated.apns) && migrated.apns.length === 0 && migrated.subs === undefined, "迁移：写回 { web, apns } 新格式");
  check(readdirSync(resolve(r3.stateDir, "assistant")).every((name) => !name.endsWith(".tmp")), "写盘：原子写后无残留临时文件");
  check(push.removeSubscription(r3, "https://push.example/1") === 1 && subsOf(r3).web.length === 1, "web 删除后新格式保持");

  /* ── 每通道 20 条 ── */
  const r4 = ref("t4");
  for (let i = 0; i < 25; i += 1) {
    push.addSubscription(r4, sub(i));
    push.addApnsSubscription(r4, { token: i.toString(16).padStart(64, "0"), bundleId: "com.example.jiebo", environment: "sandbox" });
  }
  const cap = subsOf(r4);
  check(cap.web.length === 20 && cap.apns.length === 20, "上限：web 和 apns 各最多 20 条");
  check(cap.apns[19].token === (24).toString(16).padStart(64, "0") && cap.apns[0].token === (5).toString(16).padStart(64, "0"), "上限：保留最近的 20 条");

  /* ── 端到端：startAssistant → push_test / 真实 approval 收件箱 ── */
  const deps = {
    tenants: () => [tenant],
    publish: () => undefined,
    globalStateDir: resolve(dir, "global"),
    delegate: async () => "",
    workspaces: () => [],
    createWorkspace: async () => "",
    appUrl: () => "https://example.test/app/",
  };
  writeJson(assistantPath(tenant, "marker.json"), {});
  service.startAssistant(deps);
  reply.delete(T_OK);
  await op("push_subscribe", { kind: "apns", token: T_OK, bundleId: "com.example.jiebo", environment: "sandbox" });
  seen.length = 0;
  const test = await op("push_test", {});
  check(test.ok && (test.data as { apns: number }).apns >= 1, "push_test：返回 APNs 订阅数");
  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 100 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 50));
    return pred();
  };
  check(await waitFor(() => seen.some((row) => row.token === T_OK)), "push_test：走 pushItem 发到了 APNs");
  const SECRET = "SECRET-BODY-这段收件箱正文和 /home/u/ws 路径不能出现在通知里";
  seen.length = 0;
  const long = "很长的标题".repeat(40);
  inbox.postInbox(tenant, { kind: "approval", title: long, body: SECRET, chatId: "c_9", delegationId: "d_9" });
  check(await waitFor(() => seen.some((row) => row.token === T_OK)), "pushItem：approval 条目发到了 APNs");
  const got = seen.find((row) => row.token === T_OK)!;
  const gotBody = JSON.parse(got.body);
  check(!got.body.includes("SECRET-BODY") && !got.body.includes("/home/u/ws"), "payload：不含收件箱 body 全文 / 路径");
  check(gotBody.aps.alert.title === "有一项待你批准" && gotBody.aps.alert.body.length <= 80 && long.startsWith(gotBody.aps.alert.body), "payload：alert.body 为截断到 80 字的条目标题");
  check(gotBody.cr.chatId === "c_9" && gotBody.cr.delegationId === "d_9" && gotBody.cr.kind === "approval" && got.headers["apns-priority"] === "10", "pushItem：cr 带 chatId/delegationId，approval 高优先级");
  const state = await service.buildState(tenant).catch(() => null);
  check(state?.pushApns === true, "assistant_state：配置后 pushApns=true");
  service.stopAssistant();
  delete process.env.APNS_TEAM_ID;
  const state2 = await service.buildState(tenant).catch(() => null);
  check(state2?.pushApns === false, "assistant_state：未配置时 pushApns=false");
} catch (err) {
  failed += 1;
  console.log("FAIL  冒烟异常：", err);
} finally {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
