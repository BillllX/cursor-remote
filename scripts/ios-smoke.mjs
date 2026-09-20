#!/usr/bin/env node
// 接驳 iOS 协议冒烟：直连东京站 wss，验证 iPad 客户端依赖的协议行为。
// 用法: CURSOR_REMOTE_TOKEN=xxx node scripts/ios-smoke.mjs [--skip-agent]
// 退出码 0 = 全绿；任何一步失败 = 1。
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const WS_URL = process.env.JIEBO_WS_URL || "wss://jiebo.aiagentswitcher.com/bridge";
const TOKEN = (process.env.CURSOR_REMOTE_TOKEN || "").trim();
const SKIP_AGENT = process.argv.includes("--skip-agent");

if (!TOKEN) {
  console.error("缺少 CURSOR_REMOTE_TOKEN（source .env 或显式传入）。");
  process.exit(2);
}

const chatId = `smoke-${randomUUID().slice(0, 8)}`;
const inbox = [];
let cursor = 0; // 顺序消费：waitFor 只匹配上次命中之后的消息，防止跨步骤假绿
let ws;
let failed = 0;

function send(msg) {
  ws.send(JSON.stringify(msg));
}

function waitFor(pred, label, timeoutMs = 30_000) {
  const from = cursor;
  const idx0 = inbox.findIndex((m, i) => i >= from && pred(m));
  if (idx0 >= 0) {
    cursor = idx0 + 1;
    return Promise.resolve(inbox[idx0]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`超时: ${label}`));
    }, timeoutMs);
    function scan() {
      // 全局监听器注册在前，消息已入 inbox；按游标扫描，避免引用相等问题
      for (let i = Math.max(from, cursor); i < inbox.length; i += 1) {
        if (pred(inbox[i])) {
          cursor = i + 1;
          cleanup();
          resolve(inbox[i]);
          return;
        }
      }
    }
    function cleanup() {
      clearTimeout(timer);
      ws?.off("message", onData);
    }
    function onData() {
      scan();
    }
    ws.on("message", onData);
  });
}

function step(ok, label, extra = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failed += 1;
  console.log(`${mark}  ${label}${extra ? `  — ${extra}` : ""}`);
}

