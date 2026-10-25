import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    /// 开始等连接：offlineGrace 内连上就一直算「连接中」，过了还没连上才算断开
    func armOfflineTimer() {
        guard offlineTask == nil, !connected else { return }
        offlineTask = Task { [weak self] in
            try? await Task.sleep(for: ChatStore.offlineGrace)
            guard let self, !Task.isCancelled else { return }
            self.offlineTask = nil
            if !self.connected { self.linkOffline = true }
        }
    }

    func clearOfflineTimer() {
        offlineTask?.cancel()
        offlineTask = nil
        linkOffline = false
    }

    func start() {
        guard !started else { return }
        started = true
        AppLaunchMetrics.event("app_start")
        if let saved = KeychainStore.token()?.trimmingCharacters(in: .whitespacesAndNewlines), !saved.isEmpty {
            tokenDraft = saved
            resumingLogin = true
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
        assistantChatId = assistantChatKey.flatMap { UserDefaults.standard.string(forKey: $0) }
        beginBootstrapLoad(for: tenantId)
        loadCachedList()
        wireClient()
        client.connect(url: GatewayConfig.url)
        armOfflineTimer()
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
        armOfflineTimer()
    }

    func logout() {
        KeychainStore.delete()
        UserDefaults.standard.removeObject(forKey: tenantKey)
        unlocked = false
        resumingLogin = false
        connected = false
        clearOfflineTimer()
        verifying = false
        verifyTask?.cancel()
        tokenDraft = ""
        authError = ""
        tenantId = ""
        tenantName = ""
        resetTenantSession()
        ChatCache.clearAll() // 退出登录：本机缓存的正文和列表全部清掉
        AppBootstrapCache.removeAll()
        imSink?.logout()
        ImImageCache.shared.removeAll()
        client.disconnect()
    }

    /// App 回到前台：系统可能在后台掐掉了 socket 却没通知，先探活
    func appBecameActive() {
        guard started else { return }
        client.probe()
        requestAssistant(force: true)
    }

    func wireClient() {
        client.onOpen = { [weak self] in
            guard let self else { return }
            self.connected = true
            self.gatewayReady = false
            AppLaunchMetrics.event("ws_open")
            self.clearOfflineTimer()
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
            // 连接断开前已经收到的增量必须先落进 turn；否则取消 50ms flush Task 会丢最后一小段。
            self.flushAllStreamDeltas()
            self.connected = false
            self.gatewayReady = false
            self.assistantNetworkConfirmed = false
            self.assistantTaggedResponsesSeen = false
            self.assistantSyncFailed()
            self.assistantSyncGate.resetConnection()
            self.workspacesSyncInFlight = false
            self.workspacesInFlightGeneration = nil
            self.workspacesForcePending = false
            self.fileIndexInFlight = [:]
            self.fileIndexRequestIds = [:]
            self.fileIndexForcePending = []
            for task in self.fileIndexTimeoutTasks.values { task.cancel() }
            self.fileIndexTimeoutTasks = [:]
            self.memoryCenterOnDisconnect()
            self.armOfflineTimer()
            self.failAssistantReplyWaiters()
            self.imSink?.connectionLost()
            // P4：断线时在途的 sync_chat 永远等不到 ack——倒回脏集合，重连后随 diff/重推恢复
            if !self.inflightChatIds.isEmpty {
                self.dirtyChatIds.formUnion(self.inflightChatIds)
                self.inflightChatIds = []
            }
            // P8 slim：在途分页随断线丢失，loadingChatIds 不清会永久卡死加载（Grok 评审 M1）。
            // 重启分页必须剥掉已 prepend 的页前缀（保留本地新发后缀）：留着半截从末页重拉，
            // 服务端新增尾部会被去重逻辑当 fresh 插到数组头，顺序错乱
            for id in self.loadingChatIds {
                self.abortTurnsLoad(id)
            }
            self.loadingChatIds = []
            self.loadedPageTurnCounts = [:]
            for task in self.loadTimeouts.values { task.cancel() }
            self.loadTimeouts = [:]
            // 断线已经换了恢复路径（重连后 stored_state 重启分页），超时计数从头算
            self.loadTimeoutStreak = [:]
            // 增量补齐没有并页，基线原样留着显示；重连后的 stored_state 会从末页重新补齐
            self.bodyRefreshes = [:]
            self.refreshingChatIds = []
            self.loadStartRevs = [:]
            self.loadStartSegs = [:]
            self.awaitSnapshot = []
            self.sawSnapshot = []
            self.snapshotHold = []
            self.heldDeltas = [:]
            self.pendingSnapshots = [:]
            self.pendingSnapshotBacklog = [:]
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

    func send(_ message: ClientMessage) {
        if case .hello = message {
            client.send(message)
            return
        }
        guard unlocked else { return }
        // 网关对助理会话拒删、拒换工作区，这里直接不发
        switch message {
        case .deleteSession(let chatId) where isAssistantChat(chatId):
            return
        case .setWorkspace(_, let chatId, _) where isAssistantChat(chatId):
            return
        default:
            break
        }
        client.send(message)
    }

    func resetTenantSession() {
        syncTask?.cancel()
        stallTask?.cancel()
        // 换租户/退出登录不能把旧账号尚未 flush 的增量带进新会话。
        discardStreamDeltas()
        client.clearOutbox()
        chats = [ChatSession.blank(id: "boot")]
        activeId = "boot"
        draft = ""
        cwd = ""
        workspaceRoot = ""
        workspaces = []
        workspacesSyncInFlight = false
        workspacesInFlightGeneration = nil
        workspacesForcePending = false
        workspacesSyncGeneration &+= 1
        workspaceAgents = []
        workspaceAgentsLoaded = false
        workspaceAgentsPendingCursor = nil
        workspaceAvatarTicket = nil
        pendingWorkspacePath = nil
        pendingTurnFiles.removeAll()
        fileIndexRequestChatId = nil
        fileIndexInFlight = [:]
        fileIndexRequestIds = [:]
        fileIndexForcePending = []
        for task in fileIndexTimeoutTasks.values { task.cancel() }
        fileIndexTimeoutTasks = [:]
        fileIndexSyncGeneration = [:]
        mentionRequestChatId = nil
        searchRequestChatId = nil
        chatHomeThreadChatId = nil
        chatHomeDestination = nil
        WorkspaceViewingBeacon.shared.set(nil)
        stateRev = 0
        confirmedRev = 0
        inflightBases = [:]
        truncateBases = [:]
        appliedStore = false
        gatewayReady = false
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
        for task in loadTimeouts.values { task.cancel() }
        loadTimeouts = [:]
        loadTimeoutStreak = [:]
        loadEpochs = [:]
        localTurnsPendingSync = []
        // 本机缓存按租户保留；代际递增使旧租户在途读取无法提交到新租户。
        imSink?.resetTenant()
        ThumbnailStore.shared.reset(tenant: tenantId)
        cacheEpoch += 1
        for task in bodyCacheTasks.values { task.cancel() }
        bodyCacheTasks = [:]
        listCacheTask?.cancel()
        refreshingChatIds = []
        bodyRevs = [:]
        bodySegs = [:]
        serverSegs = [:]
        loadStartRevs = [:]
        loadStartSegs = [:]
        bodyRefreshes = [:]
        cacheReadingIds = []
        cacheCheckedIds = []
        cachedOnlyIds = []
        displayOnlyIds = []
        for task in tailTasks.values { task.cancel() }
        tailTasks = [:]
        stateReloadPending = false
        pendingHistory = [:]
        pendingSnapshots = [:]
        pendingSnapshotBacklog = [:]
        awaitSnapshot = []
        sawSnapshot = []
        snapshotHold = []
        heldDeltas = [:]
        turnRenderRevisions = [:]
        previewTabs = []
        previewActivePath = nil
        runningChatIds = []
        queuedChatIds = []
        isAdmin = false // P9：换租户/登出后管理员身份与统计一并作废
        assistantState = nil
        assistantMemoryRevision = nil
        assistantNetworkConfirmed = false
        assistantTaggedResponsesSeen = false
        assistantMemoryDesired = false
        assistantInFlightGeneration = nil
        assistantInFlightReqId = nil
        assistantSyncFailed()
        assistantSyncGate.resetConnection()
        assistantChatId = nil
        pendingAssistantOpen = false
        loops = [:]
        loopError = ""
        toolLayer = nil
        searchTask?.cancel()
        searchQuery = ""
        searchHits = []
        searchTruncated = false
        searchLoading = false
        suppressContentDiscard = true
        closeContentLayer()
        suppressContentDiscard = false
        contentDiscardPrompt = false
        contentDiscardFollowup = nil
        adminStats = []
        cursorBill = nil
        adminStatsAt = nil
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
        bootstrapLoadTask?.cancel()
        bootstrapSnapshot = nil
        bootstrapLoadCompleted = false
        bootstrapAssistantDirty = false
        bootstrapWorkspacesDirty = false
        bootstrapFileIndexesDirty = false
        bootstrapFileIndexTombstones = []
        let orphans = pendingUploads
        pendingUploads = [:]
        for (_, pending) in orphans {
            pending.resume(throwing: UploadError.notConnected)
        }
        memoryCenterResetTenant()
    }

    func rememberModel(_ id: String) {
        lastModel = id
        UserDefaults.standard.set(id, forKey: ModelCatalog.lastModelKey)
    }

    func armVerifyTimeout() {
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
    func restoreLastActiveIfNeeded() {
        guard !didRestoreLastActive else { return }
        didRestoreLastActive = true
        guard activeId == "boot" else { return }
        if let key = lastChatKey,
           let stored = UserDefaults.standard.string(forKey: key),
           stored != "boot",
           chats.contains(where: { $0.id == stored }) {
            swapActive(to: stored)
            return
        }
        // 没有可恢复的会话：落到助理会话；还没同步到就等它到了再切
        guard let assistantId = assistantChatId else { return }
        if chats.contains(where: { $0.id == assistantId }) {
            swapActive(to: assistantId)
        } else {
            pendingAssistantOpen = true
        }
    }

    func dismissBannerError() {
        bannerError = ""
    }

    func scheduleBannerErrorClear() {
        bannerErrorTask?.cancel()
        guard !bannerError.isEmpty else { return }
        let text = bannerError
        bannerErrorTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self, !Task.isCancelled, self.bannerError == text else { return }
            self.bannerError = ""
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
