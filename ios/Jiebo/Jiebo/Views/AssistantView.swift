import SwiftUI
import UIKit

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
    /// 为 false 时今日只留简报，待办和计划留在各自栏目，避免变成另一份列表。
    var showsWorklists: Bool
    /// 预留：今日页本身不含收件箱，保留参数让调用方写法统一
    var showsInbox: Bool
    @State private var todoDraft = ""
    @State private var doneExpanded = false
    @State private var editingTodo: AssistantTodo?
    @AppStorage(CalendarInvite.dismissedKey) private var calendarInviteDismissed = false
    @AppStorage(CalendarInvite.staleDismissedKey) private var calendarStaleDismissedAt: Double = 0

    init(showsApprovals: Bool = true, showsDelegations: Bool = true, showsWorklists: Bool = true, showsInbox: Bool = true) {
        self.showsApprovals = showsApprovals
        self.showsDelegations = showsDelegations
        self.showsWorklists = showsWorklists
        self.showsInbox = showsInbox
    }

    private var state: AssistantState? { store.assistantState }

    var body: some View {
        if state == nil {
            // 状态还没到时各区的空文案（「今天还没有简报」「没有未完成的待办」）会被当成真的没有
            if let title = store.assistantStatePendingTitle {
                AssistantMutedText(title)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    AssistantMutedText("正在加载…")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
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
            if showsWorklists {
                todoSection
                scheduleSection
            }
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
                                store.setTodoDone(todo.id, done: true)
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
                                store.setTodoDone(todo.id, done: false)
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
        guard store.queueTodoChange("todo_add", args: ["text": .string(text)], pending: "添加这条待办") else { return }
        todoDraft = ""
    }

    private func removeTodo(_ todo: AssistantTodo) {
        store.queueTodoChange("todo_remove", args: ["id": .string(todo.id)], pending: "删除这条待办")
    }

    // MARK: 日程

    @ViewBuilder
    private var scheduleSection: some View {
        if let schedules = state?.schedules, !schedules.isEmpty {
            AssistantSection("计划") {
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
                JieboHaptic.notification(.warning)
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
                AssistantMutedText(state == nil ? (store.assistantStatePendingTitle ?? "正在加载…") : "没有通知。")
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

