import SwiftUI
import UIKit
import UserNotifications

// 抽屉里 push 出去的页面（规格 §4.3）。都没有输入框（同一时刻只能挂载一个 ComposerView）。
// 这些页面不改 store.activeId，也不调用 select。

// MARK: 委派记录

struct DelegationListScreen: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router

    init() {}

    private var rows: [AssistantDelegation] {
        (store.assistantState?.delegations ?? []).sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        List {
            ForEach(rows) { row in
                delegationRow(row)
                    .listRowBackground(JieboColor.white)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle("委派记录")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { store.requestAssistant() }
        .overlay {
            if rows.isEmpty {
                ContentUnavailableView(
                    "还没有委派",
                    systemImage: "paperplane",
                    description: Text("\(store.assistantName) 把任务交给工作区后，会记在这里。")
                )
            }
        }
        .task { store.requestAssistant() }
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
    @State private var rotateConfirm = false

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

            calendarSection

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
                        Image(systemName: "brain.head.profile")
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
                        settingsRow(symbol: "chart.bar", title: "使用统计", trailing: nil, chevron: true)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(JieboColor.white)
                } header: {
                    Text("用量")
                }
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
        .task {
            store.requestAssistant()
            await refreshNotifyStatus()
        }
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
        // 断线后 assistantState 不清空，先看连接，免得把旧的「就绪」当成现在
        guard store.connected else { return "未连接" }
        guard let background = state?.background else { return "正在获取…" }
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
                settingsRow(symbol: "bell", title: "通知", trailing: "查询中…", chevron: false)
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

    // MARK: 日历

    @ViewBuilder
    private var calendarSection: some View {
        if let calendar = state?.calendar {
            Section {
                Toggle(isOn: Binding(
                    get: { calendar.enabled },
                    set: { on in store.assistantOp("calendar_set", args: ["enabled": .bool(on)]) }
                )) {
                    HStack(spacing: 12) {
                        Image(systemName: "calendar")
                            .font(JieboFont.text(.subheadline, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                            .frame(width: 24)
                        Text("待办同步到日历")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                    }
                }
                .tint(JieboColor.pine)
                .frame(minHeight: 44)
                .listRowBackground(JieboColor.white)

                if calendar.enabled {
                    Button {
                        if let url = calendar.webcalURL { openURL(url) }
                    } label: {
                        settingsRow(symbol: "calendar.badge.plus", title: "添加到苹果日历", trailing: calendarStatus(calendar), chevron: true)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(JieboColor.white)

                    Button {
                        if let url = calendar.httpsURL {
                            UIPasteboard.general.string = url.absoluteString
                            store.flash("已复制订阅链接")
                        }
                    } label: {
                        settingsRow(symbol: "link", title: "复制订阅链接", trailing: nil, chevron: false)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(JieboColor.white)

                    Button {
                        rotateConfirm = true
                    } label: {
                        settingsRow(symbol: "arrow.triangle.2.circlepath", title: "重新生成链接", trailing: nil, chevron: false)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(JieboColor.white)
                    .confirmationDialog("旧链接会立刻失效，已订阅的日历需要重新添加。", isPresented: $rotateConfirm, titleVisibility: .visible) {
                        Button("重新生成", role: .destructive) {
                            store.assistantOp("calendar_set", args: ["rotate": .bool(true)])
                        }
                    }
                }
            } header: {
                Text("日历")
            } footer: {
                Text(calendar.enabled
                    ? "带日期的待办会出现在苹果日历里，大约每 15 分钟同步一次，只读。知道链接的人能看到待办标题，链接外泄了就重新生成。"
                    : "关掉后日历里的待办会在下次同步时清空。不想让旧链接再能打开，就打开后重新生成。")
            }
        }
    }

    private func calendarStatus(_ calendar: AssistantCalendar) -> String {
        guard let last = calendar.lastFetchAt else { return "未订阅" }
        if calendar.stale { return "好几天没同步了" }
        return "已订阅 · \(assistantRelativeTime(last))同步"
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

    init() {}

    var body: some View {
        ScrollView {
            AssistantMemoryPane()
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(JieboColor.paper)
        .navigationTitle("记忆")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { store.requestAssistant(memory: true) }
    }
}
