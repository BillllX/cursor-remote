# 会话同步 v2（网页）

网关是会话正文（turns）的唯一来源。网页只上传元数据和少数显式操作，正文按需分页拉取，并在浏览器 IndexedDB 里按版本号缓存。iOS 已经是 slim 客户端，本文不改它的行为，网关改动对它向后兼容。

## 1. 为什么改

- 网页每次打开都下载全部会话正文（`stored_state` 全量，单租户约 14MB）
- 只要会话有变化，网页就停 800ms 把整段会话（全部 turns）用 `sync_chat` 推回网关；生成期间每 800ms 一次
- 网关每次落盘都同步重写整个 `state.json`，没有合并
- Agent 输出本来就由网关产生，并由网关转录（transcript）落盘；网页回传是重复的，还要靠一整套脏标记、在途、回执、合并保护来防覆盖

## 2. 职责划分

| 内容 | 谁产生 | 怎么到达磁盘 |
| --- | --- | --- |
| 用户消息、Agent 正文、思考、工具、状态、耗时、模型、错误 | 网关转录 | `flushTranscript`（运行中每 3s、结束时一次） |
| 用户消息里的图片 | `prompt.images` | 新：转录带上图片，随转录落盘；只保留最近 20 轮的图片 |
| 工具「保留 / 还原」标记 | 网页 | 已有 `tool_review` |
| 编辑消息、重试时截掉后面的回合 | 网页 | 新：`truncate_turns` |
| 标题、草稿、模型、模式、工作目录、预览标签、未读、写入确认、策略、草稿图片、检查点 | 网页 | `sync_chat` 只带元数据（不带 `turns` 键，网关保留磁盘正文） |
| 删除会话 | 网页 | 已有 `delete_session`（墓碑），不再用 `sync_state` |
| 排队中的消息、待批工具 | 网关运行时 | 不落盘；重连时 `run_snapshot` 带回 |
| 待办列表（todos） | 网页从工具参数推导 | 不落盘；加载正文时按工具重新推导 |

网页不再发送 `sync_state`，也不再发送带 `turns` 的 `sync_chat`。

## 3. 协议改动（shared/protocol.ts 与 web/lib/protocol.ts 同步）

客户端 → 网关：

- `{ type: "truncate_turns"; chatId: string; turnId: string; rev: number }`：删掉 `turnId` 这一轮及之后所有回合。会话正在跑、或找不到这一轮时不改，回 `sync_ack { truncated: false }`（带当前 `chatRevs[chatId]`），客户端作废本地正文重拉。成功后回 `sync_ack { truncated: true }`，并向其他设备广播 digest。**不做 rev 拒绝**（和 `sync_chat` 不同）：截断只动这一条会话、可以重放，新版本号取 `max(客户端 rev, 磁盘 rev + 1)`，客户端 rev 落后时沿服务端版本往前走
- `{ type: "load_state" }`：网关按该连接的能力回一份 `stored_state`（slim 客户端只有元数据和 `preview`）

网页 hello：`caps: ["sync_chat", "stored_digest", "slim_state"]`，`maxMessageBytes: 8 * 1024 * 1024`（网关上限 8MiB）。

已有、网页开始使用的：`load_chat { chatId, from?, nonce? }` → `chat_turns { chatId, turns, from, hasMore, total, nonce }`。

## 4. 网页客户端状态

- `chats`：元数据 + `turns`。没加载正文的会话 `turns: []`，`preview` 来自网关
- `bodyRef: Map<chatId, { state: "none" | "loading" | "complete"; rev: number | null; nonce: number }>`：正文是否完整、对应哪个服务端版本
- `chatRevsRef`：服务端每会话版本号（来自 `stored_state`、`stored_digest`、`sync_ack`）
- `sentMetaRef: Map<chatId, string>`：最后一次与服务端一致的元数据快照（JSON）。元数据与快照不同即为脏，800ms 后用 `sync_chat` 上传

### 4.1 启动

