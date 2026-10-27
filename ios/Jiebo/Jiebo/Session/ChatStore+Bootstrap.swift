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
                    if self.workspaceRoot.isEmpty { self.workspaceRoot = snapshot.workspacesRoot }
                }
                if !self.bootstrapAssistantDirty, let state = cachedAssistant {
                    self.assistantState = state
                    self.assistantMemoryRevision = snapshot.assistantMemoryRevision
                    self.assistantName = state.name
                }
                if !self.bootstrapFileIndexesDirty { self.applyCachedFileIndexIfAvailable(chatId: self.activeId) }
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
    }

    func persistBootstrapSnapshot() {
        guard bootstrapLoadCompleted, !tenantId.isEmpty, let snapshot = bootstrapSnapshot else { return }
        AppBootstrapCache.save(snapshot, tenant: tenantId)
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
        persistBootstrapSnapshot()
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
        while snapshot.fileIndexes.count > limit {
            let protected = Set([chatId, activeId, chatHomeThreadChatId].compactMap { $0 })
            guard let victim = snapshot.fileIndexes.keys.sorted().first(where: { !protected.contains($0) })
                ?? snapshot.fileIndexes.keys.sorted().first
            else { break }
            snapshot.fileIndexes.removeValue(forKey: victim)
        }
        bootstrapFileIndexesDirty = true
        bootstrapSnapshot = snapshot
        persistBootstrapSnapshot()
    }

    func removeCachedFileIndex(chatId: String) {
        bootstrapFileIndexTombstones.insert(chatId)
        if bootstrapSnapshot == nil { bootstrapSnapshot = emptyBootstrapSnapshot }
        bootstrapSnapshot?.fileIndexes.removeValue(forKey: chatId)
        bootstrapFileIndexesDirty = true
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
