#!/bin/sh
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

PORT="${GATEWAY_PORT:-8787}"
BIN="$(command -v cloudflared || true)"

if [ -z "$BIN" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "没找到 cloudflared。先安装 Homebrew，再运行: brew install cloudflared"
    exit 1
  fi
  echo "正在安装 cloudflared..."
  brew install cloudflared
  BIN="$(command -v cloudflared)"
fi

echo "本机 gateway: http://127.0.0.1:${PORT}"
echo "请保持另一边的 npm run dev 开着。"
echo "Cloudflare 会给出 https://….trycloudflare.com ，用那个地址从外网打开。"
exec "$BIN" tunnel --url "http://127.0.0.1:${PORT}" --protocol http2
