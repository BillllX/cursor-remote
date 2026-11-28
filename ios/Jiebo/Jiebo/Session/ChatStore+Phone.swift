import Foundation

/// iPhone 纯助理壳用到的 ChatStore 辅助。只读/只标已读，**不会切换 activeId**。
extension ChatStore {
    func resolveInboxItem(_ item: AssistantInboxItem) {
        guard unlocked, connected else { flash("请连接后再处理通知"); return }
        assistantOp("inbox_read", args: ["ids": .array([.string(item.id)]), "resolve": .bool(true)])
        requestAssistant(force: true)
    }

    func archiveInboxItems(_ ids: Set<String>) async -> Bool {
        guard unlocked, connected else { flash("请连接后再归档"); return false }
        let eligible = (assistantState?.inbox ?? []).filter {
            ids.contains($0.id) && $0.kind != "approval" && $0.decisionKind == nil && !$0.resolved
        }
        guard !eligible.isEmpty else { return true }
        let result = await assistantOpData("inbox_read", args: [
            "ids": .array(eligible.map { .string($0.id) }), "resolve": .bool(true)
        ])
        guard result.ok else { flash(result.error ?? "归档失败，请重试"); return false }
        let archived = Set(eligible.map(\.id))
        if var state = assistantState {
            var changed = false
            for index in state.inbox.indices where archived.contains(state.inbox[index].id) {
                state.inbox[index].read = true
                state.inbox[index].resolved = true
                changed = true
            }
            // 批量归档合并为单次写回，避免 N 条通知触发 2N 次 assistantState 拷贝与重绘
            if changed { assistantState = state }
        }
        syncLocalAssistantMutation()
        requestAssistant(force: true)
        return true
    }

    /// 只标已读，不跳转。还没登录不改。没连上时先在这台设备标，并说明连上后才告诉服务器。
    func markInboxRead(_ item: AssistantInboxItem) {
        guard !item.read else { return }
        guard queueInboxRead(id: item.id) else { return }
        if let index = assistantState?.inbox.firstIndex(where: { $0.id == item.id }) {
            assistantState?.inbox[index].read = true
            syncLocalAssistantMutation()
        }
    }

    /// 全部标为已读（不带 ids = 全部）。还没登录不改。没连上时先在这台设备标，并说明连上后才告诉服务器。
    func markAllInboxRead() {
        guard var state = assistantState, state.unreadInbox > 0 else { return }
        guard queueInboxRead(id: nil) else { return }
        for index in state.inbox.indices where !state.inbox[index].read {
            state.inbox[index].read = true
        }
        assistantState = state
        syncLocalAssistantMutation()
    }

    /// id 为 nil 时标全部。还没登录返回 false，调用方不要改本地已读。
    private func queueInboxRead(id: String?) -> Bool {
        guard unlocked else {
            flash("还没登录。这次不会排队，登录后再标已读。")
            return false
        }
        if let id {
            assistantOp("inbox_read", args: ["ids": .array([.string(id)])])
        } else {
            assistantOp("inbox_read")
        }
        guard !client.isOpen else { return true }
        let what = id == nil ? "这些通知" : "这条通知"
        flash(linkState == .offline
            ? "已断开。这台设备已把\(what)标成已读，连上后才会告诉服务器。"
            : "正在连接。这台设备已把\(what)标成已读，连上后才会告诉服务器。")
        return true
    }

    /// 助理会话是否有一轮在跑
    var assistantRunning: Bool {
        assistantChat.map(chatShowsRunning) ?? false
    }

    /// status 为 running / awaiting 的委派，createdAt 倒序
    var runningDelegations: [AssistantDelegation] {
        (assistantState?.delegations ?? [])
            .filter { $0.status == "running" || $0.status == "awaiting" }
            .sorted { $0.createdAt > $1.createdAt }
    }

    /// 审批卡标题里的委派名；`create_workspace`（属于助理自己的会话）没有委派，返回助理名
    func approvalDelegationTitle(_ approval: AssistantApproval) -> String {
        if let delegationId = approval.delegationId,
           let row = assistantState?.delegations.first(where: { $0.id == delegationId }),
           !row.title.isEmpty {
            return row.title
        }
        return assistantName
    }
}
