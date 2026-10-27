import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    func openNewChat() {
        let path = currentWorkspacePath
        guard !path.isEmpty, !isUserRoot(path) else {
            openWorkspaceSwitcher()
            return
        }
        startChat(in: path)
    }

    func openWorkspaceSwitcher() {
        requestWorkspaces(force: true)
        creatingWorkspace = false
        newWorkspaceName = ""
        workspaceSheetOpen = true
    }

    /// 只刷新工作区列表，给侧栏「新对话」菜单用，不打开另一张表。
    func refreshWorkspaces() {
        requestWorkspaces(force: true)
    }

    func requestWorkspaces(force: Bool = false) {
        guard connected, unlocked, gatewayReady else { return }
        if workspacesSyncInFlight {
            if force { workspacesForcePending = true }
            return
        }
        workspacesSyncGeneration &+= 1
        workspacesSyncInFlight = true
        workspacesInFlightGeneration = workspacesSyncGeneration
        send(.listWorkspaces)
    }

    func receiveWorkspaces(root: String, items: [WorkspaceItem]) {
        workspaces = items
        if workspaceRoot.isEmpty, let first = items.first { workspaceRoot = first.path }
        updateCachedWorkspaces(root: root, items: items)
        if workspacesSyncInFlight,
           workspacesInFlightGeneration == workspacesSyncGeneration {
            // A response or a newer broadcast both satisfy the one outstanding refresh.
            let forceAgain = workspacesForcePending
            workspacesSyncInFlight = false
            workspacesInFlightGeneration = nil
            workspacesForcePending = false
            if forceAgain { requestWorkspaces(force: true) }
        }
    }

    /// 切到这个工作区：有会话就打开最近的一条，没有就新建。
    func switchWorkspace(to path: String) {
        let next = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return }
        workspaceSheetOpen = false
        creatingWorkspace = false
        if isUserRoot(next) {
            openAssistantEntry()
            return
        }
        let key = normPath(next)
        if let chat = sidebarChats.first(where: { normPath($0.cwd?.nilIfEmpty ?? groupRoot) == key }) {
            if chat.id != activeId { select(chat.id) }
            return
        }
        startChat(in: next)
    }

    /// 新对话只能开在子工作区；USER 根目录留给助理会话
    func startChat(in path: String) {
        // iPhone（assistantOnly）不开工作区会话：改回助理会话，不建占位、不发 new_session，也不动草稿
        if assistantOnly {
            openAssistantChat()
            return
        }
        let next = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return }
        guard !isUserRoot(next) else {
            openWorkspaceSwitcher()
            return
        }
        pendingAssistantOpen = false
        workspaceSheetOpen = false
        creatingWorkspace = false
        persistDraft()
        if let existing = chats.first(where: { !isAssistantChat($0.id) && $0.isUntitled && $0.turnsComplete && $0.turns.isEmpty && sameCwd($0.cwd?.nilIfEmpty ?? groupRoot, next) }) {
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
        var chat = ChatSession.blank(cwd: next, model: lastModel.nilIfEmpty ?? model, mode: .agent)
        chat.touchedAt = Date().timeIntervalSince1970 * 1000
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

    func renameWorkspace(_ path: String, to rawName: String) {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        send(.renameWorkspace(path: path, name: name))
    }

    /// 空目录网关直接删；里面有文件只隐藏；还有对话会被拒（错误走顶部提示）
    func deleteWorkspace(_ path: String) {
        send(.deleteWorkspace(path: path))
    }

    /// 清空某个工作区下的全部对话（目录和文件不动）。有对话在跑时不处理，免得误伤
    func clearWorkspaceChats(_ path: String) {
        let ids = chats
            .filter { !isAssistantChat($0.id) && $0.id != "boot" && isChatUnder($0, path) }
            .map(\.id)
        guard !ids.isEmpty else {
            flash("这个工作区里没有对话")
            return
        }
        let busy = Set(runningChatIds)
        if chats.contains(where: { ids.contains($0.id) && ($0.turns.contains(where: \.running) || busy.contains($0.id)) }) {
            flash("有对话正在运行，先停掉再清空")
            return
        }
        // 当前打开的最后删：它被删时才会切到别的会话，前面删的都不会影响选中项
        let order = ids.filter { $0 != activeId } + ids.filter { $0 == activeId }
        var removed = 0
        for id in order {
            deleteChat(id)
            // 有未保存的修改时 deleteChat 会先问用户，没删成就别往下删了
            if !deletedIds.contains(id) { break }
            removed += 1
        }
        flash(removed == ids.count ? "已清空 \(ids.count) 个对话" : "已删除 \(removed) 个，其余因有未保存的修改保留")
    }

    /// 开始或结束回复时记一下时间：侧栏按它给工作区排序、显示「几分钟前」
    func touchChat(_ id: String) {
        guard id != "boot", !isAssistantChat(id) else { return }
        let now = Date().timeIntervalSince1970 * 1000
        patch(id) { chat in
            var next = chat
            next.touchedAt = now
            return next
        }
    }

    /// P9：管理员拉全租户统计（非管理员发了也会被网关拒，入口按 isAdmin 隐藏）
    func requestAdminStats() {
        guard isAdmin else { return }
        send(.adminStats)
    }

    func select(_ requestedId: String) {
        var id = requestedId
        if assistantOnly, let assistantId = assistantChatId, id != assistantId {
            // iPhone：任何想切到工作区会话的路径都改成助理会话；助理会话还没同步到就记下意图，到了再切
            guard chats.contains(where: { $0.id == assistantId }) else {
                pendingAssistantOpen = true
                return
            }
            id = assistantId
        }
        pendingAssistantOpen = false
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
    func swapActive(to newId: String) {
        var newId = newId
        if assistantOnly, let assistantId = assistantChatId, newId != assistantId {
            // 任何路径（恢复上次会话、删除回落、网关 workspace_created……）想切到工作区会话，都改成助理会话。
            // 助理会话还没同步到就不切，留在当前页，等它到了由 fulfillPendingAssistantOpen 接上
            guard chats.contains(where: { $0.id == assistantId }) else {
                pendingAssistantOpen = true
                return
            }
            newId = assistantId
        }
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
        checkpoints = []
        notedCheckpointId = nil
        refreshCheckpoints()
        searchHits = []
        searchTruncated = false
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
        guard !isAssistantChat(id) else { return }
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
        forgetBodyCache(id)
        cachedOnlyIds.remove(id)
        removeCachedFileIndex(chatId: id)
        fileIndexInFlight.removeValue(forKey: id)
        fileIndexSyncGeneration.removeValue(forKey: id)
        fileIndexRequestIds.removeValue(forKey: id)
        fileIndexForcePending.remove(id)
        fileIndexUpdatedAt.removeValue(forKey: id)
        fileIndexBroadcastAt.removeValue(forKey: id)
        fileIndexFallbackTasks.removeValue(forKey: id)?.cancel()
        fileIndexTimeoutTasks.removeValue(forKey: id)?.cancel()
        if fileIndexRequestChatId == id { fileIndexRequestChatId = nil }
        var rest = chats.filter { $0.id != id }
        if rest.isEmpty {
            let place = cwd.nilIfEmpty ?? workspaceRoot
            // 占位在 USER 根目录时复用 boot 空壳：不同步、不开会话，等助理会话同步后切过去
            let atRoot = place.isEmpty || isUserRoot(place)
            let chat = atRoot
                ? ChatSession.blank(id: "boot", cwd: place.nilIfEmpty, model: lastModel.nilIfEmpty ?? model, mode: mode)
                : ChatSession.blank(cwd: place, model: lastModel.nilIfEmpty ?? model, mode: mode)
            rest = [chat]
            if atRoot {
                pendingAssistantOpen = true
            } else {
                send(.newSession(chatId: chat.id, cwd: chat.cwd))
                if let nextModel = chat.model {
                    send(.setModel(model: nextModel, chatId: chat.id))
                }
            }
        }
        chats = rest
        if id == activeId, let first = rest.first {
            pendingImages = [] // 被删会话的待发图随会话丢弃（swapActive 会把空数组 flush 到已删 id）
            swapActive(to: first.id)
            applySession(chats.first { $0.id == activeId }) // swapActive 可能被 assistantOnly 改道，不能再用原始的 first
        }
        scheduleSync()
    }

    func ensureActiveChat() {
        if chats.isEmpty {
            let place = cwd.nilIfEmpty ?? workspaceRoot
            let atRoot = place.isEmpty || isUserRoot(place)
            let chat = ChatSession.blank(id: atRoot ? "boot" : UUID().uuidString.lowercased(), cwd: place.nilIfEmpty, model: model, mode: mode)
            chats = [chat]
            swapActive(to: chat.id) // P9：统一入口——持久化 lastActive、置换草稿/待发图归属
            if !atRoot { send(.newSession(chatId: chat.id, cwd: chat.cwd)) }
        }
    }

    func persistDraft() {
        patch(activeId) { chat in
            var next = chat
            next.draft = self.draft
            next.model = self.model
            next.mode = self.mode
            return next
        }
    }
}
