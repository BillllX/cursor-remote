# Cursor Remote

网页长得像 Cursor 的聊天窗。浏览器只是客户端；Agent 在 VPS 上用 [Cursor SDK](https://cursor.com/docs/sdk/typescript) 读文件、改代码、跑命令。模型请求仍走你的 Cursor 账号。

```
浏览器  --WSS /media-->  VPS nginx  --loopback-->  gateway  --Cursor SDK-->  VPS 工作区
网页 UI 由同一台机器上的 Next 托管，不再转发协议。
```

## 需要

- Node **22.13+**
- Cursor 用户 API Key：[Dashboard → Integrations](https://cursor.com/dashboard/integrations)

## 生产（VPS）

公网入口：https://aiagentswitcher.com/cursor-remote

- **web** `127.0.0.1:3020` → `/cursor-remote`：聊天界面
- **gateway** `127.0.0.1:8787`：WebSocket `/ws`、文件 `/media`、Cursor SDK
- nginx 把 `/cursor-remote/bridge` 改写成 gateway `/ws`，`/cursor-remote/media` 改写成 `/media`
- 工作区：`/var/lib/cursor-remote/tenants/<id>/workspace`（每人独立）
- 租户名单：`/etc/cursor-remote/tenants.json`（`root:cursor-remote`，mode `640`）
- 密钥：`/etc/cursor-remote/gateway.env`（不要写进 systemd `Environment=`）
- 公网 **不** 开放 8787

登录框不变：每人一个独立口令，写在 `tenants.json` 的 `token` 里。模型请求仍共用一把 `CURSOR_API_KEY`。

这是可信同事共用一台机器，不是对外 SaaS。Gateway 会把读写限制在该租户目录内；Agent 的 shell 仍跑在同一个 `cursor-remote` 用户下，prompt 拦不住故意读邻居目录。

```json
{
  "tenants": [
    { "id": "bill", "name": "Bill", "token": "独立口令1" },
    { "id": "alice", "name": "Alice", "token": "独立口令2" }
  ]
}
```

改 `tenants.json` 必须 `systemctl restart cursor-remote-gateway`，会打断所有人正在跑的 Agent，挑维护窗口。五人同时跑 composer 内存不够时，把单元里的 `MemoryMax` 从 4G 加到 8G。

旧单租户数据（`workspace/` + `state.json`）安装脚本会迁到 `tenants/default/`。也可手动：

```bash
sudo systemctl stop cursor-remote-gateway
sudo CURSOR_REMOTE_STATE_DIR=/var/lib/cursor-remote python3 scripts/migrate-to-tenants.py
# 把旧 CURSOR_REMOTE_TOKEN 写进 tenants.json 的 default.token
sudo systemctl start cursor-remote-gateway
```

```bash
# 在 VPS 上（仓库放到 /opt/cursor-remote-gateway 之后）
sudo bash scripts/install-vps-gateway.sh
sudo python3 scripts/insert-nginx-gateway.py
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl start cursor-remote-gateway
```

日常部署（VPS 上是 git 仓库，用只读 deploy key 拉取）：

```bash
git push origin main   # 本机
ssh root@<vps> 'cd /opt/cursor-remote-gateway && git pull && systemctl restart cursor-remote-gateway'
```

重启会打断所有在跑的 Agent，挑维护窗口。`gateway/src/` 与 `shared/` 必须一起更新（tsx 直接跑源码，缺文件会起不来）。

## 本机开发

```bash
cd ~/Projects/cursor-remote
cp .env.example .env
# 填 CURSOR_API_KEY；本机可继续用 CURSOR_REMOTE_TOKEN 单租户，或放一份 tenants.json

npm install
npm run dev
```

浏览器打开 `http://127.0.0.1:3000` 时直连本机 `ws://127.0.0.1:8787`。不要和 VPS 生产抢同一套密钥文件以外的东西。

可选：本机仍可用 `npm run gateway:install` 跑 LaunchAgent 保活，方便离线开发。反向隧道已不是生产路径。

## 端口

| 服务 | 端口 | 作用 |
| --- | --- | --- |
| web（VPS） | 3020 → `/cursor-remote` | 公网聊天界面 |
| gateway（VPS） | 8787 | 收动作、调 Cursor SDK、读写工作区 |

## 对外预览

每个租户一条路径，挂在这台机器已经有证书的主机名上。东京是 `https://jiebo.aiagentswitcher.com/p/<id>/`，上海是 `https://aiagentswitcher.com/p/<id>/`。网页和 iPad 不用改。Agent 在工作区里执行：

```bash
jiebo-publish start -- npm run dev -- --host '$HOST' --port '$PORT' --base '$BASE_PATH/'
jiebo-publish status
jiebo-publish stop
```

每人在工作区列表里有一个单独的 USER 工作区，目录就是该用户的根目录，会话能读写下面所有子工作区。对外网站只能从这里的会话创建。

命令会分配 `127.0.0.1` 上 20000–20999 的端口，注入 `HOST`、`PORT` 和 `BASE_PATH`（形如 `/p/<id>`），并把带票据的地址打出来。打开这个地址会种下只属于该路径的 cookie。没有票据的人打不开。网站必须挂在 `BASE_PATH` 下，浏览器里的脚本和样式才会回到这条路径。一个人同时只公开一个服务，口令只对应该工作区。30 分钟没有访问会停掉；开着的 WebSocket 算访问。systemd 重启 gateway 会把这些进程一起停掉，不会自动再拉起；进程如果还活着，gateway 只重新接上。这些进程算在 gateway 的内存限额里。只监听 0.0.0.0 或 :: 的进程不会被公开。

一次性准备（不用按人申请，也不用新域名）：

- `gateway.env` 里 `JIEBO_PUBLISH_HOST` 写成这台机器现有的主机名，例如 `jiebo.aiagentswitcher.com` 或 `aiagentswitcher.com`
- `sudo python3 scripts/insert-nginx-publish.py && sudo nginx -t && sudo systemctl reload nginx`，把 `/p/` 反代进这个主机名已有的 443 站点
- 安装脚本会把 `jiebo-publish` 链到 `/usr/local/bin` 和 `/var/lib/cursor-remote/.local/bin`

## 推送通知（可选）

个人助理的收件箱（待批 / 委派结果 / 提醒 / 简报）会推送到两个通道：网页走 Web Push（VAPID，网关自动生成密钥），iPhone 走 APNs。APNs 在 `gateway.env` 里配置，**不配则安静跳过**，`assistant_state.pushApns` 为 `false`：

| 变量 | 说明 |
|---|---|
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_KEY_ID` | APNs auth key（.p8）的 Key ID |
| `APNS_PRIVATE_KEY` | `.p8` 全文，换行可写成 `\n`；与下一项二选一 |
| `APNS_PRIVATE_KEY_PATH` | `.p8` 文件路径（权限收紧，别进 git） |
| `APNS_BUNDLE_ID` | 默认 topic；订阅自带 `bundleId` 时以订阅为准 |
| `APNS_DEFAULT_ENV` | 可选，`sandbox` 或 `production`（默认）；订阅没声明 `environment` 时用 |
| `APNS_HOST_OVERRIDE` | 仅测试：覆盖 APNs 主机，如 `http://127.0.0.1:PORT`（h2c 明文）。生产不要设 |

改完需要 `systemctl restart cursor-remote-gateway`。订阅存在租户目录 `assistant/push-subs.json`（`{ web, apns }`，每通道最多 20 条），APNs 返回 410 或 400 且原因为 `BadDeviceToken` / `Unregistered` / `DeviceTokenNotForTopic` 时自动删订阅，其它错误只写 `push-log.jsonl`。不用外网的冒烟：`npm run smoke:apns -w gateway`。详见 `docs/iphone-assistant-first.md` §7.1。

## 它不会做什么

- 不复刻完整 IDE
- 不在网站服务器上跑大模型
- 这一步不和 Mac 同步文件；外网改的是 VPS 磁盘
- 不接官方 Cloud Agent（`cloud: { repos }`）；文件留在这台 VPS 上
- 不做每租户 unix 用户或进程隔离；同一台机器上的 Agent shell 理论上能读到邻居目录
