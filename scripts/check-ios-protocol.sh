#!/usr/bin/env bash
# iOS 协议契约检查（不启动服务、不监听端口）：
#   1. 把 App 里协议相关的 Swift 源码编成静态库 JieboProtocol（按源码哈希缓存在临时目录）
#   2. 编译 ios/ContractTests/main.swift 并运行：server 样本解码快照对比 + iOS 不处理的 type 清单
#   3. iOS 编码出的 client JSON 交给 scripts/check-ios-client.mts 按 TS ClientMessage 查字段
# 工具链：SWIFT_BIN 指向工具链 bin 目录；没设就用 PATH 里的 swiftc；都没有就提示并跳过（退出码 0），
# CI 设 REQUIRE_SWIFT=1 时改为失败。
# 用法：SWIFT_BIN=/path/to/swift/usr/bin npm run check:ios-protocol [-- --update]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# UI 源码级契约：所有 chrome 都过滤 silent，但 workspace_memory_propose 必须可见。
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const turn = readFileSync("ios/Jiebo/Jiebo/Views/TurnView.swift", "utf8");
const tools = readFileSync("ios/Jiebo/Jiebo/Views/ThreadAssistantRows.swift", "utf8");
if (!turn.includes("return tools.filter { !AssistantToolText.isSilent($0) }") || turn.includes("return embedded ? tools.filter")) {
  throw new Error("iOS chrome 必须统一过滤 AssistantToolText.isSilent");
}
const silentBody = tools.match(/static func isSilent\(_ tool: ToolCall\) -> Bool \{([\s\S]*?)\n    \}/)?.[1] ?? "";
if (!silentBody.includes("workspace_memory_search") || silentBody.includes("workspace_memory_propose")) {
  throw new Error("iOS silent 工具集合必须隐藏 search/mark_used，但保留 propose");
}
console.log("iOS silent tool chrome 源码契约：通过");
NODE

update=0
for arg in "$@"; do
  case "$arg" in
    --update) update=1 ;;
    *)
      echo "不认识的参数：$arg（只支持 --update）" >&2
      exit 1
      ;;
  esac
done

if [[ -n "${SWIFT_BIN:-}" ]]; then
  SWIFTC="$SWIFT_BIN/swiftc"
  if [[ ! -x "$SWIFTC" ]]; then
    echo "SWIFT_BIN=$SWIFT_BIN 下找不到可执行的 swiftc" >&2
    exit 1
  fi
elif command -v swiftc >/dev/null 2>&1; then
  SWIFTC="$(command -v swiftc)"
elif [[ "${REQUIRE_SWIFT:-}" == "1" ]]; then
  echo "REQUIRE_SWIFT=1 但没找到 swiftc（未设 SWIFT_BIN，PATH 里也没有）" >&2
  exit 1
else
  echo "没找到 Swift 工具链（未设 SWIFT_BIN，PATH 里也没有 swiftc），跳过 iOS 协议契约检查。"
  exit 0
fi

APP=ios/Jiebo/Jiebo
# 协议的最小依赖闭包：都只 import Foundation，原样参与编译
SOURCES=(
  "$APP/Gateway/Protocol.swift"
  "$APP/Gateway/MemoryCenterTypes.swift"
  "$APP/Gateway/MemoryCenterImportTypes.swift"
  "$APP/Gateway/ImProtocol.swift"
  "$APP/Gateway/JSONValue.swift"
  "$APP/Gateway/ModelCatalog.swift"
  "$APP/Session/MemoryCenterReducer.swift"
  "$APP/Session/MemoryCenterExtrasReducer.swift"
  "$APP/Session/MemoryCenterLayoutMetrics.swift"
  "$APP/Session/Preview.swift"
  "$APP/Session/ChatModels.swift"
)
CONTRACT=ios/ContractTests
FLAGS=(-Onone -swift-version 5 -enable-bare-slash-regex)

hash_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi
}

LIB_FLAGS=(-parse-as-library -enable-testing -module-name JieboProtocol -emit-library -static)

