#!/usr/bin/env bash
# 登录态界面冒烟：临时目录里起假模型、临时网关（随机口令的管理员 + 普通租户）和已构建的网页，再跑 ui-smoke.mjs。
# 会监听本地端口、起浏览器：只在测试机 / CI 上跑，不要在跑着线上服务的机器上跑。
# 网页要先按同一个 basePath 构建好：cd web && NEXT_PUBLIC_GATEWAY_WS= NEXT_PUBLIC_BASE_PATH=/cursor-remote npx next build
# 用法: UI_KIT=<含 node_modules/playwright、browsers、libs 的目录> bash scripts/smoke/ui-smoke.sh
#   端口：UI_WEB_PORT（默认 18330）、UI_GATEWAY_PORT（18331）、UI_FAKE_LLM_PORT（18332）
#   UI_BASE_PATH（默认 /cursor-remote，须与构建时一致）、UI_SHOTS（截图目录，默认 /tmp/cursor-remote-ui-shots/<时间>）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${UI_KIT:?需要 UI_KIT：playwright 套件目录}"
WEB_PORT="${UI_WEB_PORT:-18330}"
GW_PORT="${UI_GATEWAY_PORT:-18331}"
LLM_PORT="${UI_FAKE_LLM_PORT:-18332}"
BASE_PATH="${UI_BASE_PATH:-/cursor-remote}"
SHOTS="${UI_SHOTS:-/tmp/cursor-remote-ui-shots/$(date +%Y%m%d-%H%M%S)}"
WORKSPACE=ui-proj
WORKSPACE_SECOND=ui-proj-alt

[ -d "$UI_KIT/node_modules/playwright" ] || { echo "UI_KIT 下没有 node_modules/playwright：$UI_KIT"; exit 2; }
[ -d "$UI_KIT/browsers" ] && export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$UI_KIT/browsers}"
[ -d "$UI_KIT/libs/usr/lib64" ] && export LD_LIBRARY_PATH="$UI_KIT/libs/usr/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
[ -f "$ROOT/web/.next/BUILD_ID" ] || { echo "web 还没构建（缺 web/.next/BUILD_ID）"; exit 2; }
built_base=$(node -e 'console.log(require(process.argv[1]).basePath || "")' "$ROOT/web/.next/routes-manifest.json")
[ "$built_base" = "$BASE_PATH" ] || { echo "web 构建的 basePath 是「$built_base」，与 UI_BASE_PATH「$BASE_PATH」不一致"; exit 2; }
for port in "$WEB_PORT" "$GW_PORT" "$LLM_PORT"; do
  if (: <"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "端口 $port 已被占用"; exit 2; fi
done
# 网关 loadDotEnv 会把 gateway/.env、仓库根 .env 里未定义的变量补进来，providers.json 的 apiKeyEnv 又能指向任意变量名，
# 没法逐个置空；Next 运行时也会读 web/.env*。有这些文件就不跑，免得测试网关拿到真实密钥
dotenv=$(find "$ROOT" "$ROOT/gateway" "$ROOT/web" -maxdepth 1 -name '.env*' ! -name '*.example' 2>/dev/null)
[ -z "$dotenv" ] || { echo "检测到 .env 文件，拒绝运行："; echo "$dotenv"; exit 2; }

TMP="$(mktemp -d)"
mkdir -p "$TMP/home"
# 子服务一律清空环境起，只放白名单；已知的密钥类变量再显式置空（loadDotEnv 只填未定义的，空串不会被覆盖）
CLEAN=(env -i "PATH=$PATH" "HOME=$TMP/home" "LANG=${LANG:-C.UTF-8}" "TMPDIR=${TMPDIR:-/tmp}"
  CURSOR_API_KEY= CURSOR_REMOTE_TOKEN= CURSOR_REMOTE_PASSWORD= JIEBO_PUBLISH_SECRET=
  APNS_TEAM_ID= APNS_KEY_ID= APNS_PRIVATE_KEY= APNS_PRIVATE_KEY_PATH=)
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

rand() { node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))'; }
ADMIN_TOKEN="ui-admin-$(rand)"
USER_TOKEN="ui-user-$(rand)"

