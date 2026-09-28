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
    case files, search, git, terminal, loop

    var id: String { rawValue }

    var title: String {
        switch self {
        case .files: return "文件"
        case .search: return "搜索"
        case .git: return "Git"
        case .terminal: return "终端"
        case .loop: return "Loop"
        }
    }

    var symbol: String {
        switch self {
        case .files: return "folder"
        case .search: return "magnifyingglass"
        case .git: return "arrow.triangle.branch"
        case .terminal: return "terminal"
        case .loop: return "arrow.triangle.2.circlepath"
        }
    }
}

struct ShellEntry: Identifiable, Hashable {
    var id: String
    var command: String
    var output: String
    var running: Bool
}

private enum ContentDiscard {
    case closeContent
    case closeTool
    case switchTool(ToolLayer)
    case openFile(String)
    case openDiff(String)
    case openFileBrowser
    case selectChat(String)
    case deleteChat(String)
}

@Observable
@MainActor
final class ChatStore {
    var connected = false
    var unlocked = false
    var verifying = false
    var authError = ""
    var notice = ""
    var bannerError = ""
    var tokenDraft = ""
    var chats: [ChatSession] = [ChatSession.blank(id: "boot")]
    var activeId = "boot"
    var cwd = ""
    var workspaceRoot = ""
    var workspaces: [WorkspaceItem] = []
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
    var searchLoading = false
    private var searchTask: Task<Void, Never>?
    private var searchEpoch = 0
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
    private var contentChatId: String?
    /// 内容层读取代际。换文件后，迟到的 HTTP 水合不能写进新文件
    private var contentLoadEpoch = 0
    /// 已发出、还没对上 file_written 的正文快照。回包只把基线设成这份快照，之后的新输入仍算未保存
    private var contentSaves: [(path: String, snapshot: String)] = []
    private var contentDiscardFollowup: ContentDiscard?
    private var suppressContentDiscard = false
    private static let contentSaveLimit = 500_000
    /// 打开内容层之前右侧预览的焦点。内容层自己的页签不能把预览留在对话右侧
    private var contentRestorePreview: String?
    /// 表单盖住主区时，校验和网关拒绝要画在 sheet 里
    var loopError = ""
    var hasApiKey = true
    var draft = ""
    var showThinkingIds: Set<String> = []
    var tenantId = ""
    var tenantName = ""
    var pendingImages: [PendingImage] = []
    var uploads: [UploadItem] = []
    /// 待发图片按会话隔离（对齐网页端 per-chat 的 draftImages），切会话时换出/换回
    private var imagesByChat: [String: [PendingImage]] = [:]

    // MARK: P3 - @补全 / 文件清单 / Quick Look / undo
    /// 当前会话工作区的文件索引（list_files query:"" 的全量结果）
    var fileIndex: [String] = []
    var treeTruncated = false
    /// @补全候选（mention 模式 list_files 的结果）
    var mentionSuggestions: [String] = []
    /// Quick Look 预览中的文件（sheet 驱动）
    var previewFile: PreviewFile?
    var previewLoading = false
    /// 预览下载任务与最近一次 temp 文件（删除时机与 previewFile 置 nil 的顺序解耦）
    private var previewTask: Task<Void, Never>?
    private var lastPreviewURL: URL?
    /// WS 上传超时后迟到的 file_uploaded 回包 id（防被当成「别的客户端上传」写进草稿）
    private var expiredUploadIds: Set<String> = []
    /// 当前草稿尾部的 @查询（无则 nil）
    private var mentionQuery: String?
    private var mentionTask: Task<Void, Never>?

    // MARK: P5 - 预览面板（右侧 overlay，对齐网页 FilePreview）
    /// 打开的预览页签（上限 8，超出挤掉最旧的，对齐网页 slice(-8)）
    var previewTabs: [PreviewTab] = []
    /// 当前选中页签；非 nil 即面板打开
    var previewActivePath: String?
    var previewPanelOpen: Bool {
        // 文件浮层开着时，内容画在浮层右栏，不再同时从右侧弹出另一块
        !fileBrowserOpen && contentPath == nil && previewActivePath != nil && previewTabs.contains { $0.path == previewActivePath }
    }
    var activePreviewTab: PreviewTab? { previewTabs.first { $0.path == previewActivePath } }

