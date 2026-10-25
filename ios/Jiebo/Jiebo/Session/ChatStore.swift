import Foundation
import Observation
import Photos
import UIKit

/// 文件浮层左栏的筛选。搜索和 Git 不再另开滑层。
enum FileBrowserPane: String, CaseIterable, Identifiable {
    case files, search, git

    var id: String { rawValue }

    var title: String {
        switch self {
        case .files: return "文件"
        case .search: return "搜索"
        case .git: return "改动"
        }
    }

    init?(_ layer: ToolLayer) {
        switch layer {
        case .files: self = .files
        case .search: self = .search
        case .git: self = .git
        default: return nil
        }
    }
}

enum ToolLayer: String, CaseIterable, Identifiable {
    case files, search, git, terminal, loop, assistant

    /// 工具栏里的固定工具。助理不在这里，它有自己置顶的入口
    static let workTools: [ToolLayer] = [.files, .search, .git, .terminal, .loop]

    var id: String { rawValue }

    var title: String {
        switch self {
        case .files: return "文件"
        case .search: return "工作区搜索"
        case .git: return "源代码管理"
        case .terminal: return "终端输出"
        case .loop: return "Loop"
        case .assistant: return "助理"
        }
    }

    var symbol: String {
        navigationIcon.symbol
    }

    var navigationIcon: NavigationIconId {
        switch self {
        case .files: return .files
        case .search: return .search
        case .git: return .git
        case .terminal: return .terminal
        case .loop: return .loop
        case .assistant: return .assistant
        }
    }
}

struct ShellEntry: Identifiable, Hashable {
    var id: String
    var command: String
    var output: String
    var running: Bool
}

enum ContentDiscard {
    case closeContent
    case closeTool
    case switchTool(ToolLayer)
    case openFile(String)
    case openDiff(String)
    case openFileBrowser
    case selectChat(String)
    case deleteChat(String)
}

/// 聊天主页的类型化目标，避免用户 id、助理和工作区路径发生字符串碰撞。
enum ChatDestination: Hashable {
    case assistant
    case person(String)
    case group(String)
    case workspace(String)
}

