import Foundation

/// iPhone 纯助理壳用到的 ChatStore 辅助。只读/只标已读，**不会切换 activeId**。
extension ChatStore {
    /// 只标已读，不跳转（InboxHome 用；`openAssistantInboxItem` 的前半段）
    func markInboxRead(_ item: AssistantInboxItem) {
        guard !item.read else { return }
        assistantOp("inbox_read", args: ["ids": .array([.string(item.id)])])
        if let index = assistantState?.inbox.firstIndex(where: { $0.id == item.id }) {
            assistantState?.inbox[index].read = true
        }
    }

    /// 全部标为已读（不带 ids = 全部），本地同步置已读
    func markAllInboxRead() {
        guard let state = assistantState, state.unreadInbox > 0 else { return }
        assistantOp("inbox_read")
        for index in assistantState!.inbox.indices { assistantState!.inbox[index].read = true }
    }

    /// 助理会话是否有一轮在跑
    var assistantRunning: Bool {
        assistantChat?.turns.contains(where: \.running) == true
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
