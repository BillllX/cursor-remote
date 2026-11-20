#!/usr/bin/env bash
# 东京站在目标主机本地执行。只管理独立项目服务和其配置。
set -euo pipefail
umask 077
unit=cursor-remote-project-store
service_user=jiebo-projects
gateway_user=cursor-remote
node=/opt/node-v22/bin/node
config=/etc/cursor-remote-projects
data=/var/lib/cursor-remote-projects
runtime=/run/cursor-remote-projects
state=/var/lib/cursor-remote
unit_file=/etc/systemd/system/$unit.service
tmpfiles=/etc/tmpfiles.d/$unit.conf

usage() {
  cat <<'HELP'
用法：
  sudo bash scripts/install-project-service.sh install <审核后的只读发布目录> <试点账号策略 JSON>
  sudo bash scripts/install-project-service.sh check <试点站内账号 ID>
  sudo bash scripts/install-project-service.sh stop

install 启动独立项目存储服务并启用开机启动，保留已有数据库和签名密钥。
check 核验网关账号能访问服务且不能直接读取项目数据库。
stop 停止服务并取消开机启动，保留数据和配置。
HELP
}
fail() { echo "$*" >&2; exit 1; }
case ${1:-} in -h|--help|"") usage; exit 0;; esac
[[ $(id -u) == 0 ]] || fail "请使用 sudo 在东京目标主机执行"
case "$1" in
  install)
    [[ $# == 3 ]] || fail "需要发布目录和试点账号策略"
    release=$(realpath -e "$2")
    policy=$(realpath -e "$3")
    [[ "$release" =~ ^/opt/[a-zA-Z0-9._/-]+$ ]] || fail "发布目录须为 /opt 下的绝对路径"
    for bin in systemctl systemd-tmpfiles systemd-analyze useradd runuser flock; do
      command -v "$bin" >/dev/null || fail "缺少 $bin"
    done
    id "$gateway_user" >/dev/null
    [[ -d "$state" && -f "$release/gateway/src/projects/service-main.ts" ]] || fail "网关状态目录或项目服务源码缺失"
    (cd "$release" && "$node" --import tsx -e 'const {DatabaseSync}=require("node:sqlite"); new DatabaseSync(":memory:").close()')
    "$node" - "$policy" <<'JS'
const entries = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(entries) || !entries.length || entries.some(a => !a ||
    typeof a.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(a.id) ||
    a.sharingEnabled !== true || a.sandboxVerified !== true ||
    typeof a.sharingDomain !== 'string' || !a.sharingDomain.trim()) ||
    new Set(entries.map(a=>a.id)).size !== entries.length) {
  throw new Error('试点策略必须包含唯一的站内账号、分享域及明确的准入标志');
}
JS
    existing=$(find "$release" -xdev ! -type l \( ! -user root -o -perm /022 \) -print -quit)
    [[ -z "$existing" ]] || fail "发布目录须由 root 持有，组和其他账号不能修改"
    id "$service_user" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$service_user"
    install -d -o root -g "$service_user" -m 0751 "$config"
    install -d -o "$service_user" -g "$service_user" -m 0700 "$data"
    install -d -o root -g "$gateway_user" -m 0750 "$config/client"
    runuser -u "$service_user" -- test -r "$release/gateway/src/projects/service-main.ts" || fail "项目服务身份无法读取发布目录"
    if [[ ! -e "$config/server.key" ]]; then
      "$node" -e 'require("node:fs").writeFileSync(process.argv[1],require("node:crypto").randomBytes(32),{flag:"wx",mode:0o600})' "$config/server.key"
    fi
    [[ -f "$config/server.key" && $(stat -c %s "$config/server.key") == 32 ]] || fail "现有签名密钥异常，保留现场"
    chown root:"$service_user" "$config/server.key"
    chmod 0640 "$config/server.key"
    install -o root -g "$gateway_user" -m 0640 "$config/server.key" "$config/client/client.key"
    install -o root -g "$service_user" -m 0640 "$policy" "$config/accounts.next"
    mv -f "$config/accounts.next" "$config/accounts.json"
    printf '%s\n' "$release" > "$config/release"
    printf '{"directory":"%s","socketPath":"%s/store.sock","keyFile":"%s/server.key","accountsFile":"%s/accounts.json"}\n' \
      "$data" "$runtime" "$config" "$config" > "$config/service.json"
    chown root:"$service_user" "$config/service.json"
    chmod 0640 "$config/service.json"
    printf 'd %s 2750 %s %s -\n' "$runtime" "$service_user" "$gateway_user" > "$tmpfiles"
    systemd-tmpfiles --create "$tmpfiles"
    cat > "$unit_file" <<UNIT
[Unit]
Description=Jiebo shared project store
After=systemd-tmpfiles-setup.service

[Service]
User=$service_user
Group=$service_user
WorkingDirectory=$release
ExecStart=/usr/bin/flock -n $data/service.lock /bin/sh -c '/usr/bin/rm -f $runtime/store.sock && exec $node --import tsx gateway/src/projects/service-main.ts $config/service.json'
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=$data $runtime
RestrictAddressFamilies=AF_UNIX

[Install]
WantedBy=multi-user.target
UNIT
    systemd-analyze verify "$unit_file"
    systemctl daemon-reload
    systemctl enable "$unit"
    systemctl restart "$unit"
    for i in $(seq 1 20); do
      [[ -S "$runtime/store.sock" ]] && break
      sleep 1
    done
    systemctl is-active --quiet "$unit"
    [[ -S "$runtime/store.sock" ]] || fail "socket 未就绪，请查该单元日志"
    client_tmp=$(mktemp "$state/.projects-client.XXXXXX")
    printf '{"socketPath":"%s/store.sock","keyFile":"%s/client/client.key"}\n' "$runtime" "$config" > "$client_tmp"
    chown root:"$gateway_user" "$client_tmp"
    chmod 0640 "$client_tmp"
    mv -f "$client_tmp" "$state/projects-client.json"
    echo "独立服务已启动，请执行 check 再按手册开通试点账号"
    ;;
  check)
    [[ $# == 2 && -f "$config/release" ]] || fail "需要已安装服务及试点账号 ID"
    release=$(<"$config/release")
    systemctl is-active --quiet "$unit"
    runuser -u "$gateway_user" -- test ! -r "$data/projects.sqlite" || fail "网关账号能直接读取项目库"
    (cd "$release" && runuser -u "$gateway_user" -- "$node" --import tsx scripts/project-service-check.mts "$state/projects-client.json" "$2")
    ;;
  stop)
    [[ $# == 1 ]] || fail "stop 不接受额外参数"
    systemctl disable --now "$unit"
    ;;
  *) usage; exit 2;;
esac