# 缓存键：swiftc 完整版本（含 Target 行）、编译参数、每个源文件的路径和内容（用 \0 分隔，防止拼接歧义）
version_full="$("$SWIFTC" --version 2>/dev/null)"
key="$(
  {
    printf '%s\0' "$version_full" "${FLAGS[*]}" "${LIB_FLAGS[*]}"
    for file in "${SOURCES[@]}"; do
      printf '%s\0' "$file"
      cat "$file"
      printf '\0'
    done
  } | hash_cmd | cut -c1-16
)"
CACHE_ROOT="${JIEBO_IOS_CONTRACT_CACHE:-${TMPDIR:-/tmp}/jiebo-ios-contract-cache}"
LIB="$CACHE_ROOT/$key"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/jiebo-ios-contract.XXXXXX")"
BUILD=""
trap 'rm -rf "$WORK" ${BUILD:+"$BUILD"}' EXIT

echo "Swift：$(head -n 1 <<<"$version_full")"

# 记忆中心 SwiftUI / 会话桥接：契约库不含 Views，单独 swiftc -parse 防语法回归
PARSE_UI=()
while IFS= read -r -d '' file; do
  PARSE_UI+=("$file")
done < <(find "$APP/Views/MemoryCenter" -name '*.swift' -print0 | sort -z)
if [[ -f "$APP/Session/ChatStore+MemoryCenter.swift" ]]; then
  PARSE_UI+=("$APP/Session/ChatStore+MemoryCenter.swift")
fi
if [[ -f "$APP/Session/ChatStore+MemoryCenterExtras.swift" ]]; then
  PARSE_UI+=("$APP/Session/ChatStore+MemoryCenterExtras.swift")
fi
if [[ ${#PARSE_UI[@]} -gt 0 ]]; then
  echo "swiftc -parse：记忆中心 UI/桥接（${#PARSE_UI[@]} 个文件）…"
  if ! "$SWIFTC" -parse -swift-version 5 -enable-bare-slash-regex "${PARSE_UI[@]}"; then
    echo "记忆中心 SwiftUI swiftc -parse 失败" >&2
    exit 1
  fi
  echo "记忆中心 SwiftUI swiftc -parse 通过 ✅"
fi
# .ready 最后落地：看到它就说明库和模块文件都已就位
if [[ -f "$LIB/.ready" ]]; then
  echo "协议库命中缓存：$LIB"
else
  echo "编译协议库（${#SOURCES[@]} 个文件）…"
  start=$SECONDS
  mkdir -p "$CACHE_ROOT"
  # 在缓存同一文件系统上的唯一临时目录里编译，逐个 mv（rename 是原子的）再写 .ready；
  # 并发的两次运行键相同、产物相同，互相覆盖也不会留下半个文件
  BUILD="$(mktemp -d "$CACHE_ROOT/.build.XXXXXX")"
  "$SWIFTC" "${FLAGS[@]}" "${LIB_FLAGS[@]}" -o "$BUILD/libJieboProtocol.a" \
    -emit-module -emit-module-path "$BUILD/JieboProtocol.swiftmodule" \
    "${SOURCES[@]}"
  mkdir -p "$LIB"
  for file in "$BUILD"/*; do
    mv -f "$file" "$LIB/"
  done
  : >"$BUILD/.ready"
  mv -f "$BUILD/.ready" "$LIB/.ready"
  echo "协议库编译完成：$((SECONDS - start)) 秒"
fi

echo "编译契约测试…"
start=$SECONDS
"$SWIFTC" "${FLAGS[@]}" -I "$LIB" -L "$LIB" -lJieboProtocol "$CONTRACT/main.swift" -o "$WORK/contract"
echo "契约测试编译完成：$((SECONDS - start)) 秒"

args=(
  --fixtures shared/fixtures/protocol.json
  --snapshot "$CONTRACT/server-decode.snapshot.txt"
  --ignored "$CONTRACT/ios-ignored-server-types.txt"
  --client-out "$WORK/ios-client.json"
  --actual "$WORK/server-decode.actual.txt"
)
[[ $update -eq 1 ]] && args+=(--update)

status=0
"$WORK/contract" "${args[@]}" || status=$?
if [[ -f "$WORK/server-decode.actual.txt" ]]; then
  echo "快照差异（- 期望 / + 实际，最多 80 行）："
  diff -u "$CONTRACT/server-decode.snapshot.txt" "$WORK/server-decode.actual.txt" | head -n 80 || true
fi

if [[ -f "$WORK/ios-client.json" ]]; then
  "$ROOT/node_modules/.bin/tsx" scripts/check-ios-client.mts "$WORK/ios-client.json" || status=1
else
  status=1
fi

if [[ $status -ne 0 ]]; then
  echo "iOS 协议契约检查失败 ❌" >&2
  exit 1
fi
echo "iOS 协议契约检查通过 ✅"
