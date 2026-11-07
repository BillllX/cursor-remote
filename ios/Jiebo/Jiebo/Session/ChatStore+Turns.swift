import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    func editTurn(_ turnId: String, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        guard !isBusy(targetId) else {
            flash("等当前这条跑完再编辑")
            return
        }
        guard let chat = chatSession(targetId), let index = chat.turns.firstIndex(where: { $0.id == turnId }) else { return }
        // 显示的是旧正文（还在补齐）：截断不会随 sync_chat 上去，补齐完成又被服务端盖回
        guard canMutateLoadedTurn(turnId, chat: chat) else {
            flash("正文还在同步，稍后再编辑")
            return
        }
        let turn = chat.turns[index]
        let text = turn.user
        sendTruncate(chatId: chat.id, turnId: turnId)
        patch(chat.id) { item in
            var next = item
            next.turns = Array(item.turns.prefix(index))
            next.agentId = nil
            return next
        }
        forgetBodyCache(chat.id) // 截断回合：本机缓存作废
        send(.newSession(chatId: chat.id, cwd: chat.cwd))
        applyExternalDraft(text == "（附图）" ? "" : text, forChat: targetId)
        let restoredImages: [PendingImage] = turn.images.compactMap { image -> PendingImage? in
            guard let data = Data(base64Encoded: image.data), !data.isEmpty else { return nil }
            return PendingImage(data: data, mimeType: image.mimeType, base64: image.data)
        }
        if targetId == activeId { pendingImages = restoredImages }
        else { imagesByChat[targetId] = restoredImages }
        if !client.isOpen {
            flash(linkState == .offline
                ? "已断开。这句话已放回输入框，连上后才会改到服务器。"
                : "正在连接。这句话已放回输入框，连上后才会改到服务器。")
        }
    }

    func retryTurn(_ turnId: String, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        guard client.isOpen else {
            flash(linkState == .offline ? "已断开，点按重连后再重试" : "正在连接，连上后再重试")
            return
        }
        guard !isBusy(targetId) else {
            flash("等当前这条跑完再重试")
            return
        }
        guard let chat = chatSession(targetId), let index = chat.turns.firstIndex(where: { $0.id == turnId }) else { return }
        guard canMutateLoadedTurn(turnId, chat: chat) else {
            flash("正文还在同步，稍后再重试")
            return
        }
        let turn = chat.turns[index]
        let visible = turn.user == "（附图）" && !turn.images.isEmpty ? "" : turn.user
        var next = Turn.blank(
            user: turn.user,
            model: turn.model ?? model(for: targetId),
            mode: turn.mode ?? mode(for: targetId),
            running: true
        )
        next.id = turn.id
        next.images = turn.images
        let prior = Array(chat.turns.prefix(index))
        let history = ChatStore.externalHistory(model: next.model, turns: prior)
        let mentions = ChatStore.extractMentions(turn.user)
        sendTruncate(chatId: chat.id, turnId: turnId)
        patch(chat.id) { item in
            var row = item
            row.turns = prior + [next]
            row.agentId = nil
            return row
        }
        forgetBodyCache(chat.id) // 截断回合：本机缓存作废
        send(.prompt(
            text: visible,
            model: next.model,
            mode: next.mode,
            chatId: chat.id,
            files: mentions.isEmpty ? nil : mentions,
            images: turn.images.isEmpty ? nil : turn.images,
            confirmWrites: workspaceAgent(chatId: targetId) == nil ? chat.confirmWrites : false,
            autoApprove: workspaceAgent(chatId: targetId) == nil ? nil : false,
            fresh: true,
            nameChat: chat.isUntitled,
            policy: chat.policy,
            history: history,
            turnId: next.id
        ))
        markProgress(chat.id)
    }

    /// 截断由网关执行：sync_chat 不带正文，本地截掉的回合只能这样告诉服务端
    func sendTruncate(chatId: String, turnId: String) {
        stateRev += 1
        truncateBases[chatId] = chatRevs[chatId]
        send(.truncateTurns(chatId: chatId, turnId: turnId, rev: stateRev))
    }

    /// 完整正文可照旧操作；partial 只允许版本仍确认、当前不在补页且目标不是 deferred 的尾页回合。
    private func canMutateLoadedTurn(_ turnId: String, chat: ChatSession) -> Bool {
        guard let turn = chat.turns.first(where: { $0.id == turnId }), !turn.deferred else { return false }
        if chat.turnsComplete { return true }
        guard let partial = partialHistories[chat.id],
              partial.chatRev == chatRevs[chat.id],
              !loadingChatIds.contains(chat.id),
              !refreshingChatIds.contains(chat.id)
        else { return false }
        return true
    }

    func applyPlan(_ turnId: String, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        guard client.isOpen else {
            flash(linkState == .offline ? "已断开，点按重连后再执行" : "正在连接，连上后再执行")
            return
        }
        guard !isBusy(targetId) else {
            flash("等当前这条跑完再执行")
            return
        }
        guard let chat = chatSession(targetId),
              let turn = chat.turns.first(where: { $0.id == turnId }),
              !turn.deferred
        else { return }
        guard !cachedOnlyIds.contains(chat.id) else {
            flash("这条对话还没对上服务器，稍后再执行")
            return
        }
        chooseMode(.agent, chatId: targetId)
        let visible = "执行这个计划"
        let text = "请按你上一条计划开始执行，直接改文件，不要再只出方案。\n\n\(ReplyText.repair(String(turn.assistant.prefix(4000))))"
        let targetModel = model(for: targetId)
        let next = Turn.blank(user: visible, model: targetModel, mode: .agent, running: true)
        patch(chat.id) { item in
            var row = item
            row.turns.append(next)
            row.mode = .agent
            return row
        }
        // 旧正文还在补齐时追加的回合：同 submit，补齐完成后补一次全量回推
        if !chat.turnsComplete { localTurnsPendingSync.insert(chat.id) }
        flash("按计划开始执行")
        send(.prompt(
            text: text,
            model: targetModel,
            mode: .agent,
            chatId: chat.id,
            files: nil,
            images: nil,
            confirmWrites: workspaceAgent(chatId: targetId) == nil ? chat.confirmWrites : false,
            autoApprove: workspaceAgent(chatId: targetId) == nil ? nil : false,
            fresh: nil,
            nameChat: chat.isUntitled,
            policy: chat.policy,
            history: ChatStore.externalHistory(model: targetModel, turns: chat.turns),
            turnId: next.id
        ))
        markProgress(chat.id)
    }

    func dropQueuedTurn(_ turnId: String, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        guard let chat = chatSession(targetId),
              let turn = chat.turns.first(where: { $0.id == turnId && $0.queued })
        else { return }
        patch(chat.id) { item in
            var next = item
            next.turns.removeAll { $0.id == turnId }
            return next
        }
        let removed = client.removePendingPrompts(chatId: chat.id, turnIds: [turn.id])
        if !removed.contains(turn.id) {
            send(.dropQueued(chatId: chat.id, text: turn.user))
        }
    }

    func answerQuestion(_ text: String, chatId requestedId: String? = nil) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let targetId = requestedId?.nilIfEmpty ?? activeId
        let savedDraft = draft(for: targetId)
        submit(chatId: targetId, text: trimmed)
        if !savedDraft.isEmpty {
            applyExternalDraft(savedDraft, forChat: targetId)
        }
    }

    func submit() {
        submit(chatId: activeId, text: draft)
    }

    func submit(chatId: String, text rawText: String) {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = pendingImages(for: chatId)
        guard !text.isEmpty || !images.isEmpty else { return }
        // 带图 prompt 不进 outbox（base64 太大），掉线时直接拒发
        if !images.isEmpty, !client.isOpen {
            bannerError = Self.offlineImageTitle
            return
        }
        // 自动登录还没完成：send 会丢掉消息，草稿留着
        guard unlocked else {
            flash(linkState == .offline ? "已断开，稍后再发" : "正在连接，稍后再发")
            return
        }
        // 冷启动缓存列表里的会话还没跟服务端对上：只读，草稿留着等同步完再发
        guard !cachedOnlyIds.contains(chatId) else {
            flash("这条对话还没对上服务器，稍后再发")
            return
        }
        // 工作台 USER 根目录的普通占位不发；聊天主页助理会话本身就在根目录，允许发送。
        if let target = chats.first(where: { $0.id == chatId }),
           !isAssistantChat(target.id), target.turnsComplete, target.turns.isEmpty,
           isUserRoot(target.cwd?.nilIfEmpty ?? workspaceRoot) {
            flash("先选一个子文件夹，再发。")
            openWorkspaceSwitcher()
            return
        }
        guard let session = chatSession(chatId) else { return }
        let untitled = chats.first { $0.id == chatId }?.isUntitled ?? true
        let targetModel = model(for: chatId)
        let targetMode = mode(for: chatId)
        // P11：第三方模型无状态——历史随 prompt 上行；须在本地 turn 追加前组装（否则把当前消息也装进去）
        let history = ChatStore.externalHistory(model: targetModel, turns: session.turns)
        // 对齐网页端：纯图时本地占位「（附图）」，prompt.text 留空由网关兜底
        var turn = Turn.blank(
            user: text.isEmpty ? "（附图）" : text,
            model: targetModel,
            mode: targetMode,
            running: !isBusy(chatId)
        )
        turn.images = images.map(\.promptImage)
        if chatId == activeId {
            draft = ""
            pendingImages = []
        }
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
        // P8 slim：turns 未加载完时的本地新 turn——登记后补齐时保留它，直到分页完成（Grok 评审 M2）
        if chats.first(where: { $0.id == chatId })?.turnsComplete == false {
            localTurnsPendingSync.insert(chatId)
        }
        let mentions = ChatStore.extractMentions(text)
        send(.prompt(
            text: text,
            model: targetModel,
            mode: targetMode,
            chatId: chatId,
            files: mentions.isEmpty ? nil : mentions,
            images: images.isEmpty ? nil : images.map(\.promptImage),
            confirmWrites: workspaceAgent(chatId: chatId) == nil ? session.confirmWrites : false,
            autoApprove: workspaceAgent(chatId: chatId) == nil ? nil : false,
            fresh: nil,
            nameChat: untitled,
            policy: session.policy,
            history: history,
            turnId: turn.id
        ))
        if client.isOpen { markProgress(chatId) }
    }

    /// P11：第三方模型（id 形如 "provider:model"）无状态，历史随 prompt 上行；
    /// 截断口径与网关一致：最近 12 条、每条 3000 字符；排队/出错/空消息跳过
    /// （error turn 的残缺回复不进上下文，GLM/Grok 评审 m3）。
    /// 注意：history 在提交时组装——排队期间完成的 turn 不在其内（客户端权威设计的固有权衡）
    static func externalHistory(model: String?, turns: [Turn]) -> [HistoryItem]? {
        guard let model, model.contains(":") else { return nil }
        var items: [HistoryItem] = []
        for t in turns where !t.queued && t.error == nil && !t.deferred {
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

    /// 只拿掉这一句。同一条对话里其他还没发出的句子不动。服务器已经在跑的不走这里。
    func cancelUnsentTurn(_ turnId: String, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        guard !client.isOpen, !runningChatIds.contains(targetId) else { return }
        guard let chat = chats.first(where: { $0.id == targetId }),
              let turn = chat.turns.first(where: { $0.id == turnId }),
              turn.running || turn.queued,
              turn.assistant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              turn.thinking.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              turn.tools.isEmpty,
              turn.pendingTool == nil
        else { return }
        _ = client.removePendingPrompts(chatId: targetId, turnIds: [turnId])
        patch(targetId) { item in
            var next = item
            next.turns = next.turns.compactMap { row in
                guard row.id == turnId else { return row }
                if row.queued { return nil }
                return row.settled(status: "cancelled")
            }
            return next
        }
        let existing = (targetId == activeId ? draft : chats.first { $0.id == targetId }?.draft) ?? ""
        let trimmed = turn.user.trimmingCharacters(in: .whitespacesAndNewlines)
        if existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           !trimmed.isEmpty, trimmed != "（附图）" {
            applyExternalDraft(turn.user, forChat: targetId)
        }
    }

    /// 断开后本地刚记下、服务器还没开始的那些回合。没有的话返回 nil。
    func localOnlyWaitTurnIds(_ chatId: String) -> Set<String>? {
        guard !client.isOpen, !runningChatIds.contains(chatId) else { return nil }
        guard let chat = chats.first(where: { $0.id == chatId }) else { return nil }
        let live = chat.turns.filter(\.running)
        guard !live.isEmpty else { return nil }
        let waiting = live.allSatisfy { turn in
            turn.assistant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && turn.thinking.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && turn.tools.isEmpty
                && turn.pendingTool == nil
        }
        guard waiting else { return nil }
        return Set(live.map(\.id))
    }

    func stop(chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        let localOnly = localOnlyWaitTurnIds(targetId)
        var droppedLocalQueued = Set<String>()
        flushStreamDeltas(targetId)
        if let localOnly {
            let queuedIds = Set(
                (chats.first { $0.id == targetId }?.turns ?? []).filter(\.queued).map(\.id)
            )
            let removed = client.removePendingPrompts(
                chatId: targetId,
                turnIds: localOnly.union(queuedIds)
            )
            droppedLocalQueued = queuedIds
            if let chat = chats.first(where: { $0.id == targetId }) {
                for turn in chat.turns where queuedIds.subtracting(removed).contains(turn.id) {
                    send(.dropQueued(chatId: targetId, text: turn.user))
                }
            }
        } else {
            send(.cancel(chatId: targetId))
        }
        runningChatIds.removeAll { $0 == targetId }
        queuedChatIds.removeAll { $0 == targetId }
        syncLiveBusy(targetId)
        patch(targetId) { chat in
            var next = chat
            next.turns = next.turns.compactMap { turn in
                if droppedLocalQueued.contains(turn.id) { return nil }
                if turn.running || turn.tools.contains(where: { $0.status == "running" }) {
                    return turn.settled(status: "cancelled")
                }
                return turn
            }
            return next
        }
        stallTask?.cancel()
        stallTask = nil
        stallChatId = nil
        clearStallHint()
        clearStallRecoveryNotice()
        if localOnly != nil {
            restoreLastPromptIfDraftEmpty(chatId: targetId)
        }
    }

    /// 卡住后停下：输入框是空的，就把刚停掉的那一句放回去，方便再发。
    func restoreLastPromptIfDraftEmpty(chatId: String) {
        let existing = (chatId == activeId ? draft : chats.first { $0.id == chatId }?.draft) ?? ""
        guard existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard let chat = chats.first(where: { $0.id == chatId }) else { return }
        guard let text = chat.turns.reversed().lazy.compactMap({ turn -> String? in
            guard turn.status == "cancelled" else { return nil }
            let trimmed = turn.user.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed != "（附图）" else { return nil }
            return turn.user
        }).first else { return }
        applyExternalDraft(text, forChat: chatId)
    }

    /// 执行失败后输入框是空的，就把最近一句放回去。不自动发送。
    func restoreFailedPromptIfDraftEmpty(chatId: String) {
        let existing = (chatId == activeId ? draft : chats.first { $0.id == chatId }?.draft) ?? ""
        guard existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard let chat = chats.first(where: { $0.id == chatId }) else { return }
        guard let text = chat.turns.reversed().lazy.compactMap({ turn -> String? in
            let trimmed = turn.user.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed != "（附图）" else { return nil }
            return turn.user
        }).first else { return }
        applyExternalDraft(text, forChat: chatId)
    }

    /// 消息大到发不出去时，把刚放进对话的那一轮拿掉，原文回到输入框。不自动重发。
    func restoreOversizedSend(_ message: ClientMessage) {
        guard case let .prompt(text, _, _, chatId, _, images, _, _, _, _, _, _, turnId) = message else { return }
        if let turnId {
            patch(chatId) { chat in
                var next = chat
                next.turns.removeAll {
                    $0.id == turnId && $0.assistant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }
                return next
            }
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, draft(for: chatId).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            applyExternalDraft(text, forChat: chatId)
        }
        guard pendingImages(for: chatId).isEmpty, let images, !images.isEmpty else { return }
        let restored = images.compactMap { image -> PendingImage? in
            guard let data = Data(base64Encoded: image.data), !data.isEmpty else { return nil }
            return PendingImage(data: data, mimeType: image.mimeType, base64: image.data)
        }
        guard !restored.isEmpty else { return }
        if chatId == activeId {
            pendingImages = restored
        } else {
            imagesByChat[chatId] = restored
        }
    }

    /// 换模型或策略层。还没登录、或对话还没对上服务器时不改。没连上时先在这台设备改，并说明连上后才告诉服务器。
    func noteChatSettingDelivery(chatId: String, what: String) -> Bool {
        guard unlocked else {
            flash("还没登录。这次不会排队，登录后再改。")
            return false
        }
        guard !cachedOnlyIds.contains(chatId) else {
            flash("这条对话还没对上服务器，改\(what)不会留下。")
            return false
        }
        guard !client.isOpen else { return true }
        flash(linkState == .offline
            ? "已断开。这台设备已改了\(what)，连上后才会告诉服务器。"
            : "正在连接。这台设备已改了\(what)，连上后才会告诉服务器。")
        return true
    }

    func chooseModel(_ id: String, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        guard noteChatSettingDelivery(chatId: targetId, what: "模型") else { return }
        if targetId == activeId {
            model = id
            rememberModel(id)
        }
        patch(targetId) { chat in
            var next = chat
            next.model = id
            return next
        }
        send(.setModel(model: id, chatId: targetId))
    }

    func chooseMode(_ value: AgentMode, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        if targetId == activeId { mode = value }
        patch(targetId) { chat in
            var next = chat
            next.mode = value
            return next
        }
    }

    /// 待批决定还没对上服务器、或还没登录时不发，卡片留着。没连上时先在这台设备记下，并说明连上后才告诉服务器。
    func noteApprovalDelivery(chatId: String) -> Bool {
        guard unlocked else {
            flash("还没登录。这次不会排队，登录后再决定。")
            return false
        }
        guard !cachedOnlyIds.contains(chatId) else {
            flash("这条对话还没对上服务器，这次决定不会留下。")
            return false
        }
        guard !client.isOpen else { return true }
        flash(linkState == .offline
            ? "已断开。这台设备已记下这次决定，连上后才会告诉服务器。"
            : "正在连接。这台设备已记下这次决定，连上后才会告诉服务器。")
        return true
    }

    func replyToApproval(allow: Bool, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        guard let chat = chatSession(targetId),
              let pending = chat.turns.last(where: { $0.pendingTool != nil })?.pendingTool
        else { return }
        guard noteApprovalDelivery(chatId: chat.id) else { return }
        send(.approvalReply(chatId: chat.id, callId: pending.callId, allow: allow))
        patchRunning(chat.id) { turn in
            var next = turn
            next.pendingTool = nil
            return next
        }
    }
}
