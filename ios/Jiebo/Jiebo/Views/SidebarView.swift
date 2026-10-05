import SwiftUI

/// iPad 常驻侧栏，层次和手机抽屉一致：助理 → 当前工作区（切换、工具、这个工作区的对话）→ 底部设置。
/// 多出来的只有收起按钮；点对话不收起侧栏。
struct SidebarView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var collapse: () -> Void = {}
    @State private var chatActions = ChatActionTargets()
    /// P9：管理员统计面板
    @State private var adminStatsOpen = false
    @State private var themeOpen = false
    @State private var logoutConfirm = false

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 0) {
            brandBar

            AssistantEntryRow(action: store.openAssistantEntry)
                .padding(.horizontal, 12)

            Rectangle()
                .fill(JieboColor.line)
                .frame(height: 1)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

            workspaceCard
                .padding(.horizontal, 12)

            toolStrip
                .padding(.horizontal, 8)
                .padding(.top, 6)

            chatsHeader
                .padding(.top, 14)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if store.currentWorkspaceChats.isEmpty {
                        Text("这个工作区还没有对话")
                            .font(JieboFont.ui(13))
                            .foregroundStyle(JieboColor.dim)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 10)
                    } else {
                        ForEach(store.currentWorkspaceChats) { chat in
                            chatRow(chat)
                        }
                    }
                }
                .padding(.bottom, 12)
            }

            footer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(JieboColor.sidebar.ignoresSafeArea())
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(JieboColor.line)
                .frame(width: 1)
                .ignoresSafeArea()
                .allowsHitTesting(false)
        }
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(removing: .sidebarToggle)
        .sheet(isPresented: $store.workspaceSheetOpen) {
            WorkspacePickerSheet()
        }
        .sheet(isPresented: $themeOpen) {
            ThemeSettingsSheet()
        }
        .sheet(isPresented: $adminStatsOpen) {
            AdminStatsView()
        }
        .chatActionAlerts($chatActions)
        .confirmationDialog("退出登录？", isPresented: $logoutConfirm, titleVisibility: .visible) {
            Button("退出登录", role: .destructive, action: store.logout)
            Button("取消", role: .cancel) {}
        } message: {
            Text("退出后需要重新输入访问码才能连回来。")
        }
    }

    private var brandBar: some View {
        HStack(spacing: 10) {
            JieboMark(size: 22)
            Text("接驳")
                .font(JieboFont.display(17))
                .tracking(0.34)
                .foregroundStyle(JieboColor.ink)
            Spacer(minLength: 8)
            LinkStatusDot(state: store.linkState, size: 8)
                .accessibilityHidden(true)
            Text(store.linkState.title)
                .font(JieboFont.ui(12))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
            Button(action: collapse) {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleButtonStyle())
            .accessibilityLabel("收起侧栏")
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 12)
    }

    private var workspaceCard: some View {
        Button(action: store.openWorkspaceSwitcher) {
            HStack(spacing: 10) {
                Image(systemName: "folder")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(JieboColor.brass)
                    .frame(width: 30, height: 30)
                    .background(JieboColor.brass.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text("当前工作区")
                        .font(JieboFont.ui(11))
                        .foregroundStyle(JieboColor.dim)
                    Text(store.currentWorkspaceName)
                        .font(JieboFont.ui(15, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .fill(JieboColor.white.opacity(0.4))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("当前工作区，\(store.currentWorkspaceName)")
        .accessibilityHint("切换到别的工作区")
    }

    private var toolStrip: some View {
        HStack(spacing: 0) {
            ForEach(ToolLayer.workTools) { layer in
                toolButton(layer)
            }
        }
    }

    private func toolButton(_ layer: ToolLayer) -> some View {
        let on = store.toolSelected(layer)
        let marked = layer == .loop && loopLive
        return Button {
            store.toggleTool(layer)
        } label: {
            VStack(spacing: 4) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: layer.symbol)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(on ? JieboColor.pine : JieboColor.ink2)
                        .frame(width: 32, height: 32)
                        .background(on ? JieboColor.pine.opacity(0.12) : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .stroke(on ? JieboColor.pine.opacity(0.28) : JieboColor.line, lineWidth: 1)
                        )
                    Circle()
                        .fill(JieboColor.ok)
                        .frame(width: 7, height: 7)
                        .offset(x: 2, y: -2)
                        .opacity(marked ? 1 : 0)
                }
                Text(layer.title)
                    .font(JieboFont.ui(11, weight: on ? .semibold : .regular))
                    .foregroundStyle(on ? JieboColor.ink : JieboColor.dim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .animation(JieboMotion.fade(reduceMotion), value: on)
        .accessibilityLabel(marked ? "\(layer.title)，正在运行" : layer.title)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var chatsHeader: some View {
        HStack(spacing: 8) {
            Text("对话")
                .font(JieboFont.ui(12, weight: .medium))
                .tracking(0.6)
                .foregroundStyle(JieboColor.dim)
            Spacer(minLength: 8)
            Button(action: store.openNewChat) {
                Label("新对话", systemImage: "square.and.pencil")
                    .font(JieboFont.ui(13, weight: .medium))
                    .foregroundStyle(JieboColor.pine)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut("n", modifiers: .command)
        }
        .padding(.leading, 20)
        .padding(.trailing, 16)
    }

    private var footer: some View {
        HStack {
            Menu {
                Button { themeOpen = true } label: {
                    Label("主题 · \(JieboTheme.shared.palette.title)", systemImage: "paintpalette")
                }
                if store.isAdmin {
                    Button { adminStatsOpen = true } label: {
                        Label("使用统计", systemImage: "chart.bar")
                    }
                }
                Divider()
                Button(role: .destructive) { logoutConfirm = true } label: {
                    Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                Label("设置", systemImage: "gearshape")
                    .font(JieboFont.ui(14, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .overlay(alignment: .top) {
            Rectangle().fill(JieboColor.line).frame(height: 1)
        }
    }

    private var loopLive: Bool {
        guard let row = store.loops[store.activeId] else { return false }
        return row.status == "armed" || row.status == "running"
    }

    // MARK: 会话行

    private func chatRow(_ chat: ChatSession) -> some View {
        let selected = chat.id == store.activeId
        let live = chat.turns.contains(where: \.running) || store.runningChatIds.contains(chat.id)
        return Button {
            store.select(chat.id)
        } label: {
            HStack(spacing: 8) {
                Text(chat.title)
                    .font(JieboFont.ui(15, weight: chat.unread ? .semibold : .regular))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if live {
                    Text("跑")
                        .font(JieboFont.ui(10, weight: .medium))
                        .foregroundStyle(JieboColor.run)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(JieboColor.runBg)
                        .clipShape(Capsule())
                } else if chat.unread {
                    Circle().fill(JieboColor.pine).frame(width: 6, height: 6)
                }
            }
            .foregroundStyle(JieboColor.ink)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(selected ? JieboColor.white : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(selected ? JieboColor.line : Color.clear, lineWidth: 1)
            )
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(live ? "\(chat.title)，正在运行" : chat.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .chatRowMenu(
            chat,
            rename: { chatActions.beginRename($0) },
            delete: { chatActions.delete = $0 }
        )
    }

}

/// 切换工作区（iPad 侧栏与手机抽屉共用）。由 store.workspaceSheetOpen 驱动，系统表单样式：
/// 当前项打勾，新建走右上角 + 和 alert，不夹带主题、退出这类账号操作。
struct WorkspacePickerSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var store = store
        let items = store.subWorkspaces
        let duplicates = Set(Dictionary(grouping: items, by: \.name).filter { $0.value.count > 1 }.keys)
        NavigationStack {
            List {
                if items.isEmpty {
                    Section {
                        if store.workspaces.isEmpty {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("正在读取工作区…")
                                    .font(JieboFont.ui(15))
                                    .foregroundStyle(JieboColor.dim)
                            }
                        } else {
                            Text("还没有子工作区，点右上角 + 新建一个。")
                                .font(JieboFont.ui(15))
                                .foregroundStyle(JieboColor.dim)
                        }
                    }
                } else {
                    Section {
                        ForEach(items) { item in
                            row(item, showPath: duplicates.contains(item.name))
                        }
                    } footer: {
                        Text("切过去会打开那里最近的对话，没有就新建一个。")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(JieboColor.paper)
            .navigationTitle("切换工作区")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        store.newWorkspaceName = ""
                        store.creatingWorkspace = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("新建工作区")
                }
            }
            .alert("新建工作区", isPresented: $store.creatingWorkspace) {
                TextField("名称", text: $store.newWorkspaceName)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("取消", role: .cancel) { store.newWorkspaceName = "" }
                Button("创建", action: store.createWorkspace)
                    .disabled(store.newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } message: {
                Text("会在你的根目录下建一个同名文件夹，建好后直接进去。")
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ item: WorkspaceItem, showPath: Bool) -> some View {
        let current = sameCwd(item.path, store.currentWorkspacePath)
        return Button {
            store.switchWorkspace(to: item.path)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "folder")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(JieboColor.brass)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name)
                        .font(JieboFont.ui(16, weight: current ? .semibold : .regular))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    if showPath {
                        Text(item.path)
                            .font(JieboFont.mono(11))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                if current {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(current ? .isSelected : [])
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

/// 助理会话的置顶入口（iPad 侧栏与手机抽屉共用）。不进工作区分组，不能删
struct AssistantEntryRow: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var action: () -> Void

    var body: some View {
        let chat = store.assistantChat
        let selected = store.assistantChatActive
        let live = chat.map { row in
            row.turns.contains(where: \.running) || store.runningChatIds.contains(row.id)
        } ?? false
        let unread = !selected && (chat?.unread ?? false)
        let badge = store.assistantBadgeCount
        let preview = store.assistantPreview
        Button(action: action) {
            HStack(spacing: 10) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: ToolLayer.assistant.symbol)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .frame(width: 30, height: 30)
                        .background(JieboColor.pine.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                    Circle()
                        .fill(JieboColor.ok)
                        .frame(width: 7, height: 7)
                        .offset(x: 2, y: -2)
                        .opacity(badge > 0 ? 1 : 0)
                        .animation(JieboMotion.fade(reduceMotion), value: badge > 0)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.assistantName)
                        .font(JieboFont.ui(14, weight: unread ? .semibold : .medium))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    Text(preview.isEmpty ? "今日 · 收件箱 · 记忆" : preview)
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
                if live {
                    Text("跑")
                        .font(JieboFont.ui(10, weight: .medium))
                        .foregroundStyle(JieboColor.run)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(JieboColor.runBg)
                        .clipShape(Capsule())
                } else if unread {
                    Circle()
                        .fill(JieboColor.pine)
                        .frame(width: 6, height: 6)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .fill(selected ? JieboColor.white : JieboColor.white.opacity(0.4))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                            .stroke(selected ? JieboColor.pine.opacity(0.28) : JieboColor.line, lineWidth: 1)
                    )
            )
            .contentShape(Rectangle())
            .animation(JieboMotion.fade(reduceMotion), value: selected)
            .animation(JieboMotion.fade(reduceMotion), value: live)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(badge > 0 ? "\(store.assistantName)，\(badge) 条待处理" : store.assistantName)
        .accessibilityValue(preview)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// 连接点，iPhone 和 iPad 各处共用：绿 = 已连接，黄 = 连接中，红 = 已断开。
/// 连接中和后台补齐聊天记录时，外圈扩散一圈淡色波纹；断开时圆点慢慢呼吸；已连接且空闲时静止。
struct LinkStatusDot: View {
    var state: ChatStore.LinkState
    var syncing = false
    var size: CGFloat = 6
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var color: Color {
        switch state {
        case .connected: JieboColor.ok
        case .connecting: JieboColor.brass
        case .offline: JieboColor.danger
        }
    }

    private var ripples: Bool { state == .connecting || (state == .connected && syncing) }
    private var breathes: Bool { state == .offline }

    private var period: TimeInterval {
        switch state {
        case .connecting: 1.2
        case .offline: 2.0
        case .connected: 1.6
        }
    }

    private var label: String {
        syncing && state == .connected ? "已连接，正在同步聊天记录" : state.title
    }

    var body: some View {
        Group {
            if reduceMotion || !(ripples || breathes) {
                dot(opacity: 1)
                    .background {
                        if ripples {
                            Circle()
                                .stroke(color.opacity(0.45), lineWidth: 1)
                                .frame(width: size * 1.8, height: size * 1.8)
                        }
                    }
            } else {
                // 6pt 的点 15 帧就够顺，标题栏常驻，不值得按 30 帧重绘
                TimelineView(.animation(minimumInterval: 1.0 / 15)) { context in
                    let t = context.date.timeIntervalSinceReferenceDate
                        .truncatingRemainder(dividingBy: period) / period
                    dot(opacity: breathes ? 0.65 + 0.35 * cos(t * 2 * .pi) : 1)
                        .background {
                            if ripples {
                                Circle()
                                    .stroke(color, lineWidth: 1)
                                    .frame(width: size, height: size)
                                    .scaleEffect(1 + t * 1.4)
                                    .opacity(0.55 * (1 - t))
                            }
                        }
                }
            }
        }
        .frame(width: size + 2, height: size + 2)
        .animation(JieboMotion.fade(reduceMotion), value: state)
        .accessibilityElement()
        .accessibilityLabel(label)
    }

    private func dot(opacity: Double) -> some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .opacity(opacity)
    }
}

struct ThemeSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
                    VStack(spacing: 14) {
                        ForEach(JieboPalette.allCases) { palette in
                            ThemePaletteCard(
                                palette: palette,
                                selected: theme.palette == palette,
                                appearance: theme.appearance
                            ) {
                                withAnimation(JieboMotion.fade(reduceMotion)) { theme.palette = palette }
                            }
                        }
                    }
                }
                .padding(20)
                .frame(maxWidth: 560, alignment: .leading)
                .frame(maxWidth: .infinity)
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
        .presentationDetents([.large])
    }
}

/// 一套配色一张卡：左右两块迷你对话界面分别是这套配色的浅色、深色。外观锁定在某一边时，另一边压暗。
private struct ThemePaletteCard: View {
    let palette: JieboPalette
    let selected: Bool
    let appearance: JieboAppearance
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    ThemeMiniThread(ink: palette.light, dark: false, idle: appearance == .dark)
                    ThemeMiniThread(ink: palette.dark, dark: true, idle: appearance == .light)
                }
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(palette.title)
                            .font(JieboFont.ui(16, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                        Text(palette.subtitle)
                            .font(JieboFont.ui(12))
                            .foregroundStyle(JieboColor.dim)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(selected ? JieboColor.pine : JieboColor.borderStrong)
                }
                .padding(.horizontal, 4)
            }
            .padding(12)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous)
                    .stroke(selected ? JieboColor.pine : JieboColor.line, lineWidth: selected ? 2 : 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous))
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(palette.title)，\(palette.subtitle)")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// 迷你对话界面：标题、助理正文、用户气泡、输入胶囊和发送键，颜色直接取这套配色的色值，不跟当前明暗走。
private struct ThemeMiniThread: View {
    let ink: JieboSurfaces
    let dark: Bool
    let idle: Bool

    var body: some View {
        VStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Spacer()
                    VStack(spacing: 3) {
                        bar(ink.text, width: 34, height: 5)
                        Circle().fill(Color(hex: dark ? 0x7DCE98 : 0x2F7D4A)).frame(width: 4, height: 4)
                    }
                    Spacer()
                }
                .padding(.bottom, 4)
                bar(ink.text, width: nil, height: 4).opacity(0.85)
                bar(ink.text, width: 70, height: 4).opacity(0.85)
                bar(ink.muted, width: 52, height: 4).opacity(0.6)
                HStack {
                    Spacer(minLength: 24)
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(Color(hex: ink.user))
                        .frame(height: 20)
                        .overlay(alignment: .leading) {
                            bar(ink.text, width: 34, height: 3).opacity(0.7).padding(.leading, 7)
                        }
                }
                bar(ink.text, width: nil, height: 4).opacity(0.85)
                bar(ink.muted, width: 60, height: 4).opacity(0.6)
                Spacer(minLength: 0)
                HStack(spacing: 0) {
                    bar(ink.muted, width: 40, height: 3).opacity(0.45)
                    Spacer(minLength: 0)
                    Circle()
                        .fill(Color(hex: ink.accent))
                        .frame(width: 14, height: 14)
                        .overlay(
                            Image(systemName: "arrow.up")
                                .font(.system(size: 7, weight: .bold))
                                .foregroundStyle(Color(hex: ink.bg))
                        )
                }
                .padding(.leading, 9)
                .padding(.trailing, 3)
                .frame(height: 20)
                .background(Color(hex: ink.panel), in: Capsule())
                .overlay(Capsule().stroke(Color(hex: ink.border), lineWidth: 1))
            }
            .padding(10)
            .frame(maxWidth: .infinity)
            .frame(height: 170)
            .background(Color(hex: ink.bg))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color(hex: ink.border), lineWidth: 1)
            )
            Text(dark ? "深色" : "浅色")
                .font(JieboFont.ui(11))
                .foregroundStyle(JieboColor.dim)
        }
        .opacity(idle ? 0.4 : 1)
    }

    private func bar(_ hex: UInt32, width: CGFloat?, height: CGFloat) -> some View {
        Capsule()
            .fill(Color(hex: hex))
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}

/// 会话的重命名 / 删除目标。iPad 侧栏和窄窗抽屉共用：提示要挂在不会消失的宿主上，抽屉一关挂在它身上的 alert 会跟着没
struct ChatActionTargets {
    var rename: ChatSession?
    var draft = ""
    var delete: ChatSession?

    mutating func beginRename(_ chat: ChatSession) {
        draft = chat.isUntitled ? "" : chat.title
        rename = chat
    }
}

extension View {
    /// 会话行的长按菜单
    func chatRowMenu(
        _ chat: ChatSession,
        rename: @escaping (ChatSession) -> Void,
        delete: @escaping (ChatSession) -> Void
    ) -> some View {
        contextMenu {
            Button { rename(chat) } label: {
                Label("重命名", systemImage: "pencil")
            }
            Button(role: .destructive) { delete(chat) } label: {
                Label("删除", systemImage: "trash")
            }
        }
    }

    func chatActionAlerts(_ targets: Binding<ChatActionTargets>) -> some View {
        modifier(ChatActionAlerts(targets: targets))
    }
}

private struct ChatActionAlerts: ViewModifier {
    @Environment(ChatStore.self) private var store
    @Binding var targets: ChatActionTargets

    func body(content: Content) -> some View {
        content
            .alert(
                "重命名会话",
                isPresented: Binding(get: { targets.rename != nil }, set: { if !$0 { targets.rename = nil } }),
                presenting: targets.rename
            ) { chat in
                TextField("会话标题", text: $targets.draft)
                    .textInputAutocapitalization(.sentences)
                Button("取消", role: .cancel) { targets.rename = nil }
                Button("确定") {
                    store.renameChat(chat.id, to: targets.draft)
                    targets.rename = nil
                }
            } message: { chat in
                Text(chat.title)
            }
            .alert(
                "删除这个会话？",
                isPresented: Binding(get: { targets.delete != nil }, set: { if !$0 { targets.delete = nil } }),
                presenting: targets.delete
            ) { chat in
                Button("删除", role: .destructive) {
                    store.deleteChat(chat.id)
                    targets.delete = nil
                }
                Button("取消", role: .cancel) { targets.delete = nil }
            } message: { chat in
                Text("「\(chat.title)」会从这台设备上的列表里去掉。")
            }
    }
}
