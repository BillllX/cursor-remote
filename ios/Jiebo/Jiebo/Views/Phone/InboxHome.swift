import SwiftUI

/// 小驳里的待处理（规格 §4.2）：待批 + 收件箱。从聊天页右上角推进来。
/// 绝不调用 store.openAssistantInboxItem / select：收件箱条目指向的会话可能是工作区子会话，
/// 一律走 router.open（委派 → 详情 sheet，助理 → 回助理页，其它 → 只提示）。
struct InboxHome: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router

    @State private var showHistory = true
    @State private var selecting = false
    @State private var selected = Set<String>()
    @State private var archiving = false

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
                guard !showHistory, item.kind == "approval", item.decisionKind == nil else { return true }
                // 审批已有实体卡时，不再把同一条 approval inbox 通知重复列在下方。
                return !approvals.contains { approval in
                    (item.delegationId != nil && item.delegationId == approval.delegationId)
                        || (item.chatId != nil && item.chatId == approval.chatId)
                }
            }
            .filter { showHistory || $0.needsAttention }
            .sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        notices
        .background(JieboColor.paper)
        .navigationTitle("收件箱")
        .navigationBarTitleDisplayMode(.inline)
        .task { store.requestAssistant() }
    }

    private var notices: some View {
        List {
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
                let grouped = items.filter { showHistory || category($0) == group }
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
                        kindTag(item.kind)
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
        case "run":
            StatusTag(text: "需要恢复", fg: JieboColor.warnFg, bg: JieboColor.warnBg)
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
        switch item.attention {
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
        if item.actionPrompt != nil { return "查看内容并处理" }
        if item.scheduleId != nil { return "查看日程" }
        switch item.kind {
        case "approval": return "查看申请并确认"
        case "run": return "查看原因与任务"
        case "delegation": return "查看任务"
        case "memory": return "查看记忆通知"
        case "reminder": return "查看提醒"
        default: return "查看详情"
        }
    }

    private func open(_ item: AssistantInboxItem) {
        store.markInboxRead(item)
        if item.decisionKind != nil { router.openInboxItem(item.id); return }
        if item.attention == "suggestion" || item.kind == "memory" {
            router.go(.memory)
        } else if let eventId = item.eventId {
            router.openWorkTask("calendar_event:\(eventId)", column: .plan)
        } else if let todoId = item.todoId {
            router.openWorkTask("todo:\(todoId)", column: .todo)
        } else if let scheduleId = item.scheduleId {
            router.openWorkTask("schedule:\(scheduleId)", column: .plan)
        } else if item.delegationId != nil || item.chatId != nil {
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
                        ChunkedAssistantMessage(text: ReplyText.repair(row.body))
                            .textSelection(.enabled)
                            .padding(.top, 6)
                    }
                    InboxItemActions(item: row)
                    if row.scheduleId != nil || row.actionPrompt != nil {
                        HStack(spacing: 8) {
                            if let scheduleId = row.scheduleId {
                                ActionButton(title: "查看计划", kind: .outline) {
                                    router.openWorkTask("schedule:\(scheduleId)", column: .plan)
                                }
                            }
                            if row.actionPrompt != nil && row.decisionKind == nil {
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
