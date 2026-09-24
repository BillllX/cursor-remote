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

## 它不会做什么

- 不复刻完整 IDE
- 不在网站服务器上跑大模型
- 这一步不和 Mac 同步文件；外网改的是 VPS 磁盘
- 不接官方 Cloud Agent（`cloud: { repos }`）；文件留在这台 VPS 上
- 不做每租户 unix 用户或进程隔离；同一台机器上的 Agent shell 理论上能读到邻居目录
