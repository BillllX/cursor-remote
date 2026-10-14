# 平台用户之间的即时消息（IM）

P0 只做了网关；客户端只有 iOS（P1 实现，网页端不做）。协议类型以 `shared/protocol.ts` 为准，金样本见 `shared/fixtures/protocol.json`（`im_*` 各一条）。

代码位置：

| 文件                            | 内容                                         |
| ------------------------------- | -------------------------------------------- |
| `gateway/src/im/ids.ts`         | 会话号、可见性、APNs thread-id / collapse-id |
| `gateway/src/im/body.ts`        | 六种消息体校验                               |
| `gateway/src/im/store.ts`       | 落盘与内存缓存                               |
| `gateway/src/im/service.ts`     | 全部业务（不依赖 WebSocket，单测直接用）     |
| `gateway/src/im/pushRules.ts`   | 推送决策与通知内容（纯函数）                 |
| `gateway/src/im/ticket.ts`      | 下载票据                                     |
| `gateway/src/im/http.ts`        | `POST /upload/im`、`GET/HEAD /media/im`      |
| `gateway/src/im/runtime.ts`     | 进程内单例，接上连接表和 APNs                |
| `gateway/src/ws/handlers/im.ts` | `im_*` 上行分发                              |

## 产品规则

- **可见性**：同一网关内所有租户免加好友、互相可见。`tenants.json` 每行可选 `imHidden`（`true` 或 `"true"`）；两人 `imHidden` 相同才互相可见（验收账号之间互相可见，和正式用户互不可见）。不可见和不存在的用户回同一个错误 `not_visible`，不暴露隐藏账号。
- **只有单聊**：不能给自己发。存储和协议按「会话」设计，以后加群聊不用改形状。
- **会话号**：`dm~<较小租户 id>~<较大租户 id>`（按字符串排序）。租户 id 只含小写字母、数字、短横线，不会有 `~`，所以按 `~` 切分没有歧义；`~` 也是 URL 非保留字符，可直接做目录名。客户端可以自己拼：`[me, peer].sorted().joined(separator: "~")` 前面加 `dm~`。
- **没有对方可见的已读回执**。已读位置只用来同步自己的多台设备和算未读。
- **撤回**：只能撤回自己发的、发出 2 分钟内的（按网关的 `at` 算）。双方都显示撤回；撤回后消息没有 `body`。附件和原文在存储里永久保留，不删。
- **删除 / 清空聊天记录**：只对自己生效。`im_settings.hideBefore = seq` 后，`seq ≤ hideBefore` 的消息对自己不再返回、不计未读；`hideBefore` 只增不减，同时把 `readSeq` 推到不小于它。
- **拉黑**：B 拉黑 A 后，A 发的消息照样 ack（落在 A 自己那边可见），但 ack 带 `rejected: true`，客户端显示「消息已发出，但被对方拒收了」。这条不投递、不推送，B 的任何接口（历史、列表的 last / maxSeq、未读、角标）都拿不到。A 拉黑 B 不影响 A 给 B 发消息。解除拉黑不会让之前那些消息出现。对 B 来说这些消息**等同不存在**：`replyTo` 指向它和指向不存在的 seq 回同一个 `bad_body`；撤回它和撤回不存在的 seq 回同一个 `not_found`「消息不存在」；`im_read` / `hideBefore` 的上限是 B 自己可见的 maxSeq（回显的也是钳过的值）；它引用的附件 B 下载不到。
- **置顶、免打扰**：免打扰只是不发 APNs，未读照常累计，角标也照常算。
- **资料**：昵称（默认租户 name，1–32 字）、头像（blob，必须是自己上传的图片）。偏好 `notifyPreview`：通知里显示正文，默认 `false`。
- **限流**：每人每分钟 30 条 `im_send`（按成功写入计；同一 clientId 重发不计）。文字 ≤ 8KB（UTF-8 字节）；附件上限见下面上传一节。

## 协议

