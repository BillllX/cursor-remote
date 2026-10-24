import SwiftUI
import UIKit
import UserNotifications

// 抽屉里 push 出去的页面（规格 §4.3）。都没有输入框（同一时刻只能挂载一个 ComposerView）。
// 这些页面不改 store.activeId，也不调用 select。

// MARK: 待办与日程

struct AssistantTodayScreen: View {
    @Environment(ChatStore.self) private var store

    init() {}

    var body: some View {
        ScrollView {
            // 待批在行动区和待处理里，委派在委派记录里
            AssistantTodayPane(showsApprovals: false, showsDelegations: false)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(JieboColor.paper)
        .navigationTitle("待办与日程")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { store.requestAssistant() }
        .task { store.requestAssistant() }
    }
}

// MARK: 任务与计划

struct DelegationListScreen: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router

    init() {}

    private let groups: [(phase: String, title: String)] = [
        ("needs_me", "需要我"),
        ("in_progress", "进行中"),
        ("planned", "计划"),
        ("completed", "已完成"),
    ]

    private var rows: [PersonalTask] {
        store.assistantState?.personalTasks ?? []
    }

    private var legacyRows: [AssistantDelegation] {
        (store.assistantState?.delegations ?? []).sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        List {
            if store.assistantState?.personalTasks != nil {
                ForEach(groups, id: \.phase) { group in
                    let items = rows.filter { normalizedPhase($0.phase) == group.phase }
                    if !items.isEmpty {
                        Section(group.title) {
                            ForEach(items) { task in
                                taskRow(task)
                                    .listRowBackground(JieboColor.white)
                            }
                        }
                    }
                }
            } else {
                // 老网关没有投影时仍保留委派入口。
                Section("委派") {
                    ForEach(legacyRows) { row in
                        delegationRow(row)
                            .listRowBackground(JieboColor.white)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle("任务与计划")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { store.requestAssistant() }
        .overlay {
            if rows.isEmpty && legacyRows.isEmpty {
                ContentUnavailableView(
                    "还没有任务",
                    systemImage: "checklist",
                    description: Text("待办、日程、委派和后台运行会汇总在这里。")
                )
            }
        }
        .task { store.requestAssistant() }
    }

    private func normalizedPhase(_ phase: String) -> String {
        groups.contains(where: { $0.phase == phase }) ? phase : "planned"
    }

    private func taskRow(_ task: PersonalTask) -> some View {
        let delegationId = task.sources.first(where: { $0.kind == "delegation" })?.id
        let opensToday = task.kind == "todo" || task.kind == "schedule"
        return Button {
            if let delegationId {
                router.delegationDetail = DelegationRef(id: delegationId)
            } else if task.kind == "todo" {
                router.openHub(anchor: "todos")
            } else if task.kind == "schedule" {
                router.openHub(anchor: "schedules")
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: taskIcon(task.kind))
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(task.priority == "high" ? JieboColor.danger : JieboColor.ink2)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 4) {
                    Text(task.title.nilIfEmpty ?? "未命名任务")
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(2)
                    Text(taskSubtitle(task))
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(task.priority == "high" ? JieboColor.danger : JieboColor.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if delegationId != nil || opensToday {
                    Image(systemName: "chevron.right")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(delegationId == nil && !opensToday)
        .accessibilityLabel("\(task.title)，\(taskStatus(task))")
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
        if let attention = task.attention { return attention }
        switch task.phase {
        case "needs_me": return "需要处理"
        case "in_progress": return "进行中"
        case "planned": return "已计划"
        case "completed": return "已完成"
        default: return task.status.nilIfEmpty ?? "未知状态"
        }
    }

    private func taskSubtitle(_ task: PersonalTask) -> String {
        let kind: String
        switch task.kind {
        case "todo": kind = "待办"
        case "schedule": kind = "日程"
        case "delegation": kind = "委派"
        case "background_run": kind = "后台运行"
        default: kind = task.kind
        }
        let at = task.updatedAt ?? task.dueAt ?? task.createdAt
        return "\(kind) · \(taskStatus(task)) · \(assistantRelativeTime(at))"
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

// MARK: 设置

struct PhoneSettingsScreen: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var themeOpen = false
    @State private var adminStatsOpen = false
    @State private var notifyStatus: UNAuthorizationStatus?
    @State private var logoutConfirm = false

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
            } header: {
                Text("外观")
            }

            notificationSection

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
                settingsRow(
                    symbol: "cpu",
                    title: "后台模型",
                    trailing: backgroundModelText,
                    chevron: false
                )
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
                Text("助理")
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

    private var backgroundModelText: String {
        guard let background = state?.background else { return "正在连接…" }
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
                    store.assistantOp("push_test")
                    store.flash("已发送测试通知，几秒内应该收到")
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

// MARK: 记忆

struct AssistantMemoryScreen: View {
    @Environment(ChatStore.self) private var store
    @State private var navId = "overview"
    @State private var middleTab = "pinned"
    @State private var stateFilter = "all"
    @State private var searchText = ""
    @State private var searchScopeFilter = "all"
    @State private var searchKindFilter = "all"
    @State private var searchStateFilter = "all"
    @State private var searchActive = false

    var body: some View {
        MemoryCenterPhoneHome(
            navId: $navId,
            middleTab: $middleTab,
            stateFilter: $stateFilter,
            searchText: $searchText,
            searchScopeFilter: $searchScopeFilter,
            searchKindFilter: $searchKindFilter,
            searchStateFilter: $searchStateFilter,
            searchActive: $searchActive
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
    }
}
