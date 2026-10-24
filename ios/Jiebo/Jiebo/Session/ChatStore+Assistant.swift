import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    // MARK: 个人助理

    /// 入口角标：未读收件箱 + 待批
    var assistantBadgeCount: Int {
        guard let state = assistantState else { return 0 }
        return state.unreadInbox + state.approvals.count
    }

    /// 停在审批上的委派子会话里，父会话是 parentId 的那些
    func assistantApprovals(forParent parentId: String) -> [AssistantApproval] {
        guard let state = assistantState, !parentId.isEmpty else { return [] }
        let delegationIds = Set(state.delegations.filter { $0.parentChatId == parentId }.map(\.id))
        return state.approvals.filter { approval in
            if let delegationId = approval.delegationId, delegationIds.contains(delegationId) { return true }
            return approval.parentChatId == parentId
        }
    }

    func requestAssistant(memory: Bool = false) {
        send(.assistantGet(memory: memory))
    }

    func assistantOp(_ op: String, args: [String: JSONValue] = [:]) {
        send(.assistantOp(op: op, args: args, reqId: UUID().uuidString))
    }

    /// 发 assistant_op 并等网关的 assistant_result（按 reqId 配对）。没连上直接 false；超时或断线也是 false
    func assistantOpReply(_ op: String, args: [String: JSONValue] = [:], timeout: Duration) async -> Bool {
        guard connected, unlocked else { return false }
        let reqId = UUID().uuidString
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            assistantReplyWaiters[reqId] = { ok in continuation.resume(returning: ok) }
            send(.assistantOp(op: op, args: args, reqId: reqId))
            // 强引用：store 活到超时，保证 continuation 一定被 resume
            Task { @MainActor in
                try? await Task.sleep(for: timeout)
                self.assistantReplyWaiters.removeValue(forKey: reqId)?(false)
            }
        }
    }

    /// 断线：在等的回包不会来了
    func failAssistantReplyWaiters() {
        let waiters = assistantReplyWaiters
        assistantReplyWaiters = [:]
        for waiter in waiters.values { waiter(false) }
    }

    func answerAssistantApproval(_ approval: AssistantApproval, allow: Bool) {
        assistantOp("approval_answer", args: [
            "chatId": .string(approval.chatId),
            "callId": .string(approval.callId),
            "allow": .bool(allow),
        ])
        assistantState?.approvals.removeAll { $0.id == approval.id }
    }

    func openAssistantInboxItem(_ item: AssistantInboxItem) {
        if !item.read {
            assistantOp("inbox_read", args: ["ids": .array([.string(item.id)])])
            if let index = assistantState?.inbox.firstIndex(where: { $0.id == item.id }) {
                assistantState?.inbox[index].read = true
            }
        }
        if let chatId = item.chatId {
            openAssistantChat(chatId)
        } else {
            toolLayer = nil
            openAssistantChat()
        }
        if let prompt = item.actionPrompt, let assistantChatId {
            submit(chatId: assistantChatId, text: prompt)
        }
    }

    /// iPhone 兼容入口：保持原有切到小驳主会话的行为。
    @discardableResult
    func continueArtifact(_ artifact: Artifact) -> Bool {
        continueArtifact(artifact, selectAssistant: true)
    }

    /// iPad 续作入口：由 PadRouter 切域，不触碰工作台 activeId。
    @discardableResult
    func continueArtifactOnPad(_ artifact: Artifact) -> Bool {
        continueArtifact(artifact, selectAssistant: false)
    }

    /// 产物续作始终定向助理主会话，并保留用户正在输入的草稿。
    private func continueArtifact(_ artifact: Artifact, selectAssistant: Bool) -> Bool {
        guard connected, unlocked else {
            flash("尚未连接服务器，暂时不能继续加工")
            return false
        }
        guard let assistantChatId,
              chats.contains(where: { $0.id == assistantChatId })
        else {
            pendingAssistantOpen = true
            flash("小驳主会话还在同步，请稍后再试")
            return false
        }
        let source = artifact.provenance?.label ?? {
            if let turn = artifact.sourceTurnId { return "会话回合 \(turn)" }
            if let inbox = artifact.provenance?.inboxId { return "助理收件箱 \(inbox)" }
            return "产物中心"
        }()
        let target: String
        if let path = artifact.path {
            target = "工作区相对路径：\(path)"
        } else if let url = artifact.safeURL?.absoluteString {
            target = "来源 URL：\(url)"
        } else {
            target = "捕获记录：\(artifact.title)（ID：\(artifact.provenance?.captureId ?? artifact.id)）"
        }
        let prompt = """
        请继续加工这个产物，并先确认你理解它的来源。
        产物：\(artifact.title)
        来源：\(source)
        \(target)
        """
        let savedDraft = draft(for: assistantChatId)
        if selectAssistant { openAssistantChat() }
        submit(chatId: assistantChatId, text: prompt)
        saveDraft(savedDraft, forChat: assistantChatId)
        flash("已交给小驳继续处理")
        return true
    }

    /// 执行统一任务投影附带的既有动作；只允许协议已经定义的操作。
    func performPersonalTaskAction(_ action: PersonalTaskAction) {
        switch action.op {
        case "todo_done", "todo_undo":
            guard let id = action.id else { return }
            assistantOp(action.op, args: ["id": .string(id)])
            if let index = assistantState?.todos.firstIndex(where: { $0.id == id }) {
                let done = action.op == "todo_done"
                assistantState?.todos[index].done = done
                assistantState?.todos[index].doneAt = done ? Date().timeIntervalSince1970 * 1000 : nil
            }
        case "schedule_set":
            guard let id = action.id, let enabled = action.enabled else { return }
            assistantSetScheduleEnabled(id, enabled: enabled)
        case "delegation_cancel":
            guard let delegationId = action.delegationId else { return }
            assistantOp("delegation_cancel", args: ["delegationId": .string(delegationId)])
        case "approval_answer":
            guard let chatId = action.chatId, let callId = action.callId, let allow = action.allow else { return }
            assistantOp("approval_answer", args: [
                "chatId": .string(chatId),
                "callId": .string(callId),
                "allow": .bool(allow),
            ])
            assistantState?.approvals.removeAll { $0.chatId == chatId && $0.callId == callId }
        default:
            flash("这个操作需要更新后才能执行")
        }
    }

    /// iPad 收件箱动作：固定提交到小驳主会话，不选择工作台会话。
    @discardableResult
    func handlePadInboxItem(_ item: AssistantInboxItem) -> Bool {
        if !item.read {
            assistantOp("inbox_read", args: ["ids": .array([.string(item.id)])])
            if let index = assistantState?.inbox.firstIndex(where: { $0.id == item.id }) {
                assistantState?.inbox[index].read = true
            }
        }
        guard let prompt = item.actionPrompt else { return true }
        guard let assistantChatId, chats.contains(where: { $0.id == assistantChatId }) else {
            flash("小驳主会话还在同步，请稍后再试")
            return false
        }
        let savedDraft = draft(for: assistantChatId)
        submit(chatId: assistantChatId, text: prompt)
        saveDraft(savedDraft, forChat: assistantChatId)
        return true
    }

    /// 语义拖放只在实体仍存在且在线时提交；Prompt 没有服务端幂等回执，不能伪装成离线已入队。
    @discardableResult
    func continuePadTransfer(_ transfer: PadSemanticTransfer) -> Bool {
        guard transfer.isValid else {
            flash("拖入的项目已经失效")
            return false
        }
        guard connected, unlocked else {
            flash("尚未连接服务器；此操作不会离线排队，请连接后重试")
            return false
        }
        let projection = PadAssistantProjection(state: assistantState)
        guard projection.contains(transfer) else {
            flash("这个项目已更新或失效，请刷新后重试")
            return false
        }
        if transfer.kind == .artifact,
           let artifact = projection.artifacts.first(where: { $0.id == transfer.stableID }) {
            return continueArtifactOnPad(artifact)
        }
        guard let assistantChatId, chats.contains(where: { $0.id == assistantChatId }) else {
            flash("小驳主会话还在同步，请稍后再试")
            return false
        }
        let kind: String
        switch transfer.kind {
        case .task: kind = "任务"
        case .inbox: kind = "待处理事项"
        case .draft: kind = "行动卡"
        case .artifact: kind = "产物"
        }
        let prompt = "请继续处理这项\(kind)：\(transfer.title)\n稳定 ID：\(transfer.stableID)"
        let savedDraft = draft(for: assistantChatId)
        submit(chatId: assistantChatId, text: prompt)
        saveDraft(savedDraft, forChat: assistantChatId)
        flash("已交给小驳继续处理")
        return true
    }

    func isAssistantChat(_ id: String?) -> Bool {
        guard let id, let assistantChatId else { return false }
        return id == assistantChatId
    }

    var assistantChat: ChatSession? {
        guard let assistantChatId else { return nil }
        return chats.first { $0.id == assistantChatId }
    }

    var assistantChatActive: Bool { isAssistantChat(activeId) }

    /// 置顶入口的一行摘要：最后一条消息；正文没加载时用网关下发的摘要
    var assistantPreview: String {
        guard let chat = assistantChat else { return "" }
        let turn = chat.turns.last
        let last: String = turn?.assistant.nilIfEmpty ?? turn?.user.nilIfEmpty ?? chat.serverPreview?.nilIfEmpty ?? ""
        return last.split(whereSeparator: \.isNewline).joined(separator: " ")
    }

    /// 置顶入口：切到助理会话。旧网关没有助理会话时退回打开助理层
    func openAssistantEntry() {
        guard assistantChatId != nil else {
            if toolLayer != .assistant { toggleTool(.assistant) }
            return
        }
        openAssistantChat()
    }

    /// iPad 图标栏：不在助理会话就切过去并打开今日层；已经在了就开关今日层
    func toggleAssistantRail() {
        let wasActive = assistantChatActive || assistantChatId == nil
        if assistantChatId != nil { openAssistantChat() }
        if wasActive || toolLayer != .assistant { toggleTool(.assistant) }
    }

    /// 切到助理会话。本机还没同步到就记下意图，会话到了再切（不在本地新建）
    func openAssistantChat() {
        guard let id = assistantChatId, chats.contains(where: { $0.id == id }) else {
            pendingAssistantOpen = true
            return
        }
        pendingAssistantOpen = false
        select(id)
    }

    func fulfillPendingAssistantOpen() {
        guard pendingAssistantOpen, let id = assistantChatId, chats.contains(where: { $0.id == id }) else { return }
        pendingAssistantOpen = false
        select(id)
    }

    /// 打开助理关联的会话（委派子会话、收件箱条目）。本机还没同步到的会话不切，避免 activeId 指向空壳
    func openAssistantChat(_ chatId: String) {
        guard chats.contains(where: { $0.id == chatId }) else {
            flash("这个会话还没同步到本机")
            return
        }
        toolLayer = nil
        select(chatId)
    }

    func setAssistantMemoryPaused(_ paused: Bool) {
        assistantOp("memory_settings", args: ["paused": .bool(paused)])
        assistantState?.memory?.paused = paused
    }

    func applyDelegationState(_ delegation: AssistantDelegation, approval: AssistantApproval?) {
        guard var state = assistantState else { return }
        if let index = state.delegations.firstIndex(where: { $0.id == delegation.id }) {
            state.delegations[index] = delegation
        } else {
            state.delegations.insert(delegation, at: 0)
        }
        if let approval {
            if let index = state.approvals.firstIndex(where: { $0.id == approval.id }) {
                state.approvals[index] = approval
            } else {
                state.approvals.append(approval)
            }
        }
        if delegation.status != "awaiting" {
            state.approvals.removeAll { $0.delegationId == delegation.id }
        }
        assistantState = state
    }
}
