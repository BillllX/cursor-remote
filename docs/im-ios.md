# 即时消息 iOS 客户端（P1～P4）

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
| `Session/IM/ImVoice.swift`             | m4a 录音、播放、连播、距离感应和本机语音转写                                               |
| `Session/IM/ImRichMedia.swift`         | 文件准备、LinkPresentation、定位与地点搜索、地图跳转                                       |
| `Auth/ImShareBridge.swift`             | App Group 联系人快照和 Apple 地图 URL 解析（主 App / 分享扩展共用）                        |
| `Session/ChatStore+Im.swift`           | `ChatStore` 实现 `ImTransport`（借用它的 WebSocket 和 token）                              |
| `Views/HomeShell.swift`                | 两个主页的容器、推送分发、`HomeModeSection`、`ImUnreadBadge`                               |
| `Views/IM/ChatHome.swift`              | 聊天主页（手机 NavigationStack / iPad NavigationSplitView）、会话列表、头像、toast         |
| `Views/IM/ChatThreadView.swift`        | 聊天页、气泡、图片消息                                                                     |
| `Views/IM/ChatComposer.swift`          | 输入栏、发图预览（原图开关）、相机、看大图                                                 |
| `Views/IM/ChatSettingsSheet.swift`     | 聊天设置（主页切换、头像、昵称、通知预览、黑名单）、对方资料页（置顶、免打扰、清空、拉黑） |
| `Views/IM/ImRichViews.swift`           | 语音/文件/链接/位置气泡、Quick Look 入口和 MapKit 选点页                                   |
| `JieboShare/ShareViewController.swift` | 多选聊天、留言、分享内容分类和后台 HTTP 发送                                               |

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

| 路径          | 内容                                                             |
| ------------- | ---------------------------------------------------------------- |
| `state.json`  | 会话列表、自己的资料、联系人、草稿、置顶等（防抖写）             |
| `conv/*.json` | 每个会话最近 300 条（含没发出去的，重开 App 后发送中的变成失败） |
| `outbox/`     | 待发图片、语音、文件和链接图标；上传成功后搬进 `media/`          |
| `media/`      | 已下载/已上传的全部附件，文件名就是 blob id；磁盘预算 300MB，LRU |

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

## P2：语音

- `ImVoiceRecorder` 用独立的 `AVAudioRecorder` 录单声道 AAC/m4a（24kHz、32kbps），与工作台输入框的
  `VoiceDictation` 不共用 `AVAudioEngine`、tap、识别任务或状态。按住开始、上滑 60pt 取消，1 秒以下丢弃，
  60 秒自动停止；80ms 采样音量并压成不超过 64 点的波形。首次麦克风授权只申请权限并提示再次按住，
  不在系统授权弹窗结束后继续一次已经松开的录音手势；开始录音前会停止语音播放。
- 待发 m4a 放 `outbox/`，`ImLocalMessage.upload` 保存文件名、时长、波形和已经上传成功的 blob。上传
  `kind=voice` 后生成 voice body；断线、超时和重启后红色感叹号仍用原 `clientId` 重试。
- `ImVoicePlayer` 可直接播放 `outbox/` 待发录音；远端语音下载到 `media/`。只有
  `AVAudioPlayer.play()` 成功后才写入本机 `heardVoice`，播完按时间线继续后面的未听语音。播放统一使用
  `.playAndRecord/.voiceChat`，距离感应靠近时走听筒、离开时明确切扬声器；离开聊天页停止播放并关闭感应。
- 长按语音选「转文字」才创建 `SFSpeechURLRecognitionRequest`，强制
  `requiresOnDeviceRecognition=true`；设备不支持本机识别时明确提示，结果只保存在本机 `voiceText`，不上传。

## P3：文件、链接、位置

- 文件选择器拿到 security-scoped URL 后立即拷进 `outbox/`，上限 32MB；上传、失败状态、重试和图片共用
  `ImStore` 的待发时间线。scope 在选择器回调内取得，后台复制完成后才释放。接收方下载到 `media/`，
  点文件卡片用 `QLPreviewController`。
- 输入内容若完整地是一个 http/https URL，发送方用 `LPMetadataProvider` 取标题后发 link；链接气泡显示标题、
  域名和摘要并跳系统浏览器。元数据最多等待 5 秒，带 icon 的待发消息也会先显示完整 URL/标题。
  普通 text 中完整 URL 也可直接点击。
