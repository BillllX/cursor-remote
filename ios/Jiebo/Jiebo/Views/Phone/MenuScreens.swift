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
                            .font(JieboFont.ui(15, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                        StatusTag(text: row.statusLabel, fg: colors.fg, bg: colors.bg)
                    }
                    Text(workspace.isEmpty ? time : "\(workspace) · \(time)")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
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
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("记忆")
                                .font(JieboFont.ui(15))
                                .foregroundStyle(JieboColor.ink)
                            Text("\(store.assistantName) 会在后台自己整理")
                                .font(JieboFont.ui(12))
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
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 24)
            Text(title)
                .font(JieboFont.ui(15))
                .foregroundStyle(JieboColor.ink)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing)
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
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