只有 `hello.client.caps` 含 `"im"` 的连接才处理 / 收到 `im_*`。网关 `ready.features` 含 `"im"` 表示支持。没声明 cap 的连接发 `im_*` 回 `im_error { code: "no_cap" }`（不静默忽略，方便排查漏声明 cap 的客户端；网页端从不发 `im_*`，所以永远收不到任何 `im_*`）。

caps 含 im 的连接默认在前台；App 进后台 / 回前台时发 `im_presence { foreground }`，没有回包。

### 类型

```ts
type ImKind = "text" | "image" | "voice" | "file" | "link" | "location";
// body：
//   text     { text }                                   ≤ 8KB
//   image    { blob, thumb, w, h, original: boolean }   w/h 为 1..100000 的整数
//   voice    { blob, durationMs, waveform: number[] }   durationMs 1..60000；waveform ≤ 100 个 0..1
//   file     { blob, name, size, mime }                 size 以网关记录为准；name 不含斜杠和控制字符
//   link     { url, title?, desc?, icon? }              url 只能 http/https；icon 是 blob
//   location { lat, lng, name, address }               WGS-84
// 不认识的字段会被丢掉；空串的 title/desc/icon 省略。

type ImMessage = {
  convId: string;
  seq: number; // 会话内从 1 递增
  from: string; // 发件人租户 id
  at: number; // 网关落盘时间（毫秒）
  kind: ImKind;
  body?: ImBody; // 撤回后没有
  replyTo?: number; // 同会话 seq
  recalled?: true;
  rejected?: true; // 只出现在发件人自己的视图：被对方拒收
  clientId: string;
};
type ImTicket = { exp: number; sig: string };
type ImUser = { id: string; nickname: string; avatar?: string };
type ImMe = ImUser & { notifyPreview: boolean };
type ImConvRow = {
  convId: string;
  peer: string;
  last?: ImMessage; // 自己可见的最后一条；缺省 = 没有可见消息（清空过），客户端可不显示这一行
  unread: number; // 最多 1000（封顶）：客户端显示到 999，等于 1000 时显示「999+」
  readSeq: number;
  maxSeq: number; // 自己可见的最大 seq（被自己拉黑拒收的不算）
  pin: boolean;
  mute: boolean;
  hideBefore: number;
  ticket: ImTicket; // 这个会话附件的下载票据
};
```

### 上行（客户端 → 网关）与回包

| 上行                                                         | 回包                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `im_contacts {}`                                             | `im_contacts { me, users, avatarTicket }`（users 不含自己，按 id 排序） |
| `im_list { cursor?, limit? }`                                | `im_list { convs, blocked, more, cursor? }`（分页，见下）               |
| `im_history { convId, before?, after?, limit? }`             | `im_history { convId, messages, more, ticket, before?, after? }`        |
| `im_send { clientId, to? \| convId?, kind, body, replyTo? }` | 发件连接：`im_ack { clientId, convId, seq, at, rejected? }`             |
| `im_recall { convId, seq }`                                  | `im_update { what: "recall", convId, seq, unread }`                     |
| `im_read { convId, seq }`                                    | 无（自己的其他连接收 `im_update read`）                                 |
| `im_settings { convId, pin?, mute?, hideBefore? }`           | `im_update { what: "settings", convId, pin, mute, hideBefore, unread }` |
| `im_profile { nickname?, avatar?, notifyPreview? }`          | `im_update { what: "prefs", me }`；`avatar` 传 `""` 或 `null` 去掉头像  |
| `im_block { tenantId, on }`                                  | `im_update { what: "block", blocked }`                                  |
| `im_presence { foreground }`                                 | 无                                                                      |

出错统一回 `im_error { clientId?, code, message }`（`clientId` 只在 `im_send` 出错时带）。`code`：`no_cap`、`not_visible`、`rate_limited`、`too_large`、`bad_body`、`not_found`（会话 / 消息 / 附件不存在）、`recall_expired`、`forbidden`（撤回别人的消息）、`internal`。

`im_history` 翻页：

