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
