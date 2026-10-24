# 系统架构与程序说明

基于 main `9c5ac13`。本文写给第一次接手代码的人：先看整体拓扑，再按“一轮对话怎么跑完”顺着读代码，最后是各目录职责、持久化、部署与测试。产品介绍和使用方式见 [README](../README.md)，多设备同步细节见 [chat-sync.md](./chat-sync.md)。

## 1. 一句话

浏览器和 iOS 客户端经 WSS 连到 VPS 上的**网关**（gateway）；网关按所选模型把每轮对话交给 **Cursor SDK** 或**自研 Agent**（第三方模型），在租户工作区里读改文件、跑命令，把流式事件发回发起设备；会话、助理、对外预览等状态按租户落在状态目录里。

## 2. 拓扑

```mermaid
flowchart TB
  subgraph 客户端
    B[浏览器 · 网页端]
    I[iOS Jiebo<br/>iPhone 助理 / iPad 工作台]
    V[外部访客]
  end
  NM[nginx · aiagentswitcher.com<br/>/cursor-remote → :3020]
  NS[nginx · jiebo.aiagentswitcher.com<br/>/ → :3020；/bridge /upload /media /state /p/ → :8787]
  W[Next 网页服务 :3020<br/>web/server.mjs]
  subgraph G[gateway · 127.0.0.1:8787]
    WS[ws/ 连接与分发] --> CH[chat/ 回合编排]
    CH --> NA[native/ 自研 Agent]
    CH --> GU[越界与策略]
    AS[assistant/ 个人助理]
    SY[sync/ · workspace/ · tenants]
    PB[publish 对外预览]
  end
  B --> NM --> W
  B -.-> NS
  I --> NS
  V -->|/p/| NS
  NS -->|/| W
  NS --> WS
  W -->|WS 转发 · /api/media| WS
  CH --> CUR[Cursor 云 @cursor/sdk]
  NA --> TP[第三方模型 API]
  AS --> PUSH[APNs / Web Push]
  SY --> ST[(状态目录 /var/lib/cursor-remote)]
  SY --> WK[(租户工作区)]
  PB --> PP[发布子进程 127.0.0.1:20000–20999]
```

两个入口的区别：

- **主站** `aiagentswitcher.com/cursor-remote`：nginx 只转到网页服务（`scripts/insert-nginx-cursor-remote.py`），WebSocket `/cursor-remote/bridge` 由 `web/server.mjs` 再转给网关，媒体走 Next 的 `app/api/media/route.ts` 反代。
- **子域** `jiebo.aiagentswitcher.com`：nginx 直接把 `/bridge`（→ 网关 `/ws`）、`/upload`、`/media`、`/state`、`/p/` 转给网关，其余到网页服务（`scripts/nginx-jiebo.aiagentswitcher.com.conf`）。iOS 走这条。

新增公开 HTTP 地址必须挂在上面这些前缀下，否则要改服务器 nginx。

## 3. 仓库结构

npm workspaces，三端共用 `shared/`。

| 目录 | 技术 | 规模（行） | 说明 |
|---|---|---|---|
| `gateway/` | Node 22 + tsx，ESM | src 约 21.9k | 网关服务；`import index.ts` 即启动 |
| `web/` | Next 15.5 + React 19 | 约 26.3k | 网页端 |
| `ios/` | SwiftUI，iOS 26 SDK | 约 25.1k | Jiebo App；工程用显式文件引用 |
| `shared/` | TypeScript | 约 1.8k | 协议、策略、方言、工具名判定 |
| `scripts/` | Node / bash / Python | 约 5.0k | 冒烟、bench、迁移、部署 |
| `docs/` | Markdown | — | 设计文档 |

## 4. 一轮对话的完整链路

按这个顺序读代码最快。