- 都不带：最新一页；`more` = 前面还有。
- `before`：`seq < before` 的上一页（升序返回）；`more` = 前面还有。
- `after`：`seq > after` 的下一页；`more` = 后面还有（可与 `before` 一起限定区间）。
- `limit` 默认 30，最大 50。`hideBefore` 之前的、被自己拉黑拒收的不返回（所以 seq 可能不连续）。
- `more` 只是“这一页之外这个方向还有 seq”，翻到最后可能拿到一页空的、`more=false`。

`im_list` 分页：

- 只列有自己可见消息的会话（`maxSeq > 0`）：对方发的全被自己拒收的会话不出现。清空过的（有可见消息、但都在 `hideBefore` 之前）仍出现，没有 `last`。
- 排序：置顶在前，再按 `last.at` 倒序（没有可见消息的算 0），同时间按 `convId` 升序。
- 未读、角标每个会话最多算 1000（`unread` 封顶；角标是各会话封顶后的和）。
- `limit` 默认 50，最大 100。`more=true` 时带 `cursor`，下一页原样回传 `cursor`，取排在那一行之后的会话。`cursor` 对客户端不透明（目前是排序键的 base64url），坏的回 `bad_body`。
- 翻页期间被新消息顶到前面的会话不会在后面的页里重复出现，客户端靠 `im_message` 更新它；想要全新的视图就不带 `cursor` 从头拉。
- 帧太大时网关只发前面装得下的行，同样置 `more=true` 和对应 `cursor`（见帧大小）。
- 翻页期间到达的推送比后面页里的行新：客户端合并时把 `maxSeq` 当版本，旧行（`maxSeq` 更小，或相等但 `readSeq` 更小）不能覆盖 `last / maxSeq / unread / readSeq`。

**权威未读**：客户端不自己加减未读，只用网关带来的值——`im_list` 行的 `unread`，以及：

- `im_message.unread`：收件人在这个会话的最新未读（发件人自己的其他连接收到的是自己的未读，通常不变）。
- `im_update read.unread`：readSeq 前进后自己的未读。
- `im_update recall.unread`：按收件连接所属租户各算各的（双方各收自己的值；撤回的若是未读消息，对方未读会减一）。
- `im_update settings.unread`：`hideBefore` 前进后自己的未读。

老网关不带这些字段时，客户端退回「等下次 `im_list` 对账」。

### 下行推送给谁

| 下行                                       | 收件连接                                                                                                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `im_message { message, ticket }`           | 会话双方 caps 含 im 的在线连接，**发件连接本身除外**（它收 `im_ack`）。被拒收的消息只发给发件人自己的其他连接（带 `rejected: true`）。客户端仍应按 `clientId` 去重（本机发出的那条用 ack 回填 seq / at）。`ticket` 按收件租户签。 |
| `im_update recall`                         | 双方所有连接（发起撤回的连接收回包，不重复发）                                                                                                                                                                                    |
| `im_update read`                           | 自己的其他连接                                                                                                                                                                                                                    |
| `im_update settings / prefs / block`       | 自己的所有连接（发起的那条收回包）                                                                                                                                                                                                |
| `im_update profile { user, avatarTicket }` | 所有可见用户（昵称或头像变了才发；只改 notifyPreview 不发）                                                                                                                                                                       |

同一 `clientId`（同一发件人）重复到达：不再写入，原样回第一次的 `im_ack`（包括 `rejected`），并**补做没做完的副作用**：补记附件引用、把这条再投递给双方在线连接（发起连接除外，不再推 APNs）。所以第一次发送中途失败或网关崩溃后，客户端用同一个 `clientId` 重试就能补齐；客户端要按 `convId + seq` 去重。去重表每会话保留最近 2000 个，冷启动从最后一段往前跨段扫够 2000 条重建，所以离线队列不要攒超过 2000 条再发。`clientId` 只能是 1–64 位字母数字或 `_.:-`。

### 帧大小

iOS 声明 `maxMessageBytes=900000`。`shrinkMessage` 的裁法：

