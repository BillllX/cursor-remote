#!/bin/sh
# 为网关安装本机 PPT 转 PDF 组件；已有 LibreOffice 时可重复执行。
set -eu

if command -v libreoffice >/dev/null 2>&1; then
  echo "PPT 预览组件 LibreOffice 已安装。"
  exit 0
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 执行此脚本安装 PPT 预览组件；macOS 可执行 brew install --cask libreoffice。"
  exit 1
fi
if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libreoffice-impress fonts-noto-cjk
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y libreoffice-impress
  echo "中文演示文稿请同时安装系统仓库中的 Noto CJK 字体包。"
else
  echo "未找到 apt-get/dnf，请手动安装 LibreOffice Impress 并将 libreoffice 放入网关服务 PATH。"
  exit 1
fi
