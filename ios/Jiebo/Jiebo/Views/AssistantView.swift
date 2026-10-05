import SwiftUI
import UIKit

/// 个人助理：今日 / 收件箱 / 记忆。对齐 web/components/AssistantPanel.tsx（通知页是浏览器推送，iOS 不做）
/// 挂在工具层里：标题、关闭和提示条由 ToolLayerOverlay 画，这里只画内容。
/// 三个 pane（AssistantTodayPane / AssistantInboxList / AssistantMemoryPane）在本文件下方，iPhone 的页面直接复用。
struct AssistantView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var tabThumb
    @State private var tab: AssistantTab = .today

    private var state: AssistantState? { store.assistantState }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusLine
            tabBar
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    switch tab {
                    case .today: AssistantTodayPane()
                    case .inbox: AssistantInboxList()
                    case .memory: AssistantMemoryPane()
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(JieboColor.paper)
        .task { store.requestAssistant(memory: tab == .memory) }
        .onChange(of: tab) { _, next in
            if next == .memory { store.requestAssistant(memory: true) }
        }
    }

    private func tabTitle(_ item: AssistantTab) -> String {
        if item == .inbox, let unread = state?.unreadInbox, unread > 0 {
            return "收件箱 (\(unread))"
        }
        return item.title
    }

    private var statusLine: some View {
        let background = state?.background
        let ok = background?.ok ?? false
        let model = background?.model.nilIfEmpty ?? "grok-4.7"
        let status = ok ? "就绪" : (background?.reason ?? (state == nil ? "正在连接…" : "未就绪"))
        let name = state?.name ?? store.assistantName
        return HStack(spacing: 6) {
            Circle()
                .fill(ok ? JieboColor.ok : JieboColor.clay)
                .frame(width: 6, height: 6)
            Text("\(name) · 后台 \(model) · \(status)")
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
    }

    /// 与输入框的模式切换同一套：描边外框，选中项淡底滑块
    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(AssistantTab.allCases) { item in
                Button {
                    tab = item
                } label: {
                    Text(tabTitle(item))
                        .font(JieboFont.text(.footnote, weight: .medium))
                        .foregroundStyle(tab == item ? JieboColor.ink : JieboColor.ink2)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .frame(height: 32)
                        .background {
                            if tab == item {
                                RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                                    .fill(JieboColor.ink.opacity(0.06))
                                    .matchedGeometryEffect(id: "assistant-tab-thumb", in: tabThumb)
                            }
                        }
                        .hitTarget()
                }
                .buttonStyle(PressScaleButtonStyle())
                .accessibilityAddTraits(tab == item ? .isSelected : [])
            }
        }
        .padding(2)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        )
        .animation(JieboMotion.snappy(reduceMotion), value: tab)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
}

enum AssistantTab: String, CaseIterable, Identifiable {
    case today, inbox, memory

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: return "今日"
        case .inbox: return "收件箱"
        case .memory: return "记忆"
        }
    }
}

extension AssistantDelegation {
    var statusLabel: String {
        switch status {
        case "running": return "进行中"
        case "awaiting": return "待批"
        case "done": return "完成"
        case "failed": return "失败"
        default: return status
        }
    }

    var statusColors: (fg: Color, bg: Color) {
        switch status {
        case "running": return (JieboColor.run, JieboColor.runBg)
        case "awaiting": return (JieboColor.warnFg, JieboColor.warnBg)
        case "done": return (JieboColor.ok, JieboColor.okBg)
        case "failed": return (JieboColor.danger, JieboColor.dangerBg)
        default: return (JieboColor.dim, JieboColor.mist)
        }
    }
}

// MARK: - 今日 pane

