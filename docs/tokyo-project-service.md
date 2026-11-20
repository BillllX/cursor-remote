# 东京站旧试点存储服务运维记录

**适用范围：** 下文用于保全和停用旧试点数据。新版从原工作区切换器直接共享，使用现有 Linux 网关，按正常网关与客户端发布流程升级。新版无需运行下文安装命令。

东京站入口为 `https://jiebo.aiagentswitcher.com`。本手册用于在东京准备独立存储服务并开通小范围试点。常规网关发布沿用该站现有流程，项目服务使用独立的 systemd 单元。源码、Web 静态产物和项目服务应来自同一审核版本。

## 安装前核对

- 使用已经核验主机身份的东京运维连接。上海的 SSH 别名 `shanghai` 和测试脚本只用于上海。
- 核对实际单元和状态目录。脚本针对仓库提供的东京 VPS 布局，网关身份为 `cursor-remote`、状态目录为 `/var/lib/cursor-remote`、Node 路径为 `/opt/node-v22/bin/node`。若现场不同，先根据已安装单元确认差异再调整脚本。
- 准备本地磁盘上的只读发布目录，例如 `/opt/jiebo-project-release-<提交号>`，含 `gateway/`、`shared/`、`scripts/` 和锁定版本的运行依赖，确认支持 `node:sqlite`。发布树由 root 持有，服务账号与普通 Agent 均不能改写。
- 准备已注册的试点账号。加到策略之前，从实际普通租户的个人 Agent 执行环境验证项目数据库、两份签名密钥和项目 socket 对该环境不可访问。账号的 `sandbox` 必须开启，平台管理员不符合普通租户准入条件。
- 安装配置只开放 Unix socket，模型入口保持禁用。真实供应商及计费仍需单独验收。

## 安装、验收与开通

准备私有 JSON 文件，权限设为 `0600`。以下是账号格式示例，换成已经完成隔离检查的真实试点 ID。分享域相同的账号才可以互相邀请。

```json
[
  {"id":"pilot-owner","sharingEnabled":true,"sharingDomain":"tokyo-pilot","sandboxVerified":true},
  {"id":"pilot-editor","sharingEnabled":true,"sharingDomain":"tokyo-pilot","sandboxVerified":true}
]
```

在东京主机上的发布目录执行以下命令。保持参数中的版本目录与审核提交对应。

```bash
sudo bash scripts/install-project-service.sh install /opt/jiebo-project-release-<提交号> /root/tokyo-project-accounts.json
sudo bash scripts/install-project-service.sh check pilot-owner
sudo bash scripts/install-project-service.sh check pilot-editor
```

脚本建立 `jiebo-projects` 服务身份、独立数据目录和 socket，并将 `projects-client.json` 写入网关状态目录。检查会以网关身份走真实签名请求，同时确认该身份无法直接读取数据库。检查失败时优先查看：

```bash
sudo systemctl status cursor-remote-project-store --no-pager
sudo journalctl -u cursor-remote-project-store -n 60 --no-pager
```

通过后，把试点账号的 `projectSharingEnabled`、`projectSharingDomain`、`projectSandboxVerified` 写入东京网关实际使用的 `tenants.json`（默认 `/etc/cursor-remote/tenants.json`），值分别为 `true`、同一分享域和 `true`。保留原账号记录、口令和其他配置。按东京站现有发布流程加载同版本网关与 Web，网关重启安排在维护窗口。项目 Web 上传和下载经站内同源代理，无需修改 nginx 或证书。

用试点账号 A 和 B 各自登录浏览器。A 打开「共享项目」、创建空项目、邀请 B 为编辑者，B 接受后保存一份文本，A 读取；再覆盖旧版本冲突、共享消息、撤权后重新读取被拒绝。另用未开通账号确认入口隐藏。记录 Git 提交、检查时间、浏览器结果和使用的两个试点 ID。移动端单独构建及验收。正式站开通以前以试点结果为准。

## 升级、停用与故障处理

- 升级前停止项目服务，确认项目库无写入。将 `/var/lib/cursor-remote-projects` 整个目录和 `/etc/cursor-remote-projects` 私下备份，保留权限。项目库和文件对象按同一时间点恢复。备份包括签名密钥，只供受信任运维读取。
- 安装脚本支持重新运行，可用新的只读发布目录和试点策略重装，复用数据库和密钥。若版本切换失败，先停服务；确认没有格式变更后用原发布目录重装。发生格式变更时先按完整备份恢复，再启动旧版本。
- 单个账号停用时，在维护窗口使用更新后的策略文件重新执行 install，检查存储服务已经撤销该账号，再更新网关租户开关并按维护流程加载。需要全部停用时执行 `sudo bash scripts/install-project-service.sh stop`。数据库、对象和配置继续保留。
- 看到 `NOT_ACCESSIBLE`，先核对试点用户、分享域、网关租户开关及沙箱验证标志。看到 `PROJECT_UNAVAILABLE`，先检查项目单元、socket 权限、网关配置文件和发布目录。
- 项目存储目录默认为 `/var/lib/cursor-remote-projects`，服务私有配置为 `/etc/cursor-remote-projects`，socket 为 `/run/cursor-remote-projects/store.sock`。密钥、数据库、项目正文都不进入发布包或验收记录。
