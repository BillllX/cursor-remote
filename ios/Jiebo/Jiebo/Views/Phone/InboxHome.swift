import SwiftUI

/// 小驳里的待处理：待批 + 收件箱。点一条通知先看全文。
/// 待办、计划、委派和审批放在全文下面；工作区主会话再进工作区页。
/// 打不开的会话只在全文下说明，不拿提示把正文挡掉。
struct InboxHome: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router

    @State private var showHistory = true
    @State private var selecting = false
    @State private var selected = Set<String>()
    @State private var archiving = false
    /// 分页拉取的历史收件箱条目（突破 assistant_state 60 条快照上限）
    @State private var extraInboxItems: [AssistantInboxItem] = []
    @State private var inboxHasMore = false
    @State private var inboxNextCursor: String? = nil
    @State private var inboxTotal: Int? = nil
    @State private var inboxLoadingMore = false

    init() {}

    private var state: AssistantState? { store.assistantState }

    private struct InboxSnapshot {
        let approvals: [AssistantApproval]
        let drafts: [DraftCard]
        let usesDrafts: Bool
        let pendingCount: Int
        let items: [AssistantInboxItem]
        let groupedItems: [String: [AssistantInboxItem]]
    }

    private func buildSnapshot() -> InboxSnapshot {
        let sortedApprovals = (state?.approvals ?? []).sorted { $0.createdAt > $1.createdAt }
        var seenDraftKeys = Set<String>()
        let sortedDrafts = (state?.draftCards ?? [])
            .sorted { $0.createdAt > $1.createdAt }
            .filter { row in
                let key = row.sources.first(where: { $0.kind == "approval" }).map { "approval:\($0.id)" } ?? "draft:\(row.id)"
                return seenDraftKeys.insert(key).inserted
            }
        let usesDrafts = state?.draftCards != nil
        let pendingCount = usesDrafts ? sortedDrafts.count : sortedApprovals.count
        var approvalDelegationIds = Set<String>()
        var approvalChatIds = Set<String>()
        if !showHistory {
            for approval in sortedApprovals {
                if let delegationId = approval.delegationId { approvalDelegationIds.insert(delegationId) }
                if let chatId = approval.chatId.nilIfEmpty { approvalChatIds.insert(chatId) }
            }
        }
        let baseInbox = state?.inbox ?? []
        let combinedInbox: [AssistantInboxItem] = {
            guard !extraInboxItems.isEmpty else { return baseInbox }
            var seen = Set(baseInbox.map(\.id))
            var out = baseInbox
            for row in extraInboxItems where seen.insert(row.id).inserted {
                out.append(row)
            }
            return out
        }()
        let sortedItems = combinedInbox
            .filter { item in
                guard showHistory || item.needsAttention else { return false }
                guard !showHistory, item.kind == "approval", item.decisionKind == nil else { return true }
                // 审批已有实体卡时，不再把同一条 approval inbox 通知重复列在下方。
                let matchedDelegation = item.delegationId.map { approvalDelegationIds.contains($0) } ?? false
                let matchedChat = item.chatId.map { approvalChatIds.contains($0) } ?? false
                return !matchedDelegation && !matchedChat
            }
            .sorted { $0.createdAt > $1.createdAt }
        var grouped: [String: [AssistantInboxItem]] = [:]
        if showHistory {
            grouped["全部消息"] = sortedItems
        } else {
            for item in sortedItems {
                grouped[category(item), default: []].append(item)
            }
        }
        return InboxSnapshot(
            approvals: sortedApprovals,
            drafts: sortedDrafts,
            usesDrafts: usesDrafts,
            pendingCount: pendingCount,
            items: sortedItems,
            groupedItems: grouped
        )
    }

    var body: some View {
        notices
        .background(JieboColor.paper)
        .navigationTitle("收件箱")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            store.requestAssistant()
            let baseCount = state?.inbox.count ?? 0
            if baseCount >= 60 && !inboxHasMore && inboxTotal == nil {
                inboxHasMore = true
                inboxNextCursor = String(baseCount)
            }
        }
        .onChange(of: store.assistantState?.revision) { _, _ in
            // 网关状态修订变化（归档/已读/新通知）时重置分页附加缓存，防止旧数据漂移
            let baseCount = state?.inbox.count ?? 0
            extraInboxItems = []
            inboxTotal = nil
            inboxHasMore = baseCount >= 60
            inboxNextCursor = baseCount >= 60 ? String(baseCount) : nil
        }
    }

    private func loadInboxPage(cursor: String?, append: Bool) async {
        guard !inboxLoadingMore else { return }
        inboxLoadingMore = true
        defer { inboxLoadingMore = false }
        var args: [String: JSONValue] = ["kind": .string("inbox"), "limit": .number(30)]
        if let cursor, !cursor.isEmpty { args["cursor"] = .string(cursor) }
        let reply = await store.assistantOpData("assistant_list_page", args: args)
        guard reply.ok, let obj = reply.data?.object else { return }
        let rows = (obj["items"]?.array ?? []).compactMap(AssistantInboxItem.from)
        if append {
            var seen = Set(extraInboxItems.map(\.id))
            extraInboxItems.append(contentsOf: rows.filter { seen.insert($0.id).inserted })
        } else {
            extraInboxItems = rows
        }
        inboxTotal = obj["total"]?.int
        inboxHasMore = obj["hasMore"]?.bool ?? false
        inboxNextCursor = obj["nextCursor"]?.string?.nilIfEmpty
    }

    private var notices: some View {
        // 单次求值快照，避免列表分组、多选、overlay 与 toolbar 反复重排 approvals/drafts/items
        let snapshot = buildSnapshot()
        let approvals = snapshot.approvals
        let drafts = snapshot.drafts
        let usesDrafts = snapshot.usesDrafts
        let pendingCount = snapshot.pendingCount
        let items = snapshot.items
        return List {
            Section {
                Picker("消息范围", selection: $showHistory) {
                    Text("全部消息").tag(true)
                    Text("待处理").tag(false)
                }.pickerStyle(.segmented)
                HStack {
                    Text("未读 \(state?.unreadInbox ?? 0)")
                    Spacer()
                    Button("全部标为已读") { store.markAllInboxRead() }
                        .disabled((state?.unreadInbox ?? 0) == 0)
                }
                Text("已读只清除角标，需要确认或处理的事项仍会保留。")
                    .font(JieboFont.text(.caption)).foregroundStyle(JieboColor.dim)
            }
            if pendingCount > 0 && !showHistory {
                Section {
                    if usesDrafts {
                        ForEach(drafts) { draft in
                            DraftActionCard(draft: draft) { delegationId in
                                router.delegationDetail = DelegationRef(id: delegationId)
                            }
                            .onAppear {
                                for approval in approvals where draft.sources.contains(where: { $0.kind == "approval" && $0.id == approval.id }) {
                                    markApprovalRead(approval)
                                }
                            }
                            .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                            .listRowBackground(JieboColor.paper)
                            .listRowSeparator(.hidden)
                        }
                    } else {
                        ForEach(approvals) { approval in
                            ApprovalCard(approval: approval, onOpenDelegation: openDelegationAction(for: approval))
                                .onAppear { markApprovalRead(approval) }
                                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                                .listRowBackground(JieboColor.paper)
                                .listRowSeparator(.hidden)
                        }
                    }
                } header: {
                    JieboListHeader("待确认 (\(pendingCount))")
                }
            }
            ForEach(noticeGroups, id: \.self) { group in
                let grouped = snapshot.groupedItems[group] ?? []
                if !grouped.isEmpty {
                    Section {
                        ForEach(grouped) { item in
                            VStack(alignment: .leading, spacing: 10) {
                                if selecting {
                                    Button {
                                        if !selected.insert(item.id).inserted { selected.remove(item.id) }
                                    } label: {
                                        Label(item.title, systemImage: selected.contains(item.id) ? "checkmark.circle.fill" : "circle")
                                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(!canArchive(item) || archiving)
                                    if !canArchive(item) {
                                        Text("审批事项需单独确认").font(JieboFont.text(.caption)).foregroundStyle(JieboColor.dim)
                                    }
                                } else {
                                inboxRow(item)
                                InboxItemActions(item: item)
                                HStack {
                                    Button(actionTitle(item)) { open(item) }
                                        .buttonStyle(.bordered)
                                    if item.kind != "approval" && !item.resolved {
                                        Button("归档") { store.resolveInboxItem(item) }
                                            .buttonStyle(.borderless)
                                    }
                                }
                            }
                            }
                            .listRowBackground(JieboColor.white)
                        }
                    } header: { JieboListHeader(group) }
                }
            }
            if showHistory && (inboxHasMore || inboxLoadingMore) {
                Section {
                    PaginationLoadMoreRow(
                        hasMore: inboxHasMore,
                        loading: inboxLoadingMore,
                        loadedCount: items.count,
                        totalCount: inboxTotal,
                        label: "加载更早收件箱",
                        onLoadMore: {
                            let cursor = inboxNextCursor ?? String(items.count)
                            Task { await loadInboxPage(cursor: cursor, append: true) }
                        }
                    )
                    .listRowBackground(JieboColor.white)
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
        .safeAreaInset(edge: .bottom) {
            if selecting {
                HStack {
                    Button("全选可归档") { selected = Set(items.filter(canArchive).map(\.id)) }
                    Spacer()
                    Button(archiving ? "正在归档…" : "归档（\(selected.count)）") {
                        archiving = true
                        Task { @MainActor in
                            if await store.archiveInboxItems(selected) { selected.removeAll(); selecting = false }
                            archiving = false
                        }
                    }
                    .buttonStyle(.borderedProminent).tint(JieboColor.pine)
                    .disabled(selected.isEmpty || !store.connected)
                }
                .disabled(archiving)
                .padding(16).background(JieboColor.paper)
            }
        }
        .onChange(of: showHistory) { _, _ in selected.removeAll(); selecting = false }
        .refreshable { store.requestAssistant(force: true) }
        .accessibilityHidden(state == nil)
        .overlay {
            if (showHistory || pendingCount == 0) && items.isEmpty {
                if state == nil {
                    AssistantLoadingView(title: "正在加载收件箱…")
                } else {
                    ContentUnavailableView(
                        showHistory ? "暂无通知记录" : "没有待处理的事",
                        systemImage: "tray",
                        description: Text("\(store.assistantName) 有通知会放在这里。")
                    )
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(selecting ? "完成" : "选择") {
                    selecting.toggle(); selected.removeAll()
                }.disabled(archiving || state == nil || items.isEmpty)
            }
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

    private func canArchive(_ item: AssistantInboxItem) -> Bool {
        item.kind != "approval" && item.decisionKind == nil && !item.resolved
    }

    private func markApprovalRead(_ approval: AssistantApproval) {
        for item in state?.inbox ?? [] where item.kind == "approval" && item.decisionKind == nil
            && item.chatId == approval.chatId {
            store.markInboxRead(item)
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
                        kindTag(item)
                        if item.needsAttention { Text("待处理").font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warnFg) }

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
    private func kindTag(_ item: AssistantInboxItem) -> some View {
        switch item.kind {
        case "approval":
            StatusTag(text: "待批", fg: JieboColor.warnFg, bg: JieboColor.warnBg)
        case "delegation":
            StatusTag(text: "委派", fg: JieboColor.run, bg: JieboColor.runBg)
        case "reminder":
            StatusTag(text: "提醒", fg: JieboColor.pine, bg: JieboColor.pine.opacity(0.12))
        case "brief":
            StatusTag(text: "简报", fg: JieboColor.ink2, bg: JieboColor.mist)
        case "run":
            StatusTag(text: item.runStatusTitle,
                      fg: item.requiresRecovery ? JieboColor.warnFg : JieboColor.ink2,
                      bg: item.requiresRecovery ? JieboColor.warnBg : JieboColor.mist)
        case "memory":
            StatusTag(text: "记忆", fg: JieboColor.ink2, bg: JieboColor.mist)
        default:
            StatusTag(text: "消息", fg: JieboColor.ink2, bg: JieboColor.mist)
        }
    }

    private var noticeGroups: [String] {
        showHistory ? ["全部消息"] : ["待确认", "待处理内容", "到期提醒", "需要恢复", "待查看建议"]
    }

    private func category(_ item: AssistantInboxItem) -> String {
        switch item.effectiveAttention {
        case "confirmation": return "待确认"
        case "content": return "待处理内容"
        case "reminder": return "到期提醒"
        case "recovery": return "需要恢复"
        case "suggestion": return "待查看建议"
        default:
            if item.kind == "approval" { return "待确认" }
            if item.kind == "reminder" { return "到期提醒" }
            if item.actionPrompt != nil { return "待处理内容" }
            return "需要恢复"
        }
    }

    private func actionTitle(_ item: AssistantInboxItem) -> String {
        if item.decisionKind != nil || item.kind == "approval" { return "查看申请" }
        if item.actionPrompt != nil { return "查看内容" }
        switch item.kind {
        case "run": return item.requiresRecovery ? "查看原因" : "查看结果"
        case "delegation": return "查看委派通知"
        case "memory": return "查看记忆通知"
        case "reminder": return "查看提醒"
        default: return "查看详情"
        }
    }

    private func open(_ item: AssistantInboxItem) {
        store.markInboxRead(item)
        router.openInboxItem(item.id)
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
                        ChunkedAssistantMessage(text: ReplyText.repair(row.body))
                            .textSelection(.enabled)
                            .padding(.top, 6)
                    }
                    InboxItemActions(item: row)
                    InboxDetailDestinations(item: row)
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


/// 通知全文下面，只放这台手机打得开的去处。
private struct InboxDetailDestinations: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    let item: AssistantInboxItem

    var body: some View {
        if matchingDraft != nil || matchingApproval != nil || showPendingList || hasLinks || sessionNote != nil {
            destinations
        }
    }

    private var destinations: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let draft = matchingDraft {
                DraftActionCard(draft: draft) { id in
                    router.delegationDetail = DelegationRef(id: id)
                }
            } else if let approval = matchingApproval {
                ApprovalCard(approval: approval, onOpenDelegation: openDelegation)
            } else if showPendingList {
                ActionButton(title: "查看待确认", kind: .outline) { router.go(.inbox) }
            }
            if hasLinks {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { links }
                    VStack(alignment: .leading, spacing: 8) { links }
                }
            }
            if let note = sessionNote {
                Text(note)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink2)
            }
        }
        .padding(.top, 8)
    }

    private var hasLinks: Bool {
        item.eventId != nil || item.todoId != nil || item.scheduleId != nil
            || showMemory || showDelegation || workspaceChatId != nil || showAssistant || !item.resultSnapshots.isEmpty
            || (item.actionPrompt != nil && item.decisionKind == nil)
    }

    @ViewBuilder private var links: some View {
        if store.supportsReadSha {
            ForEach(item.resultSnapshots) { file in
                ActionButton(title: "查看本次版本 · \(file.path)", kind: .outline) {
                    guard let chat = item.chatId ?? store.assistantChatId else { return }
                    if store.openResultSnapshot(file, chatId: chat, workspaceKey: item.workspaceRun?.workspaceKey) {
                        router.popToRoot()
                    }
                }
            }
        }
        if item.actionPrompt != nil && item.decisionKind == nil {
            ActionButton(title: "交给小驳处理", kind: .primary) {
                store.openAssistantInboxItem(item)
                router.popToRoot()
            }
        }
        if item.eventId != nil || item.todoId != nil || item.scheduleId != nil {
            ActionButton(title: "查看定时与自动化", kind: .outline) { router.go(.automation) }
        }
        if showMemory {
            ActionButton(title: "查看记忆", kind: .outline) { router.go(.memory) }
        }
        if showDelegation, let delegationId = liveDelegationId {
            ActionButton(title: "查看委派", kind: .outline) {
                router.delegationDetail = DelegationRef(id: delegationId)
            }
        }
        if let chatId = workspaceChatId {
            ActionButton(title: "打开工作区", kind: .outline) { router.openWorkspaceChat(chatId) }
        }
        if showAssistant {
            ActionButton(title: "回到小驳", kind: .outline) {
                router.popToRoot()
                store.prepareAssistantThread()
            }
        }
    }

    private var showMemory: Bool { item.attention == "suggestion" || item.kind == "memory" }

    private var showDelegation: Bool {
        matchingDraft == nil && matchingApproval == nil && liveDelegationId != nil
    }

    /// 没有更具体的去处时，才提供回到小驳主会话。交给小驳已经会回到那里。
    private var showAssistant: Bool {
        guard let chatId = item.chatId, store.isAssistantChat(chatId) else { return false }
        if item.actionPrompt != nil || showMemory { return false }
        if item.eventId != nil || item.todoId != nil || item.scheduleId != nil { return false }
        if liveDelegationId != nil || workspaceChatId != nil { return false }
        return true
    }

    private var liveDelegationId: String? {
        if let id = item.delegationId,
           store.assistantState?.delegations.contains(where: { $0.id == id }) == true {
            return id
        }
        if let chatId = item.chatId,
           let row = store.assistantState?.delegations.first(where: { $0.childChatId == chatId }) {
            return row.id
        }
        return nil
    }

    private var workspaceChatId: String? {
        guard let chatId = item.chatId, store.workspaceAgent(chatId: chatId) != nil else { return nil }
        return chatId
    }

    private var openDelegation: (() -> Void)? {
        guard let id = matchingApproval?.delegationId else { return nil }
        return { router.delegationDetail = DelegationRef(id: id) }
    }

    private var matchingDraft: DraftCard? {
        guard item.kind == "approval", item.decisionKind == nil,
              let drafts = store.assistantState?.draftCards
        else { return nil }
        let approvals = store.assistantState?.approvals ?? []
        return drafts.first { draft in
            guard let approvalId = draft.sources.first(where: { $0.kind == "approval" })?.id,
                  let approval = approvals.first(where: { $0.id == approvalId })
            else { return false }
            return approvalMatches(approval)
        }
    }

    private var matchingApproval: AssistantApproval? {
        guard item.kind == "approval", item.decisionKind == nil, matchingDraft == nil else { return nil }
        return (store.assistantState?.approvals ?? []).first(where: approvalMatches)
    }

    private func approvalMatches(_ approval: AssistantApproval) -> Bool {
        if let delegationId = item.delegationId { return approval.delegationId == delegationId }
        guard let chatId = item.chatId, approval.chatId == chatId, approval.delegationId == nil else { return false }
        let sameChat = (store.assistantState?.approvals ?? []).filter {
            $0.chatId == chatId && $0.delegationId == nil
        }
        return sameChat.count == 1
    }

    private var showPendingList: Bool {
        guard item.kind == "approval", item.decisionKind == nil else { return false }
        if matchingDraft != nil || matchingApproval != nil { return false }
        guard let state = store.assistantState else { return false }
        if state.draftCards != nil { return state.draftCards?.isEmpty == false }
        return !state.approvals.isEmpty
    }

    private var sessionNote: String? {
        if liveDelegationId != nil { return nil }
        if let chatId = item.chatId {
            if store.isAssistantChat(chatId) || store.workspaceAgent(chatId: chatId) != nil { return nil }
            guard store.workspaceAgentsLoaded else { return nil }
            return item.delegationId == nil ? "这段对话在电脑或 iPad 上" : "这段过程在电脑或 iPad 上"
        }
        if item.delegationId != nil { return "这段过程在电脑或 iPad 上" }
        return nil
    }
}

/// Shared controls keep list and detail behavior identical; state changes only after server acknowledgement.
private struct InboxItemActions: View {
    @Environment(ChatStore.self) private var store
    let item: AssistantInboxItem
    @State private var busy = false
    @State private var error: String?
    @State private var confirmApproval = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !item.resolved {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { controls }
                    VStack(alignment: .leading, spacing: 10) { controls }
                }
                .disabled(busy || !store.connected)
                if busy { ProgressView("正在处理…") }
                if let error { Text(error).font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.danger) }
            } else if item.decisionKind != nil {
                Text("已处理").font(JieboFont.text(.caption)).foregroundStyle(JieboColor.dim)
            }
        }
        .confirmationDialog("确认处理这条申请？", isPresented: $confirmApproval, titleVisibility: .visible) {
            Button(approveTitle) { perform("inbox_decide", ["approve": .bool(true)]) }
            Button("取消", role: .cancel) {}
        } message: { Text(item.title + "\n" + item.body) }
    }

    private var approveTitle: String {
        switch item.decisionKind {
        case "skill": return "启用技能"
        case "wechat": return "确认绑定"
        default: return "同意申请"
        }
    }

    @ViewBuilder private var controls: some View {
        if item.decisionKind != nil {
            Button(approveTitle) { confirmApproval = true }.buttonStyle(.borderedProminent).tint(JieboColor.pine)
            Button("拒绝", role: .destructive) { perform("inbox_decide", ["approve": .bool(false)]) }.buttonStyle(.bordered)
        }
        if item.kind == "reminder" && (item.attention == nil || item.attention == "reminder") {
            Menu("稍后提醒") {
                Button("15 分钟后") { snooze(15) }
                Button("1 小时后") { snooze(60) }
                Button("24 小时后") { snooze(1440) }
            }.buttonStyle(.bordered)
            if let todoId = item.todoId {
                Button("完成任务") { perform("todo_done", ["id": .string(todoId)], resolve: true) }
                    .buttonStyle(.borderedProminent).tint(JieboColor.pine)
            }
        }
    }

    private func snooze(_ minutes: Int) { perform("inbox_snooze", ["minutes": .number(Double(minutes))]) }

    private func perform(_ op: String, _ extra: [String: JSONValue], resolve: Bool = false) {
        guard !busy else { return }
        busy = true
        error = nil
        Task { @MainActor in
            var args: [String: JSONValue] = ["id": .string(item.id)]
            args.merge(extra) { _, new in new }
            let result = await store.assistantOpData(op, args: args)
            if result.ok {
                if resolve { store.resolveInboxItem(item) }
                store.requestAssistant(force: true)
            } else { error = result.error ?? "处理失败，请重试" }
            busy = false
        }
    }
}