/// 简报、待批、待办、日程、委派。调用方负责 ScrollView 和内边距。
/// iPad 全开；iPhone 的今日面板传 showsApprovals: false / showsDelegations: false（它们在行动区和待处理里）。
/// 锚点：待办区 `.id("todos")`，日程区 `.id("schedules")`，供 ScrollViewReader 滚动。
struct AssistantTodayPane: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var showsApprovals: Bool
    var showsDelegations: Bool
    /// 预留：今日页本身不含收件箱，保留参数让调用方写法统一
    var showsInbox: Bool
    @State private var todoDraft = ""
    @State private var doneExpanded = false
    @State private var editingTodo: AssistantTodo?
    @AppStorage(CalendarInvite.dismissedKey) private var calendarInviteDismissed = false
    @AppStorage(CalendarInvite.staleDismissedKey) private var calendarStaleDismissedAt: Double = 0

    init(showsApprovals: Bool = true, showsDelegations: Bool = true, showsInbox: Bool = true) {
        self.showsApprovals = showsApprovals
        self.showsDelegations = showsDelegations
        self.showsInbox = showsInbox
    }

    private var state: AssistantState? { store.assistantState }

    var body: some View {
        if state == nil {
            // 状态还没到时各区的空文案（「今天还没有简报」「没有未完成的待办」）会被当成真的没有
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                AssistantMutedText("正在加载…")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            loadedBody
        }
    }

    private var loadedBody: some View {
        VStack(alignment: .leading, spacing: 20) {
            briefSection
            if showsApprovals, let approvals = state?.approvals, !approvals.isEmpty {
                AssistantSection("待批 (\(approvals.count))") {
                    ForEach(approvals) { approval in
                        ApprovalCard(approval: approval, style: .plain)
                    }
                }
            }
            todoSection
            scheduleSection
            if showsDelegations, let delegations = state?.delegations, !delegations.isEmpty {
                AssistantSection("委派") {
                    ForEach(delegations.prefix(8)) { row in
                        delegationCard(row)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var briefSection: some View {
        if let brief = state?.brief?.text.trimmingCharacters(in: .whitespacesAndNewlines), !brief.isEmpty {
            AssistantSection("简报") {
                Text(brief)
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(JieboColor.ink)
                    .textSelection(.enabled)
                    .assistantCard()
            }
        } else {
            AssistantMutedText("今天还没有简报。定时任务会在设定时刻生成。")
        }
    }

    // MARK: 待办

    private var todoSection: some View {
        let openTodos = state?.todos.filter { !$0.done } ?? []
        let doneTodos = (state?.todos.filter(\.done) ?? []).sorted { ($0.doneAt ?? 0) > ($1.doneAt ?? 0) }
        let capturedToday = (state?.todos ?? []).filter {
            $0.capturedByAssistant && Calendar.current.isDateInToday(Date(timeIntervalSince1970: $0.createdAt / 1000))
        }.count
        let calendar = state?.calendar
        return AssistantSection("待办") {
            if let calendar, CalendarInvite.staleNotice(calendar, dismissedAt: calendarStaleDismissedAt) {
                CalendarInviteCard(calendar: calendar, stale: true)
            } else if let calendar, CalendarInvite.pending(calendar, dismissed: calendarInviteDismissed),
                      openTodos.contains(where: { $0.due != nil })
            {
                CalendarInviteCard(calendar: calendar)
            }
            if capturedToday > 0 {
                AssistantMutedText("今天从聊天里记了 \(capturedToday) 件，点一条可以改。")
            }
            HStack(spacing: 8) {
                TextField("加一条待办", text: $todoDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(JieboFont.text(.subheadline))
                    .submitLabel(.done)
                    .onSubmit(addTodo)
                ActionButton(title: "添加", kind: .primary, action: addTodo)
                    .disabled(todoDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if openTodos.isEmpty {
                AssistantMutedText("没有未完成的待办。")
            } else {
                ForEach(sortedOpen(openTodos)) { todo in
                    SwipeDeleteRow(onDelete: { removeTodo(todo) }) {
                        HStack(spacing: 8) {
                            Button {
                                editingTodo = todo
                            } label: {
                                todoLabel(todo)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("轻点两下修改")
                            Spacer(minLength: 8)
                            ActionButton(title: "完成") {
                                store.assistantOp("todo_done", args: ["id": .string(todo.id)])
                            }
                        }
                        .assistantCard()
                    }
                }
            }
            if !doneTodos.isEmpty {
                doneHeader(count: doneTodos.count)
                if doneExpanded {
                    ForEach(doneTodos.prefix(30)) { todo in
                        HStack(spacing: 8) {
                            Text(todo.text)
                                .font(JieboFont.text(.subheadline))
                                .strikethrough()
                                .foregroundStyle(JieboColor.dim)
                            Spacer(minLength: 8)
                            ActionButton(title: "撤销") {
                                store.assistantOp("todo_undo", args: ["id": .string(todo.id)])
                            }
                        }
                        .assistantCard()
                    }
                }
            }
        }
        .id("todos")
        .sheet(item: $editingTodo) { todo in
            TodoEditSheet(todo: todo)
        }
    }

    /// 文字在上，日期和「聊天里记的」在下；助理记的要标出来，记错了一眼能看出
    private func todoLabel(_ todo: AssistantTodo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(todo.text)
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink)
                .multilineTextAlignment(.leading)
            let due = TodoDue.label(todo.due)
            if due != nil || todo.capturedByAssistant {
                HStack(spacing: 6) {
                    if let due {
                        let late = TodoDue.overdue(todo.due)
                        StatusTag(text: due, fg: late ? JieboColor.warnFg : JieboColor.ink2, bg: late ? JieboColor.warnBg : JieboColor.mist)
                    }
                    if todo.capturedByAssistant {
                        Text(todo.source == "nightly" ? "夜里补记" : "聊天里记的")
                            .font(JieboFont.text(.caption2))
                            .foregroundStyle(JieboColor.dim)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// 有日期的按时间先后排在前面，没日期的保持添加顺序
    private func sortedOpen(_ todos: [AssistantTodo]) -> [AssistantTodo] {
        let dated = todos.compactMap { todo in TodoDue.parse(todo.due).map { (todo, $0.date) } }
            .sorted { $0.1 < $1.1 }
            .map(\.0)
        return dated + todos.filter { TodoDue.parse($0.due) == nil }
    }

    private func doneHeader(count: Int) -> some View {
        Button {
            withAnimation(JieboMotion.snappy(reduceMotion)) { doneExpanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: doneExpanded ? "chevron.down" : "chevron.right")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                Text("已完成 (\(count))")
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("已完成 \(count) 项，\(doneExpanded ? "点按收起" : "点按展开")")
    }

    private func addTodo() {
        let text = todoDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        store.assistantOp("todo_add", args: ["text": .string(text)])
        todoDraft = ""
    }

    private func removeTodo(_ todo: AssistantTodo) {
        store.assistantOp("todo_remove", args: ["id": .string(todo.id)])
    }

    // MARK: 日程

    @ViewBuilder
    private var scheduleSection: some View {
        if let schedules = state?.schedules, !schedules.isEmpty {
            AssistantSection("日程") {
                ForEach(schedules) { row in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.title.nilIfEmpty ?? row.cron)
                                .font(JieboFont.text(.subheadline, weight: .semibold))
                                .foregroundStyle(JieboColor.ink)
                            Text(scheduleLine(row))
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(row.enabled ? JieboColor.dim : JieboColor.warnFg)
                        }
                        Spacer(minLength: 8)
                        Toggle(row.title.nilIfEmpty ?? row.cron, isOn: scheduleBinding(row))
                            .labelsHidden()
                            .tint(JieboColor.pine)
                    }
                    .assistantCard()
                }
            }
            .id("schedules")
        }
    }

    private func scheduleBinding(_ row: AssistantSchedule) -> Binding<Bool> {
        Binding(
            get: { row.enabled },
            set: { on in store.assistantSetScheduleEnabled(row.id, enabled: on) }
        )
    }

    private func scheduleLine(_ row: AssistantSchedule) -> String {
        var line = "\(row.cron) · \(row.enabled ? "启用" : "暂停")"
        if let reason = row.pausedReason { line += " · \(reason)" }
        return line
    }

    // MARK: 委派（iPad）

    private func delegationCard(_ row: AssistantDelegation) -> some View {
        let openable = !row.childChatId.isEmpty && store.chats.contains(where: { $0.id == row.childChatId })
        let colors = row.statusColors
        return Button {
            if openable { store.openAssistantChat(row.childChatId) }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(row.title.nilIfEmpty ?? "委派")
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    StatusTag(text: row.statusLabel, fg: colors.fg, bg: colors.bg)
                    Spacer(minLength: 0)
                    if openable {
                        Image(systemName: "chevron.right")
                            .font(JieboFont.text(.caption2, weight: .semibold))
                            .foregroundStyle(JieboColor.dim)
                    }
                }
                if !row.workspace.isEmpty {
                    Text(row.workspace)
                        .font(JieboFont.monoText(.caption2))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let result = row.result {
                    Text(String(result.prefix(300)))
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.ink2)
                        .multilineTextAlignment(.leading)
                }
            }
            .assistantCard()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!openable)
    }
}

/// 在 ScrollView 里也能「左滑删除」的行（系统 swipeActions 只在 List 里有效）。
/// 向左拖露出「删除」，再点一下删除；往回拖或点内容收起。VoiceOver 走自定义动作「删除」。
private struct SwipeDeleteRow<Content: View>: View {
    let onDelete: () -> Void
    let content: Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var offset: CGFloat = 0
    @State private var revealed = false

    private let actionWidth: CGFloat = 72

    init(onDelete: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.onDelete = onDelete
        self.content = content()
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            Button {
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
                onDelete()
            } label: {
                Text("删除")
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(JieboColor.fillFg)
                    .frame(width: actionWidth)
                    .frame(maxHeight: .infinity)
                    .background(JieboColor.danger)
            }
            .buttonStyle(.plain)
            .opacity(offset < 0 ? 1 : 0)
            .accessibilityHidden(true)

            content
                .offset(x: offset)
                .simultaneousGesture(dragGesture)
                .accessibilityAction(named: "删除", onDelete)
        }
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 16)
            .onChanged { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let base: CGFloat = revealed ? -actionWidth : 0
                offset = min(0, max(-actionWidth - 24, base + value.translation.width))
            }
            .onEnded { _ in
                let open = offset < -actionWidth / 2
                withAnimation(JieboMotion.snappy(reduceMotion)) {
                    revealed = open
                    offset = open ? -actionWidth : 0
                }
            }
    }
}

// MARK: - 收件箱 pane（iPad；iPhone 用 InboxHome）

struct AssistantInboxList: View {
    @Environment(ChatStore.self) private var store

    init() {}

    var body: some View {
        let state = store.assistantState
        let items = state?.inbox ?? []
        VStack(alignment: .leading, spacing: 20) {
            if items.isEmpty {
                AssistantMutedText(state == nil ? "正在加载…" : "收件箱是空的。")
            } else {
                ForEach(items) { item in
                    Button {
                        store.openAssistantInboxItem(item)
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Circle()
                                .fill(item.read ? Color.clear : JieboColor.pine)
                                .frame(width: 7, height: 7)
                                .padding(.top, 6)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.title)
                                    .font(JieboFont.text(.subheadline, weight: item.read ? .regular : .semibold))
                                    .foregroundStyle(item.read ? JieboColor.ink2 : JieboColor.ink)
                                    .multilineTextAlignment(.leading)
                                Text(assistantFormatMillis(item.createdAt))
                                    .font(JieboFont.text(.caption2))
                                    .foregroundStyle(JieboColor.dim)
                                if !item.body.isEmpty {
                                    Text(String(item.body.prefix(240)))
                                        .font(JieboFont.text(.footnote))
                                        .foregroundStyle(JieboColor.ink2)
                                        .multilineTextAlignment(.leading)
                                        .lineLimit(4)
                                }
                            }
                            Spacer(minLength: 0)
                            if item.chatId != nil {
                                Image(systemName: "chevron.right")
                                    .font(JieboFont.text(.caption2, weight: .semibold))
                                    .foregroundStyle(JieboColor.dim)
                                    .padding(.top, 4)
                            }
                        }
                        .assistantCard(highlight: !item.read)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

// MARK: - 记忆 pane

struct AssistantMemoryPane: View {
    @Environment(ChatStore.self) private var store
    @State private var memTopic = ""
    @State private var memText = ""
    /// 非 nil 时核心档案在原地编辑
    @State private var coreDrafts: [String: String]?
    @State private var editingEntryId: String?
    @State private var entryTopic = ""
    @State private var entryText = ""
    @State private var purgeTarget: AssistantMemoryEntry?

    init() {}

    private var state: AssistantState? { store.assistantState }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            memoryContent
        }
        .alert("彻底删除这条记忆？", isPresented: purgePresented, presenting: purgeTarget) { entry in
            Button("彻底删除", role: .destructive) {
                store.assistantOp("memory_purge", args: ["id": .string(entry.id)])
                purgeTarget = nil
            }
            Button("取消", role: .cancel) { purgeTarget = nil }
        } message: { entry in
            Text("「\(entry.topic.nilIfEmpty ?? "未分类")」会从记忆文件里抹掉，不能恢复。")
        }
    }

    private var purgePresented: Binding<Bool> {
        Binding(get: { purgeTarget != nil }, set: { if !$0 { purgeTarget = nil } })
    }

    @ViewBuilder
    private var memoryContent: some View {
        if let memory = state?.memory {
            AssistantSection("核心档案") {
                if coreDrafts != nil {
                    coreEditor(memory)
                } else {
                    coreSummary(memory)
                }
            }

            Toggle(isOn: Binding(
                get: { memory.paused },
                set: { store.setAssistantMemoryPaused($0) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("暂停记忆")
                        .font(JieboFont.text(.subheadline, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                    Text("暂停后对话里不再自动记新东西")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            .tint(JieboColor.pine)
            .assistantCard()

            AssistantSection("新增") {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("主题", text: $memTopic)
                        .textFieldStyle(.roundedBorder)
                        .font(JieboFont.text(.subheadline))
                    TextField("要记住的内容", text: $memText, axis: .vertical)
                        .lineLimit(3...6)
                        .textFieldStyle(.roundedBorder)
                        .font(JieboFont.text(.subheadline))
                    ActionButton(title: "保存", kind: .primary, action: saveMemory)
                        .disabled(trimmed(memTopic).isEmpty || trimmed(memText).isEmpty)
                }
            }

            let valid = memory.entries.filter(\.isValid)
            let invalid = memory.entries.filter { !$0.isValid }
            AssistantSection("有效 (\(valid.count))") {
                if valid.isEmpty {
                    AssistantMutedText("还没有记忆条目。")
                } else {
                    ForEach(valid.prefix(120)) { entry in
                        entryCard(entry)
                    }
                }
            }
            if !invalid.isEmpty {
                AssistantSection("已失效 (\(invalid.count))") {
                    ForEach(invalid.prefix(60)) { entry in
                        entryCard(entry)
                    }
                }
            }
        } else {
            AssistantMutedText("正在加载记忆…")
        }
    }

    private func coreSummary(_ memory: AssistantMemory) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(memory.orderedCoreKeys, id: \.self) { key in
                VStack(alignment: .leading, spacing: 2) {
                    Text(key)
                        .font(JieboFont.text(.caption, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                    let value = memory.coreFields[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    Text(value.isEmpty ? "（空）" : value)
                        .font(JieboFont.text(.subheadline))
                        .foregroundStyle(value.isEmpty ? JieboColor.dim : JieboColor.ink)
                }
            }
            HStack {
                Text("约 \(memory.coreTokens)/\(memory.coreBudget) token")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                Spacer(minLength: 8)
                ActionButton(title: "编辑") { coreDrafts = memory.coreFields }
            }
        }
        .assistantCard()
    }

    private func coreEditor(_ memory: AssistantMemory) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(memory.orderedCoreKeys, id: \.self) { key in
                VStack(alignment: .leading, spacing: 4) {
                    Text(key)
                        .font(JieboFont.text(.caption, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                    TextField(key, text: coreBinding(key), axis: .vertical)
                        .lineLimit(2...8)
                        .textFieldStyle(.roundedBorder)
                        .font(JieboFont.text(.subheadline))
                }
            }
            Text("约 \(memory.coreTokens)/\(memory.coreBudget) token。核心档案每轮对话都会带上，写短一点。")
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
            HStack(spacing: 8) {
                ActionButton(title: "保存", kind: .primary) { saveCore(memory) }
                ActionButton(title: "取消", kind: .secondary) { coreDrafts = nil }
            }
        }
        .assistantCard()
    }

    private func coreBinding(_ key: String) -> Binding<String> {
        Binding(get: { coreDrafts?[key] ?? "" }, set: { coreDrafts?[key] = $0 })
    }

    private func saveCore(_ memory: AssistantMemory) {
        let drafts = coreDrafts ?? [:]
        var fields: [String: JSONValue] = [:]
        for key in memory.orderedCoreKeys where (drafts[key] ?? "") != (memory.coreFields[key] ?? "") {
            fields[key] = .string(drafts[key] ?? "")
        }
        if !fields.isEmpty {
            store.assistantOp("memory_core", args: [
                "fields": .object(fields),
                "rev": .number(Double(memory.coreRev)),
            ])
        }
        coreDrafts = nil
    }

    private func saveMemory() {
        let topic = trimmed(memTopic)
        let text = trimmed(memText)
        guard !topic.isEmpty, !text.isEmpty else { return }
        store.assistantOp("memory_save", args: ["topic": .string(topic), "text": .string(text)])
        memTopic = ""
        memText = ""
    }

    @ViewBuilder
    private func entryCard(_ entry: AssistantMemoryEntry) -> some View {
        if editingEntryId == entry.id {
            entryEditor(entry)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(entry.topic.nilIfEmpty ?? "未分类")
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(entry.isValid ? JieboColor.ink : JieboColor.dim)
                        .lineLimit(1)
                    if entry.inferred {
                        StatusTag(text: "推断", fg: JieboColor.run, bg: JieboColor.runBg)
                    } else {
                        StatusTag(text: "你说的", fg: JieboColor.pine, bg: JieboColor.pine.opacity(0.12))
                    }
                    Spacer(minLength: 0)
                }
                Text(String(entry.text.prefix(400)))
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(entry.isValid ? JieboColor.ink2 : JieboColor.dim)
                    .strikethrough(!entry.isValid)
                    .textSelection(.enabled)
                if !entry.isValid, let reason = entry.invalidReason {
                    Text(reason)
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        if entry.isValid {
                            ActionButton(title: "编辑") { beginEditing(entry) }
                            ActionButton(title: "标失效") {
                                store.assistantOp("memory_invalidate", args: ["id": .string(entry.id)])
                            }
                            ActionButton(title: "遗忘") {
                                store.assistantOp("memory_forget", args: ["id": .string(entry.id)])
                            }
                            ActionButton(title: "彻底删除", kind: .destructive) { purgeTarget = entry }
                        } else {
                            ActionButton(title: "恢复") {
                                store.assistantOp("memory_restore", args: ["id": .string(entry.id)])
                            }
                            ActionButton(title: "彻底删除", kind: .destructive) { purgeTarget = entry }
                        }
                    }
                }
            }
            .assistantCard()
        }
    }

    private func entryEditor(_ entry: AssistantMemoryEntry) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("主题", text: $entryTopic)
                .textFieldStyle(.roundedBorder)
                .font(JieboFont.text(.subheadline))
            TextField("内容", text: $entryText, axis: .vertical)
                .lineLimit(3...12)
                .textFieldStyle(.roundedBorder)
                .font(JieboFont.text(.subheadline))
            HStack(spacing: 8) {
                ActionButton(title: "保存", kind: .primary) { saveEntry(entry) }
                    .disabled(trimmed(entryTopic).isEmpty || trimmed(entryText).isEmpty)
                ActionButton(title: "取消", kind: .secondary) { editingEntryId = nil }
            }
        }
        .assistantCard()
    }

    private func beginEditing(_ entry: AssistantMemoryEntry) {
        entryTopic = entry.topic
        entryText = entry.text
        editingEntryId = entry.id
    }

    private func saveEntry(_ entry: AssistantMemoryEntry) {
        store.assistantOp("memory_edit", args: [
            "id": .string(entry.id),
            "rev": .number(Double(entry.rev)),
            "topic": .string(trimmed(entryTopic)),
            "text": .string(trimmed(entryText)),
        ])
        editingEntryId = nil
    }

    private func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
