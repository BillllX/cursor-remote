import SwiftUI

// MARK: - 今日

struct PadTodayExperience: View {
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router
    let projection: PadAssistantProjection
    @State private var dropTargeted = false

    var body: some View {
        Group {
            if let chatId = store.assistantChatId {
                VStack(spacing: 0) {
                    PadTodayTimeline(projection: projection)
                    Divider().overlay(JieboColor.line)
                    ThreadView(
                        chrome: .embedded,
                        chatId: chatId,
                        dock: AnyView(PadActionDock())
                    )
                    .id(chatId)
                }
            } else if store.assistantState == nil {
                ProgressView("正在打开小驳主会话…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView(
                    "小驳主会话不可用",
                    systemImage: "bubble.left",
                    description: Text("固定助理会话仍在同步，请稍后刷新。")
                )
            }
        }
        .background(JieboColor.paper)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 7) {
                    AssistantAvatarView(phase: store.assistantAvatarPhase, size: 34)
                    Text(store.assistantName)
                        .font(JieboFont.display(17))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(store.assistantName)，\(store.assistantAvatarPhase.accessibilityLabel)")
            }
        }
        .dropDestination(for: PadSemanticTransfer.self, action: { items, _ in
            defer { router.activeSemanticDragKind = nil }
            guard items.count == 1, let transfer = items.first else {
                router.dropFeedback = "一次只能交给小驳一个项目"
                return false
            }
            let accepted = store.continuePadTransfer(transfer)
            router.dropFeedback = accepted ? "已把「\(transfer.title)」交给小驳" : "没有提交这个项目"
            return accepted
        }, isTargeted: { dropTargeted = $0 })
        .overlay(alignment: .top) {
            if dropTargeted, let kind = router.activeSemanticDragKind,
               PadSemanticDropTarget.today.accepts(kind) {
                Label("松开以交给小驳继续处理", systemImage: "arrow.down.circle.fill")
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(JieboColor.pine)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .jieboGlass(in: Capsule(), interactive: false)
                    .padding(.top, 12)
            }
        }
    }
}

private struct PadTodayTimeline: View {
    @Environment(PadRouter.self) private var router
    let projection: PadAssistantProjection

    private var events: [DayThreadEvent] {
        let needle = router.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return projection.dayThread }
        return projection.dayThread.filter {
            $0.title.localizedCaseInsensitiveContains(needle)
                || ($0.body?.localizedCaseInsensitiveContains(needle) == true)
        }
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 10) {
                Button {
                    router.select(.brief)
                } label: {
                    PadEntitySummary(
                        symbol: "sun.max.fill",
                        title: "今日简报",
                        detail: projection.dayThreadAvailable ? "今日脉络 \(events.count) 项" : "兼容模式"
                    )
                }
                .buttonStyle(.plain)

                ForEach(events.filter { $0.kind != "brief" }.prefix(8)) { event in
                    Button {
                        router.select(.dayEvent(event.id))
                    } label: {
                        PadEntitySummary(
                            symbol: event.kind == "receipt" ? "checkmark.circle" : "circle.fill",
                            title: event.title.nilIfEmpty ?? "今日动态",
                            detail: event.body?.nilIfEmpty ?? padRelative(event.at)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .frame(maxHeight: 112)
        .background(JieboColor.paper)
        .accessibilityLabel("今日脉络")
    }
}

private struct PadEntitySummary: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: symbol)
                .foregroundStyle(JieboColor.pine)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Text(detail)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(2)
            }
        }
        .padding(10)
        .frame(minWidth: 230, maxWidth: 230, minHeight: 72, alignment: .leading)
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        }
    }
}

// MARK: - 待处理

struct PadInboxExperience: View {
    enum Filter: String, CaseIterable, Identifiable {
        case all, pending, unread
        var id: String { rawValue }
        var title: String {
            switch self {
            case .all: return "全部"
            case .pending: return "待确认"
            case .unread: return "未读"
            }
        }
    }

    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router
    let projection: PadAssistantProjection
    @State private var filter = Filter.all

