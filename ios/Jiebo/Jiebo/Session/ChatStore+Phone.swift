import Foundation

/// iPhone 纯助理壳用到的 ChatStore 辅助。只读/只标已读，**不会切换 activeId**。
extension ChatStore {
    /// 只标已读，不跳转。还没登录不改。没连上时先在这台设备标，并说明连上后才告诉服务器。
    func markInboxRead(_ item: AssistantInboxItem) {
        guard !item.read else { return }
        guard queueInboxRead(id: item.id) else { return }
        if let index = assistantState?.inbox.firstIndex(where: { $0.id == item.id }) {
            assistantState?.inbox[index].read = true
        }
    }

    /// 全部标为已读（不带 ids = 全部）。还没登录不改。没连上时先在这台设备标，并说明连上后才告诉服务器。
    func markAllInboxRead() {
        guard let state = assistantState, state.unreadInbox > 0 else { return }
        guard queueInboxRead(id: nil) else { return }
        for index in assistantState!.inbox.indices { assistantState!.inbox[index].read = true }
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