- 位置选择页用 MapKit 显示当前位置、`MKLocalSearch` 搜索结果，统一发送 WGS-84。气泡本机生成地图快照；
  点开可选 Apple 地图或高德；MapKit 坐标是 WGS-84，高德 URL 带 `dev=1` 让高德执行国测偏移。
- 主 target 的 `NSLocationWhenInUseUsageDescription` 是「发送当前位置或在附近搜索地点」。

## P4：分享扩展

- Xcode target `JieboShare`，Bundle ID `ai.jiebo.ipad.share`。主 App 和扩展都声明 App Group
  `group.ai.jiebo.ipad`，以及钥匙串组 `$(AppIdentifierPrefix)group.ai.jiebo.ipad`。
- `KeychainStore` 优先读共享组；主 App 用明确的旧 access group
  `$(AppIdentifierPrefix)ai.jiebo.ipad` 读取 P4 以前的 token，共享写入成功后才删除旧项。开发配置缺共享
  entitlement 时主 App 回退写旧组，扩展绝不回退。联系人和最近会话由 `ImStore.persistState()` 写成 App Group 内的
  `im-share-directory.json`，扩展不启动主 App、不读取主 App 沙盒。
- 扩展可多选聊天并加留言；按 image、file/data、URL、plain text 分类。Apple 地图 URL 的 `ll` /
  `coordinate` 解析成 location，其余地图短链和网页 URL 发 link。
- 纯文字/link/location 和附件都先写入 App Group 的 `share-jobs/job-<id>.json` / `share-outbox/`，再串行
  发送到 `/upload/im/send-json` 或 `/upload/im/send`。每次 Share Extension 调用生成一个
  `ai.jiebo.ipad.im-share.<UUID>`；同一次分享的所有联系人、附件和留言 job 都持久化该 identifier 与严格递增
  顺序。不同批次使用不同 background `URLSession`，因此某批 running 孤儿不会阻塞其他分享。
- 扩展写完本批全部 job 后创建该动态 session，并等第一条 task 已 `resume()`、注册给系统 daemon 后才显示
  「已加入后台发送队列」并关闭。主 App 普通启动不枚举或创建任何后台 session；只有系统调用
  `handleEventsForBackgroundURLSession` 时，`AppDelegate` 才校验 UUID 前缀并 attach 对应 session。内存中按
  identifier 保存 session 状态，系统 completion 也逐 session 绑定；下一条 task 已建立，或该批 job 全部终态后
  才归还。25 秒兜底只归还 completion，不删除、不重排 job，后续系统唤醒继续依据持久状态对账。
- 每个任务持久化 `clientId`、批内顺序、租户、状态、尝试次数、`runningAt`、attempt token 和 body 文件，最多
  重试三次。切号或退出会删除旧租户任务，并尽力取消当前进程可见的系统 task；请求一旦交给系统后台 daemon，
  可能已经到达服务器，无法保证撤回，但已删除任务绝不会改用新账号 token 重发。
- 每个 job 独立原子写，App/扩展用 App Group 内的 `flock` 文件保护短事务，并以 `O_EXCL` 创建
  `claim-<id>`；因此两个进程不能同时启动同一任务。claim 只表示 task 正在注册，最长保守等待 60 秒；
  `resume()` 后清 claim，并把 `runningAt` 与 attempt token 写入 job。handoff 暂时看不到 running task
  时仍视为本批 reserved，至少 15 分钟且没有活跃 task/系统完成回调才恢复 queued，同一个 `clientId` 不变。
  每次实际 URLSession task 另带 attempt token；旧 task 的迟到完成回调与 job 当前 token 不符时不能删除
  新 task 正在读取的 body，同 id 还有其他 task 时也先等待。
  本批 active/reserved 存在时绝不启动后续任务，保证附件先于留言。旧固定 identifier 的
  `share-jobs.json`、没有动态 sessionIdentifier 的 job，以及损坏的单个 job 都保守移入 quarantine，不接入
  新批次；整次读取失败不取消任何 URLSession task，而是延迟重试。删除附件前在锁内重新枚举所有 job，存在
  quarantine 或无法确认无人引用时宁可保留。
- 分享 URL 只接受 http/https，Apple 地图链接转 location；网页 link 最多等 5 秒抓标题和 icon。图片文件先用
  ImageIO 下采样再压缩（`original=false`），文件保留原名并在入队前检查 32MB。

开发者后台还必须给主 App 与 `ai.jiebo.ipad.share` 同时启用上述 App Group 和 Keychain Sharing；
仅修改工程文件不能替代 provisioning profile 配置。
