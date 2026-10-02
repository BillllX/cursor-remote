import SwiftUI

/// 个人助理：今日 / 收件箱 / 记忆。对齐 web/components/AssistantPanel.tsx（通知页是浏览器推送，iOS 不做）
/// 挂在工具层里：标题、关闭和提示条由 ToolLayerOverlay 画，这里只画内容。
struct AssistantView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var tabThumb
    @State private var tab: AssistantTab = .today
    @State private var todoDraft = ""
    @State private var memTopic = ""
    @State private var memText = ""
    /// 非 nil 时核心档案在原地编辑
    @State private var coreDrafts: [String: String]?
    @State private var editingEntryId: String?
    @State private var entryTopic = ""
    @State private var entryText = ""
    @State private var purgeTarget: AssistantMemoryEntry?

    private var state: AssistantState? { store.assistantState }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusLine
            tabBar
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    switch tab {
                    case .today: todayPane
                    case .inbox: inboxPane
                    case .memory: memoryPane
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
                .font(JieboFont.ui(12))
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
                        .font(JieboFont.ui(13, weight: .medium))
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

    // MARK: 今日

    @ViewBuilder
    private var todayPane: some View {
        if let brief = state?.brief?.text.trimmingCharacters(in: .whitespacesAndNewlines), !brief.isEmpty {
            AssistantSection("简报") {
                Text(brief)
                    .font(JieboFont.ui(14))
                    .foregroundStyle(JieboColor.ink)
                    .textSelection(.enabled)
                    .assistantCard()
            }
        } else {
            mutedText("今天还没有简报。定时任务会在设定时刻生成。")
        }

        if let approvals = state?.approvals, !approvals.isEmpty {
            AssistantSection("待批 (\(approvals.count))") {
                ForEach(approvals) { approval in
                    approvalCard(approval)
                }
            }
        }

        AssistantSection("待办") {
            HStack(spacing: 8) {
                TextField("加一条待办", text: $todoDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(JieboFont.ui(14))
                    .submitLabel(.done)
                    .onSubmit(addTodo)
                ActionButton(title: "添加", kind: .primary, action: addTodo)
                    .disabled(todoDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            let open = state?.todos.filter { !$0.done } ?? []
            if open.isEmpty {
                mutedText("没有未完成的待办。")
            } else {
                ForEach(open) { todo in
                    HStack(spacing: 8) {
                        Text(todo.text)
                            .font(JieboFont.ui(14))
                            .foregroundStyle(JieboColor.ink)
                        if let due = todo.due {
                            StatusTag(text: due, fg: JieboColor.ink2, bg: JieboColor.mist)
                        }
                        Spacer(minLength: 8)
                        ActionButton(title: "完成") {
                            store.assistantOp("todo_done", args: ["id": .string(todo.id)])
                        }
                    }
                    .assistantCard()
                }
            }
        }

        if let schedules = state?.schedules, !schedules.isEmpty {
            AssistantSection("日程") {
                ForEach(schedules) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.title.nilIfEmpty ?? row.cron)
                            .font(JieboFont.ui(14, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                        Text(scheduleLine(row))
                            .font(JieboFont.ui(12))
                            .foregroundStyle(row.enabled ? JieboColor.dim : JieboColor.warnFg)
                    }
                    .assistantCard()
                }
            }
        }

        if let delegations = state?.delegations, !delegations.isEmpty {
            AssistantSection("委派") {
                ForEach(delegations.prefix(8)) { row in
                    delegationCard(row)
                }
            }
        }
    }

    private func addTodo() {
        let text = todoDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        store.assistantOp("todo_add", args: ["text": .string(text)])
        todoDraft = ""
    }

    private func scheduleLine(_ row: AssistantSchedule) -> String {
        var line = "\(row.cron) · \(row.enabled ? "启用" : "暂停")"
        if let reason = row.pausedReason { line += " · \(reason)" }
        return line
    }

    private func approvalCard(_ approval: AssistantApproval) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(approval.tool.nilIfEmpty ?? "工具调用")
                .font(JieboFont.ui(14, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
            if !approval.summary.isEmpty {
                Text(approval.summary)
                    .font(JieboFont.mono(12))
                    .foregroundStyle(JieboColor.ink2)
                    .lineLimit(6)
            }
            HStack(spacing: 8) {
                ActionButton(title: "批准", kind: .primary) {
                    store.answerAssistantApproval(approval, allow: true)
                }
                ActionButton(title: "拒绝", kind: .secondary) {
                    store.answerAssistantApproval(approval, allow: false)
                }
            }
        }
        .assistantCard()
    }

    private func delegationCard(_ row: AssistantDelegation) -> some View {
        let openable = !row.childChatId.isEmpty && store.chats.contains(where: { $0.id == row.childChatId })
        let colors = row.statusColors
        return Button {
            if openable { store.openAssistantChat(row.childChatId) }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(row.title.nilIfEmpty ?? "委派")
                        .font(JieboFont.ui(14, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    StatusTag(text: row.statusLabel, fg: colors.fg, bg: colors.bg)
                    Spacer(minLength: 0)
                    if openable {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(JieboColor.dim)
                    }
                }
                if !row.workspace.isEmpty {
                    Text(row.workspace)
                        .font(JieboFont.mono(11))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let result = row.result {
                    Text(String(result.prefix(300)))
                        .font(JieboFont.ui(13))
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

    // MARK: 收件箱

    @ViewBuilder
    private var inboxPane: some View {
        let items = state?.inbox ?? []
        if items.isEmpty {
            mutedText(state == nil ? "正在加载…" : "收件箱是空的。")
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
                                .font(JieboFont.ui(14, weight: item.read ? .regular : .semibold))
                                .foregroundStyle(item.read ? JieboColor.ink2 : JieboColor.ink)
                                .multilineTextAlignment(.leading)
                            Text(formatMillis(item.createdAt))
                                .font(JieboFont.ui(11))
                                .foregroundStyle(JieboColor.dim)
                            if !item.body.isEmpty {
                                Text(String(item.body.prefix(240)))
                                    .font(JieboFont.ui(13))
                                    .foregroundStyle(JieboColor.ink2)
                                    .multilineTextAlignment(.leading)
                                    .lineLimit(4)
                            }
                        }
                        Spacer(minLength: 0)
                        if item.chatId != nil {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
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

    // MARK: 记忆

    @ViewBuilder
    private var memoryPane: some View {
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
                        .font(JieboFont.ui(14, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                    Text("暂停后对话里不再自动记新东西")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            .tint(JieboColor.pine)
            .assistantCard()

            AssistantSection("新增") {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("主题", text: $memTopic)
                        .textFieldStyle(.roundedBorder)
                        .font(JieboFont.ui(14))
                    TextField("要记住的内容", text: $memText, axis: .vertical)
                        .lineLimit(3...6)
                        .textFieldStyle(.roundedBorder)
                        .font(JieboFont.ui(14))
                    ActionButton(title: "保存", kind: .primary, action: saveMemory)
                        .disabled(trimmed(memTopic).isEmpty || trimmed(memText).isEmpty)
                }
            }

            let valid = memory.entries.filter(\.isValid)
            let invalid = memory.entries.filter { !$0.isValid }
            AssistantSection("有效 (\(valid.count))") {
                if valid.isEmpty {
                    mutedText("还没有记忆条目。")
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
            mutedText("正在加载记忆…")
        }
    }

    private func coreSummary(_ memory: AssistantMemory) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(memory.orderedCoreKeys, id: \.self) { key in
                VStack(alignment: .leading, spacing: 2) {
                    Text(key)
                        .font(JieboFont.ui(12, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                    let value = memory.coreFields[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    Text(value.isEmpty ? "（空）" : value)
                        .font(JieboFont.ui(14))
                        .foregroundStyle(value.isEmpty ? JieboColor.dim : JieboColor.ink)
                }
            }
            HStack {
                Text("约 \(memory.coreTokens)/\(memory.coreBudget) token")
                    .font(JieboFont.ui(12))
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
                        .font(JieboFont.ui(12, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                    TextField(key, text: coreBinding(key), axis: .vertical)
                        .lineLimit(2...8)
                        .textFieldStyle(.roundedBorder)
                        .font(JieboFont.ui(14))
                }
            }
            Text("约 \(memory.coreTokens)/\(memory.coreBudget) token。核心档案每轮对话都会带上，写短一点。")
                .font(JieboFont.ui(12))
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
                        .font(JieboFont.ui(14, weight: .semibold))
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
                    .font(JieboFont.ui(13))
                    .foregroundStyle(entry.isValid ? JieboColor.ink2 : JieboColor.dim)
                    .strikethrough(!entry.isValid)
                    .textSelection(.enabled)
                if !entry.isValid, let reason = entry.invalidReason {
                    Text(reason)
                        .font(JieboFont.ui(11))
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
                .font(JieboFont.ui(14))
            TextField("内容", text: $entryText, axis: .vertical)
                .lineLimit(3...12)
                .textFieldStyle(.roundedBorder)
                .font(JieboFont.ui(14))
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

    // MARK: 杂项

    private func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func mutedText(_ text: String) -> some View {
        Text(text)
            .font(JieboFont.ui(13))
            .foregroundStyle(JieboColor.dim)
    }

    private func formatMillis(_ millis: Double) -> String {
        guard millis > 0 else { return "" }
        return Date(timeIntervalSince1970: millis / 1000).formatted(date: .abbreviated, time: .shortened)
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

private struct AssistantSection<Content: View>: View {
    var title: String
    var content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(JieboFont.ui(12, weight: .semibold))
                .tracking(0.4)
                .foregroundStyle(JieboColor.dim)
            content
        }
    }
}

/// 与侧栏会话行的「跑」标同一形状：小号字、浅底胶囊
private struct StatusTag: View {
    var text: String
    var fg: Color
    var bg: Color

    var body: some View {
        Text(text)
            .font(JieboFont.ui(10, weight: .medium))
            .foregroundStyle(fg)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(bg)
            .clipShape(Capsule())
    }
}

/// 按钮沿用现有两套：主/次与输入框待批条的「允许 / 拒绝」一致，描边与工具层顶栏的「保留 / 还原」一致
private struct ActionButton: View {
    enum Kind { case primary, secondary, outline, destructive }

    var title: String
    var kind: Kind = .outline
    var action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .font(JieboFont.ui(13, weight: kind == .primary ? .semibold : .medium))
            .foregroundStyle(foreground)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(background)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .overlay {
                if kind == .outline || kind == .destructive {
                    RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                }
            }
            .opacity(isEnabled ? 1 : 0.45)
            .hitTarget(36)
    }

    private var foreground: Color {
        switch kind {
        case .primary: return JieboColor.fillFg
        case .secondary: return JieboColor.ink
        case .outline: return JieboColor.ink
        case .destructive: return JieboColor.danger
        }
    }

    private var background: Color {
        switch kind {
        case .primary: return JieboColor.pine
        case .secondary: return JieboColor.mist
        case .outline, .destructive: return Color.clear
        }
    }
}

private extension View {
    func assistantCard(highlight: Bool = false) -> some View {
        padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(highlight ? JieboColor.userBubble : JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
    }
}
