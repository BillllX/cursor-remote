import SwiftUI

struct SidebarView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    @State private var deleteTarget: ChatSession?
    @State private var themeOpen = false

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                JieboMark(size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.currentWorkspaceName)
                        .font(JieboFont.display(22))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(store.connected ? subtitle : "正在重连…")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Button(action: store.openWorkspaceSwitcher) {
                    Image(systemName: "square.stack.3d.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .frame(width: 36, height: 36)
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                        .shadow(color: .black.opacity(0.06), radius: 4, y: 1)
                        .hitTarget()
                }
                .buttonStyle(PressScaleButtonStyle())
                .accessibilityLabel("切换工作区")
                Button(action: collapse) {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .frame(width: 36, height: 36)
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                        .shadow(color: .black.opacity(0.06), radius: 4, y: 1)
                        .hitTarget()
                }
                .buttonStyle(PressScaleButtonStyle())
                .accessibilityLabel("收起侧栏")
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 12)

            Button(action: store.openNewChat) {
                Label("新对话", systemImage: "plus")
                    .font(JieboFont.ui(14, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleButtonStyle())
            .disabled(store.currentWorkspacePath.isEmpty)
            .keyboardShortcut("n", modifiers: .command)
            .accessibilityLabel("在当前工作区新建对话")

            List {
                let chats = store.currentWorkspaceChats
                if chats.isEmpty {
                    Text("这个工作区还没有会话")
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.dim)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                } else {
                    ForEach(chats) { chat in
                        chatRow(chat)
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
            .alert("删除这个会话？", isPresented: deletePresented, presenting: deleteTarget) { chat in
                Button("删除", role: .destructive) {
                    store.deleteChat(chat.id)
                    deleteTarget = nil
                }
                Button("取消", role: .cancel) { deleteTarget = nil }
            } message: { chat in
                Text("「\(chat.title)」会从这台设备上的列表里去掉。")
            }

            VStack(spacing: 8) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 4) {
                        ForEach(ToolLayer.allCases) { layer in
                            toolButton(layer, labeled: true)
                        }
                    }
                    HStack(spacing: 4) {
                        ForEach(ToolLayer.allCases) { layer in
                            toolButton(layer, labeled: false)
                        }
                    }
                }
                HStack(spacing: 6) {
                    footerIcon("paintpalette", label: "主题") { themeOpen = true }
                    if store.isAdmin {
                        footerIcon("chart.bar", label: "查看使用统计") { adminStatsOpen = true }
                    }
                    Spacer(minLength: 8)
                    ConnectionDot(connected: store.connected)
                    footerIcon("rectangle.portrait.and.arrow.right", label: "退出登录", tint: JieboColor.danger, action: store.logout)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(JieboColor.sidebar)
        }
        .background(JieboColor.sidebar.ignoresSafeArea())
        // 与主区地面分层：右侧 1pt 冷灰分栏线（栏宽不变）
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(JieboColor.line.opacity(0.9))
                .frame(width: 1)
                .allowsHitTesting(false)
        }
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(removing: .sidebarToggle)
        .sheet(isPresented: $store.workspaceSheetOpen) {
            WorkspaceSheet()
        }
        .sheet(isPresented: $themeOpen) {
            ThemeSettingsSheet()
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
        let running = group.chats.contains(where: { $0.turns.contains(where: \.running) || store.runningChatIds.contains($0.id) })
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
                        .animation(.easeOut(duration: 0.2), value: isCollapsed(group))
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
                if running {
                    Circle().fill(JieboColor.pine).frame(width: 6, height: 6)
                        .transition(.opacity)
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
            .animation(JieboMotion.fade(reduceMotion), value: running)
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
        let selected = chat.id == store.activeId
        return Button {
            store.select(chat.id)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                // 选中态 2pt 品牌竖条（行高不变）
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(selected ? JieboColor.pine : Color.clear)
                    .frame(width: 2)
                    .padding(.vertical, 2)
                let live = chat.turns.contains(where: \.running) || store.runningChatIds.contains(chat.id)
                let marked = live || chat.unread
                Circle()
                    .fill(live ? JieboColor.pine : JieboColor.brass)
                    .opacity(marked ? 1 : 0)
                    .frame(width: 8, height: 8)
                    .padding(.top, 7)
                    .animation(JieboMotion.fade(reduceMotion), value: marked)
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
            .padding(.horizontal, 8)
            .frame(minHeight: 44) // P6：会话行触控高度达标（HIG 44）
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? JieboColor.userBubble.opacity(0.92) : Color.clear)
            )
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
        .animation(JieboMotion.fade(reduceMotion), value: selected)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                deleteTarget = chat
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
                deleteTarget = chat
            } label: {
                Label("删除", systemImage: "trash")
            }
        }
    }

    /// alert isPresented 绑定（presenting: 需要 Bool 驱动）
    private var deletePresented: Binding<Bool> {
        Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } })
    }

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

    /// 低频账号操作。工作工具在上面一行，这里从左到右按重要程度：主题、统计，连接状态，退出在最右。
    private func footerIcon(
        _ symbol: String,
        label: String,
        tint: Color = JieboColor.ink2,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 36, height: 36)
                .background(JieboColor.mist)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(label)
    }

    private func toolButton(_ layer: ToolLayer, labeled: Bool) -> some View {
        let on = store.toolSelected(layer)
        let marked = layer == .loop && loopLive
        return Button {
            store.toggleTool(layer)
        } label: {
            VStack(spacing: 3) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: layer.symbol)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(on ? JieboColor.paper : JieboColor.ink2)
                        .frame(width: 28, height: 28)
                        .background(on ? JieboColor.pine : JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .animation(JieboMotion.fade(reduceMotion), value: on)
                    Circle()
                        .fill(on ? JieboColor.paper : JieboColor.pine)
                        .frame(width: 6, height: 6)
                        .offset(x: 2, y: -2)
                        .opacity(marked ? 1 : 0)
                        .animation(JieboMotion.fade(reduceMotion), value: marked)
                }
                if labeled {
                    Text(layer.title)
                        .font(JieboFont.ui(10, weight: on ? .semibold : .medium))
                        .foregroundStyle(on ? JieboColor.ink : JieboColor.dim)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(layer.title)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var loopLive: Bool {
        guard let row = store.loops[store.activeId] else { return false }
        return row.status == "armed" || row.status == "running"
    }

    private var subtitle: String {
        store.tenantName.isEmpty ? "接驳" : "接驳 · \(store.tenantName)"
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
                            store.switchWorkspace(to: item.path)
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
                            store.switchWorkspace(to: store.workspaceRoot.isEmpty ? store.cwd : store.workspaceRoot)
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
            .navigationTitle("切换工作区")
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
                    .keyboardType(.numbersAndPunctuation)
                TextField("最多拍数，可空", text: $maxTicks)
                    .keyboardType(.numbersAndPunctuation)
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

struct ConnectionDot: View {
    var connected: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle().fill(JieboColor.clay)
            Circle().fill(JieboColor.ok).opacity(connected ? 1 : 0)
        }
        .frame(width: 8, height: 8)
        .animation(JieboMotion.fade(reduceMotion), value: connected)
        .accessibilityLabel(connected ? "已连接" : "未连接")
    }
}

struct ThemeSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    private var theme: JieboTheme { JieboTheme.shared }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("外观")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                    Picker("外观", selection: Bindable(theme).appearance) {
                        ForEach(JieboAppearance.allCases) { item in
                            Text(item.title).tag(item)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()

                    Text("配色")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                    VStack(spacing: 4) {
                        ForEach(JieboPalette.allCases) { palette in
                            Button {
                                theme.palette = palette
                            } label: {
                                HStack(spacing: 10) {
                                    Circle()
                                        .fill(palette.swatch)
                                        .frame(width: 12, height: 12)
                                        .overlay(Circle().stroke(JieboColor.line, lineWidth: 1))
                                    Text(palette.title)
                                        .font(JieboFont.ui(15))
                                        .foregroundStyle(JieboColor.ink)
                                    Spacer()
                                    if theme.palette == palette {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(JieboColor.pine)
                                    }
                                }
                                .padding(.horizontal, 12)
                                .frame(height: 40)
                                .background(theme.palette == palette ? JieboColor.userBubble : Color.clear)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(JieboColor.paper)
            .navigationTitle("主题")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