cat >"$TMP/tenants.json" <<EOF
{
  "tenants": [
    { "id": "ui-admin", "name": "界面冒烟管理员", "token": "$ADMIN_TOKEN", "admin": true },
    { "id": "ui-user", "name": "界面冒烟用户", "token": "$USER_TOKEN" }
  ]
}
EOF
mkdir -p "$TMP/state/tenants/ui-user/workspace/$WORKSPACE" "$TMP/state/tenants/ui-user/workspace/$WORKSPACE_SECOND"
printf '# 界面冒烟工作区\n' >"$TMP/state/tenants/ui-user/workspace/$WORKSPACE/README.md"
printf '# 界面冒烟第二工作区\n' >"$TMP/state/tenants/ui-user/workspace/$WORKSPACE_SECOND/README.md"
cat >"$TMP/state/providers.json" <<EOF
{
  "providers": [
    { "id": "fake", "name": "假模型", "baseURL": "http://127.0.0.1:$LLM_PORT/v1", "apiKey": "ui-fake", "models": ["m1"], "tools": false }
  ]
}
EOF

"${CLEAN[@]}" node "$ROOT/scripts/smoke/ui-smoke.mjs" --fake-llm "$LLM_PORT" >"$TMP/fake-llm.log" 2>&1 &
PIDS+=($!)

(cd "$ROOT/gateway" && exec "${CLEAN[@]}" \
  CURSOR_REMOTE_STATE_DIR="$TMP/state" \
  CURSOR_REMOTE_TENANTS_FILE="$TMP/tenants.json" \
  CURSOR_API_KEY="ui-smoke-collab-fixture" \
  CURSOR_REMOTE_MEDIA_SECRET="ui-media-secret" \
  GATEWAY_PROXY_WEB=0 \
  GATEWAY_HOST=127.0.0.1 \
  GATEWAY_PORT="$GW_PORT" \
  node --import tsx src/index.ts) >"$TMP/gateway.log" 2>&1 &
PIDS+=($!)

(cd "$ROOT/web" && exec "${CLEAN[@]}" NODE_ENV=production HOST=127.0.0.1 PORT="$WEB_PORT" \
  NEXT_PUBLIC_BASE_PATH="$BASE_PATH" GATEWAY_WS_URL="ws://127.0.0.1:$GW_PORT/bridge" \
  node server.mjs) >"$TMP/web.log" 2>&1 &
PIDS+=($!)

logs() {
  for name in fake-llm gateway web; do
    echo "---- $name.log（末 40 行）"
    tail -40 "$TMP/$name.log" 2>/dev/null || true
  done
}
wait_http() {
  local label=$1 url=$2
  for _ in $(seq 1 120); do
    if curl -sf -o /dev/null "$url"; then return 0; fi
    for pid in "${PIDS[@]}"; do
      kill -0 "$pid" 2>/dev/null || { echo "$label 启动前有进程退出了"; logs; exit 1; }
    done
    sleep 0.5
  done
  echo "$label 60 秒内没就绪：$url"
  logs
  exit 1
}
wait_http 假模型 "http://127.0.0.1:$LLM_PORT/v1/models"
# 网关根路径对普通 GET 不一定回 2xx，能连上即可
for _ in $(seq 1 120); do
  curl -s -o /dev/null "http://127.0.0.1:$GW_PORT/" && break
  sleep 0.5
done
wait_http 网页 "http://127.0.0.1:$WEB_PORT$BASE_PATH/"

mkdir -p "$SHOTS"
status=0
UI_URL="http://127.0.0.1:$WEB_PORT$BASE_PATH/" UI_USER_TOKEN="$USER_TOKEN" UI_ADMIN_TOKEN="$ADMIN_TOKEN" \
  UI_SHOTS="$SHOTS" UI_WORKSPACE="$WORKSPACE" UI_WORKSPACE_SECOND="$WORKSPACE_SECOND" UI_KIT="$UI_KIT" \
  node "$ROOT/scripts/smoke/ui-smoke.mjs" || status=$?

if [ "$status" -ne 0 ]; then logs; fi
exit "$status"
