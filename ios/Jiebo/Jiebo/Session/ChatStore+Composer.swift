import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    func saveDraft(_ value: String) {
        if draft != value { draft = value }
        updateMentions(for: value)
        guard let index = chats.firstIndex(where: { $0.id == activeId }) else { return }
        if chats[index].draft != value {
            chats[index].draft = value
        }
    }

    /// 输入框防抖还没落库就切了会话：草稿写回它原来的会话，不写进新会话
    func saveDraft(_ value: String, forChat id: String) {
        if id == activeId {
            saveDraft(value)
            return
        }
        guard let index = chats.firstIndex(where: { $0.id == id }), chats[index].draft != value else { return }
        chats[index].draft = value
    }

    /// 打字时只更新 @ 候选，不把草稿写进会话列表。
    func updateMentions(for text: String, chatId: String? = nil) {
        let targetId = chatId ?? activeId
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
            self?.mentionRequestChatId = targetId
            self?.send(.listFiles(query: queryString, chatId: targetId, mention: true, reqId: UUID().uuidString))
        }
    }

    // MARK: @补全

    /// 点选候选：把草稿尾部的 @查询 替换成 @路径（保留查询前的空白分隔）
    func insertMention(_ path: String, chatId: String? = nil) {
        let targetId = chatId ?? activeId
        let current = draft(for: targetId)
        guard let range = current.range(of: #"(^|\s)@(\S*)$"#, options: .regularExpression) else { return }
        let leading = current[range.lowerBound...].first.map { $0 == " " || $0 == "\n" ? String($0) : "" } ?? ""
        var next = current
        next.replaceSubrange(range, with: "\(leading)@\(path) ")
        mentionQuery = nil
        mentionTask?.cancel()
        mentionSuggestions = []
        saveDraft(next, forChat: targetId)
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
    func requestFileIndex(chatId: String? = nil, force: Bool = false, userInitiated: Bool = false) {
        let targetId = chatId ?? activeId
        applyCachedFileIndexIfAvailable(chatId: targetId)
        // iPhone 助理壳不为生命周期事件下载完整工作区；@ 查询和文件入口显式传 userInitiated。
        if assistantOnly, !userInitiated { return }
        guard connected, unlocked, gatewayReady else { return }
        if fileIndexInFlight[targetId] != nil {
            if force { fileIndexForcePending.insert(targetId) }
            return
        }
        let cached = bootstrapSnapshot?.fileIndexes[targetId]
        let visible = fileIndexRequestChatId == targetId
        let paths = cached?.paths ?? (visible ? fileIndex : [])
        let truncated = cached?.truncated ?? (visible ? treeTruncated : false)
        if !force, FileIndexFreshnessPolicy.isFresh(
            paths: paths,
            truncated: truncated,
            lastUpdatedAt: fileIndexUpdatedAt[targetId]
        ) {
            return
        }
        let generation = (fileIndexSyncGeneration[targetId] ?? 0) &+ 1
        fileIndexSyncGeneration[targetId] = generation
        fileIndexInFlight[targetId] = generation
        let reqId = UUID().uuidString
        fileIndexRequestIds[targetId] = reqId
        fileIndexRequestChatId = targetId
        send(.listFiles(query: "", chatId: targetId, mention: nil, reqId: reqId))
        fileIndexTimeoutTasks[targetId]?.cancel()
        fileIndexTimeoutTasks[targetId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, !Task.isCancelled,
                  self.fileIndexInFlight[targetId] == generation,
                  self.fileIndexRequestIds[targetId] == reqId
            else { return }
            self.settleFileIndexFailure(chatId: targetId, reqId: reqId)
        }
    }

    func receiveFileIndex(
        chatId: String,
        paths: [String],
        truncated: Bool,
        status: [String: String],
        reqId: String?
    ) {
        if let reqId, reqId != fileIndexRequestIds[chatId] { return }
        guard !deletedIds.contains(chatId) else { return }
        let now = Date()
        fileIndexUpdatedAt[chatId] = now
        if reqId == nil {
            fileIndexBroadcastAt[chatId] = now
            fileIndexFallbackTasks.removeValue(forKey: chatId)?.cancel()
        }
        updateCachedFileIndex(chatId: chatId, paths: paths, truncated: truncated, status: status)
        if chatId == activeId || chatId == chatHomeThreadChatId {
            fileIndexRequestChatId = chatId
            fileIndex = paths
            treeTruncated = truncated
            gitStatus = status
        }
        if let generation = fileIndexInFlight[chatId],
           generation == fileIndexSyncGeneration[chatId],
           FileIndexResponsePolicy.shouldSettle(
               expectedReqId: fileIndexRequestIds[chatId],
               responseReqId: reqId
           ) {
            settleFileIndexRequest(chatId: chatId)
        }
    }

    func settleFileIndexFailure(chatId: String?, reqId: String) {
        guard let chatId,
              fileIndexRequestIds[chatId] == reqId,
              fileIndexInFlight[chatId] == fileIndexSyncGeneration[chatId]
        else { return }
        settleFileIndexRequest(chatId: chatId)
    }

    private func settleFileIndexRequest(chatId: String) {
        fileIndexTimeoutTasks.removeValue(forKey: chatId)?.cancel()
        let forceAgain = fileIndexForcePending.remove(chatId) != nil
        fileIndexInFlight.removeValue(forKey: chatId)
        fileIndexRequestIds.removeValue(forKey: chatId)
        if forceAgain { requestFileIndex(chatId: chatId, force: true) }
    }

    /// 工具/文件变化后先等 compact 网关主动发无 reqId 的 files；旧网关超时才补 list_files。
    func scheduleFileIndexFallback(chatId: String) {
        guard !assistantOnly else { return }
        if let broadcastAt = fileIndexBroadcastAt[chatId],
           Date().timeIntervalSince(broadcastAt) < 1 {
            return
        }
        fileIndexFallbackTasks.removeValue(forKey: chatId)?.cancel()
        fileIndexFallbackTasks[chatId] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard let self, !Task.isCancelled else { return }
            self.fileIndexFallbackTasks.removeValue(forKey: chatId)
            self.requestFileIndex(chatId: chatId, force: true)
        }
    }

    /// 文件清单 sheet 用：把 @path 追加到当前会话草稿（带去重）
    func appendMentionToDraft(_ path: String, chatId: String? = nil) {
        appendMention(path, to: chatId ?? activeId)
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

    /// 图片还在压缩时切了会话：结果放回发起时的会话
    func addPendingImages(_ images: [PendingImage], toChat id: String) {
        guard id != activeId else {
            addPendingImages(images)
            return
        }
        guard chats.contains(where: { $0.id == id }) else { return }
        var list = imagesByChat[id] ?? []
        list.append(contentsOf: images.prefix(max(0, ImagePrep.maxCount - list.count)))
        imagesByChat[id] = list
    }

    func removePendingImage(_ id: UUID) {
        pendingImages.removeAll { $0.id == id }
    }

    func removePendingImage(_ imageId: UUID, chatId: String) {
        if chatId == activeId {
            removePendingImage(imageId)
        } else {
            imagesByChat[chatId]?.removeAll { $0.id == imageId }
        }
    }

    func toggleConfirmWrites(chatId: String? = nil) {
        patch(chatId ?? activeId) { chat in
            var next = chat
            next.confirmWrites.toggle()
            return next
        }
    }

    func togglePolicy(chatId: String? = nil) {
        let targetId = chatId ?? activeId
        let next = (chatSession(targetId)?.policy == "plane") ? "baseline" : "plane"
        patch(targetId) { chat in
            var copy = chat
            copy.policy = next
            return copy
        }
        send(.setPolicy(policy: next, chatId: targetId))
    }

    func attachFiles(_ urls: [URL], chatId: String? = nil) {
        let targetId = chatId ?? activeId
        // 对齐网页端 MAX_UPLOAD_FILES = 10
        if urls.count > 10 { flash("一次最多传 10 个文件") }
        for url in urls.prefix(10) {
            let item = UploadItem(id: UUID().uuidString.lowercased(), name: url.lastPathComponent)
            uploads.append(item)
            Task { await uploadAttachment(item: item, source: url, chatId: targetId) }
        }
    }

    func uploadAttachment(item: UploadItem, source: URL, chatId: String) async {
        let tenantAtStart = tenantId
        // 凭据与上传租约同时快照；等待用户确认期间即使切账号，也不能改用新租户 token。
        let tokenAtStart = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            // 重 I/O（安全作用域 + 复制 iCloud 文件）放后台线程，避免卡主 actor
            let (temp, originalSize) = try await Task.detached(priority: .userInitiated) { () throws -> (URL, Int) in
                let scoped = source.startAccessingSecurityScopedResource()
                defer { if scoped { source.stopAccessingSecurityScopedResource() } }
                let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size > 0 else { throw UploadError.empty }
                let limit = MediaShrink.canShrink(name: source.lastPathComponent) ? MediaShrink.maxSourceBytes : maxUploadBytes
                guard size <= limit else { throw UploadError.tooLarge }
                // 复制到临时文件，避免上传期间源文件（iCloud/安全作用域）失效
                let temp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("jiebo-upload-\(item.id)-\(source.lastPathComponent)")
                try? FileManager.default.removeItem(at: temp)
                try FileManager.default.copyItem(at: source, to: temp)
                return (temp, size)
            }.value
            defer { try? FileManager.default.removeItem(at: temp) }

            var file = temp
            var name = item.name
            var size = originalSize
            if MediaShrink.canShrink(name: name) {
                setUploadCompressing(item.id, true)
                let profile = MobileMediaPolicy.workbenchUpload(
                    mode: MobileDataRuntime.mode,
                    cost: MobileDataRuntime.networkCost
                )
                let shrunk = await Task.detached(priority: .userInitiated) { [name, profile] in
                    await MediaShrink.shrinkUpload(temp, name: name, size: originalSize, imageProfile: profile)
                }.value
                setUploadCompressing(item.id, false)
                if let shrunk {
                    file = shrunk.url
                    name = shrunk.name
                    size = shrunk.size
                }
            }
            defer { if file != temp { try? FileManager.default.removeItem(at: file) } }
            guard size <= maxUploadBytes else { throw UploadError.tooLarge }
            if size > MobileMediaPolicy.largeShareRetryBudget {
                let approved = await confirmUpload(itemId: item.id, name: name, bytes: size)
                guard approved else {
                    uploads.removeAll { $0.id == item.id }
                    return
                }
            }

            // 批准只是 UI 结果；真正产生网络副作用前重新核对租户、会话和待上传项。
            guard uploadLeaseIsCurrent(itemId: item.id, chatId: chatId, tenant: tenantAtStart) else { return }
            var path: String?
            var httpError: Error?
            if !tokenAtStart.isEmpty {
                do {
                    path = try await Uploader.upload(chatId: chatId, name: name, file: file, token: tokenAtStart).path
                } catch {
                    httpError = error
                }
            }
            if path == nil {
                guard uploadLeaseIsCurrent(itemId: item.id, chatId: chatId, tenant: tenantAtStart) else { return }
                // WS 兜底：≤8MB 才走（实测 >32MB 的 WS 帧会被传输层直接掐断）
                guard client.isOpen else { throw httpError ?? UploadError.notConnected }
                guard size <= 8 * 1024 * 1024 else { throw httpError ?? UploadError.tooLarge }
                // base64 编码也放后台（8MB → ~11MB 字符串）
                let data = try await Task.detached(priority: .userInitiated) { [file] in
                    try Data(contentsOf: file, options: .mappedIfSafe)
                }.value
                do {
                    path = try await uploadViaGateway(chatId: chatId, name: name, data: data)
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
            if size < originalSize {
                flash("已上传 \(name)（\(Self.megabytes(originalSize)) → \(Self.megabytes(size))）")
            } else {
                flash("已上传 \(name)")
            }
        } catch {
            uploads.removeAll { $0.id == item.id }
            guard tenantId == tenantAtStart else { return }
            bannerError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func setUploadCompressing(_ id: String, _ value: Bool) {
        guard let index = uploads.firstIndex(where: { $0.id == id }) else { return }
        uploads[index].compressing = value
    }

    func confirmUpload(itemId: String, name: String, bytes: Int) async -> Bool {
        await withCheckedContinuation { continuation in
            // 同一上传项重复进入确认时，旧等待者先按拒绝结清，避免 continuation 被覆盖泄漏。
            uploadConfirmationContinuations.removeValue(forKey: itemId)?.resume(returning: false)
            uploadConfirmationContinuations[itemId] = continuation
            let confirmation = UploadConfirmation(id: itemId, name: name, bytes: bytes)
            if uploadConfirmation == nil {
                uploadConfirmation = confirmation
            } else {
                uploadConfirmationQueue.append(confirmation)
            }
        }
    }

    func cancelUploadConfirmations() {
        uploadConfirmationGeneration &+= 1
        let ids = UploadConfirmationLeasePolicy.idsToReject(
            activeId: uploadConfirmation?.id,
            queuedIds: uploadConfirmationQueue.map(\.id),
            continuationIds: Set(uploadConfirmationContinuations.keys)
        )
        uploadConfirmation = nil
        uploadConfirmationQueue = []
        let continuations = uploadConfirmationContinuations
        uploadConfirmationContinuations = [:]
        for id in ids {
            continuations[id]?.resume(returning: false)
        }
    }

    private func uploadLeaseIsCurrent(itemId: String, chatId: String, tenant: String) -> Bool {
        UploadConfirmationLeasePolicy.acceptsUpload(
            expectedTenant: tenant,
            expectedChatId: chatId,
            itemId: itemId,
            currentTenant: tenantId,
            currentChatIds: Set(chats.lazy.map(\.id)).subtracting(deletedIds),
            currentUploadIds: Set(uploads.lazy.map(\.id))
        )
    }

    func resolveUploadConfirmation(_ approved: Bool) {
        guard let confirmation = uploadConfirmation else { return }
        let next = uploadConfirmationQueue.isEmpty ? nil : uploadConfirmationQueue.removeFirst()
        uploadConfirmation = nil
        uploadConfirmationContinuations.removeValue(forKey: confirmation.id)?.resume(returning: approved)
        if let next {
            let generation = uploadConfirmationGeneration
            Task { @MainActor [weak self] in
                await Task.yield()
                guard let self,
                      self.uploadConfirmationGeneration == generation,
                      self.uploadConfirmation == nil,
                      self.uploadConfirmationContinuations[next.id] != nil
                else { return }
                self.uploadConfirmation = next
            }
        }
    }

    static func megabytes(_ bytes: Int) -> String {
        let mb = Double(bytes) / 1024 / 1024
        return mb >= 10 ? String(format: "%.0fMB", mb) : String(format: "%.1fMB", max(0.1, mb))
    }

    /// WS 兜底通道：upload_file + 按 id 配对 file_uploaded，90s 超时
    func uploadViaGateway(chatId: String, name: String, data: Data) async throws -> String {
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
    func stripTrailingQuery(_ text: String) -> String {
        guard let range = text.range(of: #"(^|\s)@(\S*)$"#, options: .regularExpression) else { return text }
        let leading = text[range.lowerBound...].first.map { $0 == " " || $0 == "\n" ? String($0) : "" } ?? ""
        var out = text
        out.replaceSubrange(range, with: leading)
        return out
    }

    func appendMention(_ path: String, to chatId: String) {
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
}
