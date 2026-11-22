import SwiftUI
import UIKit

/// iPhone 助理页（docs/iphone-assistant-first.md §4.1）：根页，导航栏由 PhoneShell 的 NavigationStack 提供。
/// 整个 iPhone 上只有这里有 ComposerView（它由 ThreadView 内部创建），ActionDock 通过 ThreadView 的 dock 插槽放在输入框正上方。
struct AssistantHome: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sidebarOpen = false
    @State private var skillsOpen = false
    @State private var modelPickerOpen = false
    @Environment(PhoneRouter.self) private var router
    @Environment(\.switchPhoneSpace) private var switchPhoneSpace

    private var assistantTargetChatId: String {
        store.assistantChatId ?? "boot"
    }

    var body: some View {
        VStack(spacing: 0) {
            if store.assistantChatId == nil, router.bootstrapped {
                unsupportedCard
            } else {
                if let attentionLine {
                    Group {
                        if !store.connected {
                            Button {
                                store.retryConnection()
                            } label: {
                                Text(attentionLine)
                            }
                            .buttonStyle(PressScaleButtonStyle())
                            .disabled(store.linkState != .offline)
                            .accessibilityHint(store.linkState == .offline ? "重新连接" : "")
                        } else if store.isThreadSyncBusy(assistantTargetChatId) {
                            Button {
                                store.retryThreadSync(assistantTargetChatId)
                            } label: {
                                Text(attentionLine)
                            }
                            .buttonStyle(PressScaleButtonStyle())
                            .accessibilityHint("再拉一次这条会话")
                        } else if store.backgroundAttentionTitle == attentionLine {
                            Button {
                                store.requestAssistant(force: true)
                            } label: {
                                Text(attentionLine)
                            }
                            .buttonStyle(PressScaleButtonStyle())
                            .accessibilityHint("再向服务器确认后台模型")
                        } else if attentionLine == ChatStore.failedRetryTitle, let chatId = store.assistantChatId {
                            Button {
                                store.restoreFailedPromptIfDraftEmpty(chatId: chatId)
                            } label: {
                                Text(attentionLine)
                            }
                            .buttonStyle(PressScaleButtonStyle())
                            .accessibilityHint("上一句回到输入框")
                        } else {
                            Text(attentionLine)
                        }
                    }
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(store.connected ? JieboColor.ink2 : JieboColor.danger)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .accessibilityAddTraits(.updatesFrequently)
                }
                ThreadView(chrome: .embedded, chatId: assistantTargetChatId, dock: AnyView(ActionDock()))
                    .environment(\.homeActive, router.selectedTab == .assistant && router.path.isEmpty && !sidebarOpen)
            }
        }
        .environment(\.assistantReceiptNavigation, AssistantReceiptNavigation(
            openInbox: { router.go(.inbox) },
            openInboxItem: { router.openInboxItem($0) },
            openDelegation: { router.delegationDetail = DelegationRef(id: $0) },
                openDelegations: { router.go(.worklist(.delegation)) },
                openAutomation: { router.go(.automation) }
        ))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(JieboColor.paper.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                titleView
            }
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    withAnimation(JieboMotion.panel(reduceMotion)) { sidebarOpen = true }
                } label: {
                    Image(systemName: "sidebar.left")
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("打开小驳侧边栏")
            }
            ToolbarItem(placement: .topBarTrailing) { inboxButton }
        }
        .sheet(isPresented: $skillsOpen) { SkillsWorkspaceSheet() }
        .sheet(isPresented: $modelPickerOpen) {
            if let chatId = store.assistantChatId {
                AssistantModelPicker(models: store.models, selected: store.model(for: chatId)) {
                    store.chooseModel($0, chatId: chatId)
                }
            }
        }
        .modifier(AssistantToolbarMinimize())
        .environment(\.homeActive, router.selectedTab == .assistant && router.path.isEmpty && !sidebarOpen)
        .accessibilityHidden(sidebarOpen)
        .disabled(sidebarOpen)
        .overlay {
            JieboDrawer(isPresented: sidebarOpen, close: { closeSidebar() }) {
                sidebar
            }
        }
    }

    private func closeSidebar(then action: @escaping () -> Void = {}) {
        let revision = router.revision
        withAnimation(JieboMotion.panel(reduceMotion)) { sidebarOpen = false } completion: {
            guard router.selectedTab == .assistant, router.revision == revision else { return }
            action()
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("小驳").font(JieboFont.text(.title2, weight: .semibold))
                Spacer()
                Button { closeSidebar() } label: {
                    Image(systemName: "xmark").frame(width: 44, height: 44)
                }
                .accessibilityLabel("关闭侧边栏")
            }
            .padding(.horizontal, 16)
            List {
                Section {
                    sidebarRoute("定时与自动化", symbol: NavigationIconId.schedules.symbol, route: .automation)
                    sidebarRoute("文件", symbol: NavigationIconId.files.symbol, route: .artifacts)
                }
                conversationSection
                Section("记忆与能力") {
                    sidebarRoute("记忆与规则", symbol: NavigationIconId.memory.symbol, route: .memory)
                    Button { closeSidebar { skillsOpen = true } } label: {
                        Label("技能工厂", systemImage: NavigationIconId.skills.symbol)
                            .frame(minHeight: 44)
                    }
                    sidebarRoute("同事与访问管理", symbol: NavigationIconId.collab.symbol, route: .colleagues)
                    sidebarRoute("连接与设备权限", symbol: "checkmark.shield", route: .connections)
                }
            }
            .listStyle(.insetGrouped)
            .font(JieboFont.text(.subheadline))
            .scrollContentBackground(.hidden)
            Divider()
            sidebarRoute("设置", symbol: NavigationIconId.account.symbol, route: .settings)
                .padding(.horizontal, 16)
            Button {
                closeSidebar {
                    switchPhoneSpace?(.workspace)
                }
            } label: {
                HStack {
                    Label("工作台", systemImage: "rectangle.3.group")
                    Spacer()
                    if store.workspaceUnreadCount > 0 {
                        PendingBadge(count: store.workspaceUnreadCount)
                    }
                }
                .frame(minHeight: 44)
                .padding(16)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleButtonStyle())
        }
        .foregroundStyle(JieboColor.ink)
        .frame(maxHeight: .infinity)
        .background(JieboColor.paper)
    }

    private var conversationSection: some View {
        Section("当前对话") {
            if let chatId = store.assistantChatId {
                conversationOptions(chatId: chatId)
            }
        }
    }

    @ViewBuilder
    private func conversationOptions(chatId: String) -> some View {
        Button { closeSidebar { modelPickerOpen = true } } label: {
            HStack(spacing: 12) {
                Label("模型", systemImage: "cpu")
                Spacer(minLength: 4)
                Text(ModelCatalog.label(for: store.model(for: chatId)))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 44)
        }
        .buttonStyle(PressScaleButtonStyle())

    }

    private func sidebarRoute(_ title: String, symbol: String, route: PhoneRoute, badge: Int = 0) -> some View {
        Button { closeSidebar { router.go(route) } } label: {
            HStack(spacing: 12) {
                Label(title, systemImage: symbol)
                Spacer(minLength: 4)
                if badge > 0 { PendingBadge(count: badge) }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(badge > 0 ? "\(title)，\(badge) 项待处理" : title)
    }

    /// 连接、同步或需要人处理时才出字。平常只留圆点，避免每句都占一行。
    private var attentionLine: String? {
        if !store.connected { return store.linkState.title }
        if store.isThreadSyncBusy(assistantTargetChatId) { return ChatStore.syncingThreadTitle }
        if !store.hasApiKey { return ChatStore.missingApiKeyTitle }
        if let hint = store.approvalHint(for: store.assistantChatId ?? "", surface: .phoneAssistant) {
            return hint.title
        }
        if let title = store.backgroundAttentionTitle {
            return title
        }
        switch store.assistantAvatarPhase {
        case .failure: return ChatStore.failedRetryTitle
        default: break
        }
        return nil
    }

    // MARK: 导航栏

    private var titleView: some View {
        AssistantPlayfulAvatar(phase: store.assistantAvatarPhase, size: 32, completionEvent: store.assistantCompletionEvent)
            .overlay(alignment: .bottomTrailing) {
                LinkStatusDot(state: store.linkState, syncing: store.isThreadSyncBusy(assistantTargetChatId))
                    .offset(x: 1, y: 2)
            }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(titleAccessibility)
        .accessibilityHint("点按和小驳打个招呼")
    }

    private var titleAccessibility: String {
        var parts = [store.assistantName, store.assistantAvatarPhase.accessibilityLabel]
        if let subtitleText { parts.append(subtitleText) }
        return parts.joined(separator: "，")
    }

    /// 连接状态由圆点表达；文字与形象使用同一客户端状态映射。
    private var subtitleText: String? {
        if store.connected {
            if !store.hasApiKey { return ChatStore.missingApiKeyTitle }
            if let hint = store.approvalHint(for: store.assistantChatId ?? "", surface: .phoneAssistant) {
                return hint.title
            }
            switch store.assistantAvatarPhase {
            case .approval: break
            case .executing: return "正在执行"
            case .thinking: return "正在思考"
            case .listening: return "正在接收输入"
            case .failure: return store.backgroundAttentionReason ?? "执行没有完成"
            case .idle, .success, .offline: break
            }
            if let reason = store.backgroundAttentionReason { return reason }
        }
        return store.linkState.title
    }

    private var inboxButton: some View {
        let badge = store.assistantBadgeCount
        return Button {
            router.go(.inbox)
        } label: {
            Image(systemName: "tray")
                .font(JieboFont.text(.body, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .frame(minWidth: 44, minHeight: 44)
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        PendingBadge(count: badge)
                            .offset(x: 10, y: -8)
                    }
                }
        }
        .accessibilityLabel(
            badge > 0
                ? "收件箱，\(StatusLegendId.attention.accessibilityLabel(count: badge))"
                : "收件箱"
        )
    }

    // MARK: 降级（§4.1.6）

    /// 还没连上时不要写成服务器没有助理功能。连上且网关也没给出主会话，才是升级。
    private var unsupportedTitle: String {
        if !store.connected { return store.linkState.title }
        if !store.gatewayReady { return "正在打开小驳主会话…" }
        return "这个服务器还没有助理功能，请先升级服务器"
    }

    private var unsupportedCard: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 40)
            JieboMark(size: 36)
            Text(unsupportedTitle)
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                if store.linkState == .offline {
                    ActionButton(title: "重连", kind: .primary) { store.retryConnection() }
                } else if store.connected, store.gatewayReady {
                    ActionButton(title: "再试一次", kind: .primary) { store.requestAssistant(force: true) }
                }
                ActionButton(title: "设置") { router.go(.settings) }
            }
            .padding(.top, 4)
            Spacer(minLength: 40)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// iOS 27 可以在向下滚动时收起导航栏。冷启动时会话还是空的，这块玻璃会被铺成