| 步 | 位置 | 做什么 |
|---|---|---|
| 1 | `web/components/ChatApp.tsx`、`ios/.../ChatStore+Composer.swift` | 客户端发 `prompt` |
| 2 | `gateway/src/ws/dispatch.ts` | `parseClient`；未鉴权只认 `hello`，之后按 `handlers[type]` 分发，未知类型忽略 |
| 3 | `gateway/src/ws/handlers/prompt.ts` | `onPrompt`：记回合；槽位忙则排队；首条消息异步生成标题 |
| 4 | `gateway/src/chat/runner.ts`、`chat/prompt.ts` | `handlePrompt`：拼工作区规则、方言提示，打开 transcript，按模型选执行路径 |
| 5a | `gateway/src/chat/agent.ts` | Cursor 模型：`ensureAgent` → `Agent.create/resume` → `send` + `stream` |
| 5b | `chat/native.ts` → `native/loop.ts`；`chat/external.ts` | 第三方模型：带工具走 `runNativeChat` → `runNativeLoop`（adapter 为 openai / anthropic / xml）；纯问答走 `runExternalChat` |
| 6 | `chat/tools.ts`、`chat/shellWrites.ts`、`native/confine.ts`、`shared/policy.ts` | 工具调用拦截：越界写入硬拦、策略禁用、写入确认（`approval` ↔ `approval_reply`） |
| 7 | `gateway/src/ws/send.ts` | `text-delta` / `thinking-delta` / `tool-*` 只发给发起设备；其他设备约 800ms 收一次 `run_snapshot` |
| 8 | `chat/finish.ts`、`turnFiles.ts`、`sync/transcript.ts` | `finishRun`：发 `done`，算本轮文件 `turn.files`，正文落盘 |
| 9 | `web/lib/chat/reducer.ts`、`ios/.../ChatStore+Handle.swift` | 客户端把消息折成本地会话与回合 |

越界拦截要点：路径统一用 `pathInside.ts` 的 `isInside` / `relEscapes` 判断，按 realpath 比较防符号链接绕过；shell 写命令（rm / mv / cp / install / rsync 等，含 sudo / env / timeout 等包装）也检查目标；`/tmp`、系统临时目录和 `/dev/*` 只对新增的写命令检查放行，重定向规则不放行。

## 5. 网关（gateway/src）

### 启动顺序（`index.ts`）

1. `loadDotEnv`（只填未定义的变量）→ 读端口、地址、默认模型等
2. `loadTenants()` → 清理状态目录临时文件（嵌套目录的清理延后 10 秒异步执行）
3. 各租户沙箱检查、压缩会话
4. 创建对外预览控制器
5. HTTP 服务：publish → `/health` → `/media/cal/` → `/media` → `/state` → `/upload` →（可选）反代网页
6. WebSocket 服务（`maxPayload` 96MiB，开启 deflate）；`upgrade` 依次交给 publish、WS 路径判断、`onConnection`
7. 绑定 Loop、后台作业，启动助理
8. `listen` → 拉起已登记的对外预览

### 目录职责

| 目录 / 文件 | 职责 |
|---|---|
| `ws/`、`ws/handlers/` | 连接、鉴权、分发、出站；`frameFor` 按客户端声明的帧上限裁剪大消息。处理器按领域分文件：hello、prompt、sessions、state、files、workspaces、checkpoints、loops、assistant、admin |
| `http/` | `routes.ts`（upload / media / state）、`health.ts`、`proxy.ts` |
| `chat/` | 回合编排：runner、agent、prompt、finish、history、title、review、models，以及工具拦截 tools / shellWrites |
| `native/` | 自研 Agent：loop、adapters（openai / anthropic / xml）、tools（fs / shell / task）、mcp、上下文压缩、路径围栏 confine |
| `assistant/` | 个人助理：收件箱、委派子会话、个人记忆、工作区记忆（`.jiebo/memory.md`）、日程待办、cron、后台作业、APNs 与 Web Push |

### 产物投影