- `im_history`：从翻页方向的远端丢消息并置 `more=true`——默认 / `before` 丢最旧的（接着用 `before=最旧 seq` 翻），`after` 丢最新的（接着用 `after=最新 seq` 翻），丢掉的下一页还能拿到。
- `im_list`：先把每行 `last.body` 里的长字符串截到 100 字；还不够就只保留前面装得下的行，置 `more=true`、`cursor` = 最后保留那行，客户端接着翻页就能拿到丢掉的行。
- 其余 `im_*` 本身很小，走通用截断。

## 分享扩展 HTTP 发送

分享扩展没有 WebSocket，使用 Bearer 鉴权的两个 HTTP 入口；两者最终都调用
`ImService.send`，所以可见性、拉黑拒收、每分钟 30 条、`clientId` 去重、在线多端投递和
APNs 与 `im_send` 完全同义：

这两个入口只供已认证的原生分享扩展使用，网页 UI 不调用。HTTP 没有 WebSocket 的
`hello.client.caps`：caps 是连接能力协商，不是认证安全边界，因此这里不接受客户端自报 cap。
原生请求不需要 CORS；两个入口拒绝任何带 `Origin` 的请求（包括 OPTIONS 预检），且不返回
`Access-Control-Allow-Origin`，降低网页上下文滥用用户 token 的风险。普通附件上传
`POST /upload/im` 的既有网页兼容行为不变。

- `POST /upload/im/send-json`：请求体是 `im_send` 去掉
  `type` 也可的 JSON，最大 64KB；只用于 text/link/location，其他 kind 回 400。限流 429 带 `Retry-After: 60`。
- `POST /upload/im/send?kind=&mime=`：原始附件字节，消息 JSON 放在
  `X-Jiebo-IM: <base64url(JSON)>`。先鉴权和校验头，再按 `/upload/im` 相同的上限、
  租户并发数流式写盘，归位成功后把 blob 填进 body 并发送。支持 image/voice/file，
  以及 link 的 icon；分享图片先在扩展压到 ≤1MB，同一份图片同时登记为 image 和 thumb。

成功返回 `im_ack`；upload-and-send 另带 `blob/size/mime`。错误用 HTTP 401/403/404/
429/413/400，并保留 `ImError` 的 `error` code 和中文 `message`。扩展必须为每个收件人、
每条消息生成稳定的 `clientId`；后台任务重试时不能换 id。

## 附件

### 上传：`POST /upload/im?kind=<kind>&mime=<mime>`

- **iOS 一律用 `Authorization: Bearer <口令>` + 原始字节做请求体**：先鉴权再读 body，口令不对直接 401 并断开，不读 32MB；读的时候边写 `blobs/.upload-*.tmp` 边算 sha256，不进内存。每个租户同时最多 6 个，多了 429。
- multipart（`token` + `file` 字段）只为兼容网页表单保留：要整包读进内存，所以**不管带不带 `Authorization`**，全局最多同时 4 个，多了 503。
- 归位：先写 `<sha>.json` 再把临时文件 rename 成 `<sha>`（已有同内容就只更新 meta）；不管成功、校验不过还是中途出错，临时文件都在 finally 里删掉。rename 失败只会留下一份没有字节的 meta，读的时候当不存在。启动时后台异步清掉超过 1 小时的临时文件、没有 meta 的 blob、没有字节的 meta。
- `kind` 是用途，与上限：`image` 20MB、`thumb` 1MB、`voice` 2MB、`file` 32MB（沿用 `/upload`）、`avatar` 5MB、`icon` 512KB。Content-Length 超了直接 413，流式读到超限也 413。
- `mime` 必填：`voice` 要 `audio/*`，`file` 任意合法 mime；`image / thumb / avatar / icon` 要 `image/*`（不收 svg），而且网关按文件头识别格式（jpeg / png / gif / webp / heic / heif / avif），认不出回 400，记录的 mime 以识别结果为准。
- 按 sha256 存，同样内容只存一份；同一份字节可以按多个用途各上传一次，每个用途各记一个 mime。返回 `{ blob, size, mime }`（blob = sha256 hex）。
- 错误：401 口令不对、400 参数 / 空文件 / 不是图片、413 太大、429 本租户同时上传太多、503 multipart 上传太多。

