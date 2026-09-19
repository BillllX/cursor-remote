#!/bin/sh
# SSH 反向随道 + 健康检查。远端 8787 连续失败会重启 autossh；
# 本机 gateway 没起来时只等待，不把随道杀掉。
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

HOST="${CURSOR_REMOTE_VPS:-root@150.158.85.220}"
REMOTE_PORT="${CURSOR_REMOTE_TUNNEL_PORT:-8787}"
LOCAL_PORT="${GATEWAY_PORT:-8787}"
BIN="$(command -v autossh || true)"

if [ -z "$BIN" ]; then
  echo "没找到 autossh。先安装: brew install autossh"
  exit 1
fi

AUTOSSH_PID=""

stop_tunnel() {
  if [ -n "$AUTOSSH_PID" ]; then
    kill "$AUTOSSH_PID" 2>/dev/null
    wait "$AUTOSSH_PID" 2>/dev/null
    AUTOSSH_PID=""
  fi
  pkill -f "autossh -M 0 -N .*${HOST}" 2>/dev/null || true
}

cleanup() {
  stop_tunnel
  exit 0
}

trap cleanup TERM INT HUP

start_tunnel() {
  stop_tunnel
  export AUTOSSH_GATETIME=0
  export AUTOSSH_POLL=30
  export AUTOSSH_PIDDIR="${TMPDIR:-/tmp}"
  echo "$(date '+%F %T') 启动随道 ${HOST} 127.0.0.1:${REMOTE_PORT} -> 本机 ${LOCAL_PORT}"
  "$BIN" -M 0 -N \
    -o ServerAliveInterval=20 \
    -o ServerAliveCountMax=3 \
    -o TCPKeepAlive=yes \
    -o ExitOnForwardFailure=yes \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new \
    -R "127.0.0.1:${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}" \
    "$HOST" &
  AUTOSSH_PID=$!
}

local_ok() {
  curl -sf --max-time 3 "http://127.0.0.1:${LOCAL_PORT}/health" >/dev/null
}

remote_ok() {
  ssh -o BatchMode=yes -o ConnectTimeout=12 -o ConnectionAttempts=1 \
    -o StrictHostKeyChecking=accept-new \
    "$HOST" "curl -sf --max-time 5 http://127.0.0.1:${REMOTE_PORT}/health" >/dev/null
}

echo "随道保活: ${HOST} （本机 gateway 请保持 npm run dev）"
start_tunnel
fails=0

while true; do
  sleep 20
  if [ -z "$AUTOSSH_PID" ] || ! kill -0 "$AUTOSSH_PID" 2>/dev/null; then
    echo "$(date '+%F %T') autossh 不在了，重启"
    start_tunnel
    fails=0
    continue
  fi
  if ! local_ok; then
    continue
  fi
  if remote_ok; then
    fails=0
    continue
  fi
  fails=$((fails + 1))
  echo "$(date '+%F %T') 远端 127.0.0.1:${REMOTE_PORT} 不健康 (${fails}/3)"
  if [ "$fails" -ge 6 ]; then
    echo "$(date '+%F %T') 连续失败，重建随道（外网重启后会自动连回来）"
    start_tunnel
    fails=0
  fi
done
