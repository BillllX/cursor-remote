import SwiftUI

struct SidebarView: View {
    @Environment(ChatStore.self) private var store
    var collapse: () -> Void = {}
    /// P9：展开的工作区集合（默认收起，只记正向状态；含活跃会话的组强制展开）。
    /// P7b 曾是负向 collapsed 集合，P9 按产品决定翻转默认——旧 key 在 .task 里清掉。
    /// 初始值在 .task 里装载——@State 默认表达式每次视图 init 都求值，JSON 解码不该跟着 body 高频跑
    @State private var expanded: Set<String> = []
    /// P8：重命名目标（alert presenting 驱动）
    @State private var renameTarget: ChatSession?
    @State private var renameDraft = ""
    /// P9：管理员统计面板
    @State private var adminStatsOpen = false

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                JieboMark(size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("接驳")
                        .font(JieboFont.display(22))
                        .foregroundStyle(JieboColor.ink)
                    Text(store.connected ? subtitle : "正在重连…")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                }
                Spacer()
                Button(action: collapse) {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .frame(width: 36, height: 36)
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                        .hitTarget()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("收起侧栏")
                Button(action: store.openNewChat) {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .frame(width: 36, height: 36)
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                        .hitTarget() // P6：视觉 36，命中 44
                }
                .buttonStyle(.plain)
                .keyboardShortcut("n", modifiers: .command)
                .accessibilityLabel("新对话")
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 12)

