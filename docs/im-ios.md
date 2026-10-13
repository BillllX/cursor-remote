# 即时消息 iOS 客户端（P1）

网关和协议见 `docs/im.md`。这里只写 iOS 端：代码怎么分、两个主页怎么切、推送怎么分发、本地缓存放哪。

## 代码结构

| 文件                                   | 内容                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Gateway/ImProtocol.swift`             | `Im*` 协议类型、`ImEvent.decode`、`ImConv.dm/peer`、`GatewayConfig.imMediaURL/imUploadURL` |
| `Gateway/Protocol.swift`               | `ClientMessage.im*` 上行、`ServerMessage.im(ImEvent)`、caps 里的 `"im"`                    |
| `Session/IM/ImModels.swift`            | 本地消息 `ImLocalMessage`（带发送状态）、时间线合并、时间和预览文案、拼音搜索              |
| `Session/IM/ImCache.swift`             | 落盘：会话列表、每个会话最近 300 条、待发图片、已下载图片                                  |
| `Session/IM/ImStore.swift`             | 全部状态和业务（`@MainActor @Observable`），只依赖 Foundation，可在 Linux 上类型检查       |
| `Session/IM/ImMedia.swift`             | UIKit 部分：上传、图片内存/磁盘缓存、解码、压缩、存相册                                    |
| `Session/ChatStore+Im.swift`           | `ChatStore` 实现 `ImTransport`（借用它的 WebSocket 和 token）                              |
| `Views/HomeShell.swift`                | 两个主页的容器、推送分发、`HomeModeSection`、`ImUnreadBadge`                               |
| `Views/IM/ChatHome.swift`              | 聊天主页（手机 NavigationStack / iPad NavigationSplitView）、会话列表、头像、toast         |
| `Views/IM/ChatThreadView.swift`        | 聊天页、气泡、图片消息                                                                     |
| `Views/IM/ChatComposer.swift`          | 输入栏、发图预览（原图开关）、相机、看大图                                                 |
| `Views/IM/ChatSettingsSheet.swift`     | 聊天设置（主页切换、头像、昵称、通知预览、黑名单）、对方资料页（置顶、免打扰、清空、拉黑） |

数据流：`ChatStore` 的连接收到 `im_*` 下行，在 `handle` 里交给 `imSink?.handle(event)`（弱引用的 `ImStore`）；`ready` 后调 `connectionReady(features:)`，断线调 `connectionLost()`（发送中的全标失败），换租户 `resetTenant()`，退出 `logout()`。`ImStore` 发消息只走 `ImTransport.imSend`，并且先看 `imLinkOpen`：`GatewayClient` 断线时会把消息塞进 outbox，聊天消息不能这样补发，必须由用户点红色感叹号重发（重发用同一个 `clientId`，网关去重）。

导航只有一个真相：`im.selectedPeer`。手机的 NavigationStack path 和 iPad 的列表选中都由它派生，推送打开会话也只是设它。

## 两个主页

- 选哪个存在 `@AppStorage("jiebo.homeMode")`（`workbench` / `chat`），默认工作台。
- `HomeShell` 用 ZStack 同时挂着 `WorkbenchView` 和 `ChatHome`，**两个都不拆**（PhoneShell 拆掉重建会丢状态、重放推送）。不在前面的那层：`opacity(0)`、`allowsHitTesting(false)`、`accessibilityHidden`、`disabled`（让 ⌘N、⌘O 这类快捷键失效），环境值 `homeActive = false`。
- 工作台里的全屏盖子（文件浏览器）的 `isPresented` 加了 `&& homeActive`，免得藏起来的那层把盖子弹到聊天上面。
- 入口：iPad 侧栏设置菜单、收起后的图标栏、手机抽屉的设置菜单都有「切换到聊天」；手机设置页和聊天设置页顶部都有「主页」二选一。设置入口旁边挂聊天未读红点。
- `ImStore.setHomeVisible` 记录聊天主页在不在前面；只有聊天主页在前、App 在前台、正在看那个会话时才发 `im_read`（600ms 节流），并把会话号写进 `ImViewingBeacon` 给通知抑制用。

## 推送

- `PushRegistrar.start(store:im:)` 现在 iPad 也注册。`push_subscribe` 带 `im: true`、`assistant: 是否 iPhone`（iPad 不收助理推送）。iPad 没有助理首页，`assistant_state` 由同步循环补要（最多 30 秒一次）。
- 退出登录：四处入口都 `await PushRegistrar.shared.unsubscribe(store:)` 再 `logout()`。`push_unsubscribe` 走 `ChatStore.assistantOpReply`，按 `reqId` 等 `assistant_result`，最多 3 秒，断线立即放行；等待期间 `signingOut` 挡住同步循环再次上报订阅。等不到也没关系：下一个账号订阅时网关会把这个 token 从别的租户摘掉。
- 角标：按这台设备订阅的类别算，和网关 `apnsBadgeFor` 同一个口径。iPhone（订阅助理 + 聊天）= 聊天未读合计 + `assistantBadgeCount`，聊天列表加载完、`assistant_state` 到了才设，免得闪半截数；iPad（只订阅聊天）= 只算聊天未读，列表加载完就设——助理变化不推给 iPad，App 没开着的时候那部分补不上，所以不算它。
- 前台（`AppDelegate.willPresent`）：`im_read` 静默推送不显示；聊天通知的 `convId` 正是正在看的会话时不显示，其他照常横幅。
- 静默推送 `cr.kind == "im_read"`（`content-available`，`didReceiveRemoteNotification`）：按 thread-id `im-<convId>` 清掉通知中心里那个会话的通知（别的设备读过了），并发 `ImStore.readElsewhere` 通知：`ImStore` 标 `listStale`，在线且在前台就立刻重拉 `im_list`，否则等回前台 / 重连。打开会话、读完也会清。
- 点通知：`PushRouting.pending` 由 `HomeShell.dispatchPush` 先看：
  - 聊天通知：自己消费掉，切到聊天主页，等自己的 id 读出来（冷启动最多等 8 秒）再按会话号算出对方，设 `selectedPeer`。
  - 其他通知在 iPhone：切回工作台，不消费，交给 `PhoneShell.consumePendingPush`（它会跳过 `isIm` 的）。
  - 其他通知在 iPad：没人处理，直接消费丢掉。

## 本地缓存

根目录 `Application Support/im/<租户>/`（租户名做过文件名转义）：

| 路径         | 内容                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| `state.json` | 会话列表、自己的资料、联系人、草稿、置顶等（防抖写）                     |
| `conv/*.json` | 每个会话最近 300 条（含没发出去的，重开 App 后发送中的变成失败）       |
| `outbox/`    | 待发图片的压缩图和缩略图；上传成功后搬进 `media/`（那边已有同 blob 就直接删） |
| `media/`     | 已下载/已上传的图片，文件名就是 blob id；磁盘预算 300MB，LRU            |

- 启动时先读缓存把列表画出来，连上后 `im_list` 拉全量，再对每个有本地消息的会话 `im_history(after: 本地最大 seq)` 补洞；打开会话时没有缓存就拉最近 30 条，往上滑每次 30 条。
- 未读只用网关给的权威值（`im_list` 行、`im_message.unread`、`im_update read / recall / settings` 的 `unread`），本地不加减；正在看的会话一律 0。`im_list` 合并按 `maxSeq` 当版本：翻页时旧行不覆盖推送带来的更新（`maxSeq` 更小，或相等但 `readSeq` 更小，就保留本地的 `last / maxSeq / unread / readSeq`）。每次回前台、每次重连、收到别的设备的已读都重拉列表对账。
- 下载票据（ticket）跟着列表下发；离过期不到 10 分钟时重新拉列表（最多 60 秒一次）。
- 图片：内存缓存按 `blob + 像素` 存解码后的 `UIImage`；发图默认长边 1280 的 JPEG 0.8，打开「原图」且不超过 20MB 时原样上传（按文件头判断格式）；缩略图长边 400；头像居中裁方 512。
- 选图不在内存里留原始字节：`PhotosPicker` 每张用 `loadTransferable(type: ImPickedFile.self)`（`FileRepresentation`）拷进 `tmp/im-pick/`，拿不到文件时才取 `Data` 写成文件。预览只用 ImageIO 解长边 720 的缩略图；发送时逐张在后台从文件处理（`CGImageSourceCreateThumbnailAtIndex` + `kCGImageSourceThumbnailMaxPixelSize`，`CGImageDestination` 编 JPEG），处理完删掉临时文件；上传用 `URLSession.upload(fromFile:)`。取消预览删临时文件，启动时清空 `tmp/im-pick/`。存相册按文件 `addResource(fileURL:)`。
- outbox 清理：上传成功即搬走；删掉还没发的消息同时删它的文件；每次应用快照时把不属于任何待发消息、超过 10 分钟的文件删掉。
- `media/` LRU：命中时最多每小时刷一次修改时间，下载、搬入后 3 秒防抖检查，超过 300MB 按修改时间从旧到新删到 240MB。
- 本地删除的消息（`hidden` seq）随 `hideBefore` 前进和缓存窗口移动裁掉，最多留 500 个。
- 设置类操作要求在线（`canChangeSettings` = 在线且连接可写），离线时按钮禁用、左滑只给「未连接」提示。置顶、免打扰、拉黑、通知预览先改本地，10 秒内等不到对应的 `im_update`、断线或收到 `im_error` 就撤回并提示；昵称、清空记录等网关确认后才生效。
- 换租户：清内存，删掉旧租户的目录。退出登录：删掉整个 `im/` 目录并清图片内存缓存。

## 没做的

语音、文件、链接、位置四种消息体只显示占位文字，不能发也不能点开；输入栏的语音按钮先藏着。
