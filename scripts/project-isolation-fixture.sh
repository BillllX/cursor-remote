#!/usr/bin/env bash
# 仅在上海独立测试环境安装夹具，不触碰正式网关配置或服务。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo '仅由受信任运维创建隔离夹具'; exit 2; }
ACTION=${1:?start 或 stop}
REPO=/opt/cursor-remote-test/cursor-remote
FIXTURE=/opt/cursor-remote-project-fixture
UNIT=cursor-remote-project-fixture
case "$ACTION" in
  start)
    id cr-project-store >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin cr-project-store
    id cr-project-outsider >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin cr-project-outsider
    systemctl stop "$UNIT" 2>/dev/null || true
    install -d -m 755 "$FIXTURE"
    install -d -o cr-project-store -g cr-test -m 750 "$FIXTURE/runtime"
    install -d -o cr-project-store -g cr-project-store -m 700 "$FIXTURE/store"
    install -d -o cr-test -g cr-test -m 700 "$FIXTURE/client"
    install -d -o cr-project-store -g cr-project-store -m 700 "$FIXTURE/server"
    /opt/node-v22/bin/node - "$FIXTURE" <<'JS'
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');const dir=process.argv[2];
const key=crypto.randomBytes(32);fs.writeFileSync(path.join(dir,'server/key'),key,{mode:0o600});fs.writeFileSync(path.join(dir,'client/key'),key,{mode:0o600});
const ids=['project-owner','project-editor','project-viewer','project-outsider'];
const accounts=ids.map(id=>({id,sharingEnabled:true,sharingDomain:'project-fixture',sandboxVerified:true}));
fs.writeFileSync(path.join(dir,'server/accounts.json'),JSON.stringify(accounts),{mode:0o600});
fs.writeFileSync(path.join(dir,'server/config.json'),JSON.stringify({directory:path.join(dir,'store'),socketPath:path.join(dir,'runtime/store.sock'),keyFile:path.join(dir,'server/key'),accountsFile:path.join(dir,'server/accounts.json')}),{mode:0o600});
fs.writeFileSync(path.join(dir,'client/settings.json'),JSON.stringify({socketPath:path.join(dir,'runtime/store.sock'),keyFile:path.join(dir,'client/key')}),{mode:0o600});
JS
    chown -R cr-project-store:cr-project-store "$FIXTURE/server" "$FIXTURE/store"
    chown -R cr-test:cr-test "$FIXTURE/client"
    # 不覆盖正式 unit；仅此固定名称的测试进程。flock 保证项目库只有一个服务写入者。
    cat > "/etc/systemd/system/$UNIT.service" <<UNIT
[Unit]
Description=共享项目独立测试夹具
[Service]
User=cr-project-store
Group=cr-test
WorkingDirectory=$REPO
ExecStartPre=/usr/bin/rm -f $FIXTURE/runtime/store.sock
ExecStart=/usr/bin/flock -n $FIXTURE/store/service.lock /opt/node-v22/bin/node --import tsx gateway/src/projects/service-main.ts $FIXTURE/server/config.json
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$FIXTURE
[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl start "$UNIT"
    for attempt in $(seq 1 30); do [ -S "$FIXTURE/runtime/store.sock" ] && break; sleep 1; done
    systemctl is-active --quiet "$UNIT"
    [ -S "$FIXTURE/runtime/store.sock" ]
    echo '共享项目隔离测试服务已启动（不启用开机自启）'
    ;;
  stop)
    systemctl stop "$UNIT" 2>/dev/null || true
    echo '共享项目隔离测试服务已停止，测试数据保留供复核'
    ;;
  *) exit 2 ;;
esac