    private var draftCards: [DraftCard] {
        let needle = router.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return projection.draftCards }
        return projection.draftCards.filter {
            $0.preview.title.localizedCaseInsensitiveContains(needle)
                || $0.preview.summary.localizedCaseInsensitiveContains(needle)
        }
    }

    private var approvals: [AssistantApproval] {
        let needle = router.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        return (store.assistantState?.approvals ?? [])
            .filter {
                needle.isEmpty
                    || $0.tool.localizedCaseInsensitiveContains(needle)
                    || $0.summary.localizedCaseInsensitiveContains(needle)
            }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private var inbox: [AssistantInboxItem] {
        let approvalIds = Set(projection.draftCards.flatMap { draft in
            draft.sources.filter { $0.kind == "approval" }.map(\.id)
        })
        return (store.assistantState?.inbox ?? [])
            .filter { item in
                if item.kind == "approval" {
                    if approvalIds.contains(item.id) { return false }
                    if approvals.contains(where: { approval in
                        (item.delegationId != nil && item.delegationId == approval.delegationId)
                            || (item.chatId != nil && item.chatId == approval.chatId)
                    }) {
                        return false
                    }
                }
                let needle = router.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
                let matches = needle.isEmpty
                    || item.title.localizedCaseInsensitiveContains(needle)
                    || item.body.localizedCaseInsensitiveContains(needle)
                return matches && (filter != .unread || !item.read)
            }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private var hasPending: Bool {
        projection.draftCardsAvailable ? !draftCards.isEmpty : !approvals.isEmpty
    }

    private var visibleContentIsEmpty: Bool {
        switch filter {
        case .all: return !hasPending && inbox.isEmpty
        case .pending: return !hasPending
        case .unread: return inbox.isEmpty
        }
    }

    var body: some View {
        List {
            if filter != .unread {
                if hasPending {
                    Section(projection.draftCardsAvailable ? "行动卡" : "待确认（兼容模式）") {
                        if projection.draftCardsAvailable {
                            ForEach(draftCards) { draft in
                                PadInboxRow(
                                    title: draft.preview.title.nilIfEmpty ?? "待确认操作",
                                    detail: draft.preview.summary,
                                    symbol: "checkmark.seal",
                                    transfer: PadSemanticTransfer(
                                        kind: .draft,
                                        stableID: draft.id,
                                        title: draft.preview.title.nilIfEmpty ?? "待确认操作"
                                    )
                                ) {
                                    router.select(.draft(draft.id))
                                }
                            }
                        } else {
                            ForEach(approvals) { approval in
                                PadInboxRow(
                                    title: "待批准：\(approval.tool)",
                                    detail: approval.summary,
                                    symbol: "exclamationmark.shield"
                                ) {
                                    router.select(.approval(approval.id))
                                }
                            }
                        }
                    }
                }
            }

            if filter != .pending {
                if !inbox.isEmpty {
                    Section("收件箱") {
                        ForEach(inbox) { item in
                            PadInboxRow(
                                title: item.title.nilIfEmpty ?? "小驳消息",
                                detail: item.body,
                                symbol: item.read ? "envelope.open" : "envelope.badge",
                                transfer: PadSemanticTransfer(
                                    kind: .inbox,
                                    stableID: item.id,
                                    title: item.title.nilIfEmpty ?? "小驳消息"
                                )
                            ) {
                                if !item.read { store.markInboxRead(item) }
                                router.select(.inboxItem(item.id))
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .safeAreaInset(edge: .top, spacing: 0) {
            Picker("筛选待处理事项", selection: $filter) {
                ForEach(Filter.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .jieboGlass(in: Capsule(), interactive: true)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
        }
        .overlay {
            if visibleContentIsEmpty {
                ContentUnavailableView(
                    filter == .unread ? "没有未读消息" : "没有待处理事项",
                    systemImage: "tray",
                    description: Text(
                        filter == .pending
                            ? "当前没有需要你确认的操作。"
                            : "新的确认、提醒和捕获会出现在这里。"
                    )
                )
            }
        }
        .refreshable { store.requestAssistant() }
    }
}

private struct PadInboxRow: View {
    let title: String
    let detail: String
    let symbol: String
    var transfer: PadSemanticTransfer?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol)
                    .foregroundStyle(JieboColor.pine)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                    if !detail.isEmpty {
                        Text(detail)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(JieboColor.white)
        .modifier(PadOptionalDraggable(transfer: transfer))
    }
}

private struct PadOptionalDraggable: ViewModifier {
    let transfer: PadSemanticTransfer?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let transfer {
            content.padSemanticDraggable(transfer)
        } else {
            content
        }
    }
}

private extension View {
    func padSemanticDraggable(_ transfer: PadSemanticTransfer) -> some View {
        draggable(transfer) {
            PadSemanticDragPreview(transfer: transfer)
        }
    }
}

private struct PadSemanticDragPreview: View {
    @Environment(PadRouter.self) private var router
    let transfer: PadSemanticTransfer

    var body: some View {
        Label(transfer.title, systemImage: padSemanticSymbol(transfer.kind))
            .font(JieboFont.text(.subheadline, weight: .semibold))
            .foregroundStyle(JieboColor.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .onAppear { router.beginSemanticDrag(transfer.kind) }
            .onDisappear { router.endSemanticDrag(transfer.kind) }
    }

    private func padSemanticSymbol(_ kind: PadSemanticTransfer.Kind) -> String {
        switch kind {
        case .task: return "checklist"
        case .inbox: return "tray"
        case .draft: return "checkmark.seal"
        case .artifact: return "square.stack.3d.up"
        }
    }
}

// MARK: - 任务

struct PadTaskExperience: View {
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router
    let projection: PadAssistantProjection

    private let phases = ["needs_me", "in_progress", "planned", "completed"]

    private var tasks: [PersonalTask] {
        let needle = router.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return projection.personalTasks }
        return projection.personalTasks.filter {
            $0.title.localizedCaseInsensitiveContains(needle)
                || ($0.detail?.localizedCaseInsensitiveContains(needle) == true)
        }
    }

    private var visiblePhases: [String] {
        let unknown = Set(tasks.map(\.phase)).subtracting(phases)
        return phases + unknown.sorted()
    }

    var body: some View {
        List {
            if !projection.personalTasksAvailable, !projection.personalTasks.isEmpty {
                Section {
                    Label("当前为兼容模式，待办与委派仍可处理。", systemImage: "info.circle")
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            ForEach(visiblePhases, id: \.self) { phase in
                let rows = tasks.filter { $0.phase == phase }
                if !rows.isEmpty {
                    Section(padTaskPhaseTitle(phase)) {
                        ForEach(rows) { task in
                            Button {
                                router.select(.task(task.id))
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: padTaskSymbol(task))
                                        .foregroundStyle(task.priority == "high" ? JieboColor.warnFg : JieboColor.pine)
                                        .frame(width: 22)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(task.title.nilIfEmpty ?? "未命名任务")
                                            .font(JieboFont.text(.subheadline, weight: .semibold))
                                            .foregroundStyle(JieboColor.ink)
                                        Text(task.attention?.nilIfEmpty ?? task.detail?.nilIfEmpty ?? task.status)
                                            .font(JieboFont.text(.footnote))
                                            .foregroundStyle(JieboColor.dim)
                                            .lineLimit(2)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(JieboColor.white)
                            .padSemanticDraggable(PadSemanticTransfer(
                                kind: .task,
                                stableID: task.id,
                                title: task.title.nilIfEmpty ?? "未命名任务"
                            ))
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .overlay {
            if tasks.isEmpty {
                ContentUnavailableView(
                    projection.personalTasksAvailable ? "还没有任务" : "任务投影不可用",
                    systemImage: "checklist",
                    description: Text("待办、日程与委派会汇总在这里。")
                )
            }
        }
        .refreshable { store.requestAssistant() }
    }
}

// MARK: - 产物

struct PadArtifactExperience: View {
    enum Grouping: String, CaseIterable, Identifiable {
        case recent, kind, source
        var id: String { rawValue }
        var title: String {
            switch self {
            case .recent: return "最近"
            case .kind: return "按类型"
            case .source: return "按来源"
            }
        }
    }

    enum Kind: String, CaseIterable, Identifiable {
        case all, file, link, capture
        var id: String { rawValue }
        var title: String {
            switch self {
            case .all: return "全部类型"
            case .file: return "文件"
            case .link: return "链接"
            case .capture: return "捕获"
            }
        }
    }

    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router
    let projection: PadAssistantProjection
    @State private var grouping = Grouping.recent
    @State private var kind = Kind.all

    private var artifacts: [Artifact] {
        let needle = router.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        return projection.artifacts
            .filter { kind == .all || $0.kind == kind.rawValue }
            .filter {
                needle.isEmpty
                    || $0.title.localizedCaseInsensitiveContains(needle)
                    || ($0.path?.localizedCaseInsensitiveContains(needle) == true)
            }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private var groups: [(String, [Artifact])] {
        let grouped: [String: [Artifact]]
        switch grouping {
        case .recent:
            return [("最近", artifacts)]
        case .kind:
            grouped = Dictionary(grouping: artifacts) { padArtifactKindTitle($0.kind) }
        case .source:
            grouped = Dictionary(grouping: artifacts) { padArtifactSourceTitle($0) }
        }
        return grouped.keys.sorted().map { ($0, grouped[$0] ?? []) }
    }

    var body: some View {
        List {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                Section(group.0) {
                    ForEach(group.1) { artifact in
                        Button {
                            router.select(.artifact(artifact.id))
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: padArtifactSymbol(artifact))
                                    .foregroundStyle(JieboColor.pine)
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(artifact.title)
                                        .font(JieboFont.text(.subheadline, weight: .semibold))
                                        .foregroundStyle(JieboColor.ink)
                                    Text(artifact.path ?? artifact.safeURL?.absoluteString ?? padArtifactSourceTitle(artifact))
                                        .font(artifact.path == nil ? JieboFont.text(.caption) : JieboFont.monoText(.caption))
                                        .foregroundStyle(JieboColor.dim)
                                        .lineLimit(2)
                                }
                                Spacer(minLength: 0)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(JieboColor.white)
                        .padSemanticDraggable(PadSemanticTransfer(
                            kind: .artifact,
                            stableID: artifact.id,
                            title: artifact.title
                        ))
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                Picker("产物分组", selection: $grouping) {
                    ForEach(Grouping.allCases) { Text($0.title).tag($0) }
                }
                Picker("产物类型", selection: $kind) {
                    ForEach(Kind.allCases) { Text($0.title).tag($0) }
                }
            }
            .pickerStyle(.menu)
            .font(JieboFont.text(.subheadline, weight: .medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .jieboGlass(in: Capsule(), interactive: true)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
        }
        .overlay {
            if artifacts.isEmpty {
                ContentUnavailableView(
                    projection.artifactsAvailable ? "没有符合条件的产物" : "产物中心不可用",
                    systemImage: "square.stack.3d.up",
                    description: Text(
                        projection.artifactsAvailable
                            ? "换一个筛选，或先让小驳生成、捕获内容。"
                            : "当前服务器版本还没有提供产物投影。"
                    )
                )
            }
        }
        .refreshable { store.requestAssistant() }
    }
}

// MARK: - ActionDock

/// iPad 版行动区只依赖 PadRouter，不注入 PhoneRouter。
struct PadActionDock: View {
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router

    var body: some View {
        let projection = PadAssistantProjection(state: store.assistantState)
        let approvals = (store.assistantState?.approvals ?? []).sorted { $0.createdAt > $1.createdAt }
        let running = store.runningDelegations
        if projection.draftCards.isEmpty, approvals.isEmpty, running.isEmpty {
            EmptyView()
        } else {
            VStack(spacing: 6) {
                if projection.draftCardsAvailable {
                    ForEach(projection.draftCards.prefix(1)) { draft in
                        DraftActionCard(draft: draft) { router.openDelegation($0) }
                    }
                    if projection.draftCards.count > 1 {
                        PadDockLink("还有 \(projection.draftCards.count - 1) 项待确认") {
                            router.openAssistant(section: .inbox, selection: nil)
                        }
                    }
                } else {
                    ForEach(approvals.prefix(1)) { approval in
                        ApprovalCard(
                            approval: approval,
                            onOpenDelegation: approval.delegationId.map { id in
                                { router.openDelegation(id) }
                            }
                        )
                    }
                }
                ForEach(running.prefix(2)) { delegation in
                    PadDockLink("\(delegation.title.nilIfEmpty ?? "委派") · \(delegation.statusLabel)") {
                        router.openDelegation(delegation.id)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 4)
        }
    }
}

private struct PadDockLink: View {
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 统一 Inspector

struct PadUnifiedInspector: View {
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router
    @Environment(\.sceneSessionState) private var sceneSession

    var body: some View {
        Group {
            switch router.inspectorMode {
            case .preview:
                if let tab = sceneSession?.previewTab(in: store) {
                    PreviewPanelView(tab: tab, modal: false)
                } else {
                    NavigationStack {
                        ContentUnavailableView(
                            "正在打开预览…",
                            systemImage: "doc.text.magnifyingglass",
                            description: Text("如果文件无法内嵌预览，将使用系统文件预览。")
                        )
                        .navigationTitle("预览")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("关闭") { closePreview() }
                                    .accessibilityLabel("关闭预览")
                            }
                        }
                        .task {
                            await Task.yield()
                            if sceneSession?.previewKey == nil { router.restoreAfterPreview() }
                        }
                    }
                }
            case .detail:
                NavigationStack {
                    ScrollView {
                        PadInspectorDetail()
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .background(JieboColor.paper)
                    .navigationTitle("详情")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("完成") { router.dismissInspector() }
                                .accessibilityLabel("关闭详情")
                        }
                    }
                }
            }
        }
        .phoneNotice()
    }

    private func closePreview() {
        if let sceneSession { sceneSession.dismissPreview() }
        else { store.collapsePreview() }
        router.dismissInspector()
    }
}

private struct PadInspectorDetail: View {
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router

    private var projection: PadAssistantProjection {
        PadAssistantProjection(state: store.assistantState)
    }

    @ViewBuilder
    var body: some View {
        switch router.selection {
        case .assistantChat, nil:
            EmptyView()
        case .brief:
            PadBriefDetail(projection: projection)
        case let .dayEvent(id):
            if let event = projection.dayThread.first(where: { $0.id == id }) {
                PadDayEventDetail(event: event)
            } else {
                PadMissingDetail()
            }
        case let .draft(id):
            if let draft = projection.draftCards.first(where: { $0.id == id }) {
                DraftActionCard(draft: draft) { router.openDelegation($0) }
            } else {
                PadMissingDetail()
            }
        case let .approval(id):
            if let approval = store.assistantState?.approvals.first(where: { $0.id == id }) {
                ApprovalCard(
                    approval: approval,
                    style: .plain,
                    onOpenDelegation: approval.delegationId.map { delegationId in
                        { router.openDelegation(delegationId) }
                    }
                )
            } else {
                PadMissingDetail()
            }
        case let .inboxItem(id):
            if let item = store.assistantState?.inbox.first(where: { $0.id == id }) {
                PadInboxDetail(item: item)
            } else {
                PadMissingDetail()
            }
        case let .task(id):
            if let task = projection.personalTasks.first(where: { $0.id == id }) {
                PadTaskDetail(task: task, artifacts: projection.artifacts)
            } else {
                PadMissingDetail()
            }
        case let .artifact(id):
            if let artifact = projection.artifacts.first(where: { $0.id == id }) {
                PadArtifactDetail(artifact: artifact)
            } else {
                PadMissingDetail()
            }
        case let .delegation(id):
            PadDelegationDetail(delegationId: id, artifacts: projection.artifacts)
        }
    }
}

private struct PadBriefDetail: View {
    let projection: PadAssistantProjection
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PadDetailTitle("今日简报", symbol: "sun.max.fill")
            Text(store.assistantState?.brief?.text.nilIfEmpty ?? "今天还没有生成简报。")
                .font(JieboFont.text(.body))
                .foregroundStyle(JieboColor.ink2)
                .textSelection(.enabled)
            let events = projection.dayThread.filter { $0.kind != "brief" }
            AssistantSection("今日脉络") {
                if events.isEmpty {
                    AssistantMutedText("今天还没有需要关注的新动态。")
                } else {
                    ForEach(events) { event in
                        Button {
                            router.select(.dayEvent(event.id))
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(event.title)
                                    .font(JieboFont.text(.subheadline, weight: .semibold))
                                    .foregroundStyle(JieboColor.ink)
                                if let body = event.body {
                                    Text(body)
                                        .font(JieboFont.text(.footnote))
                                        .foregroundStyle(JieboColor.ink2)
                                        .lineLimit(3)
                                }
                            }
                            .assistantCard()
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

private struct PadDayEventDetail: View {
    let event: DayThreadEvent
    @Environment(PadRouter.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PadDetailTitle(event.title.nilIfEmpty ?? "今日动态", symbol: "clock")
            if let body = event.body {
                Text(body)
                    .font(JieboFont.text(.body))
                    .foregroundStyle(JieboColor.ink2)
                    .textSelection(.enabled)
            }
            if event.at > 0 { AssistantMutedText(assistantFormatMillis(event.at)) }
            if let receipt = event.receipt {
                PadReceiptCard(receipt: receipt)
            }
            if let draftId = event.draftCardId {
                ActionButton(title: "查看待确认", kind: .outline) {
                    router.select(.draft(draftId))
                }
            }
            if let taskId = event.taskId {
                ActionButton(title: "查看任务", kind: .outline) {
                    router.select(.task(taskId))
                }
            }
            PadSourceLinks(sources: event.sources)
        }
    }
}

private struct PadInboxDetail: View {
    let item: AssistantInboxItem
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PadDetailTitle(item.title.nilIfEmpty ?? "小驳消息", symbol: "tray")
            Text(item.body.nilIfEmpty ?? "这条消息没有更多内容。")
                .font(JieboFont.text(.body))
                .foregroundStyle(JieboColor.ink2)
                .textSelection(.enabled)
            AssistantMutedText(assistantFormatMillis(item.createdAt))
            if let delegationId = item.delegationId {
                ActionButton(title: "查看委派", kind: .outline) {
                    router.openDelegation(delegationId)
                }
            }
            if item.actionPrompt != nil {
                ActionButton(title: "交给小驳处理", kind: .primary) {
                    if store.handlePadInboxItem(item) {
                        router.openAssistant(section: .today, selection: .assistantChat)
                    }
                }
            }
        }
        .task(id: item.id) {
            if !item.read { store.markInboxRead(item) }
        }
    }
}

private struct PadTaskDetail: View {
    let task: PersonalTask
    let artifacts: [Artifact]
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router
    @Environment(\.sceneSessionState) private var sceneSession

    private var linkedArtifacts: [Artifact] {
        let delegationIds = Set(task.sources.filter { $0.kind == "delegation" }.map(\.id))
        let inboxIds = Set(task.sources.filter { $0.kind == "inbox" }.map(\.id))
        return artifacts.filter {
            if let id = $0.provenance?.delegationId, delegationIds.contains(id) { return true }
            if let id = $0.provenance?.inboxId, inboxIds.contains(id) { return true }
            return false
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PadDetailTitle(task.title.nilIfEmpty ?? "任务", symbol: padTaskSymbol(task))
            StatusTag(
                text: padTaskPhaseTitle(task.phase),
                fg: task.priority == "high" ? JieboColor.warnFg : JieboColor.pine,
                bg: task.priority == "high" ? JieboColor.warnBg : JieboColor.mist
            )
            if let attention = task.attention {
                Text(attention)
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(JieboColor.warnFg)
            }
            if let detail = task.detail {
                Text(detail)
                    .font(JieboFont.text(.body))
                    .foregroundStyle(JieboColor.ink2)
                    .textSelection(.enabled)
            }
            if let due = TodoDue.label(task.due) {
                Label(due, systemImage: "calendar")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
            }
            if let receipt = task.receipt { PadReceiptCard(receipt: receipt) }
            if !task.actions.isEmpty {
                AssistantSection("可用操作") {
                    ForEach(Array(task.actions.enumerated()), id: \.offset) { _, action in
                        ActionButton(
                            title: action.label,
                            kind: action.op == "delegation_cancel" ? .destructive : .primary,
                            fullWidth: true
                        ) {
                            store.performPersonalTaskAction(action)
                        }
                    }
                }
            }
            PadSourceLinks(sources: task.sources)
            if !linkedArtifacts.isEmpty {
                AssistantSection("关联产物") {
                    ForEach(linkedArtifacts) { artifact in
                        PadInspectorLink(artifact.title, symbol: padArtifactSymbol(artifact)) {
                            router.select(.artifact(artifact.id))
                        }
                    }
                }
            }
        }
    }
}

private struct PadArtifactDetail: View {
    let artifact: Artifact
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router
    @Environment(\.openURL) private var openURL
    @Environment(\.sceneSessionState) private var sceneSession

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            PadDetailTitle(artifact.title, symbol: padArtifactSymbol(artifact))
            Text(artifact.path ?? artifact.safeURL?.absoluteString ?? "捕获内容")
                .font(artifact.path == nil ? JieboFont.text(.body) : JieboFont.monoText(.footnote))
                .foregroundStyle(JieboColor.ink2)
                .textSelection(.enabled)
            AssistantMutedText("\(padArtifactSourceTitle(artifact)) · \(assistantFormatMillis(artifact.createdAt))")
            if let citation = artifact.sourceCitation {
                VStack(alignment: .leading, spacing: 6) {
                    if let title = citation.title { Text(title).font(JieboFont.text(.subheadline, weight: .semibold)) }
                    if let excerpt = citation.excerpt {
                        Text(excerpt)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                            .textSelection(.enabled)
                    }
                }
                .assistantCard()
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { artifactActions }
                VStack(spacing: 0) { artifactActions }
            }
            if let delegationId = artifact.provenance?.delegationId {
                ActionButton(title: "查看来源委派", kind: .outline, fullWidth: true) {
                    router.openDelegation(delegationId)
                }
            }
        }
    }

    @ViewBuilder
    private var artifactActions: some View {
        if let file = artifact.turnFile, let chatId = artifact.sourceChatId {
            ActionButton(title: "预览", kind: .outline) {
                store.openTurnFile(file, chatId: chatId)
                if file.kind != .binary {
                    sceneSession?.presentPreview(from: store)
                    router.openPreview(returningTo: .artifact(artifact.id))
                }
            }
            ActionButton(title: "分享", kind: .outline) {
                store.exportPreview(path: file.path, content: nil, chatId: chatId)
            }
        }
        if let url = artifact.safeURL {
            ActionButton(title: "打开来源", kind: .outline) { openURL(url) }
        }
        ActionButton(title: "让小驳继续处理", kind: .primary) {
            if store.continueArtifactOnPad(artifact) {
                router.openAssistant(section: .today, selection: .assistantChat)
            }
        }
    }
}

private struct PadDelegationDetail: View {
    let delegationId: String
    let artifacts: [Artifact]
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router
    @Environment(\.sceneSessionState) private var sceneSession

    private var delegation: AssistantDelegation? {
        store.assistantState?.delegations.first { $0.id == delegationId }
    }

    private var childChat: ChatSession? {
        guard let id = delegation?.childChatId, !id.isEmpty else { return nil }
        return store.chats.first { $0.id == id }
    }

    private var linkedArtifacts: [Artifact] {
        artifacts.filter { $0.provenance?.delegationId == delegationId }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let delegation {
                PadDetailTitle(delegation.title.nilIfEmpty ?? "委派", symbol: "person.2.wave.2")
                StatusTag(
                    text: delegation.statusLabel,
                    fg: delegation.statusColors.fg,
                    bg: delegation.statusColors.bg
                )
                AssistantMutedText("\(workspaceName(delegation.workspace)) · \(assistantFormatMillis(delegation.createdAt))")

                let approvals = (store.assistantState?.approvals ?? []).filter {
                    $0.delegationId == delegation.id
                }
                ForEach(approvals) { approval in
                    ApprovalCard(approval: approval, style: .plain)
                }

                if let result = delegation.result {
                    AssistantSection("汇报") {
                        Text(result)
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                            .textSelection(.enabled)
                            .assistantCard()
                    }
                }

                AssistantSection("过程") {
                    if let tools = childChat?.turns.last?.tools, !tools.isEmpty {
                        ForEach(tools.suffix(30)) { tool in
                            let running = tool.status == "running"
                            let failed = tool.status == "error"
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Image(systemName: running ? "ellipsis" : (failed ? "xmark.circle" : "checkmark.circle"))
                                    .foregroundStyle(running ? JieboColor.run : (failed ? JieboColor.danger : JieboColor.ok))
                                Text(tool.name.nilIfEmpty ?? "工具")
                                    .font(JieboFont.text(.footnote, weight: .semibold))
                                Text(tool.summary)
                                    .font(JieboFont.monoText(.caption))
                                    .foregroundStyle(JieboColor.dim)
                                    .lineLimit(1)
                            }
                        }
                        .assistantCard()
                    } else {
                        AssistantMutedText(
                            childChat == nil || childChat?.turnsComplete == false
                                ? "正在同步委派过程…"
                                : "还没有执行步骤。"
                        )
                    }
                }

                if let chat = childChat, let turn = chat.turns.last, !turn.cardFiles.isEmpty {
                    AssistantSection("本回合文件") {
                        TurnFileCards(turn: turn, chatId: chat.id) {
                            router.openPreview(returningTo: .delegation(delegationId))
                            Task { @MainActor in
                                await Task.yield()
                                if sceneSession?.previewKey == nil { router.restoreAfterPreview() }
                            }
                        }
                    }
                }

                if !linkedArtifacts.isEmpty {
                    AssistantSection("产物") {
                        ForEach(linkedArtifacts) { artifact in
                            PadInspectorLink(artifact.title, symbol: padArtifactSymbol(artifact)) {
                                router.select(.artifact(artifact.id))
                            }
                        }
                    }
                }

                if delegation.status == "running" || delegation.status == "awaiting" {
                    ActionButton(title: "停止这项委派", kind: .destructive, fullWidth: true) {
                        store.assistantOp("delegation_cancel", args: ["delegationId": .string(delegation.id)])
                    }
                }
            } else {
                PadMissingDetail()
            }
        }
        .task(id: processLoadKey) {
            guard let childId = delegation?.childChatId, !childId.isEmpty else { return }
            store.ensureTurnsLoaded(childId)
        }
    }

    private var processLoadKey: String {
        let childId = delegation?.childChatId ?? ""
        return [
            childId,
            childChat == nil ? "missing" : "present",
            store.cachedOnlyIds.contains(childId) ? "cached-only" : "server-known",
            store.cacheCheckedIds.contains(childId) ? "cache-checked" : "cache-unchecked",
            childChat?.turnsComplete == true ? "complete" : "incomplete",
        ].joined(separator: "|")
    }
}

private struct PadSourceLinks: View {
    let sources: [TaskSourceRef]
    @Environment(PadRouter.self) private var router

    var body: some View {
        if !sources.isEmpty {
            AssistantSection("来源") {
                ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
                    if destination(for: source) != nil {
                        Button {
                            open(source)
                        } label: {
                            sourceLabel(source, linked: true)
                        }
                        .buttonStyle(.plain)
                    } else {
                        sourceLabel(source, linked: false)
                    }
                }
            }
        }
    }

    private func sourceLabel(_ source: TaskSourceRef, linked: Bool) -> some View {
        HStack {
            Text(padSourceTitle(source.kind))
            Spacer(minLength: 8)
            Text(source.id)
                .font(JieboFont.monoText(.caption))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
            if linked {
                Image(systemName: "chevron.right")
            }
        }
        .font(JieboFont.text(.footnote))
        .foregroundStyle(JieboColor.ink2)
        .frame(minHeight: 40)
    }

    private func destination(for source: TaskSourceRef) -> PadSelection? {
        switch source.kind {
        case "delegation": return .delegation(source.id)
        case "inbox": return .inboxItem(source.id)
        case "artifact": return .artifact(source.id)
        case "approval": return .approval(source.id)
        case "brief": return .brief
        case "todo": return .task("todo:\(source.id)")
        case "schedule": return .task("schedule:\(source.id)")
        case "run": return .task("run:\(source.id)")
        default: return nil
        }
    }

    private func open(_ source: TaskSourceRef) {
        guard let destination = destination(for: source) else { return }
        switch destination {
        case let .delegation(id):
            router.openDelegation(id)
        default:
            router.select(destination)
        }
    }
}

private struct PadReceiptCard: View {
    let receipt: TaskReceipt

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(receipt.status == "done" ? "已完成" : receipt.status, systemImage: "checkmark.seal")
                .font(JieboFont.text(.subheadline, weight: .semibold))
                .foregroundStyle(JieboColor.ok)
            if let summary = receipt.summary {
                Text(summary)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink2)
            }
            AssistantMutedText(assistantFormatMillis(receipt.at))
        }
        .assistantCard()
    }
}

private struct PadDetailTitle: View {
    let text: String
    let symbol: String

    init(_ text: String, symbol: String) {
        self.text = text
        self.symbol = symbol
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .font(JieboFont.text(.title3, weight: .medium))
                .foregroundStyle(JieboColor.pine)
            Text(text)
                .font(JieboFont.display(20))
                .foregroundStyle(JieboColor.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct PadInspectorLink: View {
    let title: String
    let symbol: String
    let action: () -> Void

    init(_ title: String, symbol: String, action: @escaping () -> Void) {
        self.title = title
        self.symbol = symbol
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(JieboFont.text(.subheadline, weight: .medium))
                .foregroundStyle(JieboColor.ink)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .buttonStyle(.plain)
        .assistantCard()
    }
}

private struct PadMissingDetail: View {
    var body: some View {
        ContentUnavailableView(
            "内容已失效",
            systemImage: "arrow.clockwise",
            description: Text("刷新后仍找不到这项内容，它可能已在其他设备上处理。")
        )
    }
}

// MARK: - 文案与映射

private func padTaskPhaseTitle(_ phase: String) -> String {
    switch phase {
    case "needs_me": return "需要我"
    case "in_progress": return "进行中"
    case "planned": return "已计划"
    case "completed": return "已完成"
    default: return "其他"
    }
}

private func padTaskSymbol(_ task: PersonalTask) -> String {
    switch task.kind {
    case "todo": return "checkmark.circle"
    case "schedule": return "calendar"
    case "delegation": return "person.2.wave.2"
    default: return "gearshape.2"
    }
}

private func padArtifactSymbol(_ artifact: Artifact) -> String {
    switch artifact.kind {
    case "file": return "doc"
    case "link": return "link"
    default: return "tray.and.arrow.down"
    }
}

private func padArtifactKindTitle(_ kind: String) -> String {
    switch kind {
    case "file": return "文件"
    case "link": return "链接"
    default: return "捕获"
    }
}

private func padArtifactSourceTitle(_ artifact: Artifact) -> String {
    if artifact.provenance?.collabTaskId != nil { return "协作" }
    if artifact.provenance?.delegationId != nil { return "委派" }
    if artifact.provenance?.inboxId != nil { return "助理收件箱" }
    if artifact.provenance?.turnId != nil { return "会话回合" }
    return "捕获"
}

private func padSourceTitle(_ kind: String) -> String {
    switch kind {
    case "delegation": return "委派"
    case "inbox": return "收件箱"
    case "todo": return "待办"
    case "schedule": return "日程"
    case "run": return "运行"
    case "approval": return "审批"
    default: return "来源"
    }
}

private func padRelative(_ millis: Double) -> String {
    millis > 0 ? assistantRelativeTime(millis) : "今天"
}