`assistant_get` 的 `AssistantState.artifacts` 是只读派生数据，不是新的事实源：`assistant/artifactProjection.ts` 每次从当前租户既有会话的 `turn.files`、委派记录和 Share Assistant 收件箱的结构化 `capture` 字段构建，按时间和稳定 ID确定排序，最多返回 200 条；不写 `artifacts.json` 一类索引。委派文件以 `sourceChatId + sourceTurnId + path + sha/diffSha` 去重，文件只暴露工作区相对路径，绝对路径和越界路径直接丢弃；链接只接受捕获入口已校验并持久化的 HTTP(S) URL，不从收件箱正文或 actionPrompt 反解析，也不投影聊天正文、令牌或委派任务正文。

iPhone 从小驳菜单进入「产物中心」，仍在现有小驳导航栈内，不增加主 Tab。文件复用 `openTurnFile` / `PreviewPanelView`，链接走系统 `Link`；「让小驳继续处理」会带相对路径或安全 URL 和来源标签，固定提交到助理主会话，并在提交后恢复用户原草稿，避免串到工作区会话。
| `bindings/` | 把 Loop 和委派接到宿主运行时 |
| `runtime/` | `GatewayState`：连接、槽位、取消、审批等待、环境缓存 |
| `sync/` | `storedState.ts`（状态摘要与下发）、`transcript.ts`（运行中落盘） |
| `workspace/` | 文件读写、git 与影子 git、检查点、工作区增删改 |
| `auth/` | 登录失败限流：全表清理 60 秒节流，超限淘汰最早一条 |
| `tenants.ts` | 多租户加载、令牌解析、沙箱与围栏 |
| `publish.ts` | `/p/<id>/` 对外工作台：起停子进程、巡检、反代 |
| `providers.ts` | 读 `providers.json`，按 `provider:model` 路由第三方模型 |
| `chatBodies.ts` | 会话正文分段存盘（每段 100 轮），内存最多缓存 16 个会话、合计 64MB |
| `turnFiles.ts` | 本轮文件清单与 artifacts 快照配额 |
| `loops.ts` | 产品 Loop 调度 |
| `usage.ts`、`cursorBill.ts` | 自计量用量；Cursor 官方账单 |
| `config.ts` | 全部环境变量的唯一清单 `ENV_SPECS`（`npm run check:env` 校验） |
| `fsAtomic.ts`、`log.ts`、`pathInside.ts` | 原子写、日志（`GATEWAY_LOG_FORMAT=json` 输出 JSON）、路径包含判断 |

## 6. 共享层（shared/）

| 文件 | 内容 |
|---|---|
| `protocol.ts` | 客户端消息 39 种、服务端消息 47 种，三端唯一协议来源 |
| `protocol-fixtures.ts` → `fixtures/protocol.json` | 每种消息的金样本；`npm run gen:protocol-fixtures` 生成，iOS 契约测试解码它 |
| `policy.ts` | baseline / plane 两种策略、工具类别、ask / plan 模式禁用工具 |
| `dialect.ts` | 中文系模型（glm、kimi、qwen、deepseek 等）的提示补充 |
| `toolNames.ts` | “工具是否改写 / 写入 / 删除 / 写文件”按整词判定；网关和网页共用，iOS 的 `ChatModels.swift` 里 `enum ToolNames` 逐字照搬，改规则要两边同改 |
| `crew.ts`、`preview.ts`、`publishPrompt.ts` | 评审角色、预览 MIME、对外发布提示词 |

客户端消息分组：连接（hello、ping）、工作区、运行（prompt、cancel、set_model、set_policy、approval_reply 等）、会话、文件、检查点、同步（sync_state、sync_chat、load_chat 等）、Loop、助理、管理。

## 7. 网页端（web/）

