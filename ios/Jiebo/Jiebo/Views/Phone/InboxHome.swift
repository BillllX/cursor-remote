import SwiftUI

/// 待处理页（规格 §4.2）：待批 + 收件箱。从 ☰ 菜单 `router.go(.inbox)` push 进来。
/// 绝不调用 store.openAssistantInboxItem / select：收件箱条目指向的会话可能是工作区子会话，
/// 一律走 router.open（委派 → 详情 sheet，助理 → 回助理页，其它 → 只提示）。
struct InboxHome: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router

    init() {}

    private var state: AssistantState? { store.assistantState }

    private var approvals: [AssistantApproval] {
        (state?.approvals ?? []).sorted { $0.createdAt > $1.createdAt }
    }

    private var items: [AssistantInboxItem] {
        (state?.inbox ?? []).sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        List {
            if !approvals.isEmpty {
                Section {
                    ForEach(approvals) { approval in
                        ApprovalCard(approval: approval, onOpenDelegation: openDelegationAction(for: approval))
                            .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                } header: {
                    Text("待批 (\(approvals.count))")
                }
            }
            if !items.isEmpty {
                Section {
                    ForEach(items) { item in
                        inboxRow(item)
                            .listRowBackground(JieboColor.white)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                if !item.read {
                                    Button("已读") { store.markInboxRead(item) }
                                        .tint(JieboColor.pine)
                                }
                            }
                    }
                } header: {
                    Text("收件箱")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle("待处理")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { store.requestAssistant() }
        .overlay {
            if approvals.isEmpty && items.isEmpty {
                if state == nil {
                    AssistantMutedText("正在加载…")
                } else {
                    ContentUnavailableView(
                        "没有待处理的事",
                        systemImage: "tray",
                        description: Text("\(store.assistantName) 有新消息会放在这里。")
                    )
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        store.markAllInboxRead()
                    } label: {
                        Label("全部标为已读", systemImage: "envelope.open")
                    }
                    .disabled((state?.unreadInbox ?? 0) == 0)
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .hitTarget()
                }
                .accessibilityLabel("更多")
            }
        }
    }

    // MARK: 待批

    /// 委派审批行右侧的「看委派」；create_workspace 没有委派 → nil
    private func openDelegationAction(for approval: AssistantApproval) -> (() -> Void)? {
        guard let delegationId = approval.delegationId else { return nil }
        return { router.delegationDetail = DelegationRef(id: delegationId) }
    }

    // MARK: 收件箱

    private func inboxRow(_ item: AssistantInboxItem) -> some View {
        Button {
            open(item)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(item.read ? Color.clear : JieboColor.pine)
                    .frame(width: 8, height: 8)
                    .padding(.top, 6)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(item.title)
                            .font(JieboFont.ui(15, weight: item.read ? .regular : .semibold))
                            .foregroundStyle(item.read ? JieboColor.ink2 : JieboColor.ink)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                        kindTag(item.kind)
                    }
                    Text(assistantRelativeTime(item.createdAt))
                        .font(JieboFont.ui(11))
                        .foregroundStyle(JieboColor.dim)
                    if !item.body.isEmpty {
                        Text(item.body)
                            .font(JieboFont.ui(13))
                            .foregroundStyle(JieboColor.ink2)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                    .padding(.top, 5)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.read ? item.title : "未读，\(item.title)")
    }

    @ViewBuilder
    private func kindTag(_ kind: String) -> some View {
        switch kind {
        case "approval":
            StatusTag(text: "待批", fg: JieboColor.warnFg, bg: JieboColor.warnBg)
        case "delegation":
            StatusTag(text: "委派", fg: JieboColor.run, bg: JieboColor.runBg)
        case "reminder":
            StatusTag(text: "提醒", fg: JieboColor.pine, bg: JieboColor.pine.opacity(0.12))
        case "brief":
            StatusTag(text: "简报", fg: JieboColor.ink2, bg: JieboColor.mist)
        default:
            EmptyView()
        }
    }

    private func open(_ item: AssistantInboxItem) {
        store.markInboxRead(item)
        if item.delegationId != nil || item.chatId != nil {
            router.open(chatId: item.chatId, delegationId: item.delegationId, store: store)
        } else {
            router.path.append(.inboxItem(item.id))
        }
    }
}

/// 收件箱条目详情：标题、时间、完整正文
struct InboxDetailView: View {
    let itemId: String

    @Environment(ChatStore.self) private var store

    init(itemId: String) {
        self.itemId = itemId
    }

    private var item: AssistantInboxItem? {
        store.assistantState?.inbox.first(where: { $0.id == itemId })
    }

    var body: some View {
        ScrollView {
            if let row = item {
                VStack(alignment: .leading, spacing: 10) {
                    Text(row.title)
                        .font(JieboFont.display(18))
                        .foregroundStyle(JieboColor.ink)
                        .textSelection(.enabled)
                    Text(assistantFormatMillis(row.createdAt))
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                    if !row.body.isEmpty {
                        Text(row.body)
                            .font(JieboFont.ui(15))
                            .foregroundStyle(JieboColor.ink)
                            .textSelection(.enabled)
                            .padding(.top, 6)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(JieboColor.paper)
        .navigationTitle("消息")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if item == nil {
                ContentUnavailableView("这条消息已不存在", systemImage: "tray")
            }
        }
        .onAppear {
            if let row = item { store.markInboxRead(row) }
        }
    }
}
