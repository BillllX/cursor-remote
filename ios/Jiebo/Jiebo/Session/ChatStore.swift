import Foundation
import Observation

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
    var creatingWorkspace = false
    var newWorkspaceName = ""
    var model = ModelCatalog.defaultModel
    var models: [String] = [ModelCatalog.defaultModel]
    var mode: AgentMode = .agent
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
    private var runningChatIds: [String] = []
    private var queuedChatIds: [String] = []
    private var syncTask: Task<Void, Never>?
    private var verifyTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?
    private var stallTask: Task<Void, Never>?
    private var lastProgress = Date()
    private let tenantKey = "jiebo.tenantId"
    private var pendingUploads: [String: CheckedContinuation<String, Error>] = [:]

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
            policy: active?.policy
        ))
        markProgress(chatId)
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
        send(.listWorkspaces)
        creatingWorkspace = false
        newWorkspaceName = ""
        workspaceSheetOpen = true
    }

    func startChat(in path: String) {
        let next = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return }
        workspaceSheetOpen = false
        creatingWorkspace = false
        persistDraft()
        if let existing = chats.first(where: { $0.isUntitled && $0.turns.isEmpty && samePath($0.cwd ?? workspaceRoot, next) }) {
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

    func select(_ id: String) {
        guard id != activeId else { return }
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
        persistDraft()
        imagesByChat[activeId] = pendingImages // 待发图片跟会话走
        activeId = newId
        pendingImages = imagesByChat[newId] ?? []
        previewTask?.cancel() // 在途预览不带到新会话；取消分支早返回不会自己复位 loading
        previewLoading = false
        requestFileIndex() // 冷启动/切会话都靠这里补拉（select 不再单独调）
    }

    func deleteChat(_ id: String) {
        if let doomed = chats.first(where: { $0.id == id }), doomed.turns.contains(where: \.running) {
            send(.cancel(chatId: id))
        }
        send(.deleteSession(chatId: id))
        deletedIds.insert(id)
        imagesByChat[id] = nil
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
        draft = value
        refreshMentionSuggestions()
        guard let index = chats.firstIndex(where: { $0.id == activeId }) else { return }
        if chats[index].draft != value {
            chats[index].draft = value
        }
    }

    // MARK: @补全

    /// 检测草稿尾部的 @查询（对齐网页 mentionAt，iOS 简化只看文本末尾）
    private func refreshMentionSuggestions() {
        guard let range = draft.range(of: #"(^|\s)@(\S*)$"#, options: .regularExpression) else {
            mentionQuery = nil
            mentionTask?.cancel()
            mentionSuggestions = []
            return
        }
        let tail = String(draft[range.lowerBound...])
        let queryString = String(tail.drop(while: { $0 != "@" }).dropFirst())
        guard queryString != mentionQuery else { return }
        mentionQuery = queryString
        mentionTask?.cancel()
        // 本地索引先秒出候选，同时问网关要更全的（debounce 150ms）
        mentionSuggestions = ChatStore.rankMentions(fileIndex, query: queryString)
        mentionTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            self?.send(.listFiles(query: queryString, chatId: self?.activeId, mention: true))
        }
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
                var request = URLRequest(url: GatewayConfig.mediaURL(path: trimmed, chatId: chatId))
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                request.timeoutInterval = 60
                let (data, response) = try await URLSession.shared.data(for: request)
                try Task.checkCancellation()
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200 ..< 300).contains(code) else {
                    throw PreviewError.http(code)
                }
                guard data.count <= 32 * 1024 * 1024 else { throw PreviewError.tooLarge }
                let temp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("jiebo-preview-\(UUID().uuidString)-\((trimmed as NSString).lastPathComponent)")
                try data.write(to: temp)
                // 下载途中切了会话/租户：删掉 temp 静默退出，不在新上下文弹预览
                guard !Task.isCancelled, tenantId == tenantAtStart, activeId == chatId else {
                    try? FileManager.default.removeItem(at: temp)
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

    /// 预览失败文案（独立于 UploadError，避免「预览失败：上传失败」串味）
    private enum PreviewError: LocalizedError {
        case http(Int)
        case tooLarge
        var errorDescription: String? {
            switch self {
            case .http(let code):
                code == 404 ? "文件不在工作区里，可能已被移动或删除" : "预览失败（HTTP \(code)）"
            case .tooLarge:
                "文件太大，预览不了"
            }
        }
    }

    /// 写 previewFile 的唯一入口：先删旧 temp 再换新的（防覆盖泄漏）；
    /// 删除依据 lastPreviewURL 而非 previewFile——sheet 交互关闭时 SwiftUI 先置 nil 再调 onDismiss
    private func setPreviewFile(_ file: PreviewFile?) {
        if let old = lastPreviewURL, old != file?.url {
            try? FileManager.default.removeItem(at: old)
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
        case .ready(let nextCwd, let hasKey, let serverModel, let serverModels, _, let running, let queued, let root, let readyTenantId, let readyTenantName):
            if let nextTenant = readyTenantId?.nilIfEmpty {
                if !tenantId.isEmpty, tenantId != nextTenant {
                    resetTenantSession()
                }
                if tenantId != nextTenant {
                    tenantId = nextTenant
                    UserDefaults.standard.set(nextTenant, forKey: tenantKey)
                }
            }
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
        case .storedState(let rows, let rev, let deleted, let serverRevs):
            applyStoredState(rows: rows, rev: rev, deleted: deleted, chatRevs: serverRevs)
        case .storedStateDeferred(let rev):
            // stored_state 太大（超 maxMessageBytes）走 HTTP /state；rev 不新就跳过。
            // 但 digest 在途时（load_chats 单条超限的回落）digest 已抬过 rev，不能被短路挡住
            if pendingChatLoads.isEmpty, let rev, appliedStore, rev <= stateRev { break }
            pendingChatLoads = []
            digestTimeoutTask?.cancel()
            scheduleStateFetch()
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
            // 本地脏的会话本地优先（稍后重推），不脏才应用服务器版
            if !dirtyChatIds.contains(remote.id) {
                if let index = chats.firstIndex(where: { $0.id == remote.id }) {
                    var mergedChat = remote
                    mergedChat.draft = chats[index].draft.isEmpty ? remote.draft : chats[index].draft
                    chats[index] = mergedChat
                } else {
                    chats.append(remote)
                }
                if remote.id == activeId { applySession(remote) }
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
                if !agentId.isEmpty { next.agentId = agentId }
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
        case .toolCompleted(let id, let callId, let name, let status, let result, let parent, let agent, let toolModel):
            patchOpen(id) { turn in
                var next = turn
                let existing = next.tools.first { $0.callId == callId }
                if existing?.status == "error", status == "completed" { return turn }
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
                patch(id ?? activeId) { chat in
                    guard let index = chat.turns.lastIndex(where: { !$0.user.isEmpty || $0.running }) else { return chat }
                    var next = chat
                    if !next.turns[index].running {
                        next.turns[index].running = true
                        next.turns[index].queued = false
                        next.turns[index].status = status
                    }
                    return next
                }
            }
        case .error(let id, let text):
            bannerError = friendlyError(text)
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
            patch(id) { chat in
                var next = chat
                if next.turns.isEmpty {
                    next.turns = incoming
                } else if incoming.count > next.turns.count {
                    next.turns = incoming
                }
                return next
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
        case .files(let query, let paths, let mention, let truncated, let filesChatId):
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
            }
        case .undone(_, let paths, let error):
            // 只反馈当前会话的 undo（chatId 已在 handle 入口解析为 activeId 兜底）
            guard chatId == activeId else { break }
            if let error {
                notice = error
            } else {
                notice = paths.isEmpty ? "没有可还原的改动" : "已还原 \(paths.joined(separator: ", "))"
            }
            requestFileIndex()
        case .pong, .ignored:
            break
        }
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
            activeId = chat.id
            pendingImages = [] // 旧会话已不存在，待发图无归属
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

    private func merge(local: [ChatSession], remote: [ChatSession]) -> [ChatSession] {
        let localById = Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) })
        return remote.map { chat in
            guard let current = localById[chat.id] else { return chat }
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
        chatRevs = [:]
        dirtyChatIds = []
        inflightChatIds = []
        pendingChatLoads = []
        digestTimeoutTask?.cancel()
        serverSupportsP4 = false
        deletedIds.removeAll()
        runningChatIds = []
        queuedChatIds = []
        showThinkingIds = []
        bannerError = ""
        notice = ""
        pendingImages = []
        imagesByChat = [:]
        uploads = []
        fileIndex = []
        treeTruncated = false
        mentionQuery = nil
        mentionTask?.cancel()
        mentionSuggestions = []
        previewTask?.cancel()
        setPreviewFile(nil) // 强制关预览（closePreview 有 dismiss 竞态守卫，这里绕过）
        previewLoading = false
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

    /// stored_state 应用逻辑（WS 直推与 HTTP /state 拉取共用）
    private func applyStoredState(rows: [JSONValue], rev: Int?, deleted: [String], chatRevs serverRevs: [String: Int]?) {
        if serverRevs != nil { serverSupportsP4 = true }
        if appliedStore, let rev, rev <= stateRev {
            // rev 不新（如断线重连后服务端还没收到我们的 sync_chat）：
            // 内容不应用，但断线时倒回 dirty 的在途会话必须有人重推，否则会永久搁置
            if !dirtyChatIds.isEmpty { scheduleSync() }
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
            let kept = chats.filter { !deletedIds.contains($0.id) || dirtyChatIds.contains($0.id) || $0.id == "boot" }
            if kept.count != chats.count {
                chats = kept
                if !chats.contains(where: { $0.id == activeId }), let first = chats.first {
                    swapActive(to: first.id)
                    applySession(first)
                }
            }
            if !dirtyChatIds.isEmpty { scheduleSync() }
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
        chats = merge(local: chats, remote: remote) + localOnlyDirty
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
            if ChatSession.from(row)?.json() != chat.json() {
                dirtyChatIds.insert(chat.id)
            }
        }
        if !dirtyChatIds.isEmpty { scheduleSync() }
        if chats.contains(where: { $0.id == activeId }) == false, let first = chats.first {
            swapActive(to: first.id)
        }
        if let keep = chats.first(where: { $0.id == activeId }) {
            applySession(keep)
        }
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
                || dirtyChatIds.contains(chat.id)
                || chatRevs[chat.id] == nil
                || chat.id == "boot"
        }
        if kept.count != chats.count {
            chats = kept
            if !chats.contains(where: { $0.id == activeId }), let first = chats.first {
                swapActive(to: first.id)
                applySession(first)
            }
        }
        // rev 不一致或本地缺失 → 拉取（本地脏的跳过：本地优先）
        var toFetch: [String] = []
        for (id, serverRev) in serverRevs {
            guard !deletedIds.contains(id), !dirtyChatIds.contains(id) else { continue }
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

    private func flash(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(3.5))
            guard !Task.isCancelled, notice == text else { return }
            notice = ""
        }
    }
}

private func samePath(_ a: String, _ b: String) -> Bool {
    URL(fileURLWithPath: a).standardizedFileURL.path == URL(fileURLWithPath: b).standardizedFileURL.path
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