| 位置 | 职责 |
|---|---|
| `app/page.tsx` | 首页，渲染 `ChatApp` |
| `app/api/media/route.ts` | 反代网关 `/media` |
| `app/canvas-runtime/` | 画布 iframe 运行页 |
| `app/styles/*.css`、`*.module.css` | 全局样式按区域分片；组件专属样式用 CSS Modules |
| `components/ChatApp.tsx` | 主壳：连接、会话状态、发 prompt、浮层编排（约 4.2k 行） |
| `components/chat/` | Thread、Composer、Sidebar（含 `sidebar/`）、LoginGate、Settings 以及 Files / Grep / Terminal / Loop / Workspace / Admin 等浮层 |
| `lib/chat/reducer.ts` | 服务端消息 → 本地会话与回合的纯变换（有单测） |
| `lib/chat/connection.ts` | 网关地址：优先 `NEXT_PUBLIC_GATEWAY_WS`，否则同源 `{basePath}/bridge`；hello 声明 8MiB 帧上限 |
| `lib/chat/storage.ts`、`lib/chatCache.ts` | localStorage 键；IndexedDB 正文缓存 |
| `lib/canvas/` | 画布：sucrase 编译，只允许导入 react 与 `cursor/canvas`，在 iframe 里映射到 `sdk.tsx` 的组件 |

状态写法约定：先同步算出新的会话列表写进 `chatsRef`，再 `setChats`（`applyChats` / `commitSync`），避免后续分支读到旧值。

## 8. iOS（ios/Jiebo）

| 位置 | 职责 |
|---|---|
| `Gateway/GatewayClient.swift` | `URLSessionWebSocketTask` 长连接 |
| `Gateway/Protocol.swift` | `shared/protocol.ts` 的 Swift 镜像；声明帧上限 900KB |
| `Gateway/Uploader.swift` | HTTP `/upload`；状态太大时网关回 `stored_state_deferred`，改走 HTTP `/state` |
| `Session/ChatStore+*.swift` | 会话状态，按 Handle、Sync、TurnsLoad、Composer、Assistant 等拆分 |
| `Views/` | iPhone 保持小驳 / 待处理 / 消息三 Tab；iPad 为小驳 / 工作台 / 消息三域 |
| `ContractTests/` | 解码金样本的协议契约，以及工具名判定用例 |

新增 Swift 文件要加进 `project.pbxproj` 的 FileReference、BuildFile、group、Sources 四处。

iPad P0 的导航状态由 `Session/PadRouter.swift` 在每个 `HomeShell` 场景内独立持有，不进入 `ChatStore`，也不复用
`PhoneRouter`。`HomeShell` 只挂载当前域，因此工作台与固定 `assistantChatId` 的小驳输入器不会同时常驻；
`PadAssistantShell` 把 section、selection、inspector 和委派详情分开，为后续三栏扩展保留稳定边界。推送、Share、
App Intents 与语音先由 `AssistantScenePresenter` 唯一选出最近激活的前台场景，再映射到该场景的 Router 和可见
Composer；旧 `homeMode` 和 `padDomain` 只用于首次迁移/新场景默认值，现有窗口不监听其变化。协议和网关不为此
增加字段。

iPad P1 在这个边界内把今日、待处理、任务、产物、记忆接到现有 `AssistantState` 投影与 Memory Center；老网关的
今日/任务兼容数据只在 `PadAssistantProjection` 集中派生。`PadSelection` 统一定位时间线、草稿、审批、任务、委派
和产物，`PadInspectorNavigation` 负责详情与 `PreviewPanelView` 的返回栈。今日页是唯一挂载固定助理 `ThreadView`
和 `PadActionDock` 的位置；委派 child chat 只读加载，产物预览钉在来源会话和版本，续作直接提交
`assistantChatId`，都不会选择工作台 `activeId`。`PadAssistantShell` 用 scene-local 预览键与 Inspector 对齐，
在手势关闭、切 section 或切业务域时只清理当前窗口预览；老网关的 draft、todo、schedule、delegation 均由集中投影兼容。
P1 仍未新增 Gateway/shared 协议或第二份事实源。

