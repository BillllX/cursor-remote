import SwiftUI

/// 个人助理：今日 / 收件箱 / 记忆。对齐 web/components/AssistantPanel.tsx（通知页是浏览器推送，iOS 不做）
struct AssistantView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var tab: AssistantTab = .today
    @State private var todoDraft = ""
    @State private var memTopic = ""
    @State private var memText = ""
    @State private var coreEditing = false
    @State private var editingEntry: AssistantMemoryEntry?
    @State private var purgeTarget: AssistantMemoryEntry?

    private var state: AssistantState? { store.assistantState }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                Picker("分页", selection: $tab) {
                    ForEach(AssistantTab.allCases) { item in
                        Text(tabTitle(item)).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal, 16)
                .padding(.bottom, 10)
                if !store.notice.isEmpty {
                    Text(store.notice)
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        switch tab {
                        case .today: todayPane
                        case .inbox: inboxPane
                        case .memory: memoryPane
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .background(JieboColor.paper.ignoresSafeArea())
            .navigationTitle("助理")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
        .task { store.requestAssistant(memory: tab == .memory) }
        .onChange(of: tab) { _, next in
            if next == .memory { store.requestAssistant(memory: true) }
        }
        .sheet(isPresented: $coreEditing) {
            if let memory = state?.memory {
                CoreMemoryEditor(memory: memory)
            }
        }
        .sheet(item: $editingEntry) { entry in
            MemoryEntryEditor(entry: entry)
        }
        .confirmationDialog("彻底删除这条记忆？", isPresented: purgePresented, titleVisibility: .visible, presenting: purgeTarget) { entry in
            Button("彻底删除", role: .destructive) {
                store.assistantOp("memory_purge", args: ["id": .string(entry.id)])
                purgeTarget = nil
            }
            Button("取消", role: .cancel) { purgeTarget = nil }
        } message: { entry in
            Text("「\(entry.topic)」会从记忆文件里抹掉，不能恢复。")
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

    private var header: some View {
        let background = state?.background
        let ok = background?.ok ?? false
        let model = background?.model.nilIfEmpty ?? "grok-4.7"
        let status = ok ? "就绪" : (background?.reason ?? (state == nil ? "正在连接…" : "未就绪"))
        return HStack(spacing: 10) {
            JieboMark(size: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(state?.name ?? store.assistantName)
                    .font(JieboFont.display(17))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Circle()
                        .fill(ok ? JieboColor.ok : JieboColor.clay)
                        .frame(width: 6, height: 6)
                    Text("后台 \(model) · \(status)")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 12)
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
                    .submitLabel(.done)
                    .onSubmit(addTodo)
                AssistantPillButton(title: "添加", filled: true, action: addTodo)
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
                            AssistantTag(text: due)
                        }
                        Spacer(minLength: 8)
                        AssistantPillButton(title: "完成") {
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
                            .foregroundStyle(row.enabled ? JieboColor.dim : JieboColor.clay)
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
                AssistantPillButton(title: "批准", filled: true) {
                    store.answerAssistantApproval(approval, allow: true)
                }
                AssistantPillButton(title: "拒绝", tint: JieboColor.danger) {
                    store.answerAssistantApproval(approval, allow: false)
                }
            }
        }
        .assistantCard()
    }

    private func delegationCard(_ row: AssistantDelegation) -> some View {
        let openable = !row.childChatId.isEmpty && store.chats.contains(where: { $0.id == row.childChatId })
        return Button {
            if openable { store.openAssistantChat(row.childChatId) }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(row.title.nilIfEmpty ?? "委派")
                        .font(JieboFont.ui(14, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    AssistantTag(text: row.statusLabel, tint: row.statusTint)
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
                        AssistantPillButton(title: "编辑") { coreEditing = true }
                    }
                }
                .assistantCard()
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
                    TextField("要记住的内容", text: $memText, axis: .vertical)
                        .lineLimit(3...6)
                        .textFieldStyle(.roundedBorder)
                    AssistantPillButton(title: "保存", filled: true, action: saveMemory)
                        .disabled(memTopic.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || memText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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

    private func saveMemory() {
        let topic = memTopic.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = memText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !topic.isEmpty, !text.isEmpty else { return }
        store.assistantOp("memory_save", args: ["topic": .string(topic), "text": .string(text)])
        memTopic = ""
        memText = ""
    }

    private func entryCard(_ entry: AssistantMemoryEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(entry.topic.nilIfEmpty ?? "未分类")
                    .font(JieboFont.ui(14, weight: .semibold))
                    .foregroundStyle(entry.isValid ? JieboColor.ink : JieboColor.dim)
                    .lineLimit(1)
                AssistantTag(text: entry.inferred ? "推断" : "你说的", tint: entry.inferred ? JieboColor.brass : JieboColor.pine)
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
                        AssistantPillButton(title: "编辑") { editingEntry = entry }
                        AssistantPillButton(title: "标失效") {
                            store.assistantOp("memory_invalidate", args: ["id": .string(entry.id)])
                        }
                        AssistantPillButton(title: "遗忘") {
                            store.assistantOp("memory_forget", args: ["id": .string(entry.id)])
                        }
                        AssistantPillButton(title: "彻底删除", tint: JieboColor.danger) { purgeTarget = entry }
                    } else {
                        AssistantPillButton(title: "恢复") {
                            store.assistantOp("memory_restore", args: ["id": .string(entry.id)])
                        }
                    }
                }
            }
        }
        .assistantCard()
    }

    // MARK: 杂项

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

    var statusTint: Color {
        switch status {
        case "running": return JieboColor.run
        case "awaiting": return JieboColor.brass
        case "done": return JieboColor.ok
        case "failed": return JieboColor.danger
        default: return JieboColor.dim
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

struct AssistantTag: View {
    var text: String
    var tint: Color = JieboColor.dim

    var body: some View {
        Text(text)
            .font(JieboFont.ui(10, weight: .semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .overlay(Capsule().stroke(tint.opacity(0.45), lineWidth: 1))
    }
}

struct AssistantPillButton: View {
    var title: String
    var tint: Color = JieboColor.ink2
    var filled = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(JieboFont.ui(13, weight: .medium))
                .foregroundStyle(filled ? JieboColor.fillFg : tint)
                .padding(.horizontal, 12)
                .frame(height: 30)
                .background(filled ? JieboColor.pine : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                        .stroke(filled ? Color.clear : JieboColor.line, lineWidth: 1)
                )
                .hitTarget(36)
        }
        .buttonStyle(PressScaleButtonStyle())
    }
}

/// 入口角标：未读收件箱 + 待批。0 时不画
struct AssistantBadge: View {
    var count: Int

    var body: some View {
        if count > 0 {
            Text(count > 99 ? "99+" : "\(count)")
                .font(JieboFont.ui(10, weight: .bold))
                .foregroundStyle(JieboColor.fillFg)
                .padding(.horizontal, 5)
                .frame(minWidth: 16, minHeight: 16)
                .background(JieboColor.clay)
                .clipShape(Capsule())
                .accessibilityLabel("\(count) 条待处理")
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

private struct CoreMemoryEditor: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let memory: AssistantMemory
    @State private var drafts: [String: String] = [:]

    var body: some View {
        NavigationStack {
            Form {
                ForEach(memory.orderedCoreKeys, id: \.self) { key in
                    Section(key) {
                        TextField(key, text: binding(for: key), axis: .vertical)
                            .lineLimit(2...8)
                    }
                }
                Section {
                    Text("约 \(memory.coreTokens)/\(memory.coreBudget) token。核心档案每轮对话都会带上，写短一点。")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            .navigationTitle("编辑核心档案")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                }
            }
        }
        .onAppear { drafts = memory.coreFields }
    }

    private func binding(for key: String) -> Binding<String> {
        Binding(get: { drafts[key] ?? "" }, set: { drafts[key] = $0 })
    }

    private func save() {
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
        dismiss()
    }
}

private struct MemoryEntryEditor: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let entry: AssistantMemoryEntry
    @State private var topic = ""
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("主题") {
                    TextField("主题", text: $topic)
                }
                Section("内容") {
                    TextField("内容", text: $text, axis: .vertical)
                        .lineLimit(3...12)
                }
            }
            .navigationTitle("编辑记忆")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .disabled(trimmed(topic).isEmpty || trimmed(text).isEmpty)
                }
            }
        }
        .onAppear {
            topic = entry.topic
            text = entry.text
        }
    }

    private func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func save() {
        store.assistantOp("memory_edit", args: [
            "id": .string(entry.id),
            "rev": .number(Double(entry.rev)),
            "topic": .string(trimmed(topic)),
            "text": .string(trimmed(text)),
        ])
        dismiss()
    }
}
