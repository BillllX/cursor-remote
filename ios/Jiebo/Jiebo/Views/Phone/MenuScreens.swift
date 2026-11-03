import SwiftUI
import UIKit
import UserNotifications

// 抽屉里 push 出去的页面（规格 §4.3）。都没有输入框（同一时刻只能挂载一个 ComposerView）。
// 这些页面不改 store.activeId，也不调用 select。

// MARK: 今日

struct AssistantTodayScreen: View {
    @Environment(ChatStore.self) private var store

    init() {}

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("今日只看摘要。待办和计划在各自的栏目里。")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink2)
                AssistantTodayPane(showsApprovals: false, showsDelegations: false, showsWorklists: false)
            }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(JieboColor.paper)
        .navigationTitle("今日")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { store.requestAssistant(force: true) }
        .task { store.requestAssistant() }
    }
}

// MARK: 任务与计划

struct DelegationListScreen: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    var column: AssistantWorkColumn
    var embeddedInInbox: Bool = false
    @State private var openedTask: PersonalTask?
    @State private var showCompleted = false

    init(column: AssistantWorkColumn, embeddedInInbox: Bool = false) {
        self.column = column
        self.embeddedInInbox = embeddedInInbox
    }

    private let groups: [(phase: String, title: String)] = [
        ("needs_me", "需要我"),
        ("in_progress", "进行中"),
        ("overdue", "已过点"),
        ("planned", "未开始"),
        ("completed", "已完成"),
    ]

    private var rows: [PersonalTask] {
        (store.assistantState?.personalTasks ?? []).filter { AssistantWorkColumn.matching($0.kind) == column }
    }

    private var legacyRows: [AssistantDelegation] {
        (store.assistantState?.delegations ?? []).sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        List {
            if store.assistantState?.personalTasks != nil {
                ForEach(groups, id: \.phase) { group in
                    let items = rows.filter { bucket($0) == group.phase }
                    if !items.isEmpty {
                        if group.phase == "completed", !showCompleted {
                            Section {
                                Button {
                                    showCompleted = true
                                } label: {
                                    HStack {
                                        Text("已完成 \(items.count)")
                                            .font(JieboFont.text(.subheadline, weight: .medium))
                                            .foregroundStyle(JieboColor.ink)
                                        Spacer()
                                        Image(systemName: "chevron.down")
                                            .font(JieboFont.text(.caption2, weight: .semibold))
                                            .foregroundStyle(JieboColor.dim)
                                    }
                                    .frame(minHeight: 44)
                                }
                                .buttonStyle(.plain)
                                .listRowBackground(JieboColor.white)
                            }
                        } else {
                            Section {
                                ForEach(clusters(items)) { cluster in
                                    taskRow(cluster.items[0], count: cluster.items.count)
                                        .listRowBackground(JieboColor.white)
                                }
                            } header: {
                                JieboListHeader(group.phase == "completed" ? "已完成" : group.title)
                            }
                        }
                    }
                }
            } else if column == .delegation {
                // 老网关没有投影时仍保留委派入口。
                Section {
                    ForEach(legacyRows) { row in
                        delegationRow(row)
                            .listRowBackground(JieboColor.white)
                    }
                } header: {
                    JieboListHeader("委派")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle(embeddedInInbox ? "待处理" : column.title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { store.requestAssistant(force: true) }
        .overlay {
            if rows.isEmpty && (column != .delegation || legacyRows.isEmpty || store.assistantState?.personalTasks != nil) {
                ContentUnavailableView(
                    "还没有\(column.title)",
                    systemImage: column.symbol,
                    description: Text(column.emptyDetail)
                )
            }
        }
        .task { store.requestAssistant() }
        .sheet(item: $openedTask) { task in
            PersonalTaskSheet(task: task)
        }
        .onAppear { openPendingTask() }
        .onChange(of: router.pendingWorkTaskId) { _, _ in openPendingTask() }
        .onChange(of: store.assistantState?.personalTasks?.map(\.id) ?? []) { _, _ in openPendingTask() }
    }

    /// 今日摘要或推送带过来的那一条。列表还没到就先留着，到了再打开。
    private func openPendingTask() {
        guard let id = router.pendingWorkTaskId else { return }
        guard store.assistantState?.personalTasks != nil else { return }
        router.pendingWorkTaskId = nil
        guard let task = rows.first(where: { $0.id == id }) else { return }
        if let delegationId = task.sources.first(where: { $0.kind == "delegation" })?.id {
            router.delegationDetail = DelegationRef(id: delegationId)
        } else {
            openedTask = task
        }
    }

    private func normalizedPhase(_ phase: String) -> String {
        groups.contains(where: { $0.phase == phase }) ? phase : "planned"
    }

    /// 计划时间已经过去，还停在「未开始」里时，单独归到已过点。
    private func bucket(_ task: PersonalTask) -> String {
        let phase = normalizedPhase(task.phase)
        if phase == "planned", plannedIsPast(task) { return "overdue" }
        return phase
    }

    private struct TaskCluster: Identifiable {
        var id: String { items[0].id }
        var items: [PersonalTask]
    }

    /// 同一标题、同一句失败叠在一起。普通待办标题碰巧相同仍各占一行。
    private func clusters(_ items: [PersonalTask]) -> [TaskCluster] {
        var result: [TaskCluster] = []
        for task in items {
            let key = "\(task.title)|\(taskStatus(task))"
            if collapsesTogether(task),
               let index = result.lastIndex(where: { "\($0.items[0].title)|\(taskStatus($0.items[0]))" == key }) {
                result[index].items.append(task)
            } else {
                result.append(TaskCluster(items: [task]))
            }
        }
        return result
    }

    private func collapsesTogether(_ task: PersonalTask) -> Bool {
        let raw = task.attention ?? task.status
        return friendlyAttention(raw) != raw || raw.contains("失败")
    }

    private func taskRow(_ task: PersonalTask, count: Int = 1) -> some View {
        let delegationId = task.sources.first(where: { $0.kind == "delegation" })?.id
        return Button {
            if let delegationId {
                router.delegationDetail = DelegationRef(id: delegationId)
            } else {
                openedTask = task
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: taskIcon(task.kind))
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(task.priority == "high" ? JieboColor.danger : JieboColor.ink2)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 4) {
                    Text(task.title.nilIfEmpty ?? "未命名任务")
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(2)
                    Text(count > 1 ? "共 \(count) 次 · \(taskSubtitle(task))" : taskSubtitle(task))
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(task.priority == "high" ? JieboColor.danger : JieboColor.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count > 1 ? "\(task.title)，共 \(count) 次，\(taskStatus(task))" : "\(task.title)，\(taskStatus(task))")
    }

    private func taskIcon(_ kind: String) -> String {
        switch kind {
        case "todo": return "checkmark.circle"
        case "schedule": return "calendar"
        case "delegation": return "paperplane"
        case "background_run": return "gearshape.2"
        default: return "square.stack.3d.up"
        }
    }

    private func taskStatus(_ task: PersonalTask) -> String {
        if let attention = task.attention { return friendlyAttention(attention) }
        switch task.phase {
        case "needs_me": return "需要处理"
        case "in_progress": return "进行中"
        case "planned":
            if plannedIsPast(task) { return "已过点" }
            return "未开始"
        case "completed": return "已完成"
        default: return friendlyAttention(task.status.nilIfEmpty ?? "未知状态")
        }
    }

    private func plannedIsPast(_ task: PersonalTask) -> Bool {
        guard let dueAt = task.dueAt, dueAt > 0 else { return false }
        return dueAt < Date().timeIntervalSince1970 * 1000
    }

    /// 网关有时把英文用量错误原样放进状态。这里换成能读的一句。
    private func friendlyAttention(_ text: String) -> String {
        let lower = text.lowercased()
        if lower.contains("monthly usage") || lower.contains("usage limit") || lower.contains("spend limit") {
            return "这个月的用量到了"
        }
        if lower.contains("rate limit") { return "请求太频繁，过一会儿再试" }
        return text
    }

    private func taskSubtitle(_ task: PersonalTask) -> String {
        let at = task.updatedAt ?? task.dueAt ?? task.createdAt
        if task.kind == "background_run" {
            return "后台运行 · \(taskStatus(task)) · \(assistantRelativeTime(at))"
        }
        return "\(taskStatus(task)) · \(assistantRelativeTime(at))"
    }

    private func delegationRow(_ row: AssistantDelegation) -> some View {
        let colors = row.statusColors
        let title = row.title.nilIfEmpty ?? "委派"
        let workspace = workspaceName(row.workspace)
        let time = assistantRelativeTime(row.endedAt ?? row.createdAt)
        return Button {
            router.delegationDetail = DelegationRef(id: row.id)
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(JieboFont.text(.subheadline, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                        StatusTag(text: row.statusLabel, fg: colors.fg, bg: colors.bg)
                    }
                    Text(workspace.isEmpty ? time : "\(workspace) · \(time)")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title)，\(row.statusLabel)")
    }
}

private struct PersonalTaskSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let task: PersonalTask
    @State private var editingTodo: AssistantTodo?

    private var sourceTodo: AssistantTodo? {
        guard let id = task.sources.first(where: { $0.kind == "todo" })?.id else { return nil }
        return store.assistantState?.todos.first { $0.id == id }
    }

    private var heading: String {
        switch task.kind {
        case "todo": return "待办"
        case "schedule": return "计划"
        case "background_run": return "后台运行"
        default: return "任务"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(task.title.nilIfEmpty ?? heading)
                        .font(JieboFont.text(.title3, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                    Text(task.attention?.nilIfEmpty ?? task.status)
                        .font(JieboFont.text(.subheadline))
                        .foregroundStyle(JieboColor.ink2)
                    if let due = TodoDue.label(task.due) {
                        Text(due)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.dim)
                    }
                    if let detail = task.detail?.nilIfEmpty {
                        Text(detail)
                            .font(JieboFont.text(.body))
                            .foregroundStyle(JieboColor.ink)
                    }
                    if sourceTodo != nil {
                        ActionButton(title: "修改", kind: .outline) { editingTodo = sourceTodo }
                    }
                    ForEach(Array(task.actions.enumerated()), id: \.offset) { _, action in
                        ActionButton(title: action.label, kind: .primary) {
                            store.performPersonalTaskAction(action)
                            dismiss()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            .background(JieboColor.paper)
            .navigationTitle(heading)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .sheet(item: $editingTodo) { todo in
                TodoEditSheet(todo: todo)
            }
        }
    }
}

// MARK: 设置

struct PhoneSettingsScreen: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var themeOpen = false
    @State private var iconChoice = AppIconChoice.current
    @State private var adminStatsOpen = false
    @State private var notifyStatus: UNAuthorizationStatus?
    @State private var logoutConfirm = false
    @State private var mobileDataMode = MobileDataMode.load()
    @State private var hintReplayArmed = false

    init() {}

    private var state: AssistantState? { store.assistantState }

    var body: some View {
        List {
            Section {
                Button {
                    themeOpen = true
                } label: {
                    settingsRow(
                        symbol: "paintpalette",
                        title: "主题 · \(JieboTheme.shared.palette.title)",
                        trailing: nil,
                        chevron: true
                    )
                }
                .buttonStyle(.plain)
                .listRowBackground(JieboColor.white)

                NavigationLink {
                    AppIconPickerScreen(selection: $iconChoice)
                } label: {
                    settingsRow(
                        symbol: "app",
                        title: "主屏幕图标 · \(iconChoice.title)",
                        trailing: nil,
                        chevron: false
                    )
                }
                .listRowBackground(JieboColor.white)
            } header: {
                Text("外观")
            }

            notificationSection

            Section {
                Picker("移动数据", selection: $mobileDataMode) {
                    ForEach(MobileDataMode.allCases, id: \.rawValue) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(JieboColor.white)

                NavigationLink {
                    TrafficStatsScreen()
                } label: {
                    settingsRow(
                        symbol: "chart.bar.xaxis",
                        title: "网络流量统计",
                        trailing: nil,
                        chevron: false
                    )
                }
                .listRowBackground(JieboColor.white)
            } header: {
                Text("移动数据")
            } footer: {
                Text("仅在蜂窝网络、个人热点或系统低数据模式下生效；Wi‑Fi 保持完整体验。省流量会等待你点按后再加载正文图片和文件预览。")
            }

            Section {
                NavigationLink(value: PhoneRoute.connections) {
                    settingsRow(
                        symbol: "checkmark.shield",
                        title: "连接与权限",
                        trailing: nil,
                        chevron: false
                    )
                }
                .listRowBackground(JieboColor.white)
            } header: {
                Text("设备")
            } footer: {
                Text("管理 Apple 日历、提醒事项和通讯录权限，并查看脱敏的本机操作记录。")
            }

            Section {
                if UIDevice.current.userInterfaceIdiom != .phone {
                    Button {
                        UserDefaults.standard.set(false, forKey: "jiebo.firstUseHintDismissed.v3")
                        hintReplayArmed = true
                    } label: {
                        settingsRow(
                            symbol: "questionmark.circle",
                            title: "再看一遍说明",
                            trailing: hintReplayArmed ? hintReplayTrailing : nil,
                            chevron: false
                        )
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(JieboColor.white)
                    .accessibilityHint("再显示小驳、待处理、工作台和消息的说明")
                }

                settingsRow(
                    symbol: "cpu",
                    title: "后台模型",
                    trailing: backgroundModelText,
                    chevron: false
                )
                .listRowBackground(JieboColor.white)

                NavigationLink(value: PhoneRoute.artifacts) {
                    settingsRow(
                        symbol: "square.stack.3d.up",
                        title: "产物中心",
                        trailing: nil,
                        chevron: false
                    )
                }
                .listRowBackground(JieboColor.white)

                NavigationLink(value: PhoneRoute.memory) {
                    HStack(spacing: 12) {
                        Image(systemName: NavigationIconId.memory.symbol)
                            .font(JieboFont.text(.subheadline, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("记忆")
                                .font(JieboFont.text(.subheadline))
                                .foregroundStyle(JieboColor.ink)
                            Text("\(store.assistantName) 会在后台自己整理")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.dim)
                        }
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
                .listRowBackground(JieboColor.white)
            } header: {
                Text("小驳")
            }

            if store.isAdmin {
                Section {
                    Button {
                        adminStatsOpen = true
                    } label: {
                        settingsRow(symbol: NavigationIconId.stats.symbol, title: "使用统计", trailing: nil, chevron: true)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(JieboColor.white)
                } header: {
                    Text("用量")
                }
            }

            Section {
                Button(role: .destructive) {
                    logoutConfirm = true
                } label: {
                    settingsRow(
                        symbol: "rectangle.portrait.and.arrow.right",
                        title: "退出登录",
                        trailing: nil,
                        chevron: false
                    )
                }
            } header: {
                Label("账户", systemImage: NavigationIconId.account.symbol)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $themeOpen) {
            ThemeSettingsSheet()
        }
        .sheet(isPresented: $adminStatsOpen) {
            AdminStatsView()
        }
        .confirmationDialog("退出登录？", isPresented: $logoutConfirm, titleVisibility: .visible) {
            Button("退出登录", role: .destructive) {
                Task { @MainActor in
                    await PushRegistrar.shared.unsubscribe(store: store)
                    store.logout()
                }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("退出后需要重新输入访问码才能连回来。")
        }
        .onAppear { iconChoice = AppIconChoice.current }
        .onChange(of: mobileDataMode) { _, mode in mode.save() }
        .task { await refreshNotifyStatus() }
        .onChange(of: scenePhase) { _, phase in
            // 从系统设置回来时刷新
            if phase == .active {
                Task { @MainActor in await refreshNotifyStatus() }
            }
        }
    }

    // MARK: 行

    private func settingsRow(symbol: String, title: String, trailing: String?, chevron: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(JieboFont.text(.subheadline, weight: .medium))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 24)
            Text(title)
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if chevron {
                Image(systemName: "chevron.right")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// 手机说明条挂在底栏外，设置页推上去也能看见。iPad 设置是盖住的一页，关掉才看见。
    private var hintReplayTrailing: String {
        UIDevice.current.userInterfaceIdiom == .phone ? "已出现在页面上方" : "关闭后出现在上方"
    }

    private var backgroundModelText: String {
        if store.linkState == .offline { return "已断开" }
        if !store.connected { return "正在连接…" }
        guard let background = state?.background else { return "未就绪" }
        let model = background.model.nilIfEmpty ?? "未知"
        let status = background.ok ? "就绪" : (background.reason ?? "未就绪")
        return "\(model) · \(status)"
    }

    // MARK: 通知

    private var notifyEnabled: Bool {
        switch notifyStatus ?? .notDetermined {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private var showsTestPush: Bool {
        #if DEBUG
        return true
        #else
        return store.isAdmin
        #endif
    }

    @ViewBuilder
    private var notificationSection: some View {
        Section {
            if notifyStatus == nil {
                settingsRow(symbol: "bell", title: "通知", trailing: nil, chevron: false)
                    .listRowBackground(JieboColor.white)
            } else if notifyEnabled {
                settingsRow(symbol: "bell.badge", title: "通知", trailing: "已开启", chevron: false)
                    .listRowBackground(JieboColor.white)
            } else {
                Button {
                    enableNotifications()
                } label: {
                    settingsRow(symbol: "bell.slash", title: "通知", trailing: "去开启", chevron: true)
                }
                .buttonStyle(.plain)
                .listRowBackground(JieboColor.white)
            }

            if showsTestPush {
                Button {
                    store.sendTestPush()
                } label: {
                    settingsRow(symbol: "paperplane", title: "发送测试通知", trailing: nil, chevron: false)
                }
                .buttonStyle(.plain)
                .listRowBackground(JieboColor.white)
            }
        } header: {
            Text("通知")
        } footer: {
            if state != nil, state?.pushApns != true {
                Text("服务器未配置推送，iPhone 暂时收不到系统通知。")
            } else if notifyStatus != nil, !notifyEnabled {
                Text("待你批准的事项、委派结果和提醒会通过系统通知送达。")
            }
        }
    }

    private func refreshNotifyStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notifyStatus = settings.authorizationStatus
    }

    /// 还没问过 → 弹系统授权；已拒绝 → 跳系统设置
    private func enableNotifications() {
        if notifyStatus == .notDetermined {
            Task { @MainActor in
                let center = UNUserNotificationCenter.current()
                let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                if granted {
                    UIApplication.shared.registerForRemoteNotifications()
                }
                await refreshNotifyStatus()
            }
        } else if let url = URL(string: UIApplication.openSettingsURLString) {
            openURL(url)
        }
    }
}

struct TrafficStatsScreen: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var snapshot = AppTrafficMeter.shared.snapshot()
    @State private var resetConfirm = false

    var body: some View {
        List {
            trafficSection(
                title: "移动数据",
                transport: .cellular,
                symbol: "antenna.radiowaves.left.and.right"
            )
            trafficSection(title: "Wi‑Fi", transport: .wifi, symbol: "wifi")

            Section {
                valueRow("有线与其他网络", value: AppTrafficFormat.bytes(snapshot.otherTotal))
            } header: {
                Text("其他网络")
            }

            let top = snapshot.topCategories(limit: 8)
            if !top.isEmpty {
                Section {
                    ForEach(Array(top.enumerated()), id: \.offset) { _, item in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.key.category)
                                    .font(JieboFont.text(.subheadline))
                                    .foregroundStyle(JieboColor.ink)
                                Text("\(item.key.transport.title) · \(item.key.direction == .inbound ? "下载" : "上传") · \(item.count.messages) 次")
                                    .font(JieboFont.text(.caption))
                                    .foregroundStyle(JieboColor.dim)
                            }
                            Spacer()
                            Text(AppTrafficFormat.bytes(item.count.bytes))
                                .font(JieboFont.text(.footnote, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                        }
                    }
                } header: {
                    Text("流量分类")
                }
            }

            Section {
                valueRow("开始统计", value: snapshot.startedAt.formatted(date: .abbreviated, time: .shortened))
                Button("清零统计", role: .destructive) {
                    resetConfirm = true
                }
            } footer: {
                Text("这里只统计接驳 App 收发的应用载荷，不含 TLS、IP、DNS、APNs 等系统流量，也不等同于运营商账单。音视频预览会先计量下载到本地再播放；系统缓存命中不计。只保存类别、方向、字节与次数。")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle("网络流量")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { refreshSnapshot() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { refreshSnapshot() }
        }
        .task {
            // 分享扩展写入不会发进程内通知，页面可见时每两秒重读 App Group。
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                refreshSnapshot()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: AppTrafficMeter.changedNotification)) { _ in
            refreshSnapshot()
        }
        .confirmationDialog("清零网络流量统计？", isPresented: $resetConfirm, titleVisibility: .visible) {
            Button("清零", role: .destructive) {
                AppTrafficMeter.shared.reset()
                snapshot = AppTrafficMeter.shared.snapshot()
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("下载、上传、分类计数和统计起始时间都会重新开始。")
        }
    }

    private func refreshSnapshot() {
        snapshot = AppTrafficMeter.shared.snapshot()
    }

    @ViewBuilder
    private func trafficSection(
        title: String,
        transport: GatewayNetworkTransport,
        symbol: String
    ) -> some View {
        Section {
            valueRow("下载", value: AppTrafficFormat.bytes(snapshot.bytes(transport, .inbound)))
            valueRow("上传", value: AppTrafficFormat.bytes(snapshot.bytes(transport, .outbound)))
            valueRow("合计", value: AppTrafficFormat.bytes(snapshot.total(transport)))
        } header: {
            Label(title, systemImage: symbol)
        }
    }

    private func valueRow(_ title: String, value: String) -> some View {
        HStack {
            Text(title)
                .foregroundStyle(JieboColor.ink)
            Spacer()
            Text(value)
                .foregroundStyle(JieboColor.dim)
                .monospacedDigit()
        }
        .font(JieboFont.text(.subheadline))
    }
}

/// 设置页 push 出去的页面。工作台、侧栏和 iPad 的设置都是单独的导航栈，必须走这里，不能落成空页。
struct PhoneSettingsDestination: View {
    let route: PhoneRoute

    var body: some View {
        switch route {
        case .memory:
            AssistantMemoryScreen()
        case .connections:
            DeviceConnectionsScreen()
        case .artifacts:
            ArtifactCenterView()
        case .settings:
            PhoneSettingsScreen()
        default:
            EmptyView()
        }
    }
}

// MARK: 记忆

struct AssistantMemoryScreen: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var navId = "overview"
    @State private var middleTab = "all"
    @State private var stateFilter = "useful"
    @State private var searchText = ""
    @State private var searchScopeFilter = "all"
    @State private var searchKindFilter = "all"
    @State private var searchStateFilter = "all"
    @State private var searchActive = false

    var body: some View {
        // 小驳的栈只存 PhoneRoute。记忆里的下一级是另一种值，直接推进去会报没有目的地。
        // 这一页自己开一条栈，返回仍交给外面那条。
        NavigationStack {
            MemoryCenterPhoneHome(
                navId: $navId,
                middleTab: $middleTab,
                stateFilter: $stateFilter,
                searchText: $searchText,
                searchScopeFilter: $searchScopeFilter,
                searchKindFilter: $searchKindFilter,
                searchStateFilter: $searchStateFilter,
                searchActive: $searchActive,
                onLeave: { dismiss() }
            )
            .scrollDismissesKeyboard(.interactively)
            .background(JieboColor.paper)
            .memoryCenterLifecycle(
                navId: navId,
                searchActive: searchActive,
                searchText: searchText,
                searchScopeFilter: searchScopeFilter,
                searchKindFilter: searchKindFilter,
                searchStateFilter: searchStateFilter
            )
            .toolbar(.visible, for: .navigationBar)
        }
        .toolbar(.hidden, for: .navigationBar)
    }
}
