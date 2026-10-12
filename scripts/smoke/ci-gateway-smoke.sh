#!/usr/bin/env bash
# 用临时目录和临时测试用户起一个无模型密钥的网关，跑同步冒烟（slim / resume）。
# CI 和本机都能跑，不读写 /etc/cursor-remote，也不碰真实用户数据。
# 用法: bash scripts/smoke/ci-gateway-smoke.sh   （端口默认 18797，可用 CI_GATEWAY_PORT 改）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${CI_GATEWAY_PORT:-18797}"
# 网关 loadDotEnv 会把 gateway/.env、仓库根 .env 里未定义的变量补进来，providers.json 的 apiKeyEnv 又能指向任意变量名，
# 没法逐个置空：有这些文件就不跑，免得测试网关拿到真实密钥
dotenv=$(find "$ROOT" "$ROOT/gateway" -maxdepth 1 -name '.env*' ! -name '*.example' 2>/dev/null)
[ -z "$dotenv" ] || { echo "检测到 .env 文件，拒绝运行："; echo "$dotenv"; exit 2; }
TMP="$(mktemp -d)"
ADMIN_TOKEN="ci-admin-$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
USER_TOKEN="ci-user-$(node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))')"
GW_PID=""

cleanup() {
  if [ -n "$GW_PID" ] && kill -0 "$GW_PID" 2>/dev/null; then
    kill "$GW_PID" 2>/dev/null || true
    wait "$GW_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

cat > "$TMP/tenants.json" <<EOF
{
  "tenants": [
    { "id": "ci-admin", "name": "CI 管理员", "token": "$ADMIN_TOKEN", "admin": true },
    { "id": "ci-user", "name": "CI 用户", "token": "$USER_TOKEN" }
  ]
}
EOF

FAKE_LLM_PORT="${CI_FAKE_LLM_PORT:-18798}"
mkdir -p "$TMP/state"
cat > "$TMP/state/providers.json" <<EOF
{
  "providers": [
    { "id": "fake", "name": "假模型", "baseURL": "http://127.0.0.1:$FAKE_LLM_PORT/v1", "apiKey": "ci-fake", "models": ["m1"], "tools": false }
  ]
}
EOF

cd "$ROOT/gateway"
mkdir -p "$TMP/home"
# 清空环境起网关，只放白名单；已知的密钥类变量再显式置空（loadDotEnv 只填未定义的，空串不会被覆盖）
env -i "PATH=$PATH" "HOME=$TMP/home" "LANG=${LANG:-C.UTF-8}" "TMPDIR=${TMPDIR:-/tmp}" \
  CURSOR_API_KEY= CURSOR_REMOTE_TOKEN= CURSOR_REMOTE_PASSWORD= JIEBO_PUBLISH_SECRET= \
  APNS_TEAM_ID= APNS_KEY_ID= APNS_PRIVATE_KEY= APNS_PRIVATE_KEY_PATH= \
  CURSOR_REMOTE_STATE_DIR="$TMP/state" \
  CURSOR_REMOTE_TENANTS_FILE="$TMP/tenants.json" \
  CURSOR_REMOTE_MEDIA_SECRET="ci-media-secret" \
  GATEWAY_HOST=127.0.0.1 \
  GATEWAY_PORT="$PORT" \
  node --import tsx src/index.ts > "$TMP/gateway.log" 2>&1 &
GW_PID=$!
cd "$ROOT"

for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "网关启动失败："; cat "$TMP/gateway.log"; exit 1
  fi
  sleep 0.5
done
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "网关 30 秒内没起来："; cat "$TMP/gateway.log"; exit 1
fi

status=0
export JIEBO_WS_URL="ws://127.0.0.1:$PORT/bridge"
CURSOR_REMOTE_TOKEN="$ADMIN_TOKEN" SMOKE_USER_TOKEN="$USER_TOKEN" node scripts/smoke/slim-smoke.mjs || status=1
CURSOR_REMOTE_TOKEN="$USER_TOKEN" node scripts/smoke/resume-smoke.mjs || status=1
CURSOR_REMOTE_TOKEN="$USER_TOKEN" node scripts/smoke/workspace-smoke.mjs || status=1
CURSOR_REMOTE_TOKEN="$USER_TOKEN" FAKE_LLM_PORT="$FAKE_LLM_PORT" node scripts/smoke/multidevice-smoke.mjs || status=1

if [ "$status" -ne 0 ]; then
  echo "---- 网关日志 ----"; cat "$TMP/gateway.log"
fi
exit "$status"
