import SwiftUI
import UIKit

/// iPhone 的「纯个人助理」壳（docs/iphone-assistant-first.md §4.0）。
/// 根页永远是 AssistantHome（唯一的 ComposerView 在它里面）；菜单抽屉、预览层、今日面板、委派详情都叠在它上面。
/// 打开时置 `store.assistantOnly = true`：activeId 只会是助理会话，工作区会话没有任何入口。
struct PhoneShell: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var router = PhoneRouter()
    @State private var logoutConfirm = false

    var body: some View {
        @Bindable var router = router
        ZStack {
            NavigationStack(path: $router.path) {
                AssistantHome()
                    .navigationDestination(for: PhoneRoute.self) { route in
                        destination(route)
                    }
            }
            MenuDrawer(requestLogout: requestLogout)
                .zIndex(2)
            if store.previewPanelOpen, let tab = store.activePreviewTab {
                // 与 PhoneWorkbench 现有写法一致：遮罩 + 全屏 PreviewPanelView
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { store.collapsePreview() }
                    .transition(.opacity)
                    .zIndex(3)
                PreviewPanelView(tab: tab)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(JieboColor.white)
                    .transition(.move(edge: .trailing))
                    .zIndex(3)
            }
            if router.hubOpen {
                todayPanel
                    .zIndex(4)
            }
        }
        .environment(router)
        .environment(\.openDelegation, { [router = self.router] id in
            router.delegationDetail = DelegationRef(id: id)
        })
        .animation(JieboMotion.panel(reduceMotion), value: store.previewPanelOpen)
        .animation(JieboMotion.panel(reduceMotion), value: router.hubOpen)
        .sheet(item: $router.delegationDetail) { ref in
            DelegationDetailSheet(delegationId: ref.id)
        }
        .confirmationDialog("退出登录？", isPresented: $logoutConfirm, titleVisibility: .visible) {
            Button("退出登录", role: .destructive) {
                // 先退订 APNs：logout 之后 unlocked 为 false，assistant_op 会被丢弃
                PushRegistrar.shared.unsubscribe(store: store)
                store.logout()
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("退出后需要重新输入访问码才能连回来。")
        }
        .onAppear { store.assistantOnly = true }
        .onDisappear { store.assistantOnly = false }
        .onChange(of: PushRouting.shared.pending) { _, _ in
            Task { @MainActor in await consumePendingPush() }
        }
        .task { await bootstrap() }
    }

    /// 自绘底栏，避开系统 sheet。点遮罩或「完成」关掉。
    private var todayPanel: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { router.hubOpen = false }
                AssistantHubSheet()
                    .frame(height: max(320, geo.size.height * 0.72))
                    .clipShape(
                        UnevenRoundedRectangle(
                            topLeadingRadius: 16,
                            bottomLeadingRadius: 0,
                            bottomTrailingRadius: 0,
                            topTrailingRadius: 16,
                            style: .continuous
                        )
                    )
            }
        }
        .ignoresSafeArea()
        .transition(.opacity)
    }

    @ViewBuilder
    private func destination(_ route: PhoneRoute) -> some View {
        pageContent(route).phoneNotice()
    }

    @ViewBuilder
    private func pageContent(_ route: PhoneRoute) -> some View {
        switch route {
        case .inbox:
            InboxHome()
        case .inboxItem(let id):
            InboxDetailView(itemId: id)
        case .todayManage:
            AssistantTodayScreen()
        case .delegations:
            DelegationListScreen()
        case .settings:
            PhoneSettingsScreen()
        case .memory:
            AssistantMemoryScreen()
        }
    }

    /// 先收抽屉再弹确认框：两段动画叠在一起会让对话框从半透明遮罩上冒出来
    private func requestLogout() {
        withAnimation(JieboMotion.panel(reduceMotion)) {
            router.closeMenu()
        } completion: {
            logoutConfirm = true
        }
    }

    // MARK: 冷启动对齐（§3.2）

    /// 等 unlocked 且助理会话 id 到手（最多 8 秒）→ 选中助理会话 → bootstrapped
    @MainActor
    private func bootstrap() async {
        store.assistantOnly = true
        var waited = 0
        while !(store.unlocked && store.assistantChatId != nil), waited < 80, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
            waited += 1
        }
        guard !Task.isCancelled else { return }
        store.assistantOnly = true
        // 旧网关没有助理会话：openAssistantChat 只记下意图，助理页显示降级说明
        store.openAssistantChat()
        if store.assistantChatId != nil {
            PushRegistrar.shared.start(store: store) // 幂等；内部只在 iPhone 上生效
        }
        router.bootstrapped = true
        #if DEBUG
        applyDebugArguments()
        #endif
        // 冷启动点通知进来时，pending 可能早于 bootstrapped 就有了
        await consumePendingPush()
    }

    // MARK: 通知点击路由（§7.1.5）

    @MainActor
    private func consumePendingPush() async {
        guard router.bootstrapped, PushRouting.shared.pending != nil else { return }
        // 冷启动时助理状态可能还没到：多等几秒，免得委派 / 收件箱条目找不到
        if store.assistantState == nil {
            store.requestAssistant()
            var waited = 0
            while store.assistantState == nil, waited < 30, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                waited += 1
            }
        }
        guard let target = PushRouting.shared.consume() else { return }
        if let itemId = target.itemId,
           let item = store.assistantState?.inbox.first(where: { $0.id == itemId }) {
            store.markInboxRead(item)
        }
        if target.kind == "approval" {
            router.go(.inbox)
            return
        }
        if target.delegationId != nil || target.chatId != nil {
            router.open(chatId: target.chatId, delegationId: target.delegationId, store: store)
            return
        }
        router.go(.inbox)
    }

    // MARK: DEBUG 启动参数（§8 P5）

    #if DEBUG
    /// --phone-route=root|inbox|today|delegations|settings|memory
    /// --phone-menu=open
    /// --phone-delegation=<id>
    @MainActor
    private func applyDebugArguments() {
        let arguments = ProcessInfo.processInfo.arguments
        func value(of prefix: String) -> String? {
            guard let found = arguments.first(where: { $0.hasPrefix(prefix) }) else { return nil }
            return String(found.dropFirst(prefix.count))
        }
        if let route = value(of: "--phone-route=") {
            switch route {
            case "inbox": router.path = [.inbox]
            case "today": router.path = [.todayManage]
            case "delegations": router.path = [.delegations]
            case "settings": router.path = [.settings]
            case "memory": router.path = [.settings, .memory]
            default: router.path = []
            }
        }
        if value(of: "--phone-menu=") == "open" {
            router.menuOpen = true
        }
        if let id = value(of: "--phone-delegation="), !id.isEmpty {
            router.delegationDetail = DelegationRef(id: id)
        }
    }
    #endif
}