`im_send` 时按**字段**核对引用的 blob：`image.blob` 必须按 `image` 上传过、`image.thumb` 按 `thumb`、`voice.blob` 按 `voice`、`file.blob` 按 `file`、`link.icon` 按 `icon`（头像 `im_profile.avatar` 按 `avatar`）；用途不对回 `bad_body`，所以 32MB 的文件当不了缩略图 / 头像，`file` 用途的 svg 也当不了图片。归属：是发件人上传的，或出现在发件人**看得见、没撤回**的某条消息的同一字段里（转发）；否则 `not_found`。`file` 消息的 `size`、`mime` 以网关记录为准，客户端传的忽略。发送前把 `{ convId, seq, kind }` 追加进 blob 的引用日志（见存储）。所有校验都通过才建新会话：校验失败的发送不留下空会话目录；校验过了但第一条追加失败时，先重读第一段：确实没有消息行才把会话（`maxSeq = 0`）整个删掉；`appendFile` 其实写完了只是报错的，按已提交处理（修 `maxSeq`、进去重表），客户端用同一个 `clientId` 重试拿到原 ack。

### 下载：`GET/HEAD /media/im?scope=&blob=&exp=&sig=`

- `scope` 是会话号（用 `im_list` 行、`im_history`、`im_message` 带的 `ticket`）或 `avatars`（用 `im_contacts.avatarTicket` / `im_update profile.avatarTicket`）。
- 票据签名绑定（租户, scope, exp），有效期 2 小时，过期了重新拉 `im_list` / `im_history` / `im_contacts` 换新的。密钥由媒体密钥按用途派生，和 `/media` 预览票据互不通用。
- 授权跟着「调用者看得见的消息」走：scope 是会话号时，调用者是成员、双方**现在**仍互相可见，且 blob 在**这个会话**里的引用（只看这个会话的，从新到旧，找到一条就停）至少有一条对调用者可见（不是他拉黑拒收的）、**没撤回**、并且那条消息的对应字段确实是这个 blob。所以撤回后双方都下载不到（发件人本地有缓存无所谓），被拒收的那条不给拉黑方授权，有人改成 `imHidden` 后双方都下载不到。`avatars` 时 blob 是某个可见用户（含自己）的**当前**头像且按 `avatar` 上传过。
- 返回原文件：`content-type` 用授权那条引用的用途记录的 mime，`cache-control: private, max-age=31536000, immutable`，支持 `Range`（206）。为防用户上传内容在网关域名下执行，带 `content-security-policy: sandbox` 和 `nosniff`；图片（svg 除外）/ 音视频 `inline`，其余 `attachment`。
- 401 票据不对或过期、400 blob 格式不对、404 无权或不存在。

## 推送（APNs）

### 订阅

`assistant_op push_subscribe { kind: "apns", token, bundleId, environment?, ua?, im?, assistant? }`。`push-subs.json` 的 apns 条目新增可选 `im`、`assistant`：缺省 `assistant=true`、`im=false`，所以老版本 App 收不到聊天推送。新 App 订阅时带 `im: true`；iPad 以后带 `assistant: false, im: true`。每次订阅都声明完整偏好（没带就按缺省，不沿用旧值）。助理推送跳过 `assistant === false` 的订阅，聊天推送只发 `im === true` 的订阅。

**一个 token 只属于一个租户**：某租户订阅成功后，网关在后台（不阻塞回包）把同一 token 从其他所有租户的 `push-subs.json` 里摘掉（`releaseApnsToken`），所以同一台手机换账号登录后不会再收到上一个账号的推送，即使上一个账号登出时退订没送到。App 登出时仍先发 `push_unsubscribe` 并等 `assistant_result`（按 `reqId` 配对，最多 3 秒）再清本地凭据。

### 角标

推送带的是**角标分部**（`badgeParts = { assistant?, im? }`），每台设备按自己订阅的类别合计出 `aps.badge`（`apnsBadgeFor`）：iPhone 订阅助理 + 聊天，得**助理待处理 + 聊天未读合计**；iPad 只订阅聊天，只算聊天未读——助理变化不推给 iPad，App 没开着的时候那部分永远补不上，所以干脆不算它。哪个分量超时拿不到，这台设备要的部分就不落 `aps.badge`（不改现值）。