/// 左上角一块灰矩形，盖住半屏；iPad 没有这层行为，也没有灰块。先保持栏不收起。
private struct AssistantToolbarMinimize: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 27, *) {
            content.toolbarMinimizationBehavior(.never, for: .navigationBar)
        } else {
            content
        }
    }
}

/// Shared by the sidebar and composer, with search and vendor filters for large catalogs.
struct AssistantModelPicker: View {
    let models: [String]
    let selected: String
    let onSelect: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var query = ""
    @State private var vendor: String?

    private var groups: [ModelCatalog.Group] {
        ModelCatalog.groups(from: ModelCatalog.withCurrentModel(models, current: selected))
    }

    private var results: [ModelCatalog.Item] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return groups.filter { vendor == nil || $0.vendor == vendor }.flatMap { group in
            group.models.filter {
                term.isEmpty || $0.name.localizedCaseInsensitiveContains(term)
                    || $0.id.localizedCaseInsensitiveContains(term)
                    || group.label.localizedCaseInsensitiveContains(term)
            }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if results.isEmpty {
                    ContentUnavailableView {
                        Label("没有找到模型", systemImage: "magnifyingglass")
                    } description: {
                        Text("试试其他名称，或清除搜索与厂商筛选。")
                    } actions: {
                        Button("清除筛选") { query = ""; vendor = nil }
                    }
                } else {
                    LazyVGrid(columns: typeSize.isAccessibilitySize
                              ? [GridItem(.flexible())]
                              : [GridItem(.adaptive(minimum: 150), alignment: .top)], spacing: 12) {
                        ForEach(results) { model in modelButton(model) }
                    }
                    .padding(16)
                }
            }
            .background(JieboColor.paper)
            .navigationTitle("选择模型")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "搜索模型名称或厂商")
            .safeAreaInset(edge: .top, spacing: 0) { filters }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("当前：\(ModelCatalog.label(for: selected))", systemImage: "cpu")
                .font(JieboFont.text(.subheadline, weight: .medium))
                .foregroundStyle(JieboColor.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    vendorButton("全部", id: nil)
                    ForEach(groups) { group in vendorButton(group.label, id: group.vendor) }
                }
                .padding(.horizontal, 16)
            }
        }
        .padding(.vertical, 8)
        .background(JieboColor.paper)
    }

    private func vendorButton(_ title: String, id: String?) -> some View {
        Button { vendor = id } label: {
            Text(title)
                .font(JieboFont.text(.subheadline, weight: .medium))
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .foregroundStyle(vendor == id ? JieboColor.fillFg : JieboColor.ink2)
                .background(vendor == id ? JieboColor.pine : JieboColor.white, in: Capsule())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityAddTraits(vendor == id ? .isSelected : [])
    }

    private func modelButton(_ model: ModelCatalog.Item) -> some View {
        Button {
            onSelect(model.id)
            dismiss()
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: "cpu")
                    Spacer()
                    if model.id == selected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(JieboColor.pine)
                    }
                }
                Text(model.name)
                    .font(JieboFont.text(.body, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(model.id)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(JieboColor.ink)
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
            .background(JieboColor.white, in: RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(model.id == selected ? JieboColor.pine : JieboColor.line, lineWidth: model.id == selected ? 2 : 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(model.id == selected ? .isSelected : [])
    }
}
