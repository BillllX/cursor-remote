import Foundation

@MainActor
extension ChatStore {
    func beginBootstrapLoad(for tenant: String) {
        guard !tenant.isEmpty else { return }
        bootstrapLoadTask?.cancel()
        bootstrapLoadCompleted = false
        let epoch = cacheEpoch
        bootstrapLoadTask = Task { [weak self] in
            let result = await Task.detached(priority: .userInitiated) {
                AppBootstrapCache.load(tenant: tenant)
            }.value
            guard let self, !Task.isCancelled, self.tenantId == tenant, self.cacheEpoch == epoch else { return }
            switch result {
            case .hit(let snapshot, let cachedAssistant):
                let pending = self.bootstrapSnapshot
                var merged = snapshot
                if self.bootstrapAssistantDirty {
                    merged.assistant = pending?.assistant
                    merged.assistantMemoryRevision = pending?.assistantMemoryRevision
                }
                if self.bootstrapWorkspacesDirty {
                    merged.workspacesRoot = pending?.workspacesRoot ?? ""
                    merged.workspaces = pending?.workspaces ?? []
                }
                if self.bootstrapFileIndexesDirty {
                    merged.fileIndexes = AppBootstrapSnapshot.mergeFileIndexes(
                        disk: merged.fileIndexes,
                        pending: pending?.fileIndexes ?? [:],
                        tombstones: self.bootstrapFileIndexTombstones
                    )
                }
                self.bootstrapSnapshot = merged
                if !self.bootstrapWorkspacesDirty {
                    self.workspaces = snapshot.workspaces
                    self.workspacesLoaded = true
                    if self.workspaceRoot.isEmpty { self.workspaceRoot = snapshot.workspacesRoot }
                }
                if !self.bootstrapAssistantDirty, let state = cachedAssistant {
                    self.assistantState = state
                    self.assistantMemoryRevision = snapshot.assistantMemoryRevision
                    self.assistantName = state.name
                }
                if !self.bootstrapFileIndexesDirty { self.applyCachedFileIndexIfAvailable(chatId: self.activeId) }
                self.invalidateMergedFileTreeCache()
                self.bootstrapLoadCompleted = true
                if self.bootstrapAssistantDirty || self.bootstrapWorkspacesDirty || self.bootstrapFileIndexesDirty {
                    self.persistBootstrapSnapshot()
                }
                AppLaunchMetrics.event("local_cache_visible")
            case .miss:
                self.bootstrapLoadCompleted = true
                self.persistBootstrapSnapshot()
            case .corrupt:
                AppLaunchMetrics.event("cache_corrupt")
                self.bootstrapLoadCompleted = true
                AppBootstrapCache.remove(tenant: tenant)
                self.persistBootstrapSnapshot()
            case .incompatible:
                self.bootstrapLoadCompleted = true
                AppBootstrapCache.remove(tenant: tenant)
                self.persistBootstrapSnapshot()
            }
        }
    }

    func applyCachedFileIndexIfAvailable(chatId: String) {
        guard chatId == activeId || chatId == chatHomeThreadChatId else { return }
        guard let cached = bootstrapSnapshot?.fileIndexes[chatId] else { return }
        fileIndexRequestChatId = chatId
        fileIndex = cached.paths
        treeTruncated = cached.truncated
        gitStatus = cached.status
        invalidateMergedFileTreeCache(for: chatId)
    }