- 助理待处理和 App 的 `assistantBadgeCount` 同一口径：`assistant_state.inbox`（最近 60 条）里未读的条数 + 待批数（`approvals.json`）。网关异步读这两个文件（`gateway/src/assistant/badge.ts`），最多等 500 毫秒；超时用 5 分钟内最近一次读到的数顶着（`assistantBadgeCached`，IM 推送和助理推送共用同一份）。
- 聊天未读合计 = 各会话封顶后的未读之和（含免打扰会话）。
- App 在前台按同样的规则自己设角标：iPhone 算两类之和（聊天列表和 `assistant_state` 都到了才设），iPad 只算聊天未读。

### 新消息

条件：收件人没有任何「caps 含 im 且 foreground=true」的在线连接，且该会话没免打扰、发件人没被收件人拉黑。

- `aps.alert.title` = 发件人昵称。
- `aps.alert.body`：`notifyPreview=false` 时「发来一条消息」（该会话未读 > 1 时「发来 N 条消息」）；`notifyPreview=true` 时按类型：文字前 60 字（超出加 `…`）、`[图片]`、`[语音] 12″`、`[文件] 名字`、`[链接] 标题或域名`、`[位置] 地名或地址`。
- `aps.thread-id` = `im-<convId>`（APNs 对 thread-id 字符没有限制，原样用）。
- `apns-collapse-id` = `im-<sha256(convId) 前 24 位>-<seq>`（≤ 64 字节）。
- `apns-priority: 10`，`apns-push-type: alert`，`sound: default`。
- `aps.badge` = 这台设备按订阅类别合计的角标（见上；iPhone 是助理待处理 + 聊天未读）。
- `cr = { kind: "im", convId, seq }`。

### 撤回

只有原消息**确实发过 APNs alert** 才用同一个 collapse-id 再发一条替换通知：body「撤回了一条消息」，角标分部同上（按设备订阅的类别合计）。推过的记录只在内存（每个收件人最近 500 条、10 分钟过期，撤回窗口只有 2 分钟），重启后忘掉可以接受——那种情况下原通知留着「发来一条消息」，点开看到已撤回。前台收到、后来退到后台再被撤回的不发，免得凭空冒出一条通知。

### 已读

`im_read` 让 readSeq 前进后（以及 `hideBefore` 把 readSeq 推前时），给该用户的 im 订阅发静默推送：`apns-push-type: background`、`apns-priority: 5`、`aps = { "content-available": 1, badge }`，没有 alert / sound，`cr = { kind: "im_read", convId }`。角标分部同上（按设备订阅的类别合计）。其他设备据此清通知、更新角标，iOS 还把列表标成待对账（在线就立刻、否则回前台时重拉 `im_list`）。

没配 APNs 时全部安静跳过。推送日志（`push-log.jsonl`）里聊天推送的 title / body 记成空串，网关日志也不写消息正文。

## 存储

`dataRoot` = 全局状态目录（`CURSOR_REMOTE_STATE_DIR`，即 `tenants/<id>` 的上一级）。

**规模前提**：一个站点几十个用户，单会话一生可能几万到几十万条。设计目标：内存和启动后首次操作的开销与「未读窗口 + 最近一两段」成正比，与全部历史无关。

```
<dataRoot>/im/conversations/<convId>/meta.json        { convId, members, maxSeq, createdAt, visibleMax, lastIncoming }，小、有界，原子写
<dataRoot>/im/conversations/<convId>/00000.jsonl      seq 1–1000；00001.jsonl 是 1001–2000，以此类推，追加写
<dataRoot>/im/conversations/<convId>/00000.sum.json   已封闭分段的可见性摘要 { visible: { <成员>: 这一段里对他可见的条数 }, incoming: { <成员>: 其中别人发的条数 } }，可从分段重建
<dataRoot>/im/blobs/<sha256>                          附件字节
<dataRoot>/im/blobs/<sha256>.json                     { sha, size, kinds: { <用途>: mime }, uploaders, createdAt }，固定大小
<dataRoot>/im/blobs/<sha256>.refs.jsonl               引用日志，每行 { convId, seq, kind }，只追加
<dataRoot>/im/blobs/.upload-<pid>-<随机>.tmp           上传中的临时文件
<dataRoot>/im/profiles.json                           { <租户 id>: { nickname?, avatar? } }
<dataRoot>/tenants/<id>/im.json                       { convs: { <convId>: { readSeq, pin, mute, hideBefore } }, blocked, notifyPreview }
```