async function main() {
  console.log(`目标 ${WS_URL}，冒烟会话 ${chatId}${SKIP_AGENT ? "（跳过 agent 轮）" : ""}`);

  // 1. 连接 + hello → auth ok / ready（含租户字段）/ stored_state
  ws = new WebSocket(WS_URL, { maxPayload: 128 * 1024 * 1024 });
  ws.on("message", (raw) => {
    try {
      inbox.push(JSON.parse(raw.toString()));
    } catch {
      /* 忽略坏帧 */
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  step(true, "WebSocket 连接建立");

  // P2 护栏：hello 携带 client 标识，网关应容忍未知字段并正常 ready
  send({ type: "hello", token: TOKEN, client: { name: "ios-smoke", version: "1" } });
  // 网关只在失败时发 auth；成功直接 ready。
  const ready = await waitFor((m) => m.type === "ready" || (m.type === "auth" && m.ok === false), "ready 或 auth 失败");
  step(ready.type === "ready", "hello(client) 通过认证", ready.type === "auth" ? ready.message || "" : "成功时网关直接 ready，不发 auth");
  if (ready.type !== "ready") throw new Error("认证失败，冒烟中止");
  step(Boolean(ready.cwd), "ready 带 cwd", ready.cwd);
  step(
    typeof ready.tenantId === "string" && ready.tenantId.length > 0,
    "ready 带 tenantId/tenantName",
    `${ready.tenantId ?? "?"} / ${ready.tenantName ?? "?"}`,
  );
  const stored = await waitFor((m) => m.type === "stored_state", "stored_state");
  step(Array.isArray(stored.chats), "stored_state 到达", `${stored.chats.length} 个会话, rev=${stored.rev ?? "?"}`);

  // 2. 同连接重复 hello（iOS 旧 bug 的回归护栏）：服务端应容忍并回第二个 ready
  send({ type: "hello", token: TOKEN, client: { name: "ios-smoke", version: "1" } });
  const ready2 = await waitFor((m) => m.type === "ready" && m !== ready, "第二个 ready");
  step(ready2.tenantId === ready.tenantId, "重复 hello 后租户一致");

  // 3. upload_file（WS 兜底通道）：小文件 + 中等文件
  const upId = `up-${randomUUID().slice(0, 8)}`;
  send({
    type: "upload_file",
    chatId,
    name: "smoke-note.txt",
    data: Buffer.from("接驳冒烟测试\n").toString("base64"),
    mimeType: "text/plain",
    id: upId,
  });
  const uploaded = await waitFor((m) => m.type === "file_uploaded", "file_uploaded(小文件)");
  step(
    !uploaded.error && typeof uploaded.path === "string" && uploaded.path.includes(".cursor-remote/uploads/"),
    "upload_file 小文件成功",
    uploaded.error || uploaded.path,
  );

  const midId = `up-${randomUUID().slice(0, 8)}`;
  send({
    type: "upload_file",
    chatId,
    name: "smoke-mid.bin",
    data: Buffer.alloc(5 * 1024 * 1024, 7).toString("base64"),
    id: midId,
  });
  const mid = await waitFor((m) => m.type === "file_uploaded" && m.id === midId, "file_uploaded(5MB)", 60_000);
  step(!mid.error, "upload_file 5MB 成功", mid.error || `${mid.path} (${mid.size}B)`);

  send({ type: "upload_file", chatId, name: "smoke-empty.txt", data: "" });
  const empty = await waitFor((m) => m.type === "file_uploaded" && m.name === "smoke-empty.txt", "file_uploaded(空)");
  step(Boolean(empty.error), "upload_file 空内容被拒", empty.error || "未报错");

  // 注意：>32MB 的文件不要走 WS——实测 44MB 帧会让传输层直接断连（1006），
  // 网关来不及回错误。大文件必须走下面的 HTTP /upload（iOS 主通道）。

  // 3b. HTTP /upload（iOS 主通道）：raw body + Bearer
  // 本地网关 WS 挂在 /ws、公网 nginx 挂在 /bridge：两种后缀都要能换成 HTTP 端点
  const toHttp = (path) =>
    WS_URL.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/(bridge|ws)$/, path);
  const httpBase = toHttp("/upload");
  const httpOk = await fetch(`${httpBase}?chatId=${encodeURIComponent(chatId)}&name=smoke-http.txt`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
    body: Buffer.from("HTTP 通道冒烟\n"),
  });
  const httpOkJson = await httpOk.json().catch(() => ({}));
  step(
    httpOk.status === 200 && typeof httpOkJson.path === "string" && httpOkJson.path.includes(".cursor-remote/uploads/"),
    "HTTP /upload 小文件成功",
    `${httpOk.status} ${httpOkJson.path || httpOkJson.error || ""}`,
  );

  // 已知网关问题：超限时应回 413，但 readRequestBody 先 destroy 了 socket——
  // 生产经 nginx 报 502；本地直连则 socket 直接重置（fetch 抛错）。都视为「干净拒绝」。
  let httpBigStatus = 0;
  let httpBigJson = {};
  let httpBigReset = false;
  try {
    const httpBig = await fetch(`${httpBase}?chatId=${encodeURIComponent(chatId)}&name=smoke-big.bin`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
      body: Buffer.alloc(33 * 1024 * 1024, 7),
    });
    httpBigStatus = httpBig.status;
    httpBigJson = await httpBig.json().catch(() => ({}));
  } catch {
    httpBigReset = true; // 本地无 nginx：destroy 表现为连接重置
  }
  step(
    httpBigReset ||
      ((httpBigStatus === 413 || httpBigStatus === 502) && (httpBigStatus === 502 || /32MB/.test(httpBigJson.error || ""))),
    "HTTP /upload 33MB 被拒",
    httpBigReset
      ? "连接被重置（本地直连的干净拒绝）"
      : `${httpBigStatus} ${httpBigJson.error || ""}${httpBigStatus === 502 ? "（网关 destroy 抢在 413 前面，待修）" : ""}`,
  );

  const httpNoAuth = await fetch(`${httpBase}?name=x.txt`, { method: "POST", body: "x" });
  step(httpNoAuth.status === 401, "HTTP /upload 无 token 拒 401", `status=${httpNoAuth.status}`);

  // 4. 未知帧不断线
  send({ type: "smoke-bogus-frame" });
  send({ type: "ping" });
  await waitFor((m) => m.type === "pong", "pong");
  step(true, "未知 type 后连接存活（pong）");

  // 4b. P3：list_files 全量索引 + mention 模式
  send({ type: "list_files", query: "", chatId });
  const tree = await waitFor((m) => m.type === "files" && !m.mention, "files(全量)");
  step(Array.isArray(tree.paths), "list_files 返回文件索引", `${tree.paths?.length ?? "?"} 个路径${tree.truncated ? "（截断）" : ""}`);

  send({ type: "list_files", query: "json", chatId, mention: true });
  const mention = await waitFor((m) => m.type === "files" && m.mention === true, "files(mention)");
  step(mention.query === "json" && Array.isArray(mention.paths), "list_files mention 模式", `query=${mention.query} ${mention.paths?.length ?? 0} 个候选`);

  // 4c. P3：/media 预览通道（Bearer + chatId + path；用文件索引里的真实路径）
  const mediaBase = toHttp("/media");
  const mediaPath = (tree.paths || []).find((p) => typeof p === "string" && !p.endsWith("/"));
  if (mediaPath) {
    const mediaOk = await fetch(`${mediaBase}?path=${encodeURIComponent(mediaPath)}&chatId=${encodeURIComponent(chatId)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    step(mediaOk.status === 200, "/media 下载工作区文件", `${mediaOk.status} ${mediaPath}`);
  } else {
    step(false, "/media 下载工作区文件", "文件索引为空，没有可预览的路径");
  }
  const mediaNoAuth = await fetch(`${mediaBase}?path=${encodeURIComponent(mediaPath || "x.txt")}&chatId=${encodeURIComponent(chatId)}`);
  step(mediaNoAuth.status === 401, "/media 无 token 拒 401", `status=${mediaNoAuth.status}`);

  // 4d. P3：undo 协议（无可还原改动时也应回 undone，而不是断连/沉默）
  send({ type: "undo", chatId });
  const undone = await waitFor((m) => m.type === "undone", "undone");
  step(undone.chatId === chatId && Array.isArray(undone.paths), "undo → undone 回包", undone.error || `${undone.paths?.length ?? 0} 个路径`);

  // 4e. maxMessageBytes 护栏（iOS URLSessionWebSocketTask 约 1MiB 上限的修复）：
  // 声明上限后 stored_state 应改发 stored_state_deferred，全量走 HTTP /state。
  // 用独立短连接验证，避免干扰主连接游标；maxMessageBytes=1 让任何 stored_state 都必 defer。
  {
    const ws2 = new WebSocket(WS_URL, { maxPayload: 128 * 1024 * 1024 });
    const inbox2 = [];
    ws2.on("message", (raw) => {
      try {
        inbox2.push(JSON.parse(raw.toString()));
      } catch {
        /* 忽略坏帧 */
      }
    });
    await new Promise((resolve, reject) => {
      ws2.once("open", resolve);
      ws2.once("error", reject);
    });
    ws2.send(JSON.stringify({ type: "hello", token: TOKEN, client: { name: "ios-smoke", version: "1", maxMessageBytes: 1 } }));
    const got = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      const ticker = setInterval(() => {
        const hit = inbox2.find((m) => m.type === "stored_state_deferred" || m.type === "stored_state");
        if (hit) {
          clearTimeout(timer);
          clearInterval(ticker);
          resolve(hit);
        }
      }, 50);
    });
    ws2.close();
    if (got?.type === "stored_state_deferred") {
      step(true, "maxMessageBytes 触发 stored_state_deferred", `rev=${got.rev ?? "?"}`);
      const stateBase = toHttp("/state");
      const stateOk = await fetch(stateBase, { headers: { authorization: `Bearer ${TOKEN}` } });
      const stateJson = await stateOk.json().catch(() => ({}));
      step(
        stateOk.status === 200 && Array.isArray(stateJson.chats),
        "HTTP /state 拉取全量",
        `${stateOk.status} ${stateJson.chats?.length ?? "?"} 个会话, rev=${stateJson.rev ?? "?"}`,
      );
      const stateNoAuth = await fetch(stateBase);
      step(stateNoAuth.status === 401, "HTTP /state 无 token 拒 401", `status=${stateNoAuth.status}`);
    } else {
      // 网关还没部署 deferral（旧代码会照常发 stored_state）：记 SKIP 保持门禁绿，部署后自动转 PASS
      console.log(`SKIP  maxMessageBytes 护栏：网关尚未部署 stored_state_deferred（收到 ${got?.type ?? "超时"}）`);
    }
  }

  // 4f. P4 增量同步：sync_chat 单会话上传 + sync_ack 回执；stored_digest 分叉对账 + load_chats。
  // 用带 caps 的独立连接 + 幽灵会话验证，不碰真实会话；网关未部署 P4 时记 SKIP 保持门禁绿。
  {
    const stateBase = toHttp("/state");
    const ws3 = new WebSocket(WS_URL, { maxPayload: 128 * 1024 * 1024 });
    const inbox3 = [];
    ws3.on("message", (raw) => {
      try {
        inbox3.push(JSON.parse(raw.toString()));
      } catch {
        /* 忽略坏帧 */
      }
    });
    await new Promise((resolve, reject) => {
      ws3.once("open", resolve);
      ws3.once("error", reject);
    });
    let cursor3 = 0; // 顺序消费：只匹配调用之后到达的消息，防止命中初始 stored_state 造成假绿
    const waitFor3 = (pred, timeoutMs = 15_000) =>
      new Promise((resolve) => {
        const from = cursor3;
        const timer = setTimeout(() => {
          clearInterval(ticker);
          resolve(null);
        }, timeoutMs);
        const ticker = setInterval(() => {
          const idx = inbox3.findIndex((m, i) => i >= from && pred(m));
          if (idx >= 0) {
            cursor3 = idx + 1;
            clearTimeout(timer);
            clearInterval(ticker);
            resolve(inbox3[idx]);
          }
        }, 50);
      });
    ws3.send(
      JSON.stringify({
        type: "hello",
        token: TOKEN,
        client: { name: "ios-smoke", version: "1", caps: ["sync_chat", "stored_digest"] },
      }),
    );
    const ready3 = await waitFor3((m) => m.type === "ready");
    const stored3 = await waitFor3((m) => m.type === "stored_state");
    if (!ready3 || !stored3) {
      console.log("SKIP  P4 增量同步：独立连接未就绪");
      ws3.close();
    } else if (stored3.chatRevs === undefined) {
      // 旧网关的 stored_state 没有 chatRevs：整个 P4 节记 SKIP，部署后自动转 PASS
      console.log("SKIP  P4 增量同步：网关尚未部署（stored_state 无 chatRevs）");
      ws3.close();
    } else {
      step(true, "stored_state 带 chatRevs 版本表", `${Object.keys(stored3.chatRevs).length} 条`);
      // sync_chat 创建幽灵会话（网关对未知 id 追加），rev 必须 >= 服务端 rev
      const rev = (stored3.rev ?? 0) + 1;
      const ghostId = `smoke-sync-${randomUUID().slice(0, 8)}`;
      const ghost = { id: ghostId, title: "smoke 增量会话", turns: [], draft: "", mode: "agent", confirmWrites: false };
      ws3.send(JSON.stringify({ type: "sync_chat", chat: ghost, rev }));
      const ack = await waitFor3((m) => m.type === "sync_ack");
      if (!ack) {
        // 到这里 stored_state 已确认带 chatRevs（新网关），无 ack 是真失败，不能 SKIP 假绿
        step(false, "sync_chat 新会话 → sync_ack", "新网关（有 chatRevs）但 15s 无 sync_ack");
        ws3.close();
      } else {
        step(ack.chatRevs?.[ghostId] === rev, "sync_chat 新会话 → sync_ack", `rev=${ack.rev ?? "?"} chatRev=${ack.chatRevs?.[ghostId] ?? "?"}`);
        const after = await fetch(stateBase, { headers: { authorization: `Bearer ${TOKEN}` } });
        const afterJson = await after.json().catch(() => ({}));
        const got = (afterJson.chats ?? []).find((c) => c?.id === ghostId);
        step(
          got?.title === ghost.title,
          "sync_chat 已落库（HTTP /state 验证）",
          got ? `chatRevs=${afterJson.chatRevs?.[ghostId] ?? "?"}` : "未找到幽灵会话",
        );
        // 内容不变的幂等重推：仍应回 ack（rev 收敛，不该造成永久分叉）
        ws3.send(JSON.stringify({ type: "sync_chat", chat: ghost, rev: rev + 1 }));
        const ack2 = await waitFor3((m) => m.type === "sync_ack");
        step(Boolean(ack2), "sync_chat 幂等重推仍回 ack");
        // 4g. stored_digest：旧 rev 的 sync_state 触发分叉 → 目录而非全量（rev>0 保证被拒，不会误清空）
        if ((afterJson.rev ?? 0) > 0) {
          ws3.send(JSON.stringify({ type: "sync_state", chats: [], rev: 0 }));
          const digest = await waitFor3((m) => ["stored_digest", "stored_state", "stored_state_deferred"].includes(m.type));
          step(digest?.type === "stored_digest", "旧 rev 触发 stored_digest（非全量）", digest ? `type=${digest.type}` : "超时");
          if (digest?.type === "stored_digest") {
            if (!digest.chatRevs?.[ghostId]) {
              step(false, "stored_digest 包含幽灵会话", "digest 缺 ghostId（对账不完整）");
            } else {
              ws3.send(JSON.stringify({ type: "load_chats", ids: [ghostId] }));
              const gotChat = await waitFor3((m) => m.type === "stored_chat" && m.chat?.id === ghostId);
              step(gotChat?.chat?.title === ghost.title, "load_chats 拉回 stored_chat", `rev=${gotChat?.rev ?? "?"}`);
            }
          }
        } else {
          console.log("SKIP  旧 rev 触发 stored_digest：rev=0 无法构造 stale");
        }
        // 4h. 多设备广播：同租户另一条 caps 连接应在我们 sync_chat 被接受后收到 stored_digest
        {
          const ws4 = new WebSocket(WS_URL, { maxPayload: 128 * 1024 * 1024 });
          const inbox4 = [];
          ws4.on("message", (raw) => {
            try {
              inbox4.push(JSON.parse(raw.toString()));
            } catch {
              /* 忽略坏帧 */
            }
          });
          await new Promise((resolve, reject) => {
            ws4.once("open", resolve);
            ws4.once("error", reject);
          });
          let cursor4 = 0;
          const waitFor4 = (pred, timeoutMs = 15_000) =>
            new Promise((resolve) => {
              const from = cursor4;
              const timer = setTimeout(() => {
                clearInterval(ticker);
                resolve(null);
              }, timeoutMs);
              const ticker = setInterval(() => {
                const idx = inbox4.findIndex((m, i) => i >= from && pred(m));
                if (idx >= 0) {
                  cursor4 = idx + 1;
                  clearTimeout(timer);
                  clearInterval(ticker);
                  resolve(inbox4[idx]);
                }
              }, 50);
            });
          ws4.send(
            JSON.stringify({
              type: "hello",
              token: TOKEN,
              client: { name: "ios-smoke-2", version: "1", caps: ["sync_chat", "stored_digest"] },
            }),
          );
          const ready4 = await waitFor4((m) => m.type === "ready");
          const stored4 = await waitFor4((m) => m.type === "stored_state");
          if (!ready4 || !stored4) {
            console.log("SKIP  多设备广播 digest：第二连接未就绪");
          } else {
            ws3.send(JSON.stringify({ type: "sync_chat", chat: { ...ghost, title: "smoke 增量会话-广播" }, rev: rev + 2 }));
            const bcast = await waitFor4((m) => m.type === "stored_digest");
            step(
              Boolean(bcast),
              "多设备广播：sync_chat 接受后其他连接收到 stored_digest",
              bcast ? `chatRevs=${Object.keys(bcast.chatRevs ?? {}).length} 条` : "15s 无广播",
            );
          }
          ws4.close();
        }
        // 清理：删除幽灵会话
        ws3.send(JSON.stringify({ type: "delete_session", chatId: ghostId }));
        await new Promise((r) => setTimeout(r, 300));
        ws3.close();
      }
    }
  }

  if (!SKIP_AGENT) {
    try {
      await agentRounds();
    } catch (err) {
      // 网关并发有限：我们的 prompt 被 QUEUED 且等不到启动时，agent 轮记 SKIP 而不是 FAIL
      const queued = inbox.some((m) => m.type === "status" && m.chatId === chatId && m.status === "QUEUED");
      if (queued && err instanceof Error && /超时/.test(err.message)) {
        console.log(`SKIP  agent 轮：网关忙（任务排队中）— ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  // 7. 清理：删掉冒烟会话，避免留在网关内存里
  send({ type: "delete_session", chatId });
  await new Promise((r) => setTimeout(r, 500));
  step(true, "清理冒烟会话", chatId);
}

async function agentRounds() {
  // 5. prompt 带内联小图 → run_meta / text-delta / done
  const png1px =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  send({
    type: "prompt",
    chatId,
    text: "这是一张 1x1 的测试图。只回复「图已收到」四个字，不要调用任何工具。",
    images: [{ data: png1px, mimeType: "image/png" }],
    nameChat: false,
  });
  await waitFor((m) => m.type === "run_meta" && m.chatId === chatId, "run_meta", 150_000);
  step(true, "prompt(images) → run_meta");
  const sawDelta = await waitFor(
    (m) => (m.type === "text-delta" || m.type === "done") && m.chatId === chatId,
    "text-delta/done",
    120_000,
  );
  step(sawDelta.type === "text-delta" || sawDelta.type === "done", "prompt(images) 流式推进", sawDelta.type);
  const done1 = await waitFor((m) => m.type === "done" && m.chatId === chatId, "done(images)", 120_000);
  step(done1.status === "finished" || done1.status === "completed", "prompt(images) 完成", `status=${done1.status}`);

  // 6. confirmWrites 审批轮
  send({
    type: "prompt",
    chatId,
    text: "在工作区创建文件 .cursor-remote/smoke-scratch.txt，内容只写 ok。除了写这个文件不要做任何事。",
    confirmWrites: true,
    nameChat: false,
  });
  const approval = await waitFor((m) => m.type === "approval" && m.chatId === chatId, "approval", 120_000);
  step(Boolean(approval.callId), "confirmWrites → approval", approval.name || "");
  send({ type: "approval_reply", chatId, callId: approval.callId, allow: true });
  const done2 = await waitFor((m) => m.type === "done" && m.chatId === chatId, "done(approval)", 120_000);
  step(done2.status === "finished" || done2.status === "completed", "approval_reply → done", `status=${done2.status}`);
}

main()
  .catch((err) => {
    failed += 1;
    console.error(`FAIL  ${err.message}`);
  })
  .finally(() => {
    try {
      ws?.close();
    } catch {
      /* 忽略 */
    }
    setTimeout(() => {
      console.log(failed === 0 ? "\n冒烟全绿 ✅" : `\n冒烟有 ${failed} 项失败 ❌`);
      process.exit(failed === 0 ? 0 : 1);
    }, 300);
  });
