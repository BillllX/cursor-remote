#!/bin/sh
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

LABEL="com.cursor-remote.tunnel"
SRC="$(cd "$(dirname "$0")" && pwd)/com.cursor-remote.tunnel.plist"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
cp "$SRC" "$DEST"

launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
pkill -f "autossh -M 0 -N .*root@150.158.85.220" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/${UID_NUM}" "$DEST"
launchctl enable "gui/${UID_NUM}/${LABEL}"
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
echo "已装随道保活: ${DEST}"
echo "日志: ${HOME}/Library/Logs/cursor-remote-tunnel.log"
echo "关掉: launchctl bootout gui/${UID_NUM}/${LABEL}"
