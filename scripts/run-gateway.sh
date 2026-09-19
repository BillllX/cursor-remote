#!/bin/sh
# 生产 gateway：无 watch。进程挂了或 /health 连续失败会拉起来。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${GATEWAY_PORT:-8787}"
NODE="${CURSOR_REMOTE_NODE:-}"
if [ -z "$NODE" ]; then
  if [ -x /usr/local/bin/node ]; then
    NODE=/usr/local/bin/node
  elif [ -x /opt/homebrew/bin/node ]; then
    NODE=/opt/homebrew/bin/node
  else
    NODE="$(command -v node || true)"
  fi
fi
TSX="${ROOT}/node_modules/tsx/dist/cli.mjs"

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "找不到 node。请安装 Node 22+。"
  exit 1
fi
if [ ! -f "$TSX" ]; then
  echo "找不到 tsx。先在 ${ROOT} 运行 npm install。"
  exit 1
fi

CHILD=""

stop_gateway() {
  if [ -n "$CHILD" ]; then
    kill "$CHILD" 2>/dev/null
    wait "$CHILD" 2>/dev/null
    CHILD=""
  fi
  PIDS="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null || true
  fi
}

cleanup() {
  stop_gateway
  exit 0
}

trap cleanup TERM INT HUP

start_gateway() {
  stop_gateway
  echo "$(date '+%F %T') 启动 gateway  ${NODE}  :${PORT}"
  cd "$ROOT"
  export NODE_ENV=production
  "$NODE" "$TSX" "${ROOT}/gateway/src/index.ts" &
  CHILD=$!
}

health_ok() {
  curl -sf --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null
}

echo "gateway 保活: ${ROOT} （生产，非 npm run dev）"
start_gateway
fails=0

while true; do
  sleep 8
  if [ -z "$CHILD" ] || ! kill -0 "$CHILD" 2>/dev/null; then
    echo "$(date '+%F %T') gateway 进程不在了，重启"
    start_gateway
    fails=0
    continue
  fi
  if health_ok; then
    fails=0
    continue
  fi
  fails=$((fails + 1))
  echo "$(date '+%F %T') 本机 127.0.0.1:${PORT}/health 失败 (${fails}/3)"
  if [ "$fails" -ge 3 ]; then
    echo "$(date '+%F %T') 连续失败，重启 gateway"
    start_gateway
    fails=0
  fi
done
