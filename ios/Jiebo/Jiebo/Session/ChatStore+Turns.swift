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
        guard chat.turnsComplete else {
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
        saveDraft(text == "（附图）" ? "" : text, forChat: targetId)
        let restoredImages: [PendingImage] = turn.images.compactMap { image -> PendingImage? in
            guard let data = Data(base64Encoded: image.data), !data.isEmpty else { return nil }
            return PendingImage(data: data, mimeType: image.mimeType, base64: image.data)
        }
        if targetId == activeId { pendingImages = restoredImages }
        else { imagesByChat[targetId] = restoredImages }
    }

    func retryTurn(_ turnId: String, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        guard client.isOpen else { return }
        guard !isBusy(targetId) else {
            flash("等当前这条跑完再重试")
            return
        }
        guard let chat = chatSession(targetId), let index = chat.turns.firstIndex(where: { $0.id == turnId }) else { return }
        guard chat.turnsComplete else {
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

    func applyPlan(_ turnId: String, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        guard client.isOpen, !isBusy(targetId) else {
            if isBusy(targetId) { flash("等当前这条跑完再执行") }
            return
        }
        guard let chat = chatSession(targetId), let turn = chat.turns.first(where: { $0.id == turnId }) else { return }
        guard !cachedOnlyIds.contains(chat.id) else {
            flash("正在同步会话，稍后再执行")
            return
        }
        chooseMode(.agent, chatId: targetId)
        let visible = "执行这个计划"
        let text = "请按你上一条计划开始执行，直接改文件，不要再只出方案。\n\n\(turn.assistant.prefix(4000))"
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
        send(.dropQueued(chatId: chat.id, text: turn.user))
    }

    func answerQuestion(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        draft = trimmed
        submit()
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
            bannerError = "图片需要在线发送，等连接恢复再发。"
            return
        }
        // 自动登录还没完成：send 会丢掉消息，草稿留着
        guard unlocked else {
            flash("正在连接服务器，稍后再发")
            return
        }
        // 冷启动缓存列表里的会话还没跟服务端对上：只读，草稿留着等同步完再发
        guard !cachedOnlyIds.contains(chatId) else {
            flash("正在同步会话，稍后再发")
            return
        }
        // 工作台 USER 根目录的普通占位不发；聊天主页助理会话本身就在根目录，允许发送。
        if let target = chats.first(where: { $0.id == chatId }),
           !isAssistantChat(target.id), target.turnsComplete, target.turns.isEmpty,
           isUserRoot(target.cwd?.nilIfEmpty ?? workspaceRoot) {
            flash("助理会话还在同步，稍后再发；要开普通对话请先选一个子工作区。")
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

    func stop(chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        send(.cancel(chatId: targetId))
        runningChatIds.removeAll { $0 == targetId }
        queuedChatIds.removeAll { $0 == targetId }
        patch(targetId) { chat in
            var next = chat
            next.turns = next.turns.map { turn in
                turn.running || turn.tools.contains(where: { $0.status == "running" })
                    ? turn.settled(status: "cancelled")
                    : turn
            }
            return next
        }
        stallTask?.cancel()
        clearStallHint()
    }

    func chooseModel(_ id: String, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
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

    func replyToApproval(allow: Bool, chatId requestedId: String? = nil) {
        let targetId = requestedId ?? activeId
        guard let chat = chatSession(targetId),
              let pending = chat.turns.last(where: { $0.pendingTool != nil })?.pendingTool
        else { return }
        send(.approvalReply(chatId: chat.id, callId: pending.callId, allow: allow))
        patchRunning(chat.id) { turn in
            var next = turn
            next.pendingTool = nil
            return next
        }
    }
}