- 分段里每行一条消息：`{ seq, from, at, kind, body, replyTo?, clientId, rejectedFor? }`。`rejectedFor` 是拒收这条的成员（拉黑方），这些成员的任何接口都过滤掉它。
- 撤回追加 `{ "op": "recall", "seq", "at" }` 到**原消息所在那一段**，读时合并；追加前先给那一段补换行（旧分段可能有崩溃留下的半行）。
- **全部异步 IO**（`fs/promises`），不阻塞 WebSocket 的流式输出。改同一会话的操作（发送、撤回、已读、清空）经 `serial(convId)` 按到达顺序排队，seq 不重不漏；改同一个 blob 的 meta / 引用日志经 `serial(blob:<sha>)`；同一个人的资料（昵称、头像、`notifyPreview`）经 `serial(profile:<id>)`：先做完校验（含异步查头像 blob），再只把这次带的字段合并进最新的资料，并发的改昵称和换头像不会互相覆盖。其余改 `im.json` 的路径（已读、置顶 / 免打扰 / 清空、拉黑）都在 await 之后同步改内存里那一份，不拿旧副本覆盖。
- **用户状态先落盘再回包**：`im.json`、`profiles.json` 同一个文件同时只有一次异步原子写在跑，期间来的改动合并到下一次；拉黑、置顶、免打扰、清空、已读、资料、`notifyPreview` 都 await 到包含自己改动的那次写成功，才回包和同步给其他设备。写失败回 `im_error internal`（当时所有在等的请求都立即失败，不会越积越多），内存里保留改动、文件保持脏，1 秒后自动重试。一轮写刚结束、还没收尾时来的改动也会马上再写一轮（不会漏）。进程退出时还脏着的同步补写（整个进程只挂一个 exit 监听）。
- **内存里只放未读窗口**：每个成员 m 一个升序 `incoming`，只含 `seq > floor_m = max(readSeq_m, hideBefore_m)` 里对方发来、对他可见、没撤回的 seq（撤回时删掉，已读落盘后裁掉已读部分）。未读 = 其中大于 floor 的个数（二分），**最多 1000**：打开时收满 1000 条后再碰到第 1001 条才标记封顶（正好 1000 条、更早没有了就不算封顶）；封顶的窗口因撤回不满 1000 条时，在撤回里往前补到再次收满、或扫到已读线 / 开头；一直不读时内存里也只留最新的 1000 条。已读、清空先落盘再裁内存，`im.json` 停在旧版本（崩溃）重启后按旧 floor 重建，未读只会回到读之前，不会少算。
- **谁对谁不可见不常驻**：判断某条对某人可不可见（`replyTo`、撤回、下载鉴权）时读那一条所在的段，按行看 `rejectedFor`。每个会话的最后一段常驻，旧分段走全局 8 段的 LRU。
- **历史按段扫**：上界是调用者自己的 `visibleMax`（之后全是他拒收的）；一段一段读、段内同步过滤。每个已封闭的段有一份可见性摘要（追加跨段时写；没有、读不了或不合法——成员集合不一致、计数不是 0..1000 的整数、incoming 大于 visible——就读分段重建写回，同一段并发只重建一次）：对调用者全不可见的段不读，判断 `more` 时整段落在区间里、且有对他可见的段也不读。拉黑后对方发了 3 万条，拉黑方看最新历史、往前往后翻都只读 1–2 段。
- `meta.json` 里每个成员两个有界字段，发送时 O(1) 更新：`visibleMax`（自己可见的最大 seq，列表的 `maxSeq`、已读 / 清空的上限）和 `lastIncoming`（收到的最大 seq 的上界：未读重建从它所在段开始；不超过自己 floor 的成员不用扫）。
- **附件引用**：`<sha>.json` 只存固定大小的元数据，引用追加在 `<sha>.refs.jsonl`。内存里按需加载成 `会话号 → 按 seq 升序的数组 + 去重集合`（追加时二分插入保持有序，查询不排序；LRU 两道上限：最多 2000 个 blob、合计最多 20 万条引用，超了淘汰最久没用的），重复引用按集合去重、不写；鉴权只看目标会话的引用，从新到旧找到第一条可用的就停。旧格式 `<sha>.json` 里的 `refs` 第一次读到时搬进引用日志、改写 json（幂等，中途失败下次再搬）。
- 会话重建（首次打开）整个网关共用 4 个名额：多个用户同时 `im_list` / 角标也最多 4 个在扫分段，同一会话的并发打开共享一次重建。单测用 `segmentReads` 计数确认热路径不读分段、冷启动只读尾部。
- **提交点**：发送时先写附件引用（幂等；没提交成功时引用指向的 seq 上没有引用它的消息，下载鉴权会核对消息内容，所以悬空引用不授权任何东西），再追加消息行——**消息行写进 jsonl 就算发出**，之后的 meta、投递、推送失败都不影响；追加失败会给分段补换行再报错，客户端用同一个 `clientId` 重试。
- **冷启动**：只读所有会话的 meta（懒加载，不扫历史）；首次打开某个会话时最后一段没换行先补换行，分两步（段与段之间让出事件循环）：
  1. **尾部**：只读最后两段，修 `maxSeq` / `visibleMax` / `lastIncoming`（追加成功但 meta 没写上，落后的都在尾部；两段里没碰到的沿用 meta 里不超过扫描下沿的值），这些行进去重表；不够最近 2000 条时，第一次发送去重没命中再往前补（每个会话一次）。
  2. **各成员未读**：从该成员 `lastIncoming` 所在段往前，摘要里 `incoming[成员] = 0` 的段直接跳过，摘要缺失的段才读；扫到 floor 以下、找到第 1001 条（封顶）或到开头就停。所以 B 早期有几条未读、拉黑 A 后 A 发了 3 万条，重启后 B 第一次 `im_list` 只读尾部两段加未读所在那段；meta 里没有 `lastIncoming`（旧版）时也靠摘要跳过。
