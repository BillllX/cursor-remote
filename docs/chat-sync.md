# 会话同步 v2（网页）

网关是会话正文（turns）的唯一来源。网页和 iOS 都只上传元数据和少数显式操作（截断走 `truncate_turns`，保留/还原走 `tool_review`），正文按需分页拉取并按版本号缓存。多设备与工作区的规则见第 7 节。

## 1. 为什么改

- 网页每次打开都下载全部会话正文（`stored_state` 全量，单租户约 14MB）
- 只要会话有变化，网页就停 800ms 把整段会话（全部 turns）用 `sync_chat` 推回网关；生成期间每 800ms 一次
- 网关每次落盘都同步重写整个 `state.json`，没有合并（已改为按会话分段存储，见 2.1）
- Agent 输出本来就由网关产生，并由网关转录（transcript）落盘；网页回传是重复的，还要靠一整套脏标记、在途、回执、合并保护来防覆盖

## 2. 职责划分

| 内容 | 谁产生 | 怎么到达磁盘 |
| --- | --- | --- |
| 用户消息、Agent 正文、思考、工具、状态、耗时、模型、错误 | 网关转录 | `flushTranscript`（运行中每 3s、结束时一次） |
| 用户消息里的图片 | `prompt.images` | 新：转录带上图片，随转录落盘；只保留最近 20 轮的图片 |
| 工具「保留 / 还原」标记 | 网页 | 已有 `tool_review` |
| 编辑消息、重试时截掉后面的回合 | 网页 | 新：`truncate_turns` |
| 标题、模型、模式、工作目录、预览标签、未读、写入确认、策略、检查点 | 网页 | `sync_chat` 只带元数据（不带 `turns` 键，网关保留磁盘正文） |
| 删除会话 | 网页 | 已有 `delete_session`（墓碑），不再用 `sync_state` |
| 排队中的消息、待批工具 | 网关运行时 | 不落盘；重连时 `run_snapshot` 带回 |
| 待办列表（todos） | 网页从工具参数推导 | 不落盘；加载正文时按工具重新推导 |

**草稿（`draft`、`draftImages`）不上传**，只留在本机（网页、iOS 都一样）：打字频繁，上传会推进会话版本号，让其他设备跟着重拉。网关收到旧客户端上传的草稿也直接丢掉，不落盘、不下发；启动时会清掉早期版本落过盘的草稿。代价：草稿不跨设备、不跨刷新。

## 2.1 网关的存储格式（state.json v2）

```
tenants/<id>/
  state.json                 元数据：会话列表（不含正文）、槽位、版本号、墓碑。version: 2
  chats/<会话 id>/<sha1>.json 正文分段，每段 100 轮，按内容哈希命名；助理会话是 chats/assistant-<租户>/
  chats-broken/              分段损坏的会话被改写前，原目录复制到这里
  state.json.pre-split       第一次拆分前的原样备份
```

- 每条会话在 `state.json` 里带 `body: {count, preview, segs, sizes}`：条数、列表预览、每段的哈希和大小。会话列表和精简状态只读这里，不碰正文。
- 分段写好后不再改。写盘顺序：先写新分段，再换掉 `state.json`，最后删没人引用的旧分段。崩在任何一步，`state.json` 指向的分段都完整；残留的旧分段在下次启动后第一次写盘时清掉。
- 写盘时只写变了的分段：分段里的 turn 对象引用都没变就跳过，变了再比哈希。所以网关里改 turn 必须换新对象，不能原地改字段。
- 装回时校验哈希。对不上的会话：没改动就不碰盘；有改动先把原目录复制到 `chats-broken/` 再写。
- `state.json` 读不出时挪成 `state.json.unreadable-<时间>` 再按空状态启动；挪不开就拒绝启动。
- 内存里最多留 16 条会话的正文（且合计不超过 64MB），按最近使用换出；换出的会话下次读 `chat.turns` 时从分段装回。
- 退回旧版网关前，先停网关，再运行 `node scripts/state-unsplit.mjs <租户状态目录>`，把拆分格式合并回单文件。

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

## 5.1 每轮文件清单（`turn.files`）与快照

聊天里的文件卡片要打开「这一轮结束时的版本」，不是工作区当前文件。网关在每轮结束（`done` 且不是 `approval`）时算清单：

- 来源：本轮写文件类工具的路径（含 `paths`/`files` 数组、apply_patch 的 `*** Add/Update File:`，删除类工具和出错的调用不算），加上和本轮开始时基线的 git 对比（临时 `GIT_INDEX_FILE`，不动用户仓库的 index 和 HEAD）。基线优先用本轮检查点；`autoApprove` 等没建检查点的新回合，另建一棵只用于清单的 tree（read-tree + add + write-tree，不 commit、不加 ref、不进还原点列表；超 5 秒或根目录文件超 5000 个就不建）。基线跟回合 id 走，审批后重放同一轮不重建
- 耗时上限：整份清单总预算 8 秒、单条 git 5 秒，超了后面的文件只列不存快照；对照文本一次 `git diff` 批量取再按文件拆；没基线时最多 10 个文件生成对照
- 只收工作区内、结束时还在的普通文件，跳过 `.git`，最多 40 个
- 写进 transcript，随落盘出现在 `turn.files`（`TurnFile[]`，见 `shared/protocol.ts`），同时给发起这一轮的连接发一条 `turn_files`。没文件时不写键、不发消息
- 合并保护：`sync_chat` / `sync_state` 上传的回合缺 `files` 键时，按回合 id 留用磁盘那份；带键（哪怕是空数组）时以上传为准

