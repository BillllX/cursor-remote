#!/bin/sh
# Run on the VPS as root after the repo is at /opt/cursor-remote-gateway.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_ROOT="${NODE_ROOT:-/opt/node-v22}"
APP_ROOT="${APP_ROOT:-/opt/cursor-remote-gateway}"
DATA_ROOT="${DATA_ROOT:-/var/lib/cursor-remote}"
ENV_FILE="${ENV_FILE:-/etc/cursor-remote/gateway.env}"
UNIT_SRC="${ROOT}/scripts/cursor-remote-gateway.service"
UNIT_DST="/etc/systemd/system/cursor-remote-gateway.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 跑。"
  exit 1
fi

id cursor-remote >/dev/null 2>&1 || useradd --system --home "$DATA_ROOT" --shell /usr/sbin/nologin cursor-remote
mkdir -p "$DATA_ROOT/workspace" "$DATA_ROOT/tenants" "$DATA_ROOT/.local/bin" /etc/cursor-remote "$APP_ROOT"
chown -R cursor-remote:cursor-remote "$DATA_ROOT"
chown -R cursor-remote:cursor-remote "$APP_ROOT"

TENANTS_FILE="${TENANTS_FILE:-/etc/cursor-remote/tenants.json}"
if [ ! -f "$TENANTS_FILE" ]; then
  cp "${ROOT}/scripts/tenants.json.example" "$TENANTS_FILE"
  echo "请编辑 ${TENANTS_FILE}：每人一个 id 和独立 token。"
fi
chown root:cursor-remote "$TENANTS_FILE"
chmod 640 "$TENANTS_FILE"

if [ -d "$DATA_ROOT/workspace" ] && [ ! -d "$DATA_ROOT/tenants/default" ]; then
  echo "正在把旧工作区迁到 tenants/default ..."
  CURSOR_REMOTE_STATE_DIR="$DATA_ROOT" python3 "${ROOT}/scripts/migrate-to-tenants.py" || true
  chown -R cursor-remote:cursor-remote "$DATA_ROOT"
fi

if [ ! -x "${NODE_ROOT}/bin/node" ]; then
  echo "找不到 ${NODE_ROOT}/bin/node。先安装 Node 22.13+。"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  cp "${ROOT}/scripts/gateway.env.example" "$ENV_FILE"
  echo "请编辑 ${ENV_FILE} 填入 CURSOR_API_KEY 和 CURSOR_REMOTE_TOKEN。"
fi
chown root:cursor-remote "$ENV_FILE"
chmod 640 "$ENV_FILE"

install -m 644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable cursor-remote-gateway.service

echo "已装 systemd 单元: ${UNIT_DST}"
echo "填好 ${ENV_FILE} 和 ${TENANTS_FILE} 后: systemctl start cursor-remote-gateway"
echo "改 tenants.json 必须重启 gateway，会打断所有在跑的 Agent。五人同时跑吃内存时可把 MemoryMax 加到 8G。"