    func persistBootstrapSnapshot(immediate: Bool = false) {
        guard bootstrapLoadCompleted, !tenantId.isEmpty, let snapshot = bootstrapSnapshot else { return }
        if immediate {
            bootstrapSaveTask?.cancel()
            bootstrapSaveTask = nil
            AppBootstrapCache.save(snapshot, tenant: tenantId)
            return
        }
        // 合并冷启动/重连瞬间的连续助理、工作区与文件索引更新，避免 1 秒内多次全量序列化几 MB 快照写盘
        let tenant = tenantId
        let epoch = cacheEpoch
        bootstrapSaveTask?.cancel()
        bootstrapSaveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard let self, !Task.isCancelled,
                  self.cacheEpoch == epoch,
                  self.tenantId == tenant,
                  self.bootstrapLoadCompleted,
                  let latest = self.bootstrapSnapshot
            else { return }
            self.bootstrapSaveTask = nil
            AppBootstrapCache.save(latest, tenant: tenant)
        }
    }

    func flushBootstrapSnapshotIfNeeded() {
        guard bootstrapSaveTask != nil else { return }
        persistBootstrapSnapshot(immediate: true)
    }

    func updateCachedAssistant(_ state: AssistantState, memoryRevision: Int?) {
        var snapshot = bootstrapSnapshot ?? emptyBootstrapSnapshot
        snapshot.assistant = state.rawJSON
        snapshot.assistantMemoryRevision = memoryRevision
        bootstrapAssistantDirty = true
        bootstrapSnapshot = snapshot
        persistBootstrapSnapshot()
    }

    func clearCachedAssistant() {
        var snapshot = bootstrapSnapshot ?? emptyBootstrapSnapshot
        snapshot.assistant = nil
        snapshot.assistantMemoryRevision = nil
        bootstrapAssistantDirty = true
        bootstrapSnapshot = snapshot
        // 清空失效助理缓存需立刻入队，避免 800ms 窗口内切租户或退后台遗留旧快照
        persistBootstrapSnapshot(immediate: true)
    }

    func updateCachedWorkspaces(root: String, items: [WorkspaceItem]) {
        var snapshot = bootstrapSnapshot ?? emptyBootstrapSnapshot
        snapshot.workspacesRoot = root
        snapshot.workspaces = items
        bootstrapWorkspacesDirty = true
        bootstrapSnapshot = snapshot
        persistBootstrapSnapshot()
    }

    func updateCachedFileIndex(chatId: String, paths: [String], truncated: Bool, status: [String: String]) {
        guard !deletedIds.contains(chatId) else { return }
        let limit = 24
        var snapshot = bootstrapSnapshot ?? emptyBootstrapSnapshot
        bootstrapFileIndexTombstones.remove(chatId)
        snapshot.fileIndexes.removeValue(forKey: chatId)
        snapshot.fileIndexes[chatId] = .init(paths: paths, truncated: truncated, status: status)
        if snapshot.fileIndexes.count > limit {
            let protected = Set([chatId, activeId, chatHomeThreadChatId].compactMap { $0 })
            let sortedKeys = snapshot.fileIndexes.keys.sorted()
            var overflow = snapshot.fileIndexes.count - limit
            // 先按字典序淘汰非受保护会话，再在极端情况下淘汰剩余键，避免 while 内重复排序
            for key in sortedKeys where overflow > 0 && !protected.contains(key) {
                snapshot.fileIndexes.removeValue(forKey: key)
                invalidateMergedFileTreeCache(for: key)
                overflow -= 1
            }
            for key in sortedKeys where overflow > 0 && snapshot.fileIndexes[key] != nil {
                snapshot.fileIndexes.removeValue(forKey: key)
                invalidateMergedFileTreeCache(for: key)
                overflow -= 1
            }
        }
        bootstrapFileIndexesDirty = true
        bootstrapSnapshot = snapshot
        invalidateMergedFileTreeCache(for: chatId)
        persistBootstrapSnapshot()
    }

    func removeCachedFileIndex(chatId: String) {
        bootstrapFileIndexTombstones.insert(chatId)
        if bootstrapSnapshot == nil { bootstrapSnapshot = emptyBootstrapSnapshot }
        bootstrapSnapshot?.fileIndexes.removeValue(forKey: chatId)
        bootstrapFileIndexesDirty = true
        invalidateMergedFileTreeCache(for: chatId)
        persistBootstrapSnapshot()
    }

    private var emptyBootstrapSnapshot: AppBootstrapSnapshot {
        .init(assistant: nil, assistantMemoryRevision: nil, workspacesRoot: "", workspaces: [], fileIndexes: [:])
    }

    func noteConditionalSyncComplete() {
        if !launchSawConditionalSync {
            launchSawConditionalSync = true
            AppLaunchMetrics.event("conditional_sync_complete")
        }
        reportFirstScreenStableIfReady()
    }

    func reportFirstScreenStableIfReady() {
        guard launchSawReady, launchSawConditionalSync, !launchStableReported else { return }
        launchStableReported = true
        AppLaunchMetrics.event("first_screen_stable")
    }
}
