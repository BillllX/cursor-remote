#!/usr/bin/env bash
# iOS Swift 检查：
#   1. swiftc -parse 解析 ios/ 下全部 .swift，语法错误即失败（非 0 退出）
#   2. 对相对 origin/main 改动过（含未提交、未跟踪）的 .swift 跑 swift-format lint，只提示不失败
# 工具链：SWIFT_BIN 指向工具链的 bin 目录；没设就用 PATH 里的 swiftc；都没有就提示并跳过（退出码 0）。
# 用法：SWIFT_BIN=/path/to/swift/usr/bin npm run lint:swift
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -n "${SWIFT_BIN:-}" ]]; then
  SWIFTC="$SWIFT_BIN/swiftc"
  SWIFT_FORMAT="$SWIFT_BIN/swift-format"
  if [[ ! -x "$SWIFTC" ]]; then
    echo "SWIFT_BIN=$SWIFT_BIN 下找不到可执行的 swiftc" >&2
    exit 1
  fi
elif command -v swiftc >/dev/null 2>&1; then
  SWIFTC="$(command -v swiftc)"
  SWIFT_FORMAT="$(dirname "$SWIFTC")/swift-format"
  [[ -x "$SWIFT_FORMAT" ]] || SWIFT_FORMAT="$(command -v swift-format 2>/dev/null || true)"
else
  echo "没找到 Swift 工具链（未设 SWIFT_BIN，PATH 里也没有 swiftc），跳过 Swift 检查。"
  exit 0
fi

files=()
while IFS= read -r -d '' file; do
  files+=("$file")
done < <(find ios -name '*.swift' -not -path '*/build/*' -not -path '*/DerivedData/*' -print0 | sort -z)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "ios/ 下没有 .swift 文件"
  exit 0
fi

echo "swiftc -parse：${#files[@]} 个文件（$("$SWIFTC" --version 2>/dev/null | head -n 1)）"
# 一次传全部文件，比逐个起进程快得多
if ! "$SWIFTC" -parse -swift-version 5 -enable-bare-slash-regex "${files[@]}"; then
  echo "swiftc -parse 失败" >&2
  exit 1
fi
echo "swiftc -parse 通过 ✅"

if [[ -z "${SWIFT_FORMAT:-}" || ! -x "$SWIFT_FORMAT" ]]; then
  echo "没找到 swift-format，跳过格式提示。"
  exit 0
fi

base="origin/main"
if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  base="HEAD"
  echo "没有 origin/main，改用 HEAD 比对"
fi

changed=()
while IFS= read -r file; do
  [[ -f "$file" ]] && changed+=("$file")
done < <(
  {
    git diff --name-only --diff-filter=ACMR "$base" -- 'ios/*.swift'
    git ls-files --others --exclude-standard -- 'ios/*.swift'
  } | sort -u
)

if [[ ${#changed[@]} -eq 0 ]]; then
  echo "相对 $base 没有改动的 .swift，跳过 swift-format lint"
  exit 0
fi

echo "swift-format lint（只提示，不影响退出码）：${#changed[@]} 个相对 $base 改动过的文件"
"$SWIFT_FORMAT" lint --configuration ios/.swift-format "${changed[@]}" || true
exit 0