iPad P2 用 `PadAppCommands` + `FocusedValues` 把三域、五栏目、搜索、新建、刷新、历史和关闭操作定向当前场景；
`PadSemanticTransfer` 的自定义 UTType 只携带实体种类与稳定 ID，落点回到当前投影校验，失效或不匹配的目标不会接收。
`PadLayoutMode` 依据 size class 和窗口宽度调整侧栏/Inspector，在 Split View 与 Stage Manager 缩放时不迁移 selection，
今日页仍是唯一 Composer。离线自动重放只扩展已有服务端 `clientId` 去重和 `im_ack` 回执的 IM 发送：待发消息及
`ImDurableOutboxMetadata` 随租户缓存持久化，重连按批次和指数退避恢复，并区分暂时失败与永久失败。普通 Prompt
和 `assistant_op` 没有服务端幂等承诺，因此不会伪装进入 durable outbox；拖放提交离线时明确提示重试。P2 同样
不新增 Gateway/shared 协议。

iPad P3 复用既有设备桥协议扩展日历/提醒读写和系统邮件草稿：网关只向同租户、已鉴权且声明
`device_bridge` 的单个前台设备投递，P3 新操作另要求 `device_bridge_v2`（旧设备继续承接 v1 操作），读写分别限时
30/120 秒，成功写结果按幂等键缓存 24 小时；iOS 写入前必须由
唯一前台 scene 显示确认。设备审计只保存白名单结构摘要，外部 ID 与设备 ID 都只保存哈希。邮件只能打开
`MFMailComposeViewController`，App 和网关均没有后台发送路径。`web_read` 每次请求及重定向都重验 URL、DNS 和
公网地址，并固定已验证 IP，限制标准端口、10 秒、1 MB 与文本 MIME，网页正文不进入审计。

Collab 沿用已有 `im_group + im_collab` capability、安全审批与事件投影；iOS 接受 group 会话并只发送
`collab_sync` 展示运行图，不发送 `collab_op`。Headless SDK 的 `sandboxOptions.enabled` 跟随租户配置，但
`confinedCwd`、工具白名单、路径/网络/危险命令拦截和审批不随沙箱关闭而放宽。每个 `WindowGroup` 创建独立
`SceneSessionState`，持有消息目标、工作台会话、预览页签/选择和草稿；共享 Store 只保留账户、连接和规范化数据。
同一会话的 Composer 由最近激活 scene 的编辑租约独占，设备写确认另由唯一 scene presenter 承载。

### iPad P0–P3 发布交接

#### 功能与兼容矩阵

| 阶段 | iPad 可见能力 | 数据与协议边界 | 旧网关 / 旧客户端行为 | 最小回滚点 |
|---|---|---|---|---|
| P0 | 小驳 / 工作台 / 消息三域；推送、Share、App Intents、语音、委派详情不断路 | 只增加 iOS scene-local `PadRouter` 与入口映射，不增加协议 | 旧 `homeMode` 只迁移为新场景默认域；iPhone 三 Tab、Web、Gateway 不变 | 回滚 iOS；服务端没有配套状态 |
| P1 | 今日、待处理、任务、产物、记忆；统一 Inspector、ActionDock、委派→产物→Preview | 复用 `AssistantState`、任务/记忆/文件投影；不新增事实源 | 缺少新投影字段时由 `PadAssistantProjection` 集中回退或显示明确空态 | 回滚 iOS；无需回滚数据 |
| P2 | 全键盘/鼠标 Commands、typed 拖放、窗口尺寸适配、持久 IM outbox | outbox 只重放已有 `im_send.clientId` 幂等操作；Prompt / `assistant_op` 不入队 | 旧网关继续按既有 IM ack/dedupe 工作；本地 outbox 元数据按租户惰性创建 | 回滚 iOS；保留的本地 outbox 文件可由新版再次恢复 |
| P3 | 日历/提醒扩展、系统邮件草稿、受控网页阅读、Collab 只读运行图、多窗口状态拆分 | 新 DeviceOp 为加法协议；新操作要求 `device_bridge_v2`；Collab 复用 `im_group + im_collab` | 旧 iOS 只有 v1 cap，不会收到 P3 op；新 iOS 连旧网关时额外 cap 被忽略，P3 工具/群数据缺席但基础功能可用 | 先回滚 iOS，再按需回滚 Gateway；cap 隔离保证两端可交错版本 |