@Observable
@MainActor
final class ChatStore {
    var connected = false
    @ObservationIgnored var gatewayReady = false
    /// 连不上已超过 offlineGrace：客户端仍在后台重连，界面从「连接中」改报「已断开」
    var linkOffline = false
    var offlineTask: Task<Void, Never>?
    static let offlineGrace: Duration = .seconds(10)
    var unlocked = false
    /// 钥匙串里有上次登录的令牌：先进主界面、后台用它自动登录；网关拒绝或退出登录才回登录页
    var resumingLogin = false
    var verifying = false
    var authError = ""
    var notice = ""
    /// 红色错误条。8 秒后自动清掉，点一下也能关（dismissBannerError）
    var bannerError = "" {
        didSet { scheduleBannerErrorClear() }
    }
    var tokenDraft = ""
    var chats: [ChatSession] = [ChatSession.blank(id: "boot")]
    var activeId = "boot"
    var cwd = ""
    var workspaceRoot = ""
    var assistantName = AssistantDefaults.name
    /// 个人助理今日页/收件箱/记忆。ready 后拉一次，之后靠网关推送
    var assistantState: AssistantState?
    /// Revision at which the retained memory projection was actually fetched.
    @ObservationIgnored var assistantMemoryRevision: Int?
    /// 只由网络确认推进；缓存水合不伪装成网关响应。
    var assistantStateRevision: UInt64 = 0
    @ObservationIgnored var assistantNetworkConfirmed = false
    @ObservationIgnored var assistantRequestGeneration = 0
    @ObservationIgnored var assistantInFlightGeneration: Int?
    @ObservationIgnored var assistantInFlightReqId: String?
    @ObservationIgnored var assistantTaggedResponsesSeen = false
    /// 当前 UI 最后声明的记忆投影订阅意图；不能从缓存里是否仍有 memory 反推。
    @ObservationIgnored var assistantMemoryDesired = false
    @ObservationIgnored var assistantSyncGate = AssistantSyncGate()
    @ObservationIgnored var assistantSyncTimeoutTask: Task<Void, Never>?
    /// 统一记忆中心只读数据（overview / scope detail / search）
    var memoryCenterData = MemoryCenterDataState.initial
    @ObservationIgnored var memoryCenterActiveCount = 0
    @ObservationIgnored var memoryCenterSearchDebounceTask: Task<Void, Never>?
    @ObservationIgnored var memoryCenterPendingSearchKey: String?
    @ObservationIgnored var memoryCenterLastSearch: MemoryCenterSearchParams?
    @ObservationIgnored var memoryCenterExtrasStorage = MemoryCenterExtrasDataState.initial
    /// 租户唯一的助理会话（ready 下发，网关建在 stored chats 里）。按租户存一份，冷启动 ready 前也认得出
    var assistantChatId: String?
    /// 想打开助理会话时它还没同步到本机：记下意图，会话到了再切
    var pendingAssistantOpen = false
    /// iPhone 的 PhoneShell 出现时置 true：activeId 只允许是助理会话。iPad / 网页永远 false
    var assistantOnly = false
    /// 聊天主页自己的导航；不复用工作台 activeId。
    var chatHomeDestination: ChatDestination?
    /// 聊天主页线程目标，可指助理或工作区主会话；绝不写回工作台 activeId。
    var chatHomeThreadChatId: String?
    var workspaceAgents: [WorkspaceAgentItem] = []
    var workspaceAgentsLoaded = false
    var workspaceAgentsPendingCursor: String?
    var workspaceAvatarTicket: ImTicket?
    var pendingWorkspacePath: String?
    /// turn_files 可能早于非 owner 的 snapshot/history；按会话和回合暂存，回合出现时再合并。
    var pendingTurnFiles = DeferredTurnFiles()
    var workspaces: [WorkspaceItem] = []
    @ObservationIgnored var workspacesSyncInFlight = false
    @ObservationIgnored var workspacesSyncGeneration = 0
    @ObservationIgnored var workspacesInFlightGeneration: Int?
    @ObservationIgnored var workspacesForcePending = false
    var workspaceSheetOpen = false
    /// P7a：Finder 式文件浏览器 fullScreenCover 的开关（挂在 WorkbenchView——从侧栏列弹 cover 会继承 compact sizeClass）
    var fileBrowserOpen = false
    var fileBrowserPane: FileBrowserPane = .files
    var creatingWorkspace = false
    var newWorkspaceName = ""
    var model = ModelCatalog.defaultModel
    var models: [String] = [ModelCatalog.defaultModel]
    var mode: AgentMode = .agent
    /// L4：当前租户的产品 Loop，按会话
    var loops: [String: LoopSnapshot] = [:]
    var searchQuery = ""
    var searchHits: [SearchHit] = []
    var searchRequestChatId: String?
    /// 网关为了不超单条上限裁掉了一部分命中
    var searchTruncated = false
    var searchLoading = false
    var searchTask: Task<Void, Never>?
    var searchEpoch = 0
    var searchNameHits: [String] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return [] }
        return Array(fileIndex.filter { $0.lowercased().contains(query) }.prefix(40))
    }
    var shellEntries: [ShellEntry] {
        guard let turns = active?.turns else { return [] }
        var rows: [ShellEntry] = []
        for turn in turns {
            for tool in turn.tools where tool.kind == .shell {
                let stdout = tool.result?.object?["stdout"]?.string ?? ""
                let stderr = tool.result?.object?["stderr"]?.string ?? ""
                let output = [stdout, stderr].filter { !$0.isEmpty }.joined(separator: "\n")
                let command = tool.args?.string(in: "command", "cmd").nilIfEmpty ?? tool.summary
                rows.append(ShellEntry(
                    id: tool.callId,
                    command: command,
                    output: output,
                    running: tool.status == "running"
                ))
            }
        }
        return rows
    }
    /// 当前工具浮层。同一时间只开一个，再点一次关闭
    var toolLayer: ToolLayer?
    /// I2：叠在工具层上的内容。换路径即替换，关掉回到工具层
    var gitStatus: [String: String] = [:]
    var contentPath: String?
    var contentDiff = false
    var contentKind: PreviewKind = .text
    var contentOriginal = ""
    var contentDraft = ""
    var contentLoading = false
    var contentError: String?
    /// 网关 write_file 超过 500KB 会拒绝。这种文件只读，避免显示能保存。
    var contentOversized = false
    /// 关闭或换文件前，先问要不要丢掉未保存的修改
    var contentDiscardPrompt = false
    var contentDirty: Bool { contentPath != nil && !contentOversized && contentDraft != contentOriginal }
    /// 打开内容时的会话。保存和读回都用它，避免切会话后写到另一个工作区
    var contentChatId: String?
    /// 内容层读取代际。换文件后，迟到的 HTTP 水合不能写进新文件
    var contentLoadEpoch = 0
    /// 已发出、还没对上 file_written 的正文快照。回包只把基线设成这份快照，之后的新输入仍算未保存
    var contentSaves: [(path: String, snapshot: String)] = []
    var contentDiscardFollowup: ContentDiscard?
    var suppressContentDiscard = false
    static let contentSaveLimit = 500_000
    /// 打开内容层之前右侧预览的焦点。内容层自己的页签不能把预览留在对话右侧
    var contentRestorePreview: String?
    /// 表单盖住主区时，校验和网关拒绝要画在 sheet 里
    var loopError = ""
    var hasApiKey = true
    var draft = ""
    var tenantId = ""
    var tenantName = ""
    var pendingImages: [PendingImage] = []
    var uploads: [UploadItem] = []
    /// 待发图片按会话隔离（对齐网页端 per-chat 的 draftImages），切会话时换出/换回
    var imagesByChat: [String: [PendingImage]] = [:]

    // MARK: P3 - @补全 / 文件清单 / Quick Look / undo
    /// 当前会话工作区的文件索引（list_files query:"" 的全量结果）
    var fileIndex: [String] = []
    var fileIndexRequestChatId: String?
    @ObservationIgnored var fileIndexSyncGeneration: [String: Int] = [:]
    @ObservationIgnored var fileIndexInFlight: [String: Int] = [:]
    @ObservationIgnored var fileIndexRequestIds: [String: String] = [:]
    @ObservationIgnored var fileIndexForcePending = Set<String>()
    @ObservationIgnored var fileIndexTimeoutTasks: [String: Task<Void, Never>] = [:]
    var treeTruncated = false
    /// @补全候选（mention 模式 list_files 的结果）
    var mentionSuggestions: [String] = []
    var mentionRequestChatId: String?
    /// Quick Look 预览中的文件（sheet 驱动）
    var previewFile: PreviewFile?
    var previewLoading = false
    /// 预览下载任务与最近一次 temp 文件（删除时机与 previewFile 置 nil 的顺序解耦）
    var previewTask: Task<Void, Never>?
    var lastPreviewURL: URL?
    /// WS 上传超时后迟到的 file_uploaded 回包 id（防被当成「别的客户端上传」写进草稿）
    var expiredUploadIds: Set<String> = []
    /// 当前草稿尾部的 @查询（无则 nil）
    var mentionQuery: String?
    var mentionTask: Task<Void, Never>?

    // MARK: P5 - 预览面板（右侧 overlay，对齐网页 FilePreview）
    /// 打开的预览页签（上限 8，超出挤掉最旧的，对齐网页 slice(-8)）
    var previewTabs: [PreviewTab] = []
    /// 当前选中页签；非 nil 即面板打开
    var previewActivePath: String?
    /// 网页 preview-max：收起后页签还在，点「预览」芯片再展开。
    var previewExpanded = false
    var previewPanelOpen: Bool {
        // 文件浮层开着时，内容画在浮层右栏，不再同时从右侧弹出另一块
        previewExpanded && !fileBrowserOpen && contentPath == nil && previewActivePath != nil && previewTabs.contains { $0.path == previewActivePath }
    }
    var activePreviewTab: PreviewTab? { previewTabs.first { $0.path == previewActivePath } }

    var active: ChatSession? { chats.first { $0.id == activeId } }
    var busy: Bool { active?.turns.contains(where: \.running) == true }
    var canSend: Bool {
        // 对齐网页端：上传未完成时禁发（@path 还没写进草稿，发出去会漏附件）
        uploads.isEmpty
            && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingImages.isEmpty)
    }

    let client = GatewayClient()
    /// 即时消息借这条连接：im_* 下行转给它，连上/断线/换账号也通知它
    @ObservationIgnored weak var imSink: ImStore?
    /// P5-A 先把请求交给设备协调器；未安装 hook 时保持待处理，不回假成功。
    @ObservationIgnored var deviceInvokeHandler: ((DeviceInvoke) -> Void)?
    /// 等 assistant_result 的 assistant_op（按 reqId）：回包、超时或断线时调一次，参数是 ok
    @ObservationIgnored var assistantReplyWaiters: [String: (Bool) -> Void] = [:]
    var started = false
    /// 推送用的乐观版本号：每次推送先自增，推送丢了也不回退
    var stateRev = 0
    /// 服务端确认过的全局版本（stored_state / digest / ack 带来的）。判断 stored_state 是否陈旧只能看它，
    /// 看 stateRev 的话，断线前丢掉的推送会让别的设备的写入被整份跳过
    var confirmedRev = 0
    var appliedStore = false
    // P4 增量同步：每会话版本号 + 脏标记 + 在途确认
    var chatRevs: [String: Int] = [:]
    var dirtyChatIds = Set<String>()
    var inflightChatIds = Set<String>()
    /// 在途 sync_chat / truncate_turns 发出时的 chatRevs[id]：回执时据此判断本机正文是否仍是服务端那一版
    var inflightBases: [String: Int] = [:]
    var truncateBases: [String: Int] = [:]
    var pendingChatLoads = Set<String>()
    var digestTimeoutTask: Task<Void, Never>?
    /// 网关是否支持 P4（stored_state 带 chatRevs / 收到 ack/digest/stored_chat）。
    /// 默认 false：未知时先走全量 sync_state（新旧网关都收），确认支持后才增量。
    var serverSupportsP4 = false
    var deletedIds = Set<String>()
    var lastModel = ""
    /// 运行中/排队会话 id（侧栏运行点也读它：slim 会话没 turns，不能靠 turns.contains(running)）
    var runningChatIds: [String] = []
    var queuedChatIds: [String] = []
    /// P9：当前租户是否管理员（ready 带下来）；管理员统计面板数据
    var isAdmin = false
    var adminStats: [AdminTenantStats] = []
    var adminStatsAt: Date?
    /// 当前服务器 API Key 的 Cursor 官方账单（admin_stats.cursor）
    var cursorBill: CursorBill?
    /// P8 slim：内容分页加载中的会话（ThreadView 遮罩 + 在途页去重用）
    var loadingChatIds: Set<String> = []
    /// 增量补齐正文时导航栏小 spinner（不阻塞输入）
    var threadSyncBusy: Bool {
        (resumingLogin && !unlocked)
            || refreshingChatIds.contains(activeId)
            || (loadingChatIds.contains(activeId) && bodyRevs[activeId] != nil && !(active?.turnsComplete ?? true))
    }

    enum LinkState {
        case connected, connecting, offline

        var title: String {
            switch self {
            case .connected: "已连接"
            case .connecting: "连接中…"
            case .offline: "已断开"
            }
        }
    }

    var linkState: LinkState {
        if connected { return .connected }
        return linkOffline ? .offline : .connecting
    }

    /// P8 slim：turns 未加载完时暂存的 agent 历史（fresh UUID 与持久 turn id 不同空间，直接合并会重复）
    var pendingHistory: [String: [Turn]] = [:]
    /// 快照到达时分页还没完成：先暂存，正文齐了再按 turnId 盖上
    var pendingSnapshots: [String: ServerMessage] = [:]
    /// 分页期间跨过多轮时保留前一轮终态快照，不能被下一轮首帧覆盖。
    var pendingSnapshotBacklog: [String: [ServerMessage]] = [:]
    /// ready 之后、快照之前的增量丢掉，避免拼到半截正文上
    var awaitSnapshot = Set<String>()
    var sawSnapshot = Set<String>()
    /// 快照超限、正文改走分页时，先攒着随后的增量
    var snapshotHold = Set<String>()
    var heldDeltas: [String: [String]] = [:]
    /// 网关增量先在主线程短暂合并，再一次写入 running turn，避免每个 token 都触发整棵观察树。
    /// 事件数组保留正文、思考和工具输出之间的到达顺序；快照专用的 heldDeltas 仍保持独立。
    enum BufferedStreamEvent {
        case text(String)
        case thinking(String)
        case toolOutput(callId: String, stream: String?, chunk: String?, stdout: String?, stderr: String?)
    }
    @ObservationIgnored var streamDeltaBuffers: [String: [BufferedStreamEvent]] = [:]
    @ObservationIgnored var streamDeltaFlushTasks: [String: Task<Void, Never>] = [:]
    static let streamDeltaFlushDelay: Duration = .milliseconds(50)
    /// ThreadView 只关心「这一批可能改变了末轮高度」，不再为每次重算拼 liveTail 大字符串。
    var turnRenderRevisions: [String: UInt64] = [:]
    /// P8 slim：分页期间已 prepend 的页 turn 数（断线重启分页时剥掉页前缀、保留本地新发后缀）
    var loadedPageTurnCounts: [String: Int] = [:]
    /// P8 slim：每会话分页代际（单调递增，会话内不复用）。load_chat 携带、chat_turns 回显，
    /// 降级/重启分页后旧链迟到页凭 nonce 不匹配丢弃——成员资格守卫挡不住同步重注册（Kimi R2 M1）
    var loadEpochs: [String: Int] = [:]
    /// 分页请求的超时：每发一页重新计时，回包丢了不会让会话永远停在「加载中」
    var loadTimeouts: [String: Task<Void, Never>] = [:]
    /// 连续超时次数，超过上限就停下等重连，不无限重发
    var loadTimeoutStreak: [String: Int] = [:]
    static let loadPageTimeout: Duration = .seconds(25)
    /// P8 slim：turns 未加载完就发了消息的会话——加载完成后必须补一次全量 sync，
    /// 否则加载期间的 sync（无 turns 键）会把 dirty 清掉，新 turn 永不落盘（Grok 评审 M2）
    var localTurnsPendingSync = Set<String>()

    // MARK: 正文本机缓存 + 增量补齐
    /// 增量补齐进行中的会话：旧正文（基线）还在显示，后台对齐服务端（界面可显示「同步中」）
    var refreshingChatIds: Set<String> = []
    /// 内存正文（不含本地新加的回合）对应的服务端会话版本。只在正文是某个版本的完整全文时才有值：
    /// 分页/补齐完成、本机缓存读入、带正文的 sync_ack。没有值的半截正文不能当补齐基线
    var bodyRevs: [String: Int] = [:]
    /// 分页/补齐发起时的 chatRevs[id]：完成时正文就是这个版本（途中版本又前进了就再补一次）
    var loadStartRevs: [String: Int] = [:]
    /// 服务端段哈希（segHashes[i] 覆盖 turns[i*100, (i+1)*100)）和它对应的会话版本：版本对不上就不能用
    struct SegHashes: Equatable {
        var rev: Int
        var hashes: [String]
    }
    /// slim 行带来的服务端最新段哈希
    var serverSegs: [String: SegHashes] = [:]
    /// 内存正文对应的服务端段哈希：跟 bodyRevs 同设同清（rev 与 bodyRevs 一致才有效）
    var bodySegs: [String: SegHashes] = [:]
    /// 分页/补齐发起时的服务端段哈希，完成时随 loadStartRevs 记进 bodySegs
    var loadStartSegs: [String: SegHashes] = [:]
    /// 增量补齐的进度：base 是基线里已结束的回合，acc 是从末尾往前累积的服务端回合（覆盖 [from, total)）
    struct BodyRefresh {
        var base: [Turn]
        var acc: [Turn] = []
        /// 基线和服务端对不上：继续翻到第一页，最后用 acc 整体替换
        var fallback = false
        /// 段哈希判出的第一个变动位置：acc 至少要覆盖到这里（from <= minFrom）才能接缝
        var minFrom: Int?
        /// 基线只是首屏尾段：同 id 以服务端正文为准，不要用尾段盖掉服务端终态
        var displayBase = false
    }
    var bodyRefreshes: [String: BodyRefresh] = [:]
    /// 正在读本机正文缓存的会话（读完前不重复读、不发分页）
    var cacheReadingIds = Set<String>()
    /// 本次启动已经查过本机正文缓存的会话（没命中的不再查）
    var cacheCheckedIds = Set<String>()
    /// 冷启动从 list.json 画出来的会话行：只读，不标脏、不上传；首个 stored_state 到达时以服务端为准整份替换
    var cachedOnlyIds = Set<String>()
    /// 屏幕上的正文来自首屏尾段，还不是某个服务端版本的全文。不写 bodyRevs，也不上传
    var displayOnlyIds = Set<String>()
    var tailTasks: [String: Task<Void, Never>] = [:]
    /// stored_digest 发了 load_state、还在等回包：回包的 stored_state 不受 rev 早退，对账完之前先不推
    var stateReloadPending = false
    var bodyCacheTasks: [String: Task<Void, Never>] = [:]
    var listCacheTask: Task<Void, Never>?
    /// 本机缓存读取代际：resetTenantSession 递增，之前发起的读取回来直接丢（同租户登出再登录也不串）
    var cacheEpoch = 0
    @ObservationIgnored var bootstrapSnapshot: AppBootstrapSnapshot?
    @ObservationIgnored var bootstrapLoadTask: Task<Void, Never>?
    @ObservationIgnored var bootstrapLoadCompleted = false
    @ObservationIgnored var bootstrapAssistantDirty = false
    @ObservationIgnored var bootstrapWorkspacesDirty = false
    @ObservationIgnored var bootstrapFileIndexesDirty = false
    /// bootstrap 尚未读完时删除会话也要留下墓碑，防止磁盘索引在合并时复活。
    @ObservationIgnored var bootstrapFileIndexTombstones = Set<String>()
    @ObservationIgnored var launchSawReady = false
    @ObservationIgnored var launchSawConditionalSync = false
    @ObservationIgnored var launchStableReported = false

    var syncTask: Task<Void, Never>?
    var verifyTask: Task<Void, Never>?
    var noticeTask: Task<Void, Never>?
    var bannerErrorTask: Task<Void, Never>?
    var stallTask: Task<Void, Never>?
    /// stallTask 正在盯的对话；别的对话收尾/有进展不能抢掉它
    var stallChatId: String?
    var lastProgress = Date()
    /// 当前这一轮已经多少秒没有新进展（0 = 不显示提示）。
    /// 对齐网页：4 秒起显示「仍在处理…」，15 秒起带秒数并出现停止按钮。
    /// 只有 StallHintRow 读它，每秒刷新不会带动整条对话重绘。
    var stallSeconds = 0
    let tenantKey = "jiebo.tenantId"
    /// P9：最后活跃会话是否已在本次启动恢复过（只恢复一次，重连/后续 stored_state 不再抢）
    var didRestoreLastActive = false
    var pendingUploads: [String: CheckedContinuation<String, Error>] = [:]

    /// P9：最后活跃会话按租户隔离持久化（登出不清——下次登录同租户要能直接打开）
    var lastChatKey: String? {
        tenantId.isEmpty ? nil : "jiebo.lastActiveChatId.\(tenantId)"
    }

    var assistantChatKey: String? {
        tenantId.isEmpty ? nil : "jiebo.assistantChatId.\(tenantId)"
    }

    /// 网关段哈希每段的回合数
    static let serverSegmentSize = 100

    enum SegCompare {
        /// 比不了（网关不支持、哈希缺失或版本对不上）：退回末页接缝
        case unknown
        case same
        /// 第一个不一致的段（或一方先结束的位置）
        case changed(Int)
    }

    // MARK: P5b - diff 联动

    /// 网关 ready 声明的能力（turn_files / read_sha / read_req_id）。旧网关为空
    var gatewayFeatures: Set<String> = []
    /// 「全部还原」已发出、还没等到回执的轮次（只在本机，不上传）
    var restoringTurnIds: Set<String> = []
    /// 没有任何工具能带标记的轮次（files 有、tools 为空）点过的保留/还原：turnId → accepted/rejected。
    /// 只在本机，重启后这类轮次的整轮条会再出现
    var localTurnReviews: [String: String] = [:]
    /// 还原在等的回执：undo 一条，逐个 revert_file 每个路径一条
    var restoreWaits: [String: RestoreWait] = [:]

    struct RestoreWait {
        var chatId: String
        /// 这一轮改过的路径（已 relToCwd 归一）
        var paths: Set<String>
        /// 走的是整轮 undo（网关可能回 restored 而不是 undone）
        var viaUndo: Bool
        /// 还差几条 undone 回执
        var remaining: Int
        var timeout: Task<Void, Never>?
        /// 回执里出现过这一轮的路径
        var hit = false
    }

    /// 预览/导出共用的下载失败文案（P10 起导出也走这条，措辞保持中性；
    /// 独立于 UploadError，避免「预览失败：上传失败」串味）
    enum PreviewError: LocalizedError {
        case http(Int)
        case tooLarge
        var errorDescription: String? {
            switch self {
            case .http(let code):
                code == 404 ? "文件不在工作区里，可能已被移动或删除" : "获取文件失败（HTTP \(code)）"
            case .tooLarge:
                "文件太大（超过 32MB），处理不了"
            }
        }
    }

    // MARK: P10 - 预览导出（分享 / 存相册）

    /// 待分享的文件（temp，系统分享 sheet 的 activityItem）；dismiss 后删除
    var exportFile: PreviewFile?
    var exportLoading = false
    var lastExportURL: URL?
    var exportTask: Task<Void, Never>?

    // MARK: 检查点

    var checkpoints: [CheckpointInfo] = []
    var notedCheckpointId: String?

    var contentRevertPrompt = false

    /// stored_state 超 maxMessageBytes 时网关改发 deferred 通知，这里走 HTTP /state 拉全量。
    /// 运行中可能连续来多个 deferred，300ms 去抖合并成一次拉取。
    var stateFetchTask: Task<Void, Never>?

    enum StateFetchOutcome {
        case success([String: JSONValue])
        case retryable
        case fatal
    }
}