    var active: ChatSession? { chats.first { $0.id == activeId } }
    var busy: Bool { active?.turns.contains(where: \.running) == true }
    var canSend: Bool {
        // 对齐网页端：上传未完成时禁发（@path 还没写进草稿，发出去会漏附件）
        uploads.isEmpty
            && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingImages.isEmpty)
    }

    private let client = GatewayClient()
    private var started = false
    private var stateRev = 0
    private var appliedStore = false
    // P4 增量同步：每会话版本号 + 脏标记 + 在途确认
    private var chatRevs: [String: Int] = [:]
    private var dirtyChatIds = Set<String>()
    private var inflightChatIds = Set<String>()
    private var pendingChatLoads = Set<String>()
    private var digestTimeoutTask: Task<Void, Never>?
    /// 网关是否支持 P4（stored_state 带 chatRevs / 收到 ack/digest/stored_chat）。
    /// 默认 false：未知时先走全量 sync_state（新旧网关都收），确认支持后才增量。
    private var serverSupportsP4 = false
    private var deletedIds = Set<String>()
    private var lastModel = ""
    /// 运行中/排队会话 id（侧栏运行点也读它：slim 会话没 turns，不能靠 turns.contains(running)）
    var runningChatIds: [String] = []
    private var queuedChatIds: [String] = []
    /// P9：当前租户是否管理员（ready 带下来）；管理员统计面板数据
    var isAdmin = false
    var adminStats: [AdminTenantStats] = []
    var adminStatsAt: Date?
    /// P8 slim：内容分页加载中的会话（ThreadView 遮罩 + 在途页去重用）
    var loadingChatIds: Set<String> = []
    /// P8 slim：turns 未加载完时暂存的 agent 历史（fresh UUID 与持久 turn id 不同空间，直接合并会重复）
    private var pendingHistory: [String: [Turn]] = [:]
    /// P8 slim：分页期间已 prepend 的页 turn 数（断线重启分页时剥掉页前缀、保留本地新发后缀）
    private var loadedPageTurnCounts: [String: Int] = [:]
    /// P8 slim：每会话分页代际（单调递增，会话内不复用）。load_chat 携带、chat_turns 回显，
    /// 降级/重启分页后旧链迟到页凭 nonce 不匹配丢弃——成员资格守卫挡不住同步重注册（Kimi R2 M1）
    private var loadEpochs: [String: Int] = [:]
    /// P8 slim：turns 未加载完就发了消息的会话——加载完成后必须补一次全量 sync，
    /// 否则加载期间的 sync（无 turns 键）会把 dirty 清掉，新 turn 永不落盘（Grok 评审 M2）
    private var localTurnsPendingSync = Set<String>()
    private var syncTask: Task<Void, Never>?
    private var verifyTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?
    private var stallTask: Task<Void, Never>?
    private var lastProgress = Date()
    private let tenantKey = "jiebo.tenantId"
    /// P9：最后活跃会话是否已在本次启动恢复过（只恢复一次，重连/后续 stored_state 不再抢）
    private var didRestoreLastActive = false
    private var pendingUploads: [String: CheckedContinuation<String, Error>] = [:]

    /// P9：最后活跃会话按租户隔离持久化（登出不清——下次登录同租户要能直接打开）
    private var lastChatKey: String? {
        tenantId.isEmpty ? nil : "jiebo.lastActiveChatId.\(tenantId)"
    }

    func start() {
        guard !started else { return }
        started = true
        if let saved = KeychainStore.token() {
            tokenDraft = saved
        }
        #if DEBUG
        // 开发便利：模拟器里 defaults write ai.jiebo.ipad jiebo.token 可预填令牌
        if tokenDraft.isEmpty,
           let prefilled = UserDefaults.standard.string(forKey: "jiebo.token")?.trimmingCharacters(in: .whitespacesAndNewlines),
           !prefilled.isEmpty
        {
            tokenDraft = prefilled
        }
        // 开发便利：DEBUG 下已有令牌（钥匙串或预填）直接自动登录
        if !tokenDraft.isEmpty {
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(300))
                self?.login()
            }
        }
        // 开发便利：defaults write ai.jiebo.ipad jiebo.previewPath -string <path> 登录后自动打开预览面板（截图/调试用）；
        // 前缀 "diff:" 直接开 diff 页签
        if let debugRaw = UserDefaults.standard.string(forKey: "jiebo.previewPath")?.trimmingCharacters(in: .whitespacesAndNewlines),
           !debugRaw.isEmpty
        {
            let wantDiff = debugRaw.hasPrefix("diff:")
            let debugPath = wantDiff ? String(debugRaw.dropFirst(5)) : debugRaw
            Task { @MainActor [weak self] in
                // 等 stored_state 应用完再开（否则 activeId 还是 boot）
                for _ in 0 ..< 40 {
                    try? await Task.sleep(for: .milliseconds(500))
                    guard let self, self.appliedStore, self.unlocked else { continue }
                    if wantDiff {
                        self.openPreviewTab(path: debugPath, diff: true)
                    } else {
                        self.openPreview(debugPath)
                    }
                    break
                }
            }
        }
        #endif
        lastModel = UserDefaults.standard.string(forKey: ModelCatalog.lastModelKey) ?? ""
        tenantId = UserDefaults.standard.string(forKey: tenantKey) ?? ""
        wireClient()
        client.connect(url: GatewayConfig.url)
    }

    func login() {
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        tokenDraft = token
        authError = ""
        verifying = true
        armVerifyTimeout()
        // hello 由 client.onOpen 在握手完成后统一发出
        client.connect(url: GatewayConfig.url)
    }

    func logout() {
        KeychainStore.delete()
        UserDefaults.standard.removeObject(forKey: tenantKey)
        unlocked = false
        connected = false
        verifying = false
        verifyTask?.cancel()
        tokenDraft = ""
        authError = ""
        tenantId = ""
        tenantName = ""
        resetTenantSession()
        client.disconnect()
    }

    func answerQuestion(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        draft = trimmed
        submit()
    }

    func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = pendingImages
        guard !text.isEmpty || !images.isEmpty else { return }
        // 带图 prompt 不进 outbox（base64 太大），掉线时直接拒发
        if !images.isEmpty, !client.isOpen {
            bannerError = "图片需要在线发送，等连接恢复再发。"
            return
        }
        ensureActiveChat()
        let chatId = activeId
        let untitled = chats.first { $0.id == chatId }?.isUntitled ?? true
        // P11：第三方模型无状态——历史随 prompt 上行；须在本地 turn 追加前组装（否则把当前消息也装进去）
        let history = ChatStore.externalHistory(model: model, turns: active?.turns ?? [])
        // 对齐网页端：纯图时本地占位「（附图）」，prompt.text 留空由网关兜底
        let turn = Turn.blank(user: text.isEmpty ? "（附图）" : text, model: model, mode: mode, running: !busy)
        draft = ""
        pendingImages = []
        imagesByChat[chatId] = nil
        bannerError = ""
        notice = ""
        patch(chatId) { chat in
            var next = chat
            next.draft = ""
            next.unread = false
            next.turns.append(turn)
            return next
        }
        // P8 slim：turns 未加载完时的本地新 turn——加载完成前若 sync 被触发（无 turns 键），
        // dirty 会被清掉导致此 turn 永不落盘；登记后由分页完成分支补全量回推（Grok 评审 M2）
        if chats.first(where: { $0.id == chatId })?.turnsComplete == false {
            localTurnsPendingSync.insert(chatId)
        }
        let mentions = ChatStore.extractMentions(text)
        send(.prompt(
            text: text,
            model: model,
            mode: mode,
            chatId: chatId,
            files: mentions.isEmpty ? nil : mentions,
            images: images.isEmpty ? nil : images.map(\.promptImage),
            confirmWrites: active?.confirmWrites,
            autoApprove: nil,
            fresh: nil,
            nameChat: untitled,
            policy: active?.policy,
            history: history
        ))
        markProgress(chatId)
    }

    /// P11：第三方模型（id 形如 "provider:model"）无状态，历史随 prompt 上行；
    /// 截断口径与网关一致：最近 12 条、每条 3000 字符；排队/出错/空消息跳过
    /// （error turn 的残缺回复不进上下文，GLM/Grok 评审 m3）。
    /// 注意：history 在提交时组装——排队期间完成的 turn 不在其内（客户端权威设计的固有权衡）
    static func externalHistory(model: String?, turns: [Turn]) -> [HistoryItem]? {
        guard let model, model.contains(":") else { return nil }
        var items: [HistoryItem] = []
        for t in turns where !t.queued && t.error == nil {
            let user = t.user.trimmingCharacters(in: .whitespacesAndNewlines)
            let assistant = t.assistant.trimmingCharacters(in: .whitespacesAndNewlines)
            if !user.isEmpty { items.append(HistoryItem(role: "user", text: String(user.prefix(3000)))) }
            if !assistant.isEmpty { items.append(HistoryItem(role: "assistant", text: String(assistant.prefix(3000)))) }
        }
        return items.isEmpty ? nil : Array(items.suffix(12))
    }

    /// 与网页端同一规则：草稿里的 @路径 在发送时抽成 files 数组
    static func extractMentions(_ text: String) -> [String] {
        var out: [String] = []
        for match in text.matches(of: /@(\S+)/) {
            let path = String(match.1)
            if !path.isEmpty, !out.contains(path) { out.append(path) }
        }
        return out
    }

    func stop() {
        send(.cancel(chatId: activeId))
        runningChatIds.removeAll { $0 == activeId }
        queuedChatIds.removeAll { $0 == activeId }
        patch(activeId) { chat in
            var next = chat
            next.turns = next.turns.map { turn in
                turn.running || turn.tools.contains(where: { $0.status == "running" })
                    ? turn.settled(status: "cancelled")
                    : turn
            }
            return next
        }
        stallTask?.cancel()
    }

    func chooseModel(_ id: String) {
        model = id
        rememberModel(id)
        patch(activeId) { chat in
            var next = chat
            next.model = id
            return next
        }
        send(.setModel(model: id, chatId: activeId))
    }

    func chooseMode(_ value: AgentMode) {
        mode = value
        patch(activeId) { chat in
            var next = chat
            next.mode = value
            return next
        }
    }

    func openNewChat() {
        let path = currentWorkspacePath
        guard !path.isEmpty else {
            openWorkspaceSwitcher()
            return
        }
        startChat(in: path)
    }

    func openWorkspaceSwitcher() {
        send(.listWorkspaces)
        creatingWorkspace = false
        newWorkspaceName = ""
        workspaceSheetOpen = true
    }

    /// 切到这个工作区：有会话就打开最近的一条，没有就新建。
    func switchWorkspace(to path: String) {
        let next = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return }
        workspaceSheetOpen = false
        creatingWorkspace = false
        let key = normPath(next)
        if let chat = sidebarChats.first(where: { normPath($0.cwd?.nilIfEmpty ?? groupRoot) == key }) {
            if chat.id != activeId { select(chat.id) }
            return
        }
        startChat(in: next)
    }

    func startChat(in path: String) {
        let next = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return }
        workspaceSheetOpen = false
        creatingWorkspace = false
        persistDraft()
        if let existing = chats.first(where: { $0.isUntitled && $0.turnsComplete && $0.turns.isEmpty && sameCwd($0.cwd?.nilIfEmpty ?? groupRoot, next) }) {
            select(existing.id)
            patch(existing.id) { chat in
                var nextChat = chat
                nextChat.cwd = next
                nextChat.mode = .agent
                nextChat.model = chat.model ?? self.model
                return nextChat
            }
            cwd = next
            mode = .agent
            send(.setWorkspace(cwd: next, chatId: existing.id, create: nil))
            return
        }
        let chat = ChatSession.blank(cwd: next, model: lastModel.nilIfEmpty ?? model, mode: .agent)
        chats.insert(chat, at: 0)
        swapActive(to: chat.id)
        cwd = next
        mode = .agent
        if let nextModel = chat.model {
            model = nextModel
        }
        draft = ""
        send(.newSession(chatId: chat.id, cwd: next))
        if let nextModel = chat.model {
            send(.setModel(model: nextModel, chatId: chat.id))
        }
        dirtyChatIds.insert(chat.id) // 新会话上传走 sync_chat（网关对未知 id 会追加）
        scheduleSync()
    }

    func createWorkspace() {
        let name = newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        send(.createWorkspace(name: name))
        newWorkspaceName = ""
        creatingWorkspace = false
    }

    /// P9：管理员拉全租户统计（非管理员发了也会被网关拒，入口按 isAdmin 隐藏）
    func requestAdminStats() {
        guard isAdmin else { return }
        send(.adminStats)
    }

    func select(_ id: String) {
        guard id != activeId else { return }
        let nextCwd = chats.first { $0.id == id }?.cwd
        if contentPath != nil, !sameCwd(nextCwd, active?.cwd), contentDirty, !suppressContentDiscard {
            contentDiscardFollowup = .selectChat(id)
            contentDiscardPrompt = true
            return
        }
        swapActive(to: id)
        mentionQuery = nil
        mentionTask?.cancel()
        mentionSuggestions = []
        patch(id) { chat in
            var next = chat
            next.unread = false
            return next
        }
        applySession(chats.first { $0.id == id })
    }

    /// 切换 activeId 的统一入口：保存旧会话草稿+待发图 → 切 → 载入新会话待发图 → 拉新工作区文件索引。
    /// 所有改 activeId 的路径（select/startChat/deleteChat/storedState）都必须走这里。
    private func swapActive(to newId: String) {
        guard newId != activeId else { return }
        let nextCwd = chats.first { $0.id == newId }?.cwd
        if contentPath != nil, !sameCwd(nextCwd, active?.cwd) {
            let prompted = suppressContentDiscard
            let dirty = contentDirty
            let wasSuppressing = suppressContentDiscard
            suppressContentDiscard = true
            closeContentLayer()
            suppressContentDiscard = wasSuppressing
            if dirty, !prompted { flash("未保存的修改已丢掉") }
        }
        let oldCwd = active?.cwd
        persistDraft()
        imagesByChat[activeId] = pendingImages // 待发图片跟会话走
        activeId = newId
        // P9：持久化最后活跃会话（boot 占位不记）；下次启动 applyStoredState 后恢复
        if newId != "boot", let key = lastChatKey {
            UserDefaults.standard.set(newId, forKey: key)
        }
        pendingImages = imagesByChat[newId] ?? []
        previewTask?.cancel() // 在途预览不带到新会话；取消分支早返回不会自己复位 loading
        previewLoading = false
        exportTask?.cancel() // P10：在途导出同样不带到新会话（Grok R1 M1）——页签虽全局存活，
        exportLoading = false // 但「下载中切会话」是被动场景，完成时弹 sheet 会打断新上下文
        requestFileIndex() // 冷启动/切会话都靠这里补拉（select 不再单独调）
        searchHits = []
        if !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            scheduleSearch()
        }
        // 工作区按会话走：cwd 变了，页签内容按新工作区重拉（页签保留，路径仍有效）。
        // 与下方清空判断同用 sameCwd（字符串级归一）——/foo 与 /foo/ 不该白打一遍 read_file
        if !sameCwd(active?.cwd, oldCwd) {
            reloadPreviewTabs()
            // P7：跨工作区切换时先清空文件索引——新索引到达前不串旧工作区的内容
            fileIndex = []
            treeTruncated = false
            gitStatus = [:]
        }
        ensureTurnsLoaded(newId) // P8 slim：点开的会话若只有元数据壳，启动分页加载
    }

    /// P8 slim：会话 turns 未加载时启动分页加载（幂等）。from=nil 拉最后一页，
    /// 之后按响应的 from/hasMore 一页页向前翻（见 .chatTurns 处理）。
    func ensureTurnsLoaded(_ chatId: String) {
        guard let chat = chats.first(where: { $0.id == chatId }),
              !chat.turnsComplete,
              !loadingChatIds.contains(chatId) else { return }
        loadEpochs[chatId] = (loadEpochs[chatId] ?? 0) + 1 // 新分页链起新代际
        loadingChatIds.insert(chatId)
        send(.loadChat(chatId: chatId, from: nil, nonce: loadEpochs[chatId]))
    }

    /// 切工作区后重拉所有打开的页签（对齐网页 per-chat tabs 的意图：内容不能跨工作区复用）
    private func reloadPreviewTabs() {
        for index in previewTabs.indices {
            previewTabs[index].content = nil
            previewTabs[index].error = nil
            // 媒体字段也是旧工作区的票据，一并清掉（否则切工作区后还加载旧文件）
            previewTabs[index].url = nil
            previewTabs[index].headUrl = nil
            previewTabs[index].media = nil
            previewTabs[index].mime = nil
            previewTabs[index].size = nil
            // cwd 快照同步刷新：内容来自新工作区，副标题不能还拼旧 cwd。
            // 注意用 active?.cwd——swapActive 先切 activeId 再调本函数，store.cwd 此刻可能还是旧值
            previewTabs[index].cwd = active?.cwd ?? cwd
            previewTabs[index].chatId = activeId // 票据将绑新会话（Kimi R2 N1：导出按旧会话 cwd 会拿错文件）
            previewTabs[index].loading = true
            send(.readFile(path: previewTabs[index].path, chatId: activeId, diff: previewTabs[index].diff))
            armPreviewWatchdog(path: previewTabs[index].path)
        }
    }

    /// loading 看门狗：outbox 挤掉/服务端丢包时给页签一个出口（网页 2.5s×4 重试的简化版）
    private func armPreviewWatchdog(path: String) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self, let index = self.previewTabs.firstIndex(where: { $0.path == path }) else { return }
            let tab = self.previewTabs[index]
            if tab.loading, tab.content == nil, tab.error == nil {
                self.previewTabs[index].loading = false
                self.previewTabs[index].error = "读取超时。点重试再试一次。"
            }
        }
    }

    // MARK: P5b - diff 联动

    /// agent 改过、还没看过的文件（有序去重；点 pill 进入面板后清空）
    var pendingDiffPaths: [String] = []

    /// mutating 工具完成后的联动：静默备好 diff 页签；面板已打开才抢焦点（对齐网页自动开 diff 的意图，
    /// 但 overlay 会盖住会话，不能在面板关着时硬弹）
    func trackEditedFile(_ rawPath: String) {
        let path = relToCwd(rawPath)
        guard !path.isEmpty else { return }
        // 8 签挤掉最旧时若挤掉的是 active 签，面板会静默关闭——先记下用户本来在不在看
        let wasOpen = previewPanelOpen
        let kind = previewKind(of: path)
        // binary 面板渲染不了——只计待看，pill/工具卡点进来走 Quick Look
        guard kind.panelRenderable else {
            if !(wasOpen && previewActivePath == path) {
                pendingDiffPaths.removeAll { $0 == path }
                pendingDiffPaths.append(path)
            }
            return
        }
        // 网页对 canvas/markdown/html/pdf/audio 跳过 diff——这些类型 diff 视图没意义；
        // video 走 diff 会被网关拒（isByteKind）；image/svg 从 P5c 起支持双图对照，不再跳过
        let skipDiff: Bool = switch kind {
        case .canvas, .markdown, .html, .pdf, .audio, .video: true
        default: false
        }
        let wantDiff = !skipDiff
        if let index = previewTabs.firstIndex(where: { $0.path == path }) {
            var tab = previewTabs[index]
            if wantDiff && !tab.diff {
                tab.diff = true
                tab.content = nil
                tab.error = nil
                tab.url = nil // 与 openPreviewTab/togglePreviewDiff 一致：升级窗口别拿旧图误标「新文件」
                tab.headUrl = nil
            }
            tab.loading = true
            tab.chatId = activeId // 重读即重签，票据绑当前会话（Kimi R2 N1）
            previewTabs[index] = tab
            send(.readFile(path: path, chatId: activeId, diff: tab.diff))
            armPreviewWatchdog(path: path)
        } else {
            previewTabs.append(PreviewTab(path: path, kind: kind, diff: wantDiff, content: nil, error: nil, loading: true, url: nil, media: nil, chatId: activeId, cwd: cwd))
            if previewTabs.count > 8 { previewTabs.removeFirst(previewTabs.count - 8) }
            send(.readFile(path: path, chatId: activeId, diff: wantDiff))
            armPreviewWatchdog(path: path)
        }
        if wasOpen {
            previewActivePath = path // 面板开着才跟焦点（用 wasOpen：挤掉 active 签后面板已关，不能误判）
        }
        // 用户正盯着这个 diff 就不计待看；重复编辑挪到尾部（openDiffs 聚焦最新）
        if !(wasOpen && previewActivePath == path) {
            pendingDiffPaths.removeAll { $0 == path }
            pendingDiffPaths.append(path)
        }
    }

    /// 工具卡「看改动」入口：归一路径后按类型路由——skipDiff 类型走 openPreview
    /// （markdown/html/canvas 开原文页签，pdf/audio 面板播放，binary 转 Quick Look），
    /// image/svg 开 diff 页签做双图对照（P5c），其余文本开 diff 页签
    func openToolFile(_ rawPath: String) {
        let path = relToCwd(rawPath)
        guard !path.isEmpty else { return }
        pendingDiffPaths.removeAll { $0 == path } // 看过即销账（含走 Quick Look 的 binary）
        switch previewKind(of: path) {
        case .canvas, .markdown, .html, .pdf, .audio, .video:
            openPreview(path)
        default:
            openPreview(path, diff: true)
        }
    }

    /// pill 入口：打开面板聚焦最近改动，清空待看清单
    func openDiffs() {
        guard let latest = pendingDiffPaths.last else { return }
        pendingDiffPaths = []
        // 走 openToolFile：skipDiff 类型（image/svg 等）路由到原文/Quick Look，
        // 不会把已有页签升级成「Binary files differ」死页签；页签被挤掉也能重建
        openToolFile(latest)
    }

    /// canvas 页签的 源码/画布 切换（P5d）
    func toggleCanvasSource(_ path: String) {
        guard let index = previewTabs.firstIndex(where: { $0.path == path }) else { return }
        previewTabs[index].showSource.toggle()
    }

    /// 头部 diff/原文 切换
    func togglePreviewDiff(_ path: String) {
        guard let index = previewTabs.firstIndex(where: { $0.path == path }) else { return }
        let next = !previewTabs[index].diff
        previewTabs[index].diff = next
        previewTabs[index].content = nil
        previewTabs[index].error = nil
        previewTabs[index].url = nil // 清掉旧媒体地址，避免切换期间闪旧图
        previewTabs[index].headUrl = nil
        previewTabs[index].loading = true
        send(.readFile(path: path, chatId: activeId, diff: next))
        armPreviewWatchdog(path: path)
    }

    /// 工具参数/结果里提取文件路径（对齐网页 toolPath 的字段集）。
    /// string(in:) 无命中返回 ""，必须 nilIfEmpty 才能回退到 result
    static func toolPath(args: JSONValue?, result: JSONValue?) -> String? {
        args?.string(in: "path", "file", "target", "file_path", "uri", "filename", "image_path", "imagePath", "output_path", "outputPath").nilIfEmpty
            ?? result?.string(in: "path", "file", "file_path", "filename", "image_path", "imagePath", "output_path", "outputPath").nilIfEmpty
    }

    /// 绝对路径转工作区相对（对齐网页 relToCwd：反斜杠归一、去尾斜杠、去前导 ./）；
    /// 不在工作区里的返回归一化后的原路径；path == cwd 返回空串
    private func relToCwd(_ path: String) -> String {
        var p = path.replacingOccurrences(of: "\\", with: "/")
        while p.hasSuffix("/") { p.removeLast() }
        if p.hasPrefix("./") { p.removeFirst(2) }
        guard let cwdRaw = active?.cwd?.nilIfEmpty ?? workspaceRoot.nilIfEmpty else { return p }
        var root = cwdRaw.replacingOccurrences(of: "\\", with: "/")
        while root.hasSuffix("/") { root.removeLast() }
        if p == root { return "" }
        if !root.isEmpty, p.hasPrefix(root + "/") {
            return String(p.dropFirst(root.count + 1))
        }
        return p
    }

    /// 重命名（对齐 web commitRename）：空标题忽略；已命名的会话不许改回「新对话」（那是未命名标记）；
    /// patch 会标脏并走 sync_chat 增量推送，多设备随 digest 对账同步
    func renameChat(_ id: String, to rawTitle: String) {
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        patch(id) { chat in
            if chat.title == title { return chat }
            if title == "新对话", !chat.isUntitled { return chat }
            var next = chat
            next.title = title
            return next
        }
    }

    func deleteChat(_ id: String) {
        if contentChatId == id, contentPath != nil {
            if contentDirty, !suppressContentDiscard {
                contentDiscardFollowup = .deleteChat(id)
                contentDiscardPrompt = true
                return
            }
            let wasSuppressing = suppressContentDiscard
            suppressContentDiscard = true
            closeContentLayer()
            suppressContentDiscard = wasSuppressing
        }
        if let doomed = chats.first(where: { $0.id == id }), doomed.turns.contains(where: \.running) {
            send(.cancel(chatId: id))
        }
        send(.deleteSession(chatId: id))
        deletedIds.insert(id)
        imagesByChat[id] = nil
        dropChatState(id) // 在途分页随删除终止（迟到页由 .chatTurns 校验丢弃）
        var rest = chats.filter { $0.id != id }
        if rest.isEmpty {
            let chat = ChatSession.blank(cwd: cwd.nilIfEmpty ?? workspaceRoot, model: lastModel.nilIfEmpty ?? model, mode: mode)
            rest = [chat]
            send(.newSession(chatId: chat.id, cwd: chat.cwd))
            if let nextModel = chat.model {
                send(.setModel(model: nextModel, chatId: chat.id))
            }
        }
        chats = rest
        if id == activeId, let first = rest.first {
            pendingImages = [] // 被删会话的待发图随会话丢弃（swapActive 会把空数组 flush 到已删 id）
            swapActive(to: first.id)
            applySession(first)
        }
        scheduleSync()
    }

    func replyToApproval(allow: Bool) {
        guard let chat = active, let pending = chat.turns.last(where: { $0.pendingTool != nil })?.pendingTool else { return }
        send(.approvalReply(chatId: chat.id, callId: pending.callId, allow: allow))
        patchRunning(chat.id) { turn in
            var next = turn
            next.pendingTool = nil
            return next
        }
    }

    func saveDraft(_ value: String) {
        if draft != value { draft = value }
        updateMentions(for: value)
        guard let index = chats.firstIndex(where: { $0.id == activeId }) else { return }
        if chats[index].draft != value {
            chats[index].draft = value
        }
    }

    /// 打字时只更新 @ 候选，不把草稿写进会话列表。
    func updateMentions(for text: String) {
        guard let range = text.range(of: #"(^|\s)@(\S*)$"#, options: .regularExpression) else {
            if mentionQuery != nil { mentionQuery = nil }
            mentionTask?.cancel()
            if !mentionSuggestions.isEmpty { mentionSuggestions = [] }
            return
        }
        let tail = String(text[range.lowerBound...])
        let queryString = String(tail.drop(while: { $0 != "@" }).dropFirst())
        guard queryString != mentionQuery else { return }
        mentionQuery = queryString
        mentionTask?.cancel()
        let next = ChatStore.rankMentions(fileIndex, query: queryString)
        if next != mentionSuggestions { mentionSuggestions = next }
        mentionTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            self?.send(.listFiles(query: queryString, chatId: self?.activeId, mention: true))
        }
    }

    // MARK: @补全

    /// 检测草稿尾部的 @查询（对齐网页 mentionAt，iOS 简化只看文本末尾）
    private func refreshMentionSuggestions() {
        updateMentions(for: draft)
    }

    /// 点选候选：把草稿尾部的 @查询 替换成 @路径（保留查询前的空白分隔）
    func insertMention(_ path: String) {
        guard let range = draft.range(of: #"(^|\s)@(\S*)$"#, options: .regularExpression) else { return }
        let leading = draft[range.lowerBound...].first.map { $0 == " " || $0 == "\n" ? String($0) : "" } ?? ""
        var next = draft
        next.replaceSubrange(range, with: "\(leading)@\(path) ")
        mentionQuery = nil
        mentionTask?.cancel()
        mentionSuggestions = []
        saveDraft(next)
    }

    /// 候选排序：文件名前缀 > 文件名包含 > 路径包含，同分短路径优先（对齐网页 mentionHits 的意图）
    static func rankMentions(_ paths: [String], query: String, limit: Int = 8) -> [String] {
        let q = query.lowercased()
        func score(_ path: String) -> Int {
            if q.isEmpty { return 0 }
            let name = (path as NSString).lastPathComponent.lowercased()
            if name.hasPrefix(q) { return 0 }
            if name.contains(q) { return 10 }
            if path.lowercased().contains(q) { return 20 }
            return 99
        }
        var scored: [(path: String, rank: Int)] = []
        scored.reserveCapacity(paths.count)
        for path in paths {
            let rank = score(path)
            if rank < 99 { scored.append((path, rank)) }
        }
        scored.sort { lhs, rhs in
            lhs.rank == rhs.rank ? lhs.path.count < rhs.path.count : lhs.rank < rhs.rank
        }
        return scored.prefix(limit).map(\.path)
    }

    /// 拉当前会话工作区的文件索引（@补全的本地底数据 + 文件清单 sheet）
    func requestFileIndex() {
        guard unlocked else { return }
        send(.listFiles(query: "", chatId: activeId, mention: nil))
    }

    /// 文件清单 sheet 用：把 @path 追加到当前会话草稿（带去重）
    func appendMentionToDraft(_ path: String) {
        appendMention(path, to: activeId)
    }

    // MARK: Quick Look 预览

    /// 点 @文件 芯片：从 /media 下载到临时文件后用 QLPreviewController 打开
    func openMention(_ path: String) {
        let trimmed = path.trimmingCharacters(in: .whitespaces)
        // 对齐网页 isOpenableMention：只挡精确 "diff" 与目录
        guard !trimmed.isEmpty, !trimmed.hasSuffix("/"), trimmed.lowercased() != "diff" else {
            if !trimmed.isEmpty { flash("这类内容暂不支持预览") }
            return
        }
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        previewTask?.cancel() // 连续点两个 mention：取消在途的，避免覆盖泄漏
        previewLoading = true
        let chatId = activeId
        let tenantAtStart = tenantId
        previewTask = Task {
            do {
                let temp = try await downloadToTemp(path: trimmed, chatId: chatId, token: token)
                // 下载途中切了会话/租户：删掉 temp 静默退出，不在新上下文弹预览
                guard !Task.isCancelled, tenantId == tenantAtStart, activeId == chatId else {
                    removeTempFile(temp)
                    return
                }
                previewLoading = false
                setPreviewFile(PreviewFile(url: temp, name: (trimmed as NSString).lastPathComponent))
            } catch {
                guard !Task.isCancelled else { return }
                previewLoading = false
                guard tenantId == tenantAtStart else { return }
                bannerError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// /media 下载的公共段（openMention / exportPreview / saveImageToPhotos 共用）；
    /// 纯 IO，不含租户/会话守卫——调用方按自己的语义决定下载完成后是否还该呈现
    private func downloadData(path: String, chatId: String, token: String) async throws -> Data {
        var request = URLRequest(url: GatewayConfig.mediaURL(path: path, chatId: chatId))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 60
        let (data, response) = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(code) else { throw PreviewError.http(code) }
        guard data.count <= 32 * 1024 * 1024 else { throw PreviewError.tooLarge }
        return data
    }

    /// temp 用 uuid 目录隔离、文件名保持干净——分享 sheet/隔空投送给接收方的是
    /// lastPathComponent，带 uuid 前缀会泄漏丑名字（Kimi R1 M5）
    private func downloadToTemp(path: String, chatId: String, token: String, prefix: String = "jiebo-preview") async throws -> URL {
        let data = try await downloadData(path: path, chatId: chatId, token: token)
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let temp = dir.appendingPathComponent((path as NSString).lastPathComponent)
        try data.write(to: temp)
        return temp
    }

    /// 删 temp 文件并顺手收掉空的 uuid 隔离目录（非空目录不递归删——里面可能还有别的文件）
    private func removeTempFile(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
        let dir = url.deletingLastPathComponent()
        let name = dir.lastPathComponent
        guard name.hasPrefix("jiebo-preview-") || name.hasPrefix("jiebo-export-") else { return }
        if (try? FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty) == true {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    /// 预览/导出共用的下载失败文案（P10 起导出也走这条，措辞保持中性；
    /// 独立于 UploadError，避免「预览失败：上传失败」串味）
    private enum PreviewError: LocalizedError {
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

    /// 写 previewFile 的唯一入口：先删旧 temp 再换新的（防覆盖泄漏）；
    /// 删除依据 lastPreviewURL 而非 previewFile——sheet 交互关闭时 SwiftUI 先置 nil 再调 onDismiss
    private func setPreviewFile(_ file: PreviewFile?) {
        if let old = lastPreviewURL, old != file?.url {
            removeTempFile(old)
        }
        lastPreviewURL = file?.url
        previewFile = file
    }

    /// sheet onDismiss 入口：SwiftUI 已先把 previewFile 置 nil。
    /// 若此时 previewFile 非 nil，说明 dismiss 的是旧 sheet、期间又点了新预览——新 temp 不能删。
    func closePreview() {
        guard previewFile == nil else { return }
        setPreviewFile(nil)
    }

    /// Quick Look「完成」按钮入口：主动关 sheet（temp 清理由 setPreviewFile/onDismiss 链负责）
    func dismissPreviewFile() {
        setPreviewFile(nil)
    }

    // MARK: P10 - 预览导出（分享 / 存相册）

    /// 待分享的文件（temp，系统分享 sheet 的 activityItem）；dismiss 后删除
    var exportFile: PreviewFile?
    var exportLoading = false
    private var lastExportURL: URL?
    private var exportTask: Task<Void, Never>?

    /// 分享任意预览文件：文本类直接用已内联的 content 写 temp（省一次下载），
    /// 媒体/大文件走 /media 下载。temp 文件名保留原扩展名，分享 sheet 才能识别 UTType。
    /// chatId 用页签快照（票据/路径都绑签发时的会话）——页签全局存活，activeId 可能已切走（GLM R1 M1）
    func exportPreview(path rawPath: String, content: String?, isDiff: Bool = false, chatId: String? = nil) {
        let path = rawPath.trimmingCharacters(in: .whitespaces)
        // 与 openMention 同一套入口守卫（对齐：空串/目录/精确 "diff"）
        guard !path.isEmpty, !path.hasSuffix("/"), path.lowercased() != "diff" else { return }
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        exportTask?.cancel()
        exportLoading = true
        bannerError = "" // 清旧错误：cover 顶条红优先于绿，不清的话成功 flash 被旧错误挡住（Grok R2 M1）
        let chatId = chatId ?? activeId
        let tenantAtStart = tenantId
        let filename = (path as NSString).lastPathComponent
        exportTask = Task {
            do {
                let temp: URL
                if let content {
                    // diff 页签的 content 是 unified diff 文本，加 .diff 后缀让接收方按纯文本打开；
                    // uuid 目录隔离保持文件名干净（同 downloadToTemp，Kimi R1 M5）
                    let name = isDiff ? "\(filename).diff" : filename
                    let dir = FileManager.default.temporaryDirectory
                        .appendingPathComponent("jiebo-export-\(UUID().uuidString)", isDirectory: true)
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    temp = dir.appendingPathComponent(name)
                    try Data(content.utf8).write(to: temp)
                } else {
                    temp = try await downloadToTemp(path: path, chatId: chatId, token: token, prefix: "jiebo-export")
                }
                guard !Task.isCancelled, tenantId == tenantAtStart else {
                    removeTempFile(temp)
                    return
                }
                exportLoading = false
                setExportFile(PreviewFile(url: temp, name: filename))
            } catch {
                guard !Task.isCancelled else { return }
                exportLoading = false
                guard tenantId == tenantAtStart else { return }
                bannerError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// 图片一键存相册（原始字节直存，PNG/JPEG/GIF 都不重编码；权限由系统在写入时弹）
    /// chatId 同 exportPreview——页签快照，防切会话后跨 cwd 404
    func saveImageToPhotos(path rawPath: String, chatId: String? = nil) {
        let path = rawPath.trimmingCharacters(in: .whitespaces)
        guard !path.isEmpty, !path.hasSuffix("/"), path.lowercased() != "diff" else { return }
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        exportTask?.cancel()
        exportLoading = true
        bannerError = "" // 同 exportPreview（Grok R2 M1）
        let chatId = chatId ?? activeId
        let tenantAtStart = tenantId
        exportTask = Task {
            do {
                let data = try await downloadData(path: path, chatId: chatId, token: token)
                guard !Task.isCancelled, tenantId == tenantAtStart else { return }
                // 仅校验可解码（不用于写入——写入走 addResource(data:) 保原字节）；
                // 损坏图/ico 等 Photos 不收的格式在这里给中文文案，不露 PHPhotosErrorDomain 原文（Grok R2 N1）
                guard UIImage(data: data) != nil else {
                    exportLoading = false
                    bannerError = "图片数据读不出来，没法存相册"
                    return
                }
                // Photos 框架：权限明确、错误可抛（UIImageWriteToSavedPhotosAlbum 的
                // selector 回调有 delegate 存活坑，且权限拒绝时静默）。
                // addOnly 只回 authorized/denied/restricted，无 .limited（GLM R1 N4）
                let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
                // await 期间可能已被新导出/切会话取消——写状态前必须重检，
                // 否则旧任务醒来会抹掉新任务的 exportLoading（Grok R1 M2）
                guard !Task.isCancelled, tenantId == tenantAtStart else { return }
                guard status == .authorized else {
                    exportLoading = false
                    bannerError = "没有相册写入权限——去系统设置 → 接驳 → 照片 里打开"
                    return
                }
                // addResource(data:) 保原始字节（creationRequestForAsset(from: UIImage)
                // 会重编码，JPEG 二次压缩、GIF 掉帧——GLM R1 N5）
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
                }
                // 图已存是事实，但取消后不 flash、不动 loading（归新任务/取消源管）
                guard !Task.isCancelled, tenantId == tenantAtStart else { return }
                exportLoading = false
                flash("已存到相册")
            } catch {
                guard !Task.isCancelled else { return }
                exportLoading = false
                guard tenantId == tenantAtStart else { return }
                bannerError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// 写 exportFile 的唯一入口：先删旧 temp 再换新的（同 setPreviewFile 的防泄漏链）
    private func setExportFile(_ file: PreviewFile?) {
        if let old = lastExportURL, old != file?.url {
            removeTempFile(old)
        }
        lastExportURL = file?.url
        exportFile = file
    }

    /// 分享 sheet onDismiss 入口（SwiftUI 已先置 nil；同 closePreview 的旧 sheet 守卫）
    func closeExport() {
        guard exportFile == nil else { return }
        setExportFile(nil)
    }

    // MARK: P5 - 预览面板

    /// 从对话点文件：先把文件浮层打开，再读内容。浮层已经开着就直接读。
    func openPreview(_ path: String, diff: Bool = false) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasSuffix("/"), trimmed.lowercased() != "diff" else {
            if !trimmed.isEmpty { flash("这类内容暂不支持预览") }
            return
        }
        let warm = fileBrowserOpen
        fileBrowserPane = .files
        fileBrowserOpen = true
        let load = { [weak self] in
            self?.loadPreview(trimmed, diff: diff)
        }
        if warm {
            load()
        } else {
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(320))
                load()
            }
        }
    }

    /// 浮层已经在屏幕上时读文件。binary 仍走 Quick Look。
    func loadPreview(_ path: String, diff: Bool) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasSuffix("/"), trimmed.lowercased() != "diff" else { return }
        let kind = previewKind(of: trimmed)
        if kind.panelRenderable {
            openPreviewTab(path: trimmed, kind: kind, diff: diff)
        } else {
            openMention(trimmed)
        }
    }

    /// 打开/激活预览页签并发起 read_file；页签上限 8，超出挤掉最旧的（对齐网页 slice(-8)）。
    /// 绝对路径先归一到工作区相对（工具卡传来的可能是绝对路径；相对路径原样通过）
    func openPreviewTab(path rawPath: String, kind: PreviewKind? = nil, diff: Bool) {
        let path = relToCwd(rawPath)
        let resolved = kind ?? previewKind(of: path)
        pendingDiffPaths.removeAll { $0 == path } // 用户显式看过即销账
        if let index = previewTabs.firstIndex(where: { $0.path == path }) {
            var tab = previewTabs[index]
            previewActivePath = path
            if diff && !tab.diff {
                // diff 状态升级：内容含义变了，必须重拉；清掉旧媒体地址避免误标「新文件」/闪旧图
                tab.diff = true
                tab.content = nil
                tab.error = nil
                tab.url = nil
                tab.headUrl = nil
                tab.loading = true
                previewTabs[index] = tab
                send(.readFile(path: path, chatId: activeId, diff: true))
                armPreviewWatchdog(path: path)
            } else if !diff && tab.diff {
                // 从对照回到文件本身：清掉 diff 媒体，否则图片/svg 会继续显示对照
                tab.diff = false
                tab.content = nil
                tab.error = nil
                tab.url = nil
                tab.headUrl = nil
                tab.loading = true
                previewTabs[index] = tab
                send(.readFile(path: path, chatId: activeId, diff: false))
                armPreviewWatchdog(path: path)
            } else if tab.content == nil && tab.error == nil && !tab.loading && tab.mediaURL == nil {
                // 媒体页签已有 url 就不重发（content 恒 nil，重发只会白拉一趟）
                previewTabs[index].loading = true
                send(.readFile(path: path, chatId: activeId, diff: tab.diff))
                armPreviewWatchdog(path: path)
            }
            return
        }
        previewTabs.append(PreviewTab(path: path, kind: resolved, diff: diff, content: nil, error: nil, loading: true, url: nil, media: nil, cwd: cwd))
        if previewTabs.count > 8 { previewTabs.removeFirst(previewTabs.count - 8) }
        previewActivePath = path
        send(.readFile(path: path, chatId: activeId, diff: diff))
        armPreviewWatchdog(path: path)
    }

    func selectPreviewTab(_ path: String) {
        if previewTabs.contains(where: { $0.path == path }) {
            previewActivePath = path
            pendingDiffPaths.removeAll { $0 == path }
        }
    }

    func closePreviewTab(_ path: String) {
        previewTabs.removeAll { $0.path == path }
        pendingDiffPaths.removeAll { $0 == path } // 关签即视为已处理，pill 不再挂这个路径
        if previewActivePath == path { previewActivePath = previewTabs.last?.path }
    }

    func dismissPreviewPanel() {
        previewActivePath = nil
    }

    /// 错误页重试
    func retryPreviewTab(_ path: String) {
        guard let index = previewTabs.firstIndex(where: { $0.path == path }) else { return }
        previewTabs[index].error = nil
        previewTabs[index].loading = true
        send(.readFile(path: path, chatId: activeId, diff: previewTabs[index].diff))
        armPreviewWatchdog(path: path)
    }

    /// 大文本的 HTTP 水合（对齐网页 fetchPreviewText）：file_content 只给 url 时经票据拉正文
    private func hydratePreviewText(path: String) {
        guard let tab = previewTabs.first(where: { $0.path == path }),
              let url = tab.mediaURL
        else { return }
        let tenantAtStart = tenantId
        Task {
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 60
                let (data, response) = try await URLSession.shared.data(for: request)
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200 ..< 300).contains(code), let text = String(data: data, encoding: .utf8) else {
                    throw PreviewError.http(code)
                }
                guard tenantId == tenantAtStart,
                      let index = previewTabs.firstIndex(where: { $0.path == path }),
                      previewTabs[index].content == nil // 期间 WS 已补上 content 的不覆盖
                else { return }
                previewTabs[index].content = text
                previewTabs[index].error = nil // 清掉可能的陈旧错误（双 Task 竞态）
                previewTabs[index].loading = false
            } catch {
                guard tenantId == tenantAtStart,
                      let index = previewTabs.firstIndex(where: { $0.path == path }),
                      previewTabs[index].content == nil // 已有内容时不盖错误
                else { return }
                previewTabs[index].loading = false
                previewTabs[index].error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    // MARK: 单颗 undo

    /// 有可还原的最近一轮（对齐网页：undo 作用于最后一轮）
    var canUndo: Bool {
        guard !busy, let chat = active else { return false }
        return chat.turns.contains { !$0.running && !$0.queued }
    }

    func undoLast() {
        guard canUndo else { return }
        send(.undo(chatId: activeId))
    }

    // MARK: 附件与图片

    func addPendingImages(_ images: [PendingImage]) {
        let room = ImagePrep.maxCount - pendingImages.count
        guard room > 0 else {
            flash("一次最多带 \(ImagePrep.maxCount) 张图")
            return
        }
        if images.count > room { flash("一次最多带 \(ImagePrep.maxCount) 张图") }
        pendingImages.append(contentsOf: images.prefix(room))
    }

    func removePendingImage(_ id: UUID) {
        pendingImages.removeAll { $0.id == id }
    }

    func toggleConfirmWrites() {
        patch(activeId) { chat in
            var next = chat
            next.confirmWrites.toggle()
            return next
        }
    }

    func togglePolicy() {
        let next = (active?.policy == "plane") ? "baseline" : "plane"
        patch(activeId) { chat in
            var copy = chat
            copy.policy = next
            return copy
        }
        send(.setPolicy(policy: next, chatId: activeId))
    }

    func attachFiles(_ urls: [URL]) {
        // 对齐网页端 MAX_UPLOAD_FILES = 10
        if urls.count > 10 { flash("一次最多传 10 个文件") }
        for url in urls.prefix(10) {
            let item = UploadItem(id: UUID().uuidString.lowercased(), name: url.lastPathComponent)
            uploads.append(item)
            Task { await uploadAttachment(item: item, source: url) }
        }
    }

    private func uploadAttachment(item: UploadItem, source: URL) async {
        let chatId = activeId
        let tenantAtStart = tenantId
        do {
            // 重 I/O（安全作用域 + 复制 iCloud 文件）放后台线程，避免卡主 actor
            let (temp, size) = try await Task.detached(priority: .userInitiated) { () throws -> (URL, Int) in
                let scoped = source.startAccessingSecurityScopedResource()
                defer { if scoped { source.stopAccessingSecurityScopedResource() } }
                let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size > 0 else { throw UploadError.empty }
                guard size <= maxUploadBytes else { throw UploadError.tooLarge }
                // 复制到临时文件，避免上传期间源文件（iCloud/安全作用域）失效
                let temp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("jiebo-upload-\(item.id)-\(source.lastPathComponent)")
                try? FileManager.default.removeItem(at: temp)
                try FileManager.default.copyItem(at: source, to: temp)
                return (temp, size)
            }.value
            defer { try? FileManager.default.removeItem(at: temp) }

            let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            var path: String?
            var httpError: Error?
            if !token.isEmpty {
                do {
                    path = try await Uploader.upload(chatId: chatId, name: item.name, file: temp, token: token).path
                } catch {
                    httpError = error
                }
            }
            if path == nil {
                // WS 兜底：≤8MB 才走（实测 >32MB 的 WS 帧会被传输层直接掐断）
                guard client.isOpen else { throw httpError ?? UploadError.notConnected }
                guard size <= 8 * 1024 * 1024 else { throw httpError ?? UploadError.tooLarge }
                // base64 编码也放后台（8MB → ~11MB 字符串）
                let data = try await Task.detached(priority: .userInitiated) {
                    try Data(contentsOf: temp, options: .mappedIfSafe)
                }.value
                do {
                    path = try await uploadViaGateway(chatId: chatId, name: item.name, data: data)
                } catch {
                    // 两条路都失败时优先展示更具体的 HTTP 错误（如 401），而非 WS 超时
                    throw httpError ?? error
                }
            }
            guard let path else { throw UploadError.badResponse }
            uploads.removeAll { $0.id == item.id }
            // 上传期间切了租户：静默丢弃，不写草稿不弹提示
            guard tenantId == tenantAtStart else { return }
            appendMention(path, to: chatId)
            flash("已上传 \(item.name)")
        } catch {
            uploads.removeAll { $0.id == item.id }
            guard tenantId == tenantAtStart else { return }
            bannerError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// WS 兜底通道：upload_file + 按 id 配对 file_uploaded，90s 超时
    private func uploadViaGateway(chatId: String, name: String, data: Data) async throws -> String {
        let id = UUID().uuidString.lowercased()
        return try await withCheckedThrowingContinuation { continuation in
            pendingUploads[id] = continuation
            client.send(.uploadFile(chatId: chatId, name: name, data: data.base64EncodedString(), mimeType: nil, id: id))
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(90))
                guard let self, let pending = self.pendingUploads.removeValue(forKey: id) else { return }
                // 记住超时 id：迟到的 file_uploaded 回包不再当「别的客户端上传」写草稿
                self.expiredUploadIds.insert(id)
                if self.expiredUploadIds.count > 50 { self.expiredUploadIds = Set(self.expiredUploadIds.suffix(25)) }
                pending.resume(throwing: UploadError.timeout)
            }
        }
    }

    /// 剥掉文本尾部进行中的 @查询（保留前面的空白分隔），文件清单点选时防残留
    private func stripTrailingQuery(_ text: String) -> String {
        guard let range = text.range(of: #"(^|\s)@(\S*)$"#, options: .regularExpression) else { return text }
        let leading = text[range.lowerBound...].first.map { $0 == " " || $0 == "\n" ? String($0) : "" } ?? ""
        var out = text
        out.replaceSubrange(range, with: leading)
        return out
    }

    private func appendMention(_ path: String, to chatId: String) {
        let mention = "@\(path)"
        if chatId == activeId {
            guard !draft.contains(mention) else { return } // 对齐网页端去重
            let base = stripTrailingQuery(draft)
            let needsSpace = !base.isEmpty && !base.hasSuffix(" ") && !base.hasSuffix("\n")
            saveDraft(base + (needsSpace ? " " : "") + mention + " ")
        } else {
            patch(chatId) { chat in
                guard !chat.draft.contains(mention) else { return chat }
                var next = chat
                let base = stripTrailingQuery(next.draft)
                let needsSpace = !base.isEmpty && !base.hasSuffix(" ") && !base.hasSuffix("\n")
                next.draft = base + (needsSpace ? " " : "") + mention + " "
                return next
            }
        }
    }

    private func wireClient() {
        client.onOpen = { [weak self] in
            guard let self else { return }
            self.connected = true
            if self.authError.hasPrefix("还没连上") { self.authError = "" }
            // tokenDraft 是当前凭据（login 写入）；Keychain 只是持久化兜底
            var token = self.tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty { token = KeychainStore.token() ?? "" }
            if !token.isEmpty {
                if !self.unlocked { self.verifying = true }
                self.armVerifyTimeout()
                self.client.send(.hello(token: token))
            }
        }
        client.onDrop = { [weak self] reason in
            self?.bannerError = reason
        }
        client.onClose = { [weak self] in
            guard let self else { return }
            self.connected = false
            // P4：断线时在途的 sync_chat 永远等不到 ack——倒回脏集合，重连后随 diff/重推恢复
            if !self.inflightChatIds.isEmpty {
                self.dirtyChatIds.formUnion(self.inflightChatIds)
                self.inflightChatIds = []
            }
            // P8 slim：在途分页随断线丢失，loadingChatIds 不清会永久卡死加载（Grok 评审 M1）。
            // 重启分页必须剥掉已 prepend 的页前缀（保留本地新发后缀）：留着半截从末页重拉，
            // 服务端新增尾部会被去重逻辑当 fresh 插到数组头，顺序错乱
            if !self.loadingChatIds.isEmpty {
                for id in self.loadingChatIds {
                    guard let index = self.chats.firstIndex(where: { $0.id == id }) else { continue }
                    let pageCount = self.loadedPageTurnCounts[id] ?? 0
                    if pageCount > 0, pageCount <= self.chats[index].turns.count {
                        self.chats[index].turns = Array(self.chats[index].turns.dropFirst(pageCount))
                    } else if pageCount > self.chats[index].turns.count {
                        self.chats[index].turns = []
                    }
                }
                self.loadingChatIds = []
                self.loadedPageTurnCounts = [:]
            }
            if !self.unlocked {
                self.verifying = false
            } else {
                self.flash("正在重连服务器…")
            }
        }
        client.onMessage = { [weak self] message in
            self?.handle(message)
        }
    }

    private func handle(_ message: ServerMessage) {
        let chatId = message.chatId?.nilIfEmpty ?? activeId
        switch message {
        case .textDelta, .thinkingDelta, .toolStarted, .toolCompleted, .toolOutput, .task:
            markProgress(chatId)
        case .status(_, let status, _) where status == "RUNNING" || status == "CREATING":
            markProgress(chatId)
        case .done, .error:
            stallTask?.cancel()
        default:
            break
        }
        if chatId != activeId {
            switch message {
            case .textDelta, .thinkingDelta, .toolStarted, .done, .error, .approval:
                patch(chatId) { chat in
                    guard !chat.unread else { return chat }
                    var next = chat
                    next.unread = true
                    return next
                }
            default:
                break
            }
        }

        switch message {
        case .ready(let nextCwd, let hasKey, let serverModel, let serverModels, _, let running, let queued, let root, let readyTenantId, let readyTenantName, let admin, let readyLoops):
            if let nextTenant = readyTenantId?.nilIfEmpty {
                if !tenantId.isEmpty, tenantId != nextTenant {
                    resetTenantSession()
                }
                if tenantId != nextTenant {
                    tenantId = nextTenant
                    UserDefaults.standard.set(nextTenant, forKey: tenantKey)
                }
            }
            isAdmin = admin // P9：管理员才显示统计入口（须在 resetTenantSession 之后，否则被其清回 false）
            if let name = readyTenantName?.nilIfEmpty {
                tenantName = name
            }
            let reconnected = unlocked
            unlocked = true
            verifying = false
            verifyTask?.cancel()
            authError = ""
            if reconnected { flash("已重新连上服务器") }
            let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            if !token.isEmpty, KeychainStore.token() != token { KeychainStore.save(token) }
            hasApiKey = hasKey
            workspaceRoot = root ?? workspaceRoot.nilIfEmpty ?? nextCwd
            let current = chats.first { $0.id == activeId }
            cwd = current?.cwd ?? nextCwd
            models = serverModels.isEmpty ? [serverModel.nilIfEmpty ?? ModelCatalog.defaultModel] : serverModels
            runningChatIds = running
            queuedChatIds = queued
            loops = Dictionary(readyLoops.filter { $0.status != "stopped" && $0.status != "idle" }.map { ($0.chatId, $0) }, uniquingKeysWith: { _, new in new })
            let nextModel = ModelCatalog.resolve(
                preferred: current?.sessionModel ?? lastModel.nilIfEmpty ?? model,
                ids: models,
                fallback: serverModel
            )
            model = nextModel
            rememberModel(nextModel)
            markLive(running: running, queued: queued)
            if let current, current.id != "boot", current.model != nextModel {
                patch(current.id) { chat in
                    var next = chat
                    next.model = nextModel
                    return next
                }
                send(.setModel(model: nextModel, chatId: current.id))
            }
            client.flushOutbox()
            send(.listWorkspaces)
            requestFileIndex()
        case .auth(let ok, let messageText):
            if !ok {
                unlocked = false
                verifying = false
                verifyTask?.cancel()
                authError = messageText ?? "密码不对。"
                KeychainStore.delete()
            }
        case .adminStats(let rows, _):
            adminStats = rows
            adminStatsAt = Date()
        case .loopState(let chatId, let status, let goal, let intervalSec, let tick, let maxTicks, let lastSummary, let nextAt):
            guard !chatId.isEmpty else { break }
            loops[chatId] = LoopSnapshot(
                chatId: chatId,
                status: status,
                goal: goal,
                intervalSec: intervalSec,
                tick: tick,
                maxTicks: maxTicks,
                lastSummary: lastSummary,
                nextAt: nextAt
            )
        case .loopTick(let chatId, let tick, let status, let summary):
            guard var row = loops[chatId] else { break }
            row.tick = tick
            row.lastSummary = summary
            if status == "stopped" { row.status = "stopped" }
            loops[chatId] = row
        case .storedState(let rows, let rev, let deleted, let serverRevs):
            applyStoredState(rows: rows, rev: rev, deleted: deleted, chatRevs: serverRevs)
        case .storedStateDeferred(let rev):
            // stored_state 太大（超 maxMessageBytes）走 HTTP /state；rev 不新就跳过。
            // 但 digest 在途时（load_chats 单条超限的回落）digest 已抬过 rev，不能被短路挡住
            if pendingChatLoads.isEmpty, let rev, appliedStore, rev <= stateRev { break }
            // Kimi 评审 M2：digest 判出的变更会话单条超接收上限——HTTP 回落拿的是 slim 壳
            // （且 rev 已被 digest 收敛，applyStoredState 会早退整帧丢弃），壳合并保留本地
            // 旧 turns 会造成永久 stale。直接把待拉会话降级为壳：内容改走 load_chat 分页补齐
            // （分页有字节双上限，超大会话也能载），HTTP 全量只负责刷新元数据/chatRevs
            for id in pendingChatLoads {
                guard !hasLocalPriority(id), // 本地脏/有未回推新 turn 的本地优先，等回推
                      let index = chats.firstIndex(where: { $0.id == id }) else { continue }
                chats[index].turns = []
                chats[index].turnsComplete = false
                dropChatState(id) // 在途分页作废（旧内容的页），迟到页由 .chatTurns 校验丢弃
            }
            pendingChatLoads = []
            digestTimeoutTask?.cancel()
            scheduleStateFetch()
            ensureTurnsLoaded(activeId) // active 被降级就立即重启分页
        case .syncAck(let rev, let ackRevs):
            // P4b 回执：确认服务端收下了这些会话
            serverSupportsP4 = true
            for (id, chatRev) in ackRevs {
                chatRevs[id] = chatRev
                inflightChatIds.remove(id)
            }
            if let rev, rev > stateRev { stateRev = rev }
            if !dirtyChatIds.isEmpty { scheduleSync() } // ack 期间又改了的继续推
        case .storedDigest(let rev, let deleted, let serverRevs):
            serverSupportsP4 = true
            applyStoredDigest(rev: rev, deleted: deleted, serverRevs: serverRevs)
        case .storedChat(let value, let rev):
            serverSupportsP4 = true
            if let id = value.object?["id"]?.string { pendingChatLoads.remove(id) } // 解析失败也别白等安全网
            guard let remote = ChatSession.from(value), !deletedIds.contains(remote.id) else { break }
            pendingChatLoads.remove(remote.id)
            if let rev { chatRevs[remote.id] = rev }
            // 本地优先（脏/有未回推新 turn）的会话不应用服务器版，稍后重推
            if !hasLocalPriority(remote.id) {
                if let index = chats.firstIndex(where: { $0.id == remote.id }) {
                    var mergedChat = remote
                    mergedChat.draft = chats[index].draft.isEmpty ? remote.draft : chats[index].draft
                    // P8 slim：元数据壳（无 turns 键）不得清空已加载正文——只更新元数据；
                    // 全量到达则取消在途分页（迟到页由 loadingChatIds 校验丢弃）
                    if !remote.turnsComplete {
                        mergedChat.turns = chats[index].turns
                        mergedChat.turnsComplete = chats[index].turnsComplete
                    } else {
                        dropChatState(remote.id) // 全量到达取消在途分页 + 清暂存（迟到页由校验丢弃）
                    }
                    chats[index] = mergedChat
                } else {
                    chats.append(remote)
                }
                if remote.id == activeId {
                    applySession(chats.first { $0.id == remote.id } ?? remote)
                    ensureTurnsLoaded(remote.id)
                }
            }
            if pendingChatLoads.isEmpty { scheduleSync() } // 对账完毕，把本地脏的推上去
        case .workspaces(_, let items):
            workspaces = items
            if workspaceRoot.isEmpty, let first = items.first { workspaceRoot = first.path }
        case .workspaceCreated(let path, let name):
            if !workspaces.contains(where: { $0.path == path }) {
                workspaces.insert(WorkspaceItem(path: path, name: name), at: 0)
            }
            startChat(in: path)
        case .session(let id, let agentId, let sessionCwd):
            let target = id.nilIfEmpty ?? activeId
            patch(target) { chat in
                var next = chat
                if !sessionCwd.isEmpty { next.cwd = sessionCwd }
                // agentId 空串也要落（对齐网页 agentId || undefined）：gateway 在换工作区/新会话/
                // 宽容化 resume 时会回空 agentId，表示「旧 agent 已回收」——不清掉就会拿着陈旧的
                // agentId 反复 resume 失败（旧网关：「不能恢复别人的会话」）
                next.agentId = agentId.nilIfEmpty
                return next
            }
            if target == activeId, !sessionCwd.isEmpty { cwd = sessionCwd }
        case .runMeta(let id, let runModel, let runMode):
            patchRunning(id) { turn in
                var next = turn
                if !runModel.isEmpty { next.model = runModel }
                if let runMode { next.mode = runMode }
                return next
            }
        case .textDelta(let id, let text):
            patchRunning(id) { turn in
                var next = turn
                next.assistant += text
                return next
            }
        case .thinkingDelta(let id, let text):
            patchRunning(id) { turn in
                var next = turn
                next.thinking += text
                return next
            }
            showThinkingIds.insert(id)
        case .toolStarted(let id, let callId, let name, let args, let parent, let agent, let toolModel):
            patchRunning(id) { turn in
                var next = turn
                next.tools.removeAll { $0.callId == callId }
                next.tools.append(ToolCall(callId: callId, name: name, args: args, result: nil, status: "running", parentCallId: parent, agent: agent, model: toolModel))
                return next
            }
            // P5b：工具一启动就把路径累计进待看清单（不发 read_file、不开页签），
            // 让用户在慢工具执行中也能看到「有文件正在被改」（对齐网页 tool-started peek 的意图）
            if id == activeId, ToolKind.from(name: name, args: args).isMutating,
               active?.confirmWrites != true,
               let rawPath = Self.toolPath(args: args, result: nil)
            {
                let path = relToCwd(rawPath)
                // 正在看这个文件的 diff 就不计；重复编辑挪尾部
                if !path.isEmpty, !(previewPanelOpen && previewActivePath == path) {
                    pendingDiffPaths.removeAll { $0 == path }
                    pendingDiffPaths.append(path)
                }
            }
        case .toolCompleted(let id, let callId, let name, let status, let result, let parent, let agent, let toolModel):
            var toolArgs: JSONValue?
            patchOpen(id) { turn in
                var next = turn
                let existing = next.tools.first { $0.callId == callId }
                if existing?.status == "error", status == "completed" { return turn }
                toolArgs = existing?.args
                next.tools.removeAll { $0.callId == callId }
                next.tools.append(ToolCall(
                    callId: callId,
                    name: name,
                    args: existing?.args,
                    result: result,
                    status: status,
                    parentCallId: existing?.parentCallId ?? parent,
                    agent: existing?.agent ?? agent,
                    model: existing?.model ?? toolModel
                ))
                return next
            }
            // P5b：mutating 工具完成后静默准备 diff 页签（对齐网页的自动开 diff，但适配 overlay 形态：
            // 面板已开才抢焦点，否则只累计 pendingDiffs 由用户点 pill 进入）。
            // 对齐网页：confirmWrites 门槛只在 tool-started（批准后改动已落盘，完成后仍应能看 diff）
            if id == activeId, status == "completed",
               ToolKind.from(name: name, args: toolArgs).isMutating
            {
                // P7：mutating 工具完成后重拉文件索引——git 徽章/文件树不 stale。
                // 新 gateway 在 mutating tool 完成时已 pushWorkspace 主动推 files，这里是兜底旧网关
                //（对齐网页 tool-completed 后重发 list_files；此前只在 select/ready/undone 拉取）
                requestFileIndex()
                if let rawPath = Self.toolPath(args: toolArgs, result: result) {
                    trackEditedFile(rawPath)
                }
            }
        case .toolOutput(let id, let callId, let stream, let chunk, let stdout, let stderr):
            patchRunning(id) { turn in
                var next = turn
                if let index = next.tools.firstIndex(where: { $0.callId == callId }) {
                    next.tools[index].result = mergeOutput(next.tools[index].result, stream: stream, chunk: chunk, stdout: stdout, stderr: stderr)
                } else {
                    next.tools.append(ToolCall(
                        callId: callId,
                        name: "shell",
                        args: nil,
                        result: mergeOutput(nil, stream: stream, chunk: chunk, stdout: stdout, stderr: stderr),
                        status: "running",
                        parentCallId: nil,
                        agent: nil,
                        model: nil
                    ))
                }
                return next
            }
        case .task(let id, let text):
            patchRunning(id) { turn in
                var next = turn
                next.task = text
                return next
            }
        case .approval(let id, let callId, let name, let args):
            patchRunning(id) { turn in
                var next = turn
                next.pendingTool = PendingTool(callId: callId, name: name, args: args)
                return next
            }
        case .status(let id, let status, let text):
            if let text, !text.isEmpty { flash(text) }
            if status == "RUNNING" || status == "CREATING" {
                let target = id ?? activeId
                // slim 会话没有 turns 可标 running——运行点靠 runningChatIds 驱动，必须回填
                if !runningChatIds.contains(target) { runningChatIds.append(target) }
                patch(target) { chat in
                    guard let index = chat.turns.lastIndex(where: { !$0.user.isEmpty || $0.running }) else { return chat }
                    var next = chat
                    if !next.turns[index].running {
                        next.turns[index].running = true
                        next.turns[index].queued = false
                        next.turns[index].status = status
                    }
                    return next
                }
            } else if status == "FINISHED" || status == "ERROR" || status == "CANCELLED" || status == "EXPIRED" {
                let target = id ?? activeId
                runningChatIds.removeAll { $0 == target }
                queuedChatIds.removeAll { $0 == target }
                let settled = (status == "ERROR" || status == "EXPIRED") ? "error" : (status == "CANCELLED" ? "cancelled" : "finished")
                patchOpen(target) { $0.settled(status: settled) }
            }
        case .error(let id, let text):
            bannerError = friendlyError(text)
            if toolLayer == .loop, text.contains("Loop") {
                loopError = friendlyError(text)
            }
            let target = id ?? activeId
            runningChatIds.removeAll { $0 == target }
            queuedChatIds.removeAll { $0 == target }
            patchOpen(target) { turn in
                var next = turn.settled(status: "error")
                next.error = text
                return next
            }
        case .done(let id, let status, let duration):
            runningChatIds.removeAll { $0 == id }
            queuedChatIds.removeAll { $0 == id }
            patchOpen(id) { turn in
                turn.settled(status: status, durationMs: duration)
            }
            scheduleSync()
        case .history(let id, let rows):
            let incoming = rows.compactMap(Turn.from)
            guard !incoming.isEmpty else { break }
            // P8 slim：turns 未加载完时，history（fresh UUID）与 load_chat 页（持久 id）
            // id 空间不同，直接合并会重复/覆盖——暂存，加载完成后按老规则应用
            if let chat = chats.first(where: { $0.id == id }), !chat.turnsComplete {
                pendingHistory[id] = incoming
                break
            }
            applyHistory(chatId: id, incoming: incoming)
        case .chatTurns(let chatId, let rows, let from, let hasMore, let nonce):
            // 代际校验必须在成员资格之前（Kimi R2 M1）：deferred 降级/断线重启后旧链迟到页
            // 与重注册的新链都能过成员资格守卫；nonce 不匹配即旧代际，丢弃且不动当前加载状态。
            // 无 nonce（不回显的旧实现）按兼容放行——旧网关本就不支持 load_chat，不会到此
            if let nonce, nonce != loadEpochs[chatId] ?? 0 { break }
            // 在途校验：会话已删 / 全量 stored_chat 已取消加载 → 丢弃迟到页
            guard loadingChatIds.contains(chatId),
                  let index = chats.firstIndex(where: { $0.id == chatId }),
                  !deletedIds.contains(chatId) else {
                loadingChatIds.remove(chatId)
                break
            }
            // 页合并直接改 chats[index]，不走 patch()——加载不是本地编辑，不能误标脏触发回推。
            // 已知限制（Kimi 评审 MINOR4）：from 是位置游标，假设服务端 turns append-only——
            // 分页中途他端增删会索引漂移（去重防重不防漏）；漂移靠 digest→stored_chat 全量
            // 替换（或 deferred 降级重载）自愈，不在这里做复杂对账
            let page = rows.compactMap(Turn.from)
            let existing = Set(chats[index].turns.map(\.id))
            let fresh = page.filter { !existing.contains($0.id) }
            chats[index].turns = fresh + chats[index].turns
            loadedPageTurnCounts[chatId] = (loadedPageTurnCounts[chatId] ?? 0) + fresh.count
            if hasMore {
                send(.loadChat(chatId: chatId, from: from, nonce: loadEpochs[chatId])) // 继续向前翻 turns[..<from]
            } else {
                chats[index].turnsComplete = true
                loadingChatIds.remove(chatId)
                loadedPageTurnCounts[chatId] = nil
                chats[index].serverPreview = nil // 正文齐了，侧栏预览回到本地计算（GLM 评审 m4）
                // 加载期间发过消息：当时的 sync 无 turns 键、dirty 已被清——现在 turns 齐了，
                // 必须补一次全量回推，否则本地新 turn 永不落盘（Grok 评审 M2）
                if localTurnsPendingSync.remove(chatId) != nil {
                    dirtyChatIds.insert(chatId)
                    scheduleSync()
                }
                if let pending = pendingHistory.removeValue(forKey: chatId), !pending.isEmpty {
                    applyHistory(chatId: chatId, incoming: pending)
                }
            }
        case .chatTitle(let id, let title):
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { break }
            patch(id) { chat in
                guard chat.isUntitled else { return chat }
                var next = chat
                next.title = trimmed
                return next
            }
        case .fileWritten(let path, let writtenChatId, let error):
            if let writtenChatId, !writtenChatId.isEmpty,
               writtenChatId != activeId, writtenChatId != contentChatId { break }
            let written = relToCwd(path)
            guard let index = contentSaves.firstIndex(where: { $0.path == path || $0.path == written }) else { break }
            let save = contentSaves.remove(at: index)
            guard contentPath == save.path else { break }
            if let error {
                flash(error)
            } else {
                contentOriginal = save.snapshot
                contentError = nil
                flash(contentDraft == save.snapshot ? "已保存" : "已保存。之后的修改还没写入")
            }
        case .fileUploaded(let path, let chatId, let name, let error, _, let id):
            // 超时后迟到的回包：丢弃（用户已看到失败提示，草稿不应再被污染）
            if let id, expiredUploadIds.remove(id) != nil { break }
            if let id, let pending = pendingUploads.removeValue(forKey: id) {
                if let error {
                    pending.resume(throwing: UploadError.http(0, error))
                } else {
                    pending.resume(returning: path)
                }
                break
            }
            // 别的客户端上传的：把 @path 补进对应会话草稿（对齐网页端）
            if let error {
                // 仅当能归属到现存会话时才显示（防切租户后晚到的错误条写进新会话）
                if let cid = chatId?.nilIfEmpty, chats.contains(where: { $0.id == cid }) {
                    bannerError = error
                }
            } else if !path.isEmpty {
                let targetId = chatId?.nilIfEmpty ?? activeId
                // 目标会话必须存在（防切租户后晚到的回包写进新会话）
                if chats.contains(where: { $0.id == targetId }) {
                    appendMention(path, to: targetId)
                    flash("已上传 \(name ?? path)")
                }
            }
        case .fileContent(let path, let msgChatId, let content, let error, let diff, let kind, let mime, let size, let url, let headUrl, let media):
            let forActive = msgChatId?.isEmpty != false || msgChatId == activeId
            let forContent = msgChatId == contentChatId && contentChatId != nil
            if !forActive, !forContent { break }
            if forContent || forActive, contentPath == path, diff, contentDiff {
                contentLoading = false
                if let error {
                    contentError = error
                } else if let content {
                    contentOversized = false
                    contentKind = .text
                    contentOriginal = content
                    contentDraft = content
                } else if kind == "image" || kind == "svg" || contentKind == .image || contentKind == .svg {
                    contentLoading = false
                    contentError = nil
                } else {
                    contentError = "读不到这次改动"
                }
            } else if forContent || forActive, contentPath == path, !diff, (contentKind == .text || contentKind == .markdown) {
                if let error {
                    contentLoading = false
                    contentError = error
                } else if let content {
                    acceptContentText(content)
                } else if let url, !url.isEmpty {
                    contentLoadEpoch += 1
                    hydrateContentText(path: path, urlString: url, epoch: contentLoadEpoch)
                } else {
                    contentLoading = false
                    contentError = "读不到这个文件"
                }
            }
            guard forActive, let index = previewTabs.firstIndex(where: { $0.path == path }) else { break }
            var tab = previewTabs[index]
            tab.loading = false
            if let error {
                if tab.diff && error == "没有未提交的改动" {
                    // 对齐网页：diff 没内容时自动回落全文重拉；清掉旧 diff 文本避免回落期以代码视图闪渲染
                    tab.diff = false
                    tab.content = nil
                    tab.error = nil
                    tab.loading = true
                    previewTabs[index] = tab
                    send(.readFile(path: path, chatId: activeId, diff: false))
                    armPreviewWatchdog(path: path)
                    break
                }
                // 对齐网页：「读不了/不是文件/不在工作区」改写为友好文案 + notice
                if error.contains("读不了") || error.contains("不是文件") || error.contains("不在工作区") {
                    if tab.content == nil { tab.error = "文件已不在当前工作区，换工作区后再打开，或关掉这个预览。" }
                    flash("\(path) 已不在工作区")
                } else if tab.content == nil {
                    tab.error = error // 已有内容时静默保留旧内容（对齐网页）
                }
            } else {
                tab.error = nil
                if let kind, let parsed = PreviewKind(rawValue: kind) { tab.kind = parsed }
                tab.diff = diff
                tab.url = url
                tab.headUrl = headUrl
                tab.media = media
                tab.mime = mime
                tab.size = size
                tab.chatId = msgChatId ?? activeId // 票据签发会话（签名绑 chatId，视图拼 mediaSrc 要用它）
                if let content { tab.content = content }
            }
            previewTabs[index] = tab
            // 大文本（markdown/html/canvas 超限时）可能只回 url 不回 content：走 HTTP 票据水合；
            // diff 页签不水合；媒体类（needsMediaURL）由媒体视图直接加载 URL，不能当文本拉
            if tab.error == nil && !tab.diff && tab.content == nil && tab.mediaURL != nil && !tab.kind.needsMediaURL {
                hydratePreviewText(path: tab.path)
            }
        case .files(let query, let paths, let mention, let truncated, let filesChatId, let status):
            // 只接收当前会话的（对齐网页端 chatId 过滤）
            if let filesChatId, !filesChatId.isEmpty, filesChatId != activeId { break }
            if mention {
                // 过期查询的结果直接丢（对齐网页端 query 比对）
                guard query == mentionQuery else { break }
                // 合并本地索引与服务端结果（对齐网页 mentionHits 的 remote 合并；
                // 本地索引被截断时服务端结果可能是唯一来源）
                var seen = Set<String>()
                var merged: [String] = []
                for path in paths + fileIndex where seen.insert(path).inserted {
                    merged.append(path)
                }
                mentionSuggestions = ChatStore.rankMentions(merged, query: query)
            } else {
                fileIndex = paths
                treeTruncated = truncated
                if query.isEmpty { gitStatus = status }
            }
        case .searchHits(let query, let hits, let hitsChatId):
            if let hitsChatId, !hitsChatId.isEmpty, hitsChatId != activeId { break }
            let current = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            guard query.trimmingCharacters(in: .whitespacesAndNewlines) == current else { break }
            searchHits = hits
            searchLoading = false
        case .undone(_, let paths, let error):
            // 只反馈当前会话的 undo（chatId 已在 handle 入口解析为 activeId 兜底）
            guard chatId == activeId else { break }
            if let error {
                notice = error
            } else {
                notice = paths.isEmpty ? "没有可还原的改动" : "已还原 \(paths.joined(separator: ", "))"
                if let path = contentPath, paths.contains(where: { relToCwd($0) == path || $0 == path }) {
                    let was = suppressContentDiscard
                    suppressContentDiscard = true
                    closeContentLayer()
                    suppressContentDiscard = was
                }
            }
            requestFileIndex()
        case .pong, .ignored:
            break
        }
    }

    func toolSelected(_ layer: ToolLayer) -> Bool {
        switch layer {
        case .files: return fileBrowserOpen && fileBrowserPane == .files
        case .search: return fileBrowserOpen && fileBrowserPane == .search
        case .git: return fileBrowserOpen && fileBrowserPane == .git
        default: return toolLayer == layer
        }
    }

    func toggleTool(_ layer: ToolLayer) {
        if let pane = FileBrowserPane(layer) {
            toggleFileBrowser(pane)
            return
        }
        if contentDirty, !suppressContentDiscard {
            contentDiscardFollowup = toolLayer == layer ? .closeTool : .switchTool(layer)
            contentDiscardPrompt = true
            return
        }
        if toolLayer == .loop, layer != .loop { loopError = "" }
        if toolLayer == layer {
            toolLayer = nil
            closeContentLayer()
            if layer == .loop { loopError = "" }
            return
        }
        closeContentLayer()
        toolLayer = layer
    }

    /// 文件、搜索、改动都进同一张全屏浮层，左栏切换筛选。
    func toggleFileBrowser(_ pane: FileBrowserPane = .files) {
        if fileBrowserOpen, fileBrowserPane == pane {
            fileBrowserOpen = false
            return
        }
        let browserLayer = toolLayer == .files || toolLayer == .search || toolLayer == .git
        if browserLayer, contentDirty, !suppressContentDiscard {
            fileBrowserPane = pane
            contentDiscardFollowup = .openFileBrowser
            contentDiscardPrompt = true
            return
        }
        if browserLayer {
            let was = suppressContentDiscard
            suppressContentDiscard = true
            closeContentLayer()
            suppressContentDiscard = was
            toolLayer = nil
        }
        fileBrowserPane = pane
        fileBrowserOpen = true
        requestFileIndex()
    }

    /// 文件名走本地索引，内容走 search_text。空查询不发请求。
    func scheduleSearch() {
        searchTask?.cancel()
        searchEpoch += 1
        let epoch = searchEpoch
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty {
            searchHits = []
            searchLoading = false
            return
        }
        searchLoading = true
        searchHits = []
        let chatId = activeId
        searchTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, searchEpoch == epoch else { return }
            send(.searchText(query: query, chatId: chatId))
        }
    }

    /// 文件树点开：文本和 Markdown 可编辑，图片 / HTML / Canvas 等只读，二进制走 Quick Look。
    /// 换文件替换内容层，不另开右侧预览。
    func openContentFile(_ rawPath: String) {
        let path = relToCwd(rawPath.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !path.isEmpty, !path.hasSuffix("/"), path.lowercased() != "diff" else { return }
        let kind = previewKind(of: path)
        if !kind.panelRenderable {
            openMention(path)
            return
        }
        if contentPath == path, contentError == nil, !contentDiff { return }
        if contentDirty, !suppressContentDiscard {
            contentDiscardFollowup = .openFile(path)
            contentDiscardPrompt = true
            return
        }
        if contentPath == nil {
            contentRestorePreview = previewPanelOpen ? previewActivePath : nil
        }
        if contentPath != path { contentSaves.removeAll() }
        contentLoadEpoch += 1
        let epoch = contentLoadEpoch
        contentChatId = activeId
        contentPath = path
        contentDiff = false
        contentKind = kind
        contentError = nil
        contentOversized = false
        contentOriginal = ""
        contentDraft = ""
        if kind == .text || kind == .markdown {
            contentLoading = true
            send(.readFile(path: path, chatId: contentChatId, diff: false))
            armContentWatchdog(path: path, epoch: epoch)
        } else {
            contentLoading = false
            openPreviewTab(path: path, kind: kind, diff: false)
            previewActivePath = contentRestorePreview
        }
    }

    /// Git 列表点开：diff 叠在工具层上。图片走预览页签，其余把 diff 文本放进内容层。
    func openContentDiff(_ rawPath: String) {
        let path = relToCwd(rawPath.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !path.isEmpty, !path.hasSuffix("/") else { return }
        if contentPath == path, contentDiff, contentError == nil { return }
        if contentDirty, !suppressContentDiscard {
            contentDiscardFollowup = .openDiff(path)
            contentDiscardPrompt = true
            return
        }
        if contentPath == nil {
            contentRestorePreview = previewPanelOpen ? previewActivePath : nil
        }
        if contentPath != path { contentSaves.removeAll() }
        contentLoadEpoch += 1
        let epoch = contentLoadEpoch
        let kind = previewKind(of: path)
        contentChatId = activeId
        contentPath = path
        contentDiff = true
        contentKind = kind
        contentError = nil
        contentOversized = false
        contentOriginal = ""
        contentDraft = ""
        if kind == .image || kind == .svg {
            contentLoading = false
            openPreviewTab(path: path, kind: kind, diff: true)
            previewActivePath = contentRestorePreview
        } else {
            contentLoading = true
            send(.readFile(path: path, chatId: contentChatId, diff: true))
            armContentWatchdog(path: path, epoch: epoch)
        }
    }

    func keepContentDiff() {
        guard let path = contentPath, contentDiff else { return }
        contentDiff = false
        contentPath = nil
        openContentFile(path)
    }

    var contentRevertPrompt = false

    func revertContentFile() {
        guard let path = contentPath else { return }
        let chatId = contentChatId ?? activeId
        guard chats.contains(where: { $0.id == chatId }) else {
            flash("这个会话已经不在了，没法还原")
            return
        }
        send(.revertFile(chatId: chatId, path: path))
    }

    func closeContentLayer() {
        if contentDirty, !suppressContentDiscard {
            contentDiscardFollowup = .closeContent
            contentDiscardPrompt = true
            return
        }
        contentLoadEpoch += 1
        contentSaves.removeAll()
        contentChatId = nil
        contentPath = nil
        contentOriginal = ""
        contentDraft = ""
        contentLoading = false
        contentError = nil
        contentOversized = false
        contentDiff = false
    }

    func confirmContentDiscard() {
        let followup = contentDiscardFollowup
        contentDiscardPrompt = false
        contentDiscardFollowup = nil
        suppressContentDiscard = true
        switch followup {
        case .closeContent, nil:
            closeContentLayer()
        case .closeTool:
            toolLayer = nil
            loopError = ""
            closeContentLayer()
        case .switchTool(let layer):
            if let pane = FileBrowserPane(layer) {
                toolLayer = nil
                closeContentLayer()
                fileBrowserPane = pane
                fileBrowserOpen = true
                requestFileIndex()
                break
            }
            if toolLayer == .loop, layer != .loop { loopError = "" }
            closeContentLayer()
            toolLayer = layer
        case .openFileBrowser:
            toolLayer = nil
            closeContentLayer()
            fileBrowserOpen = true
            requestFileIndex()
        case .openFile(let path):
            openContentFile(path)
        case .openDiff(let path):
            openContentDiff(path)
        case .selectChat(let id):
            select(id)
        case .deleteChat(let id):
            deleteChat(id)
        }
        suppressContentDiscard = false
    }

    func cancelContentDiscard() {
        contentDiscardPrompt = false
        contentDiscardFollowup = nil
    }

    func saveContentLayer() {
        guard let path = contentPath, contentDirty, !contentOversized,
              (contentKind == .text || contentKind == .markdown) else { return }
        guard let chatId = contentChatId, chats.contains(where: { $0.id == chatId }) else {
            flash("这个会话已经不在了，没法保存")
            return
        }
        let snapshot = contentDraft
        if snapshot.utf16.count > Self.contentSaveLimit {
            flash("内容超过 500KB，不在这里保存")
            return
        }
        contentSaves.append((path: path, snapshot: snapshot))
        send(.writeFile(path: path, content: snapshot, chatId: chatId))
    }

    private func acceptContentText(_ text: String) {
        contentLoading = false
        contentError = nil
        let edited = contentDraft != contentOriginal
        if !edited, text.utf16.count > Self.contentSaveLimit {
            contentOversized = true
            contentOriginal = text
            contentDraft = text
            return
        }
        contentOversized = false
        contentOriginal = text
        if !edited { contentDraft = text }
    }

    private func hydrateContentText(path: String, urlString: String, epoch: Int) {
        guard let url = GatewayConfig.resolveHTTP(urlString) else {
            contentLoading = false
            contentError = "读不到这个文件"
            return
        }
        let tenantAtStart = tenantId
        Task { @MainActor [weak self] in
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 60
                let (data, response) = try await URLSession.shared.data(for: request)
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200 ..< 300).contains(code), let text = String(data: data, encoding: .utf8) else {
                    throw PreviewError.http(code)
                }
                guard let self, self.tenantId == tenantAtStart, self.contentLoadEpoch == epoch, self.contentPath == path else { return }
                self.acceptContentText(text)
            } catch {
                guard let self, self.tenantId == tenantAtStart, self.contentLoadEpoch == epoch, self.contentPath == path else { return }
                self.contentLoading = false
                self.contentError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func armContentWatchdog(path: String, epoch: Int) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self, self.contentLoadEpoch == epoch, self.contentPath == path, self.contentLoading else { return }
            self.contentLoading = false
            self.contentError = "读取超时。点重试再试一次。"
        }
    }

    func startActiveLoop(goal: String, intervalSec: Int, maxTicks: Int?) {
        let trimmed = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            loopError = "Loop 需要一段目标"
            return
        }
        if trimmed.count > 4000 {
            loopError = "Loop 目标超过 4000 字"
            return
        }
        if !(30...86_400).contains(intervalSec) {
            loopError = "间隔要在 30 秒到 24 小时之间"
            return
        }
        if let maxTicks, !(1...100).contains(maxTicks) {
            loopError = "最多 1 到 100 拍"
            return
        }
        loopError = ""
        send(.loopStart(
            chatId: activeId,
            goal: trimmed,
            intervalSec: intervalSec,
            maxTicks: maxTicks,
            model: model,
            mode: mode
        ))
    }

    func stopActiveLoop() {
        send(.loopStop(chatId: activeId))
    }

    private func send(_ message: ClientMessage) {
        if case .hello = message {
            client.send(message)
            return
        }
        guard unlocked else { return }
        client.send(message)
    }

    private func ensureActiveChat() {
        if chats.isEmpty {
            let chat = ChatSession.blank(cwd: cwd.nilIfEmpty ?? workspaceRoot, model: model, mode: mode)
            chats = [chat]
            swapActive(to: chat.id) // P9：统一入口——持久化 lastActive、置换草稿/待发图归属
            send(.newSession(chatId: chat.id, cwd: chat.cwd))
        }
    }

    private func persistDraft() {
        patch(activeId) { chat in
            var next = chat
            next.draft = self.draft
            next.model = self.model
            next.mode = self.mode
            next.cwd = chat.cwd ?? self.cwd
            return next
        }
    }

    /// agent 历史 backfill 应用（老规则：本地空直接整表替换；incoming 更多才替换）
    private func applyHistory(chatId id: String, incoming: [Turn]) {
        patch(id) { chat in
            var next = chat
            if next.turns.isEmpty {
                next.turns = incoming
            } else if incoming.count > next.turns.count {
                next.turns = incoming
            }
            return next
        }
    }

    private func applySession(_ chat: ChatSession?) {
        guard let chat else { return }
        draft = chat.draft
        mode = chat.mode
        if let sessionModel = chat.sessionModel {
            model = ModelCatalog.resolve(preferred: sessionModel, ids: models, fallback: model)
        }
        if let path = chat.cwd, !path.isEmpty {
            cwd = path
            send(.setWorkspace(cwd: path, chatId: chat.id, create: nil))
        }
        if let agentId = chat.agentId, !agentId.isEmpty {
            send(.resumeSession(chatId: chat.id, agentId: agentId))
        }
    }

    private func markLive(running: [String], queued: [String]) {
        let keep = Set(running + queued)
        let queuedSet = Set(queued)
        chats = chats.map { chat in
            var next = chat
            if !keep.contains(chat.id) {
                next.turns = next.turns.map { turn in
                    turn.running || turn.tools.contains(where: { $0.status == "running" })
                        ? turn.settled(status: turn.status ?? "cancelled")
                        : turn
                }
            }
            if queuedSet.contains(chat.id), !next.turns.contains(where: { $0.queued || $0.running }),
               let last = next.turns.lastIndex(where: { !$0.user.trimmingCharacters(in: .whitespaces).isEmpty })
            {
                next.turns[last].queued = true
            }
            return next
        }
    }

    /// 会话从列表消失（远端删除/全量替换取消分页）时清理其分页/暂存状态（Kimi 评审 MINOR5）
    private func dropChatState(_ id: String) {
        loadingChatIds.remove(id)
        loadedPageTurnCounts[id] = nil
        pendingHistory[id] = nil
        localTurnsPendingSync.remove(id)
    }

    /// 本地优先门闩：显式脏 + 加载期间发过消息（Grok R2 M1——后者 turns 未齐时 sync 不带正文，
    /// ack 会把显式脏清掉，但本地新 turn 必须等分页完成后全量回推；此期间远端全量/降级/拉取
    /// 都不得覆盖本地，否则新 turn 被抹且回推标记丢失）
    private func hasLocalPriority(_ id: String) -> Bool {
        dirtyChatIds.contains(id) || localTurnsPendingSync.contains(id)
    }

    private func merge(local: [ChatSession], remote: [ChatSession]) -> [ChatSession] {
        let localById = Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) })
        return remote.map { chat in
            guard let current = localById[chat.id] else { return chat }
            // P8 slim：远端是元数据壳（无 turns 键）→ 只合元数据，本地 turns/加载状态不动。
            // 不能走下方权重比较——壳的权重恒 0，本地有内容就永远本地胜出，会吞掉别端的元数据更新
            if !chat.turnsComplete {
                // 脏会话本地全赢（含改名类元数据编辑，否则被壳静默吞掉）；
                // 仅待回推（pendingSync）的壳走下方正常合并即可——它本就保本地 turns/加载状态，
                // 元数据跟远端走，完成回推时不会带旧元数据误覆盖
                if dirtyChatIds.contains(chat.id) { return current }
                var slim = chat
                slim.turns = current.turns
                slim.turnsComplete = current.turnsComplete
                slim.draft = current.draft.isEmpty ? chat.draft : current.draft
                slim.agentId = current.agentId ?? chat.agentId
                return slim
            }
            // 远端全量、本地是壳：直接采用远端（本地没有可保留的正文）。
            // 本地优先例外：脏/待回推新 turn 的壳被远端全量（含真空会话的 turns:[] 行）覆盖会
            // 丢本地内容且 localTurnsPendingSync 无释放路径（Kimi R2 MINOR1）
            if !current.turnsComplete {
                if hasLocalPriority(chat.id) { return current }
                var next = chat
                next.cwd = current.cwd ?? chat.cwd
                next.draft = current.draft.isEmpty ? chat.draft : current.draft
                next.agentId = current.agentId ?? chat.agentId
                return next
            }
            let localWeight = current.turns.reduce(0) { $0 + $1.user.count + $1.assistant.count }
            let remoteWeight = chat.turns.reduce(0) { $0 + $1.user.count + $1.assistant.count }
            if current.turns.contains(where: \.running) || localWeight > remoteWeight {
                var keep = current
                keep.agentId = current.agentId ?? chat.agentId
                keep.cwd = current.cwd ?? chat.cwd
                keep.draft = current.draft.isEmpty ? chat.draft : current.draft
                return keep
            }
            var next = chat
            next.cwd = current.cwd ?? chat.cwd
            next.draft = current.draft.isEmpty ? chat.draft : current.draft
            next.agentId = current.agentId ?? chat.agentId
            return next
        }
    }

    private func patch(_ id: String, _ update: (ChatSession) -> ChatSession) {
        guard let index = chats.firstIndex(where: { $0.id == id }) else { return }
        chats[index] = update(chats[index])
        if id != "boot" { dirtyChatIds.insert(id) } // P4b：增量上传只推脏会话
        scheduleSync()
    }

    private func patchRunning(_ id: String, _ update: (Turn) -> Turn) {
        patch(id) { chat in
            var next = chat
            if let index = next.turns.lastIndex(where: \.running) {
                next.turns[index] = update(next.turns[index])
            } else if let index = next.turns.indices.last,
                      // slim 壳分页期间不把 delta 挂到已加载的旧尾 turn——正常路径 delta 只回发起端
                      // （本端 send 前已 append running turn，走上面 if 分支），这是别端运行场景的防御（GLM 评审 M2）
                      next.turnsComplete,
                      !next.turns[index].user.isEmpty,
                      next.turns[index].status == nil || next.turns[index].queued || runningChatIds.contains(id) || queuedChatIds.contains(id) {
                var turn = next.turns[index]
                turn.running = true
                turn.queued = false
                turn.status = nil
                turn.error = nil
                next.turns[index] = update(turn)
            }
            return next
        }
    }

    private func patchOpen(_ id: String, _ update: (Turn) -> Turn) {
        patch(id) { chat in
            var next = chat
            if let index = next.turns.lastIndex(where: { $0.running || $0.tools.contains(where: { $0.status == "running" }) }) {
                next.turns[index] = update(next.turns[index])
            }
            return next
        }
    }

    private func markProgress(_ chatId: String) {
        lastProgress = Date()
        armStallWatch(chatId)
    }

    private func armStallWatch(_ chatId: String) {
        stallTask?.cancel()
        stallTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled else { return }
                let live = chats.first { $0.id == chatId }?.turns.contains(where: { $0.running || $0.tools.contains(where: { $0.status == "running" }) }) == true
                guard live else { return }
                if Date().timeIntervalSince(lastProgress) >= 90 {
                    notice = "这一轮没有新进展。如果一直转圈，点停止再发一次。"
                    return
                }
            }
        }
    }

    private func scheduleSync() {
        if chats.count == 1, chats[0].id == "boot" { return }
        let tenantAtSchedule = tenantId
        syncTask?.cancel()
        syncTask = Task {
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled, unlocked, tenantAtSchedule == tenantId else { return }
            if chats.count == 1, chats[0].id == "boot" { return }
            // digest 对账在途：先不推，等对账合并完（storedChat 收齐后这里会被再触发）
            guard pendingChatLoads.isEmpty else { return }
            // 旧网关没有 ack/digest，增量状态机跑不起来：退回全量 sync_state（老行为）。
            // 不动 dirty/inflight——dirty 保持非空，每次编辑都触发全量，与 P4 前一致。
            guard serverSupportsP4 else {
                // 防御：slim 壳（!turnsComplete）只会来自支持 P4 的新网关，正常到不了这里；
                // 真出现说明状态不一致——sync_state 是全量替换，缺 turns 键会把服务端正文抹掉，宁可不推
                guard !chats.contains(where: { !$0.turnsComplete && $0.id != "boot" }) else { return }
                stateRev += 1
                send(.syncState(chats: .array(chats.map { $0.json() }), rev: stateRev))
                return
            }
            let dirty = dirtyChatIds.subtracting(inflightChatIds)
            guard !dirty.isEmpty else { return }
            stateRev += 1
            // P4b：只上传脏会话（流式期间从全量 2MB 降到单会话）
            for id in dirty {
                guard let chat = chats.first(where: { $0.id == id }) else {
                    dirtyChatIds.remove(id) // 本地已删（delete_session 已单独通知）
                    continue
                }
                dirtyChatIds.remove(id)
                inflightChatIds.insert(id)
                send(.syncChat(chat: chat.json(), rev: stateRev))
            }
        }
    }

    private func resetTenantSession() {
        syncTask?.cancel()
        stallTask?.cancel()
        client.clearOutbox()
        chats = [ChatSession.blank(id: "boot")]
        activeId = "boot"
        draft = ""
        cwd = ""
        workspaceRoot = ""
        workspaces = []
        stateRev = 0
        appliedStore = false
        didRestoreLastActive = false // P9：换租户后重新允许恢复（新租户有自己的 lastChatKey）
        chatRevs = [:]
        dirtyChatIds = []
        inflightChatIds = []
        pendingChatLoads = []
        digestTimeoutTask?.cancel()
        serverSupportsP4 = false
        deletedIds.removeAll()
        loadingChatIds = []
        loadedPageTurnCounts = [:]
        loadEpochs = [:]
        localTurnsPendingSync = []
        pendingHistory = [:]
        previewTabs = []
        previewActivePath = nil
        pendingDiffPaths = []
        runningChatIds = []
        queuedChatIds = []
        isAdmin = false // P9：换租户/登出后管理员身份与统计一并作废
        loops = [:]
        loopError = ""
        toolLayer = nil
        searchTask?.cancel()
        searchQuery = ""
        searchHits = []
        searchLoading = false
        suppressContentDiscard = true
        closeContentLayer()
        suppressContentDiscard = false
        contentDiscardPrompt = false
        contentDiscardFollowup = nil
        adminStats = []
        adminStatsAt = nil
        showThinkingIds = []
        bannerError = ""
        notice = ""
        pendingImages = []
        imagesByChat = [:]
        uploads = []
        fileIndex = []
        treeTruncated = false
        gitStatus = [:]
        fileBrowserOpen = false // 切租户/登出时文件浏览器不能还挂着（Grok R2 MINOR）
        mentionQuery = nil
        mentionTask?.cancel()
        mentionSuggestions = []
        previewTask?.cancel()
        setPreviewFile(nil) // 强制关预览（closePreview 有 dismiss 竞态守卫，这里绕过）
        previewLoading = false
        exportTask?.cancel() // P10：导出状态一并清（temp 由 setExportFile 链删除）
        setExportFile(nil)
        exportLoading = false
        expiredUploadIds = []
        stateFetchTask?.cancel()
        let orphans = pendingUploads
        pendingUploads = [:]
        for (_, pending) in orphans {
            pending.resume(throwing: UploadError.notConnected)
        }
    }

    private func rememberModel(_ id: String) {
        lastModel = id
        UserDefaults.standard.set(id, forKey: ModelCatalog.lastModelKey)
    }

    private func armVerifyTimeout() {
        verifyTask?.cancel()
        verifyTask = Task {
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled, !unlocked else { return }
            verifying = false
            authError = "验证超时，请再试一次。"
        }
    }

    /// P9：启动后首次合并出会话列表时恢复上次活跃会话。
    /// 只在 activeId 还是 boot 占位时动手（用户已手动切换/重连场景不抢）；
    /// stored id 已被删则什么都不做，交给调用处的默认回落（第一个会话）。
    /// applySession 不在此调——主分支合并后有统一的 applySession(active)（它有 set_workspace 副作用，不能重发）。
    private func restoreLastActiveIfNeeded() {
        guard !didRestoreLastActive else { return }
        didRestoreLastActive = true
        guard activeId == "boot",
              let key = lastChatKey,
              let stored = UserDefaults.standard.string(forKey: key),
              stored != "boot",
              chats.contains(where: { $0.id == stored }) else { return }
        swapActive(to: stored)
    }

    /// stored_state 应用逻辑（WS 直推与 HTTP /state 拉取共用）
    private func applyStoredState(rows: [JSONValue], rev: Int?, deleted: [String], chatRevs serverRevs: [String: Int]?) {
        if serverRevs != nil { serverSupportsP4 = true }
        if appliedStore, let rev, rev <= stateRev {
            // rev 不新（如断线重连后服务端还没收到我们的 sync_chat）：
            // 内容不应用，但断线时倒回 dirty 的在途会话必须有人重推，否则会永久搁置
            if !dirtyChatIds.isEmpty { scheduleSync() }
            ensureTurnsLoaded(activeId) // 断线丢失的在途分页在此重启（onClose 已清 loadingChatIds）
            return
        }
        deleted.forEach { deletedIds.insert($0) }
        appliedStore = true
        if let rev, rev > stateRev { stateRev = rev }
        // 双保险：全量到达时回收在途（正常 ack 会清；断线已由 onClose 回收）
        dirtyChatIds.formUnion(inflightChatIds)
        inflightChatIds = []
        let oldRevs = chatRevs
        chatRevs = serverRevs ?? [:] // 服务端视图全量替换
        let remote = rows.compactMap(ChatSession.from).filter { !deletedIds.contains($0.id) }
        guard !remote.isEmpty else {
            // 服务端全空（新租户/被清空）：清掉已被删的本地会话（保留脏的/boot），脏会话触发重推
            let kept = chats.filter { !deletedIds.contains($0.id) || hasLocalPriority($0.id) || $0.id == "boot" }
            if kept.count != chats.count {
                let keptIds = Set(kept.map(\.id))
                for chat in chats where !keptIds.contains(chat.id) { dropChatState(chat.id) }
                chats = kept
            }
            restoreLastActiveIfNeeded() // P9：远端为空也先尝试恢复（本地脏会话可能就是上次活跃的）
            if !chats.contains(where: { $0.id == activeId }), let first = chats.first {
                swapActive(to: first.id)
            }
            // restore/fallback 之后统一 applySession（GLM R1 M1：漏调会让草稿/模式/工作区不载入，
            // 用户再输入时 persistDraft 把空草稿写回恢复的会话——数据丢失）
            if let keep = chats.first(where: { $0.id == activeId }) {
                applySession(keep)
            }
            if !dirtyChatIds.isEmpty { scheduleSync() }
            ensureTurnsLoaded(activeId)
            return
        }
        // 合并前记住服务端原始行（按 id），用于合并后的差异标脏
        var rowsById: [String: JSONValue] = [:]
        for row in rows {
            guard let id = row.object?["id"]?.string else { continue }
            rowsById[id] = row
        }
        // merge 只保留远端 id：本地独有的脏会话（离线新建未上传）必须追加保留，否则被静默丢弃
        let remoteIds = Set(remote.map(\.id))
        let localOnlyDirty = chats.filter {
            dirtyChatIds.contains($0.id) && !remoteIds.contains($0.id) && !deletedIds.contains($0.id)
        }
        let preMergeIds = Set(chats.map(\.id))
        chats = merge(local: chats, remote: remote) + localOnlyDirty
        let keptIds = Set(chats.map(\.id))
        for id in preMergeIds where !keptIds.contains(id) { dropChatState(id) } // 远端删除的会话清分页/暂存
        // 合并结果与服务端不一致的（本地优先胜出的/本地独有的）标脏，随后 sync_chat 增量重推。
        // 比较前把服务端行过一遍 from→json 归一化默认值，避免字段缺失造成的假差异。
        for chat in chats where chat.id != "boot" {
            if dirtyChatIds.contains(chat.id) { continue } // 已脏（含倒回的在途），无需再判
            guard let row = rowsById[chat.id], !deletedIds.contains(chat.id) else {
                dirtyChatIds.insert(chat.id) // 本地独有（新建未同步）
                continue
            }
            // rev 未变且本地不脏 → 内容必然一致，跳过序列化比较（全量 diff 的短路）
            if let oldRev = oldRevs[chat.id], oldRev == chatRevs[chat.id] { continue }
            // P8 slim：一方缺 turns（元数据壳）时按元数据比较——壳 json() 不写 turns 键，
            // 本地完整版带 turns，直接比必假差异 → sync_chat 风暴
            if var serverChat = ChatSession.from(row) {
                var localChat = chat
                if !serverChat.turnsComplete || !localChat.turnsComplete {
                    serverChat.turns = []
                    serverChat.turnsComplete = false
                    localChat.turns = []
                    localChat.turnsComplete = false
                }
                if serverChat.json() != localChat.json() {
                    dirtyChatIds.insert(chat.id)
                }
            }
        }
        // P8 slim 对账：slim 行看不到 turns——断线期间别端正文变更（chatRev 前进）本地感知不到，
        // 已加载会话的 turns 已陈旧：作废重载（脏会话本地优先跳过；壳本来就未完成无需处理）。
        // 网关只在内容真变时才前进 chatRevs，纯元数据/未读类本地脏不会误触发。
        for chat in chats where chat.id != "boot" && chat.turnsComplete && !hasLocalPriority(chat.id) {
            guard let row = rowsById[chat.id], row.object?["turns"] == nil else { continue } // 只看 slim 行
            guard let oldRev = oldRevs[chat.id], let newRev = chatRevs[chat.id], newRev > oldRev else { continue }
            guard let index = chats.firstIndex(where: { $0.id == chat.id }) else { continue }
            chats[index].turns = []
            chats[index].turnsComplete = false
        }
        if !dirtyChatIds.isEmpty { scheduleSync() }
        restoreLastActiveIfNeeded() // P9：默认回落前先恢复上次活跃会话
        if chats.contains(where: { $0.id == activeId }) == false, let first = chats.first {
            swapActive(to: first.id)
        }
        if let keep = chats.first(where: { $0.id == activeId }) {
            applySession(keep)
        }
        ensureTurnsLoaded(activeId) // P8 slim：active 是壳就启动分页（含重连后在途丢失的重启）
        markLive(running: runningChatIds, queued: queuedChatIds)
    }

    /// P4c：stored_digest 目录对账——只拉差异会话，本地脏的保留优先
    private func applyStoredDigest(rev: Int?, deleted: [String], serverRevs: [String: Int]) {
        // 被拒的 inflight 回到脏集合（服务端没收下，本地优先稍后重推）。
        // 注：digest 目前只会作为「本连接推送被拒」的响应到达（WS 有序），所以倒回是安全的；
        // 若以后网关主动广播 digest，这里需要按 id 精细化。
        dirtyChatIds.formUnion(inflightChatIds)
        inflightChatIds = []
        deleted.forEach { deletedIds.insert($0) }
        appliedStore = true
        if let rev, rev > stateRev { stateRev = rev }
        let digestIds = Set(serverRevs.keys)
        // 清掉已删除会话的版本号残留（保留脏会话的）
        chatRevs = chatRevs.filter { digestIds.contains($0.key) || dirtyChatIds.contains($0.key) }
        // 本地有、digest 没有 → 已被别处删除；本地脏的/从未同步过的（无 rev）保留
        let kept = chats.filter { chat in
            digestIds.contains(chat.id)
                || hasLocalPriority(chat.id)
                || chatRevs[chat.id] == nil
                || chat.id == "boot"
        }
        if kept.count != chats.count {
            let keptIds = Set(kept.map(\.id))
            for chat in chats where !keptIds.contains(chat.id) { dropChatState(chat.id) }
            chats = kept
            if !chats.contains(where: { $0.id == activeId }), let first = chats.first {
                swapActive(to: first.id)
                applySession(first)
            }
        }
        // rev 不一致或本地缺失 → 拉取（本地优先的跳过：本地优先）
        var toFetch: [String] = []
        for (id, serverRev) in serverRevs {
            guard !deletedIds.contains(id), !hasLocalPriority(id) else { continue }
            let missing = !chats.contains(where: { $0.id == id })
            if missing || chatRevs[id] != serverRev {
                toFetch.append(id)
            }
        }
        guard !toFetch.isEmpty else {
            if !dirtyChatIds.isEmpty { scheduleSync() }
            return
        }
        digestTimeoutTask?.cancel()
        pendingChatLoads = Set(toFetch)
        send(.loadChats(ids: toFetch))
        // 安全网：网关对缺失 id 静默跳过，5s 后强制清空避免卡死同步
        digestTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard let self, !Task.isCancelled, !self.pendingChatLoads.isEmpty else { return }
            self.pendingChatLoads = []
            self.scheduleSync()
        }
    }

    /// stored_state 超 maxMessageBytes 时网关改发 deferred 通知，这里走 HTTP /state 拉全量。
    /// 运行中可能连续来多个 deferred，300ms 去抖合并成一次拉取。
    private var stateFetchTask: Task<Void, Never>?

    private func scheduleStateFetch() {
        stateFetchTask?.cancel()
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        let tenantAtStart = tenantId
        stateFetchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, !Task.isCancelled else { return }
            do {
                var request = URLRequest(url: GatewayConfig.stateURL)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                request.timeoutInterval = 60
                let (data, response) = try await URLSession.shared.data(for: request)
                guard (200 ..< 300).contains((response as? HTTPURLResponse)?.statusCode ?? 0) else { return }
                let json = try JSONValue.parse(data)
                guard let object = json.object else { return }
                // 跨租户/登出后的迟到结果直接丢
                guard !Task.isCancelled, self.tenantId == tenantAtStart else { return }
                self.applyStoredState(
                    rows: object["chats"]?.array ?? [],
                    rev: object["rev"]?.int,
                    deleted: object["deletedIds"]?.array?.compactMap(\.string) ?? [],
                    chatRevs: object["chatRevs"]?.intMap
                )
            } catch {
                // 静默：下次状态变更网关还会再推 deferred
            }
        }
    }

    /// 顶条通知（3.5s 自动消）。P7 起文件浏览器等视图也用，放开为 internal
    func flash(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(3.5))
            guard !Task.isCancelled, notice == text else { return }
            notice = ""
        }
    }
}

private func mergeOutput(_ result: JSONValue?, stream: String?, chunk: String?, stdout: String?, stderr: String?) -> JSONValue {
    var record = result?.object ?? [:]
    if record["stdout"] == nil { record["stdout"] = .string("") }
    if record["stderr"] == nil { record["stderr"] = .string("") }
    if let stdout { record["stdout"] = .string(stdout) }
    if let stderr { record["stderr"] = .string(stderr) }
    if let chunk, !chunk.isEmpty {
        let key = stream == "stderr" ? "stderr" : "stdout"
        record[key] = .string((record[key]?.string ?? "") + chunk)
    }
    return .object(record)
}