#### 升级、迁移与回滚

1. 合并前在仓库根运行 `npm test && npm run test:web && npm run build && npm run lint && npm run format:check`，再用
   `SWIFT_BIN=<Swift 6.0.3 bin> npm run check:ios-protocol`、`npm run lint:swift` 和全量 `swiftc -parse` 验证。
2. 先升级 shared/Gateway，再发布 iOS。Gateway 对 v1 设备继续提供原有 upsert/联系人能力；只有同时声明
   `device_bridge_v2` 的连接才接收列表、删除、完成和邮件草稿操作。
3. 不需要服务端数据迁移或回填：`homeMode` 只在本地首次迁移；scene state 不落服务端；IM outbox、设备审计文件均按需创建；
   协议解码快照随代码提交，不是运行时数据。
4. 发布 iOS 后先验证单窗口，再验证 Split View / Stage Manager 双窗口，最后开放设备写入口。写请求升级期间若在途，等待其
   120 秒边界内完成或超时，不跨版本手工重放同一幂等键。
5. 回滚时优先下架/回滚 iOS：新版 Gateway 因 capability 门槛不会把 v2 op 发给旧 App。若继续回滚 Gateway，新 App 只会失去
   `web_read`、v2 设备工具和 Collab 群投影，不影响 iPhone 三 Tab、工作台或普通 IM。不要删除 outbox、审计或助理事实文件；
   它们不是 schema 迁移，旧版本会忽略，新版恢复后继续使用。

#### Xcode / 真机验收清单

- [ ] 用 iOS 26 SDK 执行
  `xcodebuild -project ios/Jiebo/Jiebo.xcodeproj -scheme Jiebo -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`；
  主 App 与 Share Extension 都成功链接，新 Swift 文件只进入主 App 的条目符合设计。
- [ ] iPhone：小驳 / 待处理 / 消息三 Tab、推送、分享、语音、委派、预览均与升级前一致。
- [ ] iPad 全屏、1/2 与 1/3 Split View、Slide Over、Stage Manager compact/regular：域切换与侧栏始终可达，正文不是玻璃表面。
- [ ] 键盘/鼠标：三域、五栏目、搜索、新建、刷新、关闭 Inspector/Preview 的 discoverability 与实际动作一致，无系统快捷键冲突。
- [ ] 拖放任务、待处理和产物到合法目标成功；非法目标不高亮并给出中文反馈；跨租户或已失效 payload 不执行。
- [ ] 断网发送 IM 后强杀并重启，重连仅按稳定 `clientId` 重放一次；rate limit 后按窗口重试，永久错误停止重放。
- [ ] 两个 iPad 窗口打开同一助理/工作区会话：只有最近激活窗口可编辑；草稿、域、selection、Inspector 和 Preview 不串窗。
- [ ] 推送、Share、App Intent 和语音只路由到唯一前台 scene；语音启动后屏幕上只有一个可编辑 Composer。
- [ ] EventKit 读操作在 30 秒内结束；每个写/删/完成操作都显示唯一 iOS 确认，拒绝不落盘，超时幂等键 24 小时内不重执行。
- [ ] 邮件能力只打开系统草稿；取消或完成系统编辑器后状态清理，App 无后台发送行为。
- [ ] `web_read` 可读取普通公网文本；私网、本地、NAT64、6to4、ORCHIDv2、混合 DNS、私网重定向、超时、超大和错误 MIME 均拒绝。
- [ ] Collab 群只显示运行图和刷新；iOS 不出现执行、重试、取消或绕过审批入口；旧网关下显示兼容空态。
- [ ] VoiceOver、动态字体、中文标签/提示、设备写确认摘要与键盘焦点通过人工检查。

