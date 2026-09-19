#!/bin/sh
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

LABEL="com.cursor-remote.gateway"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/scripts/com.cursor-remote.gateway.plist"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
PORT="${GATEWAY_PORT:-8787}"

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"

sed \
  -e "s|__ROOT__|${ROOT}|g" \
  -e "s|__HOME__|${HOME}|g" \
  "$SRC" > "$DEST"

launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true

# 不要和 npm run dev / tsx watch 抢 8787
pkill -f "concurrently -n web,gateway" 2>/dev/null || true
pkill -f "tsx watch src/index.ts" 2>/dev/null || true
PIDS="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs kill 2>/dev/null || true
  sleep 1
fi

launchctl bootstrap "gui/${UID_NUM}" "$DEST"
launchctl enable "gui/${UID_NUM}/${LABEL}"
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"

echo "已装 gateway 生产保活: ${DEST}"
echo "日志: ${HOME}/Library/Logs/cursor-remote-gateway.log"
echo "关掉: launchctl bootout gui/${UID_NUM}/${LABEL}"