快照存在 `<租户 stateDir>/artifacts/<sha256>`，按内容寻址、同内容只存一份：

- 单文件超过 **8MB** 不存快照，`TurnFile` 不带 `sha`，客户端退回打开当前版本
- 文本类（text/canvas/markdown/html/svg）另存一份这一轮的 unified diff（截到 200KB），填 `diffSha`
- 每个账号 artifacts 总量上限 **1GB**，超了按 mtime 从旧到新删到 0.9GB 以下；读快照会刷新 mtime。每轮结束都检查：内存里按目录缓存总量，写入时累加，超额或距上次扫描满 10 分钟才真正扫目录
- 读取：`read_file` 带 `sha`（`diff: true` 时是 `diffSha`），不读工作区；快照没了回 `error: "历史版本已清理"`。媒体类走 `/media?rev=sha:<sha>`，只从本租户 artifacts 目录取
- `ready.features` 里有 `turn_files`、`read_sha`、`read_req_id` 时客户端才用这些能力

## 6. 降级与已知取舍

- 侧栏搜索只覆盖标题、`preview` 和已加载的正文（以前全部正文都在内存）
- 工具参数和结果在磁盘上本来就截到 24k 字符；以前网页内存里有完整版，重新加载后显示截断版
- 离线 Loop、后台委派本来就不写会话正文，不受影响
- 旧版网页（缓存的旧 JS）仍会上传全量正文，网关保持兼容
- 只补最后一页时，只校验接缝处的回合 id。别的设备给更早的回合改了「保留 / 还原」标记，这台要等下次整段加载才看得到
- 分页里被截断的超大回合（`clipped`）不写缓存
- 元数据按字段三方合并：以最后一次对齐的快照为基准，只有本地改过的字段保留本地。等 `load_state` 回来期间（最多 5s）暂停上传，避免旧字段先盖上去
- `truncate_turns` 没截成（回合不在、正在跑）时回执带 `truncated: false`，网页作废本地正文重拉

## 7. 多设备与工作区

### 7.1 运行中的输出

- 逐字增量（`text-delta` 等流式事件）只发给这条会话的 owner。运行中 owner 不换手：另一台设备连上、查文件、切会话都不会抢走；只有空闲（没在跑、没排队、没等审批）或原 owner 已断开时才由新连接接管
- 同租户的其他连接改收 `run_snapshot`：开跑时一份，运行中最多每 800ms 一份，`done` 时立即补最后一份。快照是累计全文，按 `turnId` 替换，旁观设备据此插入或更新这一轮
- 运行中 3 秒一次的落盘仍不推 rev、不发 digest；回合结束才 rev+1 并广播

### 7.2 digest 的 reason

- `rejected`：本连接的 `sync_state` / `sync_chat` 因 rev 落后被拒，只发给这个连接。客户端把在途推送倒回脏集合重推
- `changed`：别处写入后的广播。客户端的在途推送仍有效，回执照常会到，不能倒回
- 旧网关不带 reason，客户端按 `rejected` 处理
- 元数据没变化的 `sync_chat` 只回 ack，不推高全局 rev（否则其他设备的下一次推送会因 rev 落后被拒）

### 7.3 iOS 只传元数据

- `sync_chat` 不带 `turns` 键（`ChatSession.metaJSON()`）。以前 iOS 正文完整时会带全部回合，而网关以上传的回合为准；本机正文落后时，重连后的推送会删掉别的设备刚写的回合
- 编辑、重试先发 `truncate_turns`。回执 `truncated: true` 且发出时正文就是服务端那一版：正文版本跟着前进；`truncated: false`：本地正文作废，按服务端补齐（活的回合保留）
- `sync_ack`：发出时记下 `chatRevs[id]`。回执时正文版本等于它、且期间没收到这条会话的新版本，才把正文版本前进到回执版本；否则标记待补齐
- 本地优先（脏）的会话收到 digest 时也记下服务端版本，只是不立即补齐，等回执后再补
- 判断 `stored_state` 是否陈旧用服务端确认过的版本（`confirmedRev`），不用推送时自增的 `stateRev`：推送丢了 `stateRev` 不回退，会让别的设备的写入被整份跳过

### 7.4 工作区以服务端为准

- 有过回合的会话，目录固定为服务端记录的 `cwd`：`sync_chat` / `sync_state` 上传的 `cwd`、切会话时的 `set_workspace`、`new_session` 的 `cwd` 都改不了它。`set_workspace` 回 `session` 时带真实目录，客户端据此纠正
- 空会话仍可换目录（iOS 复用空白新对话）
- 以前任何一台设备上旧的或误填的 `cwd` 都能把会话挪组；`set_workspace` 的目录与运行时不同还会销毁 Agent、清掉 `agentId`
- 客户端不再用全局 `cwd` 给没目录的会话补值；网页收到工作区列表时不再改写会话的 `cwd`；切到没目录的会话时界面回落到 `workspaceRoot`
- 冒烟：`scripts/multidevice-smoke.mjs`（`ci-gateway-smoke.sh` 里用本地假模型跑）