            List {
                let groups = store.workspaceGroups // body 里只算一遍（@Observable 不缓存计算属性）
                let dupNames = duplicateNames(in: groups)
                if groups.count <= 1 {
                    // 单组：隐藏组头，观感=扁平列表（零打扰渐进）
                    ForEach(groups.first?.chats ?? []) { chat in
                        chatRow(chat)
                    }
                } else {
                    ForEach(groups) { group in
                        // 组头是普通 row 而非 Section header——iOS 17+ List 会丢掉零 row 的
                        // 空 section（含 header），折叠后组头会消失/点不着（评审 Grok M4）
                        groupHeader(group, duplicate: dupNames.contains(group.name))
                        if !isCollapsed(group) {
                            ForEach(group.chats) { chat in
                                chatRow(chat)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            // P8：重命名 alert（swipe/长按菜单共用入口）
            .alert("重命名会话", isPresented: renamePresented, presenting: renameTarget) { chat in
                TextField("会话标题", text: $renameDraft)
                    .textInputAutocapitalization(.sentences)
                Button("取消", role: .cancel) { renameTarget = nil }
                Button("确定") {
                    store.renameChat(chat.id, to: renameDraft)
                    renameTarget = nil
                }
            } message: { chat in
                Text(chat.title)
            }

            HStack(spacing: 10) {
                Button("退出登录", action: store.logout)
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.ink2)
                ForEach(ToolLayer.allCases) { layer in
                    toolButton(layer)
                }
                Spacer()
                if store.isAdmin {
                    Button {
                        adminStatsOpen = true
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "chart.bar")
                                .font(.system(size: 12))
                            Text("统计")
                                .font(JieboFont.ui(13))
                        }
                        .foregroundStyle(JieboColor.ink2)
                        .hitTarget()
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("查看使用统计")
                }
                Circle()
                    .fill(store.connected ? JieboColor.ok : JieboColor.clay)
                    .frame(width: 8, height: 8)
            }
            .padding(16)
        }
        .background(JieboColor.sidebar.ignoresSafeArea())
        .sheet(isPresented: $store.workspaceSheetOpen) {
            WorkspaceSheet()
        }
        .sheet(isPresented: $adminStatsOpen) {
            AdminStatsView()
        }
        .task {
            expanded = Self.loadExpanded(for: store.tenantId)
            UserDefaults.standard.removeObject(forKey: Self.legacyCollapsedKey) // P9：清 P7b 旧 key
        }
        .onChange(of: store.tenantId) { _, next in
            expanded = Self.loadExpanded(for: next) // 租户切换：展开集按租户隔离（Kimi R1 N4）
        }
    }

    // MARK: P7b 工作区分组

    /// 组名重复（两个工作区末段同名很常见）→ 组头补路径副标题
    private func duplicateNames(in groups: [WorkspaceGroup]) -> Set<String> {
        Set(Dictionary(grouping: groups, by: \.name).filter { $0.value.count > 1 }.keys)
    }

    /// 含活跃会话的组强制展开（否则选中项被折进组头里不可见）；其余组默认收起（P9）
    private func isCollapsed(_ group: WorkspaceGroup) -> Bool {
        if group.chats.contains(where: { $0.id == store.activeId }) { return false }
        return !expanded.contains(group.key)
    }

    @ViewBuilder
    private func groupHeader(_ group: WorkspaceGroup, duplicate: Bool) -> some View {
        let active = group.chats.contains(where: { $0.id == store.activeId })
        Button {
            if group.chats.isEmpty {
                store.startChat(in: group.path) // 空组：点击直达新建（对齐 web 空组保留的意图）
            } else if !active {
                // 含活跃会话的组不接受折叠：点了没反应会像 bug，且写入展开集会「记仇」
                //（活跃会话移走后组状态莫名其妙变化）——chevron 置灰表达不可点
                if expanded.contains(group.key) { expanded.remove(group.key) } else { expanded.insert(group.key) }
                Self.saveExpanded(expanded, for: store.tenantId)
            }
        } label: {
            HStack(spacing: 6) {
                if !group.chats.isEmpty {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(active ? JieboColor.dim.opacity(0.5) : JieboColor.dim)
                        .rotationEffect(.degrees(isCollapsed(group) ? 0 : 90))
                }
                Text(group.name)
                    .font(JieboFont.ui(12, weight: .semibold))
                    .foregroundStyle(JieboColor.ink2)
                    .lineLimit(1)
                if duplicate {
                    Text(group.path)
                        .font(JieboFont.mono(10))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                if group.chats.contains(where: { $0.turns.contains(where: \.running) || store.runningChatIds.contains($0.id) }) {
                    Circle().fill(JieboColor.pine).frame(width: 6, height: 6)
                }
                if group.chats.isEmpty {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(JieboColor.dim)
                } else {
                    Text("\(group.chats.count)")
                        .font(JieboFont.ui(11))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            .padding(.vertical, 2)
            .frame(minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityLabel(group.chats.isEmpty ? "在 \(group.name) 新建会话" : "\(group.name)，\(group.chats.count) 个会话")
        // 活跃组头点击是 no-op（不接受折叠），给 VoiceOver 用户一句解释，别点了没反应（Kimi R2 MINOR）
        .accessibilityHint(active && !group.chats.isEmpty ? "含当前会话，不能折叠" : "")
    }

    // MARK: 会话行（与原扁平列表一致）

    private func chatRow(_ chat: ChatSession) -> some View {
        Button {
            store.select(chat.id)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(chat.turns.contains(where: \.running) || store.runningChatIds.contains(chat.id) ? JieboColor.pine : (chat.unread ? JieboColor.brass : .clear))
                    .frame(width: 8, height: 8)
                    .padding(.top, 7)
                VStack(alignment: .leading, spacing: 4) {
                    Text(chat.title)
                        .font(JieboFont.ui(15, weight: chat.unread ? .semibold : .medium))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    if !chat.preview.isEmpty {
                        Text(chat.preview)
                            .font(JieboFont.ui(12))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .frame(minHeight: 44) // P6：会话行触控高度达标（HIG 44）
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(chat.id == store.activeId ? JieboColor.userBubble : Color.clear)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                store.deleteChat(chat.id)
            } label: {
                Label("删除", systemImage: "trash")
            }
            Button {
                renameDraft = chat.isUntitled ? "" : chat.title
                renameTarget = chat
            } label: {
                Label("重命名", systemImage: "pencil")
            }
            .tint(JieboColor.brass)
        }
        .contextMenu {
            Button {
                renameDraft = chat.isUntitled ? "" : chat.title
                renameTarget = chat
            } label: {
                Label("重命名", systemImage: "pencil")
            }
            Button(role: .destructive) {
                store.deleteChat(chat.id)
            } label: {
                Label("删除", systemImage: "trash")
            }
        }
    }

    /// alert isPresented 绑定（presenting: 需要 Bool 驱动）
    private var renamePresented: Binding<Bool> {
        Binding(get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } })
    }

    // MARK: 展开状态持久化（UserDefaults 存 JSON，key=normPath；路径漂移后 key 失效无害，默认收起兜底）

    /// 按租户隔离（与 lastActiveChatId 同口径）；空租户（未连接）退化为全局 key
    private static func expandedKey(for tenantId: String) -> String {
        tenantId.isEmpty ? "sidebar.expandedWorkspaces" : "sidebar.expandedWorkspaces.\(tenantId)"
    }
    /// P7b 的负向 key：语义与新默认一致（收起），直接废弃清理
    private static let legacyCollapsedKey = "sidebar.collapsedWorkspaces"

    private static func loadExpanded(for tenantId: String) -> Set<String> {
        if let data = UserDefaults.standard.data(forKey: expandedKey(for: tenantId)),
           let list = try? JSONDecoder().decode([String].self, from: data) { return Set(list) }
        // 一次性迁移：P9 首版的全局 key → per-tenant（否则老用户升级后展开状态全丢）
        if !tenantId.isEmpty, let data = UserDefaults.standard.data(forKey: expandedKey(for: "")),
           let list = try? JSONDecoder().decode([String].self, from: data) {
            let set = Set(list)
            saveExpanded(set, for: tenantId)
            UserDefaults.standard.removeObject(forKey: expandedKey(for: ""))
            return set
        }
        return []
    }

    private static func saveExpanded(_ set: Set<String>, for tenantId: String) {
        let list = Array(set)
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: expandedKey(for: tenantId))
    }

    // MARK: 杂项

    private func toolButton(_ layer: ToolLayer) -> some View {
        let on = store.toolLayer == layer
        let marked = layer == .loop && loopLive
        return Button {
            store.toggleTool(layer)
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: layer.symbol)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(on ? JieboColor.paper : JieboColor.ink2)
                    .frame(width: 32, height: 32)
                    .background(on ? JieboColor.pine : JieboColor.mist)
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                if marked {
                    Circle().fill(JieboColor.pine).frame(width: 6, height: 6).offset(x: 2, y: -2)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(layer.title)
    }

    private var loopLive: Bool {
        guard let row = store.loops[store.activeId] else { return false }
        return row.status == "armed" || row.status == "running"
    }

    private var subtitle: String {
        let base = workspaceName(store.cwd.isEmpty ? store.workspaceRoot : store.cwd)
        return store.tenantName.isEmpty ? base : "\(store.tenantName) · \(base)"
    }
}

private struct WorkspaceSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            List {
                Section("工作区") {
                    ForEach(store.workspaces) { item in
                        Button {
                            store.startChat(in: item.path)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.name)
                                    .font(JieboFont.ui(16, weight: .medium))
                                    .foregroundStyle(JieboColor.ink)
                                Text(item.path)
                                    .font(JieboFont.mono(12))
                                    .foregroundStyle(JieboColor.dim)
                                    .lineLimit(1)
                            }
                        }
                    }
                    if store.workspaces.isEmpty {
                        Button {
                            store.startChat(in: store.workspaceRoot.isEmpty ? store.cwd : store.workspaceRoot)
                            dismiss()
                        } label: {
                            Text(store.workspaceRoot.isEmpty ? "正在读取工作区…" : workspaceName(store.workspaceRoot))
                                .foregroundStyle(JieboColor.ink)
                        }
                        .disabled(store.workspaceRoot.isEmpty && store.cwd.isEmpty)
                    }
                }
                Section {
                    if store.creatingWorkspace {
                        HStack {
                            TextField("名称", text: $store.newWorkspaceName)
                                .onSubmit { store.createWorkspace() }
                            Button("创建", action: store.createWorkspace)
                                .disabled(store.newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    } else {
                        Button("新建工作区") {
                            store.creatingWorkspace = true
                        }
                    }
                }
            }
            .navigationTitle("新对话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct LoopSheet: View {
    @Environment(ChatStore.self) private var store
    @State private var goal = ""
    @State private var interval = "900"
    @State private var maxTicks = ""

    private var row: LoopSnapshot? { store.loops[store.activeId] }

    private var live: Bool {
        guard let row else { return false }
        return row.status == "armed" || row.status == "running"
    }

    var body: some View {
        Form {
            Section {
                TextField("每拍要做的事。做完时让它在最后一行写 LOOP_DONE", text: $goal, axis: .vertical)
                    .lineLimit(3...6)
                TextField("间隔（秒）", text: $interval)
                    .keyboardType(.numberPad)
                TextField("最多拍数，可空", text: $maxTicks)
                    .keyboardType(.numberPad)
            }
            Section {
                if !store.loopError.isEmpty {
                    Text(store.loopError)
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.clay)
                }
                if let row {
                    Text(statusLine(row))
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.ink2)
                } else {
                    Text("还没开始。关掉 App 也会继续，重新打开后状态还在。")
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            Section {
                Button("开始") { start() }
                    .disabled(live)
                Button("停止", role: .destructive) { store.stopActiveLoop() }
                    .disabled(!live)
            }
        }
        .onAppear { refill() }
        .onChange(of: store.activeId) { _, _ in refill() }
    }

    private func refill() {
        if let row, row.status != "stopped", row.status != "idle" {
            goal = row.goal
            interval = String(row.intervalSec)
            maxTicks = row.maxTicks.map(String.init) ?? ""
        } else {
            goal = ""
            interval = "900"
            maxTicks = ""
        }
    }

    private func start() {
        let cap = maxTicks.trimmingCharacters(in: .whitespacesAndNewlines)
        let parsed = cap.isEmpty ? nil : Int(cap)
        if !cap.isEmpty, parsed == nil {
            store.loopError = "最多拍数要是整数"
            return
        }
        let secondsText = interval.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let seconds = Int(secondsText) else {
            store.loopError = "间隔要是整数"
            return
        }
        store.startActiveLoop(goal: goal, intervalSec: seconds, maxTicks: parsed)
    }

    private func statusLine(_ row: LoopSnapshot) -> String {
        let state: String
        switch row.status {
        case "running": state = "正在跑"
        case "armed": state = "等待下一拍"
        case "stopped": state = "已停止"
        default: state = "空闲"
        }
        var line = "\(state) · 第 \(row.tick) 拍"
        if let max = row.maxTicks { line += " / \(max)" }
        if let summary = row.lastSummary, !summary.isEmpty { line += " · \(summary)" }
        return line
    }
}