- 被拒收的消息占用会话 seq：对方后来看到的 seq 会跳号，但拿不到内容，`maxSeq` / 未读也不算它。

## 测试

- 单测：`gateway/test/im-core.test.ts`（会话号、可见性、消息体、附件用途 / mime / 文件头识别、列表游标、票据、推送规则）、`im-service.test.ts`（发送、并发 seq、去重与补投递、热路径不读分段、拉黑隐藏消息不可探测、附件用途、发送中途失败 / 崩溃 / meta 落后的恢复、跨段去重重建、meta 有界与 visibleMax O(1)、懒加载异步重建、合并写的退出窗口与连续失败、2 万条会话冷启动只读尾段、未读封顶 1000、很早被拒收的消息重启后仍不存在、引用日志只追加 / 旧格式迁移、资料并发合并、校验失败不建会话、拉黑后 3 万条的历史跳段、未读恰好 1000 与撤回后补、全局重建名额、引用缓存总条数预算、首条追加失败清理空会话 / 写上了却报错按已提交、拉黑后 3 万条的未读重建跳段、摘要校验与并发重建去重、用户状态先落盘再回包与写失败重试、上传归位与残留清理、下载鉴权、列表分页、未读、推送决策与撤回替换）、`im-frame.test.ts`（帧裁剪）。
- 端到端：`npm run smoke:im`（临时目录起真实网关 + 本地 h2c 假 APNs + 两台模拟 iOS + 一个网页连接；含上传先鉴权、未鉴权并发上限、断开不留临时文件、撤回后下载 404）。已加进 `npm run ci:smoke`。
