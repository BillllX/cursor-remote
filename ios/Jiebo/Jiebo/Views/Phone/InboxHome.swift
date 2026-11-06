import SwiftUI

/// 小驳里的待处理（规格 §4.2）：待批 + 收件箱。从聊天页右上角推进来。
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

    private var drafts: [DraftCard] {
        var seen = Set<String>()
        return (state?.draftCards ?? [])
            .sorted { $0.createdAt > $1.createdAt }
            .filter { row in
                let key = row.sources.first(where: { $0.kind == "approval" }).map { "approval:\($0.id)" } ?? "draft:\(row.id)"
                return seen.insert(key).inserted
            }
    }

    private var usesDrafts: Bool { state?.draftCards != nil }
    private var pendingCount: Int { usesDrafts ? drafts.count : approvals.count }

    private var items: [AssistantInboxItem] {
        (state?.inbox ?? [])
            .filter { item in
                guard item.kind == "approval" else { return true }
                // 审批已有实体卡时，不再把同一条 approval inbox 通知重复列在下方。
                return !approvals.contains { approval in
                    (item.delegationId != nil && item.delegationId == approval.delegationId)
                        || (item.chatId != nil && item.chatId == approval.chatId)
                }
            }
            .sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        @Bindable var router = router
        VStack(spacing: 0) {
            laneBar
            switch router.inboxLane {
            case .notices:
                notices
            case .work(let column):
                DelegationListScreen(column: column, embeddedInInbox: true)
            case .artifacts:
                ArtifactCenterView(embedded: true)
            }
        }
        .background(JieboColor.paper)
        .navigationTitle("助理中心")
        .navigationBarTitleDisplayMode(.inline)
        .task { store.requestAssistant() }
    }

    private var laneBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                laneChip("通知", .notices)
                laneChip("待办", .work(.todo))
                laneChip("计划", .work(.plan))
                laneChip("委派", .work(.delegation))
                laneChip("产物", .artifacts)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .accessibilityLabel("助理中心栏目")
    }

    private func laneChip(_ title: String, _ lane: InboxLane) -> some View {
        let selected = router.inboxLane == lane
        return Button {
            router.inboxLane = lane
        } label: {
            Text(title)
                .font(JieboFont.text(.subheadline, weight: .semibold))
                .foregroundStyle(selected ? JieboColor.pine : JieboColor.ink2)
                .padding(.horizontal, 14)
                .frame(minHeight: 36)
                .background(selected ? JieboColor.pine.opacity(0.12) : JieboColor.white)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(selected ? JieboColor.pine.opacity(0.35) : JieboColor.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var notices: some View {
        List {
            if pendingCount > 0 {
                Section {
                    if usesDrafts {
                        ForEach(drafts) { draft in
                            DraftActionCard(draft: draft) { delegationId in
                                router.delegationDetail = DelegationRef(id: delegationId)
                            }
                            .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                            .listRowBackground(JieboColor.paper)
                            .listRowSeparator(.hidden)
                        }
                    } else {
                        ForEach(approvals) { approval in
                            ApprovalCard(approval: approval, onOpenDelegation: openDelegationAction(for: approval))
                                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                                .listRowBackground(JieboColor.paper)
                                .listRowSeparator(.hidden)
                        }
                    }
                } header: {
                    JieboListHeader("待批 (\(pendingCount))")
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
                    JieboListHeader("通知")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .safeAreaInset(edge: .top, spacing: 0) {
            if !store.connected {
                Button {
                    store.retryConnection()
                } label: {
                    Text(store.linkState.title)
                        .font(JieboFont.text(.caption, weight: .medium))
                        .foregroundStyle(JieboColor.danger)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 16)
                        .background(JieboColor.paper)
                }
                .buttonStyle(.plain)
                .disabled(store.linkState != .offline)
                .accessibilityHint(store.linkState == .offline ? "重新连接" : "")
            }
        }
        .refreshable { store.requestAssistant(force: true) }
        .overlay {
            if pendingCount == 0 && items.isEmpty {
                if state == nil {
                    AssistantMutedText(store.assistantStatePendingTitle ?? "正在加载…")
                } else {
                    ContentUnavailableView(
                        "没有待处理的事",
                        systemImage: "tray",
                        description: Text("\(store.assistantName) 有通知会放在这里。")
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
                            .font(JieboFont.text(.subheadline, weight: item.read ? .regular : .semibold))
                            .foregroundStyle(item.read ? JieboColor.ink2 : JieboColor.ink)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                        kindTag(item.kind)
                    }
                    Text(assistantRelativeTime(item.createdAt))
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                    if !item.body.isEmpty {
                        Text(item.body)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(JieboFont.text(.caption2, weight: .semibold))
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
            router.openInboxItem(item.id)
        }
    }
}

/// 收件箱条目详情：标题、时间、完整正文
struct InboxDetailView: View {
    let itemId: String

    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router

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
                        .font(JieboFont.text(.title3, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .textSelection(.enabled)
                    Text(assistantFormatMillis(row.createdAt))
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                    if !row.body.isEmpty {
                        Text(row.body)
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                            .textSelection(.enabled)
                            .padding(.top, 6)
                    }
                    if row.scheduleId != nil || row.actionPrompt != nil {
                        HStack(spacing: 8) {
                            if let scheduleId = row.scheduleId {
                                ActionButton(title: "查看计划", kind: .outline) {
                                    router.openWorkTask("schedule:\(scheduleId)", column: .plan)
                                }
                            }
                            if row.actionPrompt != nil {
                                ActionButton(title: "交给小驳处理", kind: .primary) {
                                    store.openAssistantInboxItem(row)
                                    router.popToRoot()
                                }
                            }
                        }
                        .padding(.top, 8)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(JieboColor.paper)
        .navigationTitle("通知")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if item == nil {
                ContentUnavailableView("这条通知已不存在", systemImage: "tray")
            }
        }
        .onAppear {
            if let row = item { store.markInboxRead(row) }
        }
    }
}