1. hello（带 `slim_state`）→ `stored_state`（元数据）
2. 合并元数据：本地脏的保留本地，其余用服务端；记录 `chatRevs`；正文版本对不上的标记为过期
3. 选中当前会话 → `ensureBody(activeId)`

### 4.2 `ensureBody(chatId)`

- 内存里正文完整且版本等于 `chatRevs[chatId]`：不动
- 否则先找基线：内存正文或 IndexedDB 缓存（版本相同直接用，结束）
- 有基线（版本旧）：只拉最后一页。页起点 `from` 处的回合 id 与基线一致 → 基线前段拼上这一页，完成；对不上 → 全量重拉
- 没基线：从最后一页往前一页页拉到底（与 iOS 一致，整段加载，保证查找、终端、编辑定位等读全量的功能不变）。没有可显示内容时每到一页就先显示；有旧内容显示时攒齐再一次替换
- 每次请求带 `nonce`；版本在加载途中变了就作废重来
- 提交时保留本地「活的」回合（`running` / `queued` / `pendingTool`）：同 id 用本地，服务端没有的追加在末尾
- 加载期间收到的 `history`（Cursor 端历史）忽略

### 4.3 版本前进时

- `stored_digest`：版本有变的会话 → 发 `load_state` 拿元数据；当前会话且正文完整 → 后台 `ensureBody`（只拉最后一页）
- 自己跑完一轮后也会收到 digest（网关对所有设备广播），按上面走，通常一页就对齐
- `sync_ack`：自己的元数据上传被接受，且上传前正文版本等于旧的服务端版本 → 正文版本跟着前进，不重拉

### 4.4 用户操作

- 发消息、执行计划、排队：本地先插回合，`prompt` 带 `turnId`（不变）
- 编辑消息：本地截断 → `truncate_turns(turnId)` → `new_session`（不变）
- 重试：本地截断 → `truncate_turns(turnId)` → `prompt { fresh: true, turnId }`
- 正文没加载完时，编辑和重试先提示「正在加载」
- 删除会话：`delete_session`（不变），不再跟一份全量 `sync_state`

### 4.5 IndexedDB 缓存

- 库 `jiebo-chat-cache`，表 `bodies`，键 `${tenantId}:${chatId}`，值 `{ rev, turns, at }`
- 写入时机：正文完整、没有活的回合、版本已知；去抖 1.5s
- 只缓存正文，不缓存会话列表（避免离线列表误触发上传）
- 上限 60 个会话，按 `at` 淘汰最旧的；删除会话时删缓存；退出登录或换租户时清空
- IndexedDB 不可用（隐私模式）时静默退回纯网络

## 5. 网关落盘

- `saveDisk` 改为合并写：标记脏后 1s 内写一次（尾随去抖，最长等 3s）
- 写临时文件再 `rename`，避免写到一半崩溃留下坏文件
- 收到 `SIGTERM` / `SIGINT` 和进程退出前同步写一次
- 启动时的压缩写和需要立即可见的路径不受影响（读的都是内存里的 `tenant.disk`）

## 6. 降级与已知取舍

- 侧栏搜索只覆盖标题、`preview` 和已加载的正文（以前全部正文都在内存）
- 工具参数和结果在磁盘上本来就截到 24k 字符；以前网页内存里有完整版，重新加载后显示截断版
- 离线 Loop、后台委派本来就不写会话正文，不受影响
- 旧版网页（缓存的旧 JS）仍会上传全量正文，网关保持兼容
- 只补最后一页时，只校验接缝处的回合 id。别的设备给更早的回合改了「保留 / 还原」标记，这台要等下次整段加载才看得到
- 分页里被截断的超大回合（`clipped`）不写缓存
- 元数据按字段三方合并：以最后一次对齐的快照为基准，只有本地改过的字段保留本地。等 `load_state` 回来期间（最多 5s）暂停上传，避免旧字段先盖上去
- `truncate_turns` 没截成（回合不在、正在跑）时回执带 `truncated: false`，网页作废本地正文重拉