## 9. 持久化与多租户

```
/var/lib/cursor-remote/            CURSOR_REMOTE_STATE_DIR
  providers.json                    第三方模型（可选）
  loops.json                        产品 Loop
  tenants/<id>/
    state.json                      元数据 v2（不含正文）
    chats/<chatId>/<sha1>.json      会话正文，每段 100 轮
    chats-broken/                   损坏文件备份
    artifacts/<sha256>              本轮文件快照
    assistant/                      收件箱、记忆、推送订阅、委派
    publish.json                    对外工作台启动命令
    workspace/                      租户工作区根
```

- 多租户名单来自 `CURSOR_REMOTE_TENANTS_FILE`；没有名单时用 `CURSOR_REMOTE_TOKEN` 跑单租户（上海站就是单租户）。
- WebSocket 用 `hello` 携带令牌鉴权；HTTP 的 `/upload`、`/media`、`/state` 用 Bearer 或签名票据。
- 正文以网关为准：客户端 `sync_chat` 只传元数据，按需 `load_chat` 分页拉回合；有回合的会话 `cwd` 以服务端为准。
- 所有状态写盘经 `fsAtomic` 的原子写（临时文件 + rename）。

## 10. 部署

| 项 | 说明 |
|---|---|
| `scripts/cursor-remote-gateway.service` | tsx 直接跑 `gateway/src/index.ts`，监听 127.0.0.1:8787，读 `/etc/cursor-remote/gateway.env`，MemoryMax 4G |
| `scripts/cursor-remote.service` | `web/server.mjs`，监听 127.0.0.1:3020，basePath `/cursor-remote` |
| `scripts/cursor-remote.subdomain.service` | 子域形态的网页服务（basePath 为空） |
| `scripts/nginx-*.conf`、`insert-nginx-*.py` | nginx 配置与注入脚本 |
| `scripts/jiebo-publish.mjs` | 对外工作台命令行（start / stop / status） |
| `scripts/run-gateway.sh`、`install-*-keepalive.sh`、`tunnel.sh` | 本机保活与隧道（非生产主路径） |

环境变量按组：网关监听与日志（`GATEWAY_*`）、Cursor（`CURSOR_API_KEY`、`CURSOR_REMOTE_MODEL`）、租户与状态（`CURSOR_REMOTE_STATE_DIR`、`CURSOR_REMOTE_TENANTS_FILE`、`CURSOR_REMOTE_TOKEN` 等）、检查点 git 身份、对外预览（`JIEBO_PUBLISH_*`，端口默认 20000–20999）、APNs（`APNS_*`）。权威清单在 `gateway/src/config.ts`，样例见 `scripts/gateway.env.example`。

## 11. 开发与测试

| 命令 | 作用 |
|---|---|
| `npm run check` | lint、Prettier（`scripts/format-baseline.mjs` 维护遗留名单）、环境变量清单、网关与网页单测、网关构建、脚本类型检查、网页构建；不含冒烟 |
| `npm run ci` | `check` 加离线冒烟 |
| `npm test` / `npm run test:web` | node:test 单测（网页需 `TSX_TSCONFIG_PATH=web/tsconfig.json`） |
| `npm run smoke` / `ci:smoke` | `scripts/smoke/run.mjs` 统一入口；`--only` 按参数顺序执行 |
| `npm run check:ios-protocol` | Swift 协议契约（`REQUIRE_SWIFT=1` 时必须有 swiftc） |
| `npm run bench:policy` / `bench:dialect` | 策略与方言评测 |

连真实网关的冒烟和 bench 脚本必须显式设置 `JIEBO_WS_URL`，不设直接报错退出，避免误连生产网关。

CI（`.github/workflows/`）：

- `ci.yml`：lint、格式、环境变量、单测、构建、离线冒烟、网页构建
- `ios-contract.yml`：Swift 协议契约
- `ios-build.yml`：macOS 26 + 最新 Xcode 真编译；编译错误转成注解
