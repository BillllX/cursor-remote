import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    func editTurn(_ turnId: String) {
        guard !busy else {
            flash("等当前这条跑完再编辑")
            return
        }
        guard let chat = active, let index = chat.turns.firstIndex(where: { $0.id == turnId }) else { return }
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
        draft = text == "（附图）" ? "" : text
        pendingImages = turn.images.compactMap { image in
            guard let data = Data(base64Encoded: image.data), !data.isEmpty else { return nil }
            return PendingImage(data: data, mimeType: image.mimeType, base64: image.data)
        }
    }

    func retryTurn(_ turnId: String) {
        guard client.isOpen else { return }
        guard !busy else {
            flash("等当前这条跑完再重试")
            return
        }
        guard let chat = active, let index = chat.turns.firstIndex(where: { $0.id == turnId }) else { return }
        guard chat.turnsComplete else {
            flash("正文还在同步，稍后再重试")
            return
        }
        let turn = chat.turns[index]
        let visible = turn.user == "（附图）" && !turn.images.isEmpty ? "" : turn.user
        var next = Turn.blank(user: turn.user, model: turn.model ?? model, mode: turn.mode ?? mode, running: true)
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
            confirmWrites: chat.confirmWrites,
            autoApprove: nil,
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

    func applyPlan(_ turnId: String) {
        guard client.isOpen, !busy else {
            if busy { flash("等当前这条跑完再执行") }
            return
        }
        guard let chat = active, let turn = chat.turns.first(where: { $0.id == turnId }) else { return }
        guard !cachedOnlyIds.contains(chat.id) else {
            flash("正在同步会话，稍后再执行")
            return
        }
        chooseMode(.agent)
        let visible = "执行这个计划"
        let text = "请按你上一条计划开始执行，直接改文件，不要再只出方案。\n\n\(turn.assistant.prefix(4000))"
        let next = Turn.blank(user: visible, model: model, mode: .agent, running: true)
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
            model: model,
            mode: .agent,
            chatId: chat.id,
            files: nil,
            images: nil,
            confirmWrites: chat.confirmWrites,
            autoApprove: nil,
            fresh: nil,
            nameChat: chat.isUntitled,
            policy: chat.policy,
            history: ChatStore.externalHistory(model: model, turns: chat.turns),
            turnId: next.id
        ))
        markProgress(chat.id)
    }

    func dropQueuedTurn(_ turnId: String) {
        guard let chat = active, let turn = chat.turns.first(where: { $0.id == turnId && $0.queued }) else { return }
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
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = pendingImages
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
        ensureActiveChat()
        let chatId = activeId
        // 冷启动缓存列表里的会话还没跟服务端对上：只读，草稿留着等同步完再发
        guard !cachedOnlyIds.contains(chatId) else {
            flash("正在同步会话，稍后再发")
            return
        }
        // USER 根目录不开新的普通会话：等助理会话同步，或先选子工作区
        if let target = chats.first(where: { $0.id == chatId }),
           !isAssistantChat(target.id), target.turnsComplete, target.turns.isEmpty,
           isUserRoot(target.cwd?.nilIfEmpty ?? workspaceRoot) {
            if let home = assistantChat {
                // 输入的文字和图片跟着搬到助理会话，不留在看不见的占位里
                let carryText = draft
                select(home.id)
                patch(chatId) { chat in
                    var next = chat
                    next.draft = ""
                    return next
                }
                imagesByChat[chatId] = nil
                draft = carryText
                pendingImages = images
            } else {
                flash("助理会话还在同步，稍后再发；要开普通对话请先选一个子工作区。")
            }
            return
        }
        let untitled = chats.first { $0.id == chatId }?.isUntitled ?? true
        // P11：第三方模型无状态——历史随 prompt 上行；须在本地 turn 追加前组装（否则把当前消息也装进去）
        let history = ChatStore.externalHistory(model: model, turns: active?.turns ?? [])
        // 对齐网页端：纯图时本地占位「（附图）」，prompt.text 留空由网关兜底
        var turn = Turn.blank(user: text.isEmpty ? "（附图）" : text, model: model, mode: mode, running: !busy)
        turn.images = images.map(\.promptImage)
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
        // P8 slim：turns 未加载完时的本地新 turn——登记后补齐时保留它，直到分页完成（Grok 评审 M2）
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
        clearStallHint()
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

    func replyToApproval(allow: Bool) {
        guard let chat = active, let pending = chat.turns.last(where: { $0.pendingTool != nil })?.pendingTool else { return }
        send(.approvalReply(chatId: chat.id, callId: pending.callId, allow: allow))
        patchRunning(chat.id) { turn in
            var next = turn
            next.pendingTool = nil
            return next
        }
    }
}
