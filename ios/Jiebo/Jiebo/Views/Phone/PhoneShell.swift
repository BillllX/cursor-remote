import SwiftUI
import UIKit

/// iPhone 的「小驳」空间（docs/iphone-assistant-first.md §4.0）。
/// 根页永远是 AssistantHome（唯一的 ComposerView 在它里面）；这里只承载菜单抽屉和今日面板。
/// PhoneRouter 由外层 PhoneTabShell 唯一持有，避免和待处理空间共用导航栈。
struct PhoneShell: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(PhoneRouter.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// 今日面板顶部下拉的位移（抓手和标题行跟手）
    @State private var hubDrag: CGFloat = 0

    var body: some View {
        @Bindable var router = router
        ZStack {
            NavigationStack(path: $router.path) {
                AssistantHome()
                    .navigationDestination(for: PhoneRoute.self) { route in
                        destination(route)
                    }
            }
            // 今日面板、菜单盖在上面时，底下的对话不再让 VoiceOver 摸到
            .accessibilityHidden(router.hubOpen || router.menuOpen)
            MenuDrawer()
                .zIndex(2)
                .accessibilityHidden(router.hubOpen)
            if router.hubOpen {
                todayPanel
                    .zIndex(4)
            }
        }
        .animation(JieboMotion.panel(reduceMotion), value: router.hubOpen)
        .task { await bootstrap() }
    }

    /// 自绘底栏，避开系统 sheet。点遮罩或「完成」关掉。
    private var todayPanel: some View {
        // 外层不忽略安全区：键盘弹起时面板跟着让开；只有遮罩和面板底色铺到 Home 指示条下面
        GeometryReader { geo in
            let height = max(320, (geo.size.height + geo.safeAreaInsets.top) * 0.72)
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.28 * (1 - min(hubDrag / height, 1)))
                    .ignoresSafeArea()
                    .onTapGesture { router.hubOpen = false }
                    .accessibilityHidden(true)
                AssistantHubSheet(drag: $hubDrag, panelHeight: height)
                    .frame(height: height)
                    .clipShape(Self.panelShape)
                    .background {
                        Self.panelShape
                            .fill(JieboColor.paper)
                            .ignoresSafeArea(.container, edges: .bottom)
                    }
                    .offset(y: hubDrag)
                    .accessibilityAddTraits(.isModal)
                    .accessibilityAction(.escape) { router.hubOpen = false }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
        .transition(.opacity)
        .onDisappear { hubDrag = 0 }
    }

    private static let panelShape = UnevenRoundedRectangle(
        topLeadingRadius: 16,
        bottomLeadingRadius: 0,
        bottomTrailingRadius: 0,
        topTrailingRadius: 16,
        style: .continuous
    )

    @ViewBuilder
    private func destination(_ route: PhoneRoute) -> some View {
        pageContent(route).phoneNotice()
    }

    @ViewBuilder
    private func pageContent(_ route: PhoneRoute) -> some View {
        switch route {
        case .inbox:
            InboxHome()
        case .todayManage:
            AssistantTodayScreen()
        case .delegations:
            DelegationListScreen()
        case .artifacts:
            ArtifactCenterView()
        case .settings:
            PhoneSettingsScreen()
        case .memory:
            AssistantMemoryScreen()
        case .connections:
            DeviceConnectionsScreen()
        }
    }

    // MARK: 冷启动对齐（§3.2）

    /// 等 unlocked（自动登录时可能要等网络）→ 再等助理会话 id 到手（最多 8 秒）→ 选中助理会话 → bootstrapped
    @MainActor
    private func bootstrap() async {
        store.assistantOnly = router.selectedTab != .messages
        while !store.unlocked, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
        }
        var waited = 0
        while !(store.unlocked && store.assistantChatId != nil), waited < 80, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
            waited += 1
        }
        guard !Task.isCancelled else { return }
        store.assistantOnly = router.selectedTab != .messages
        if router.selectedTab != .messages {
            // 旧网关没有助理会话：openAssistantChat 只记下意图，助理页显示降级说明
            store.openAssistantChat()
        }
        if store.assistantChatId != nil {
            PushRegistrar.shared.start(store: store, im: im) // 幂等
        }
        router.bootstrapped = true
        #if DEBUG
        applyDebugArguments()
        #endif
    }

    // MARK: DEBUG 启动参数（§8 P5）

    #if DEBUG
    /// --phone-route=root|inbox|today|delegations|artifacts|settings|memory
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
            case "inbox": router.go(.inbox)
            case "today": router.path = [.todayManage]
            case "delegations": router.path = [.delegations]
            case "artifacts": router.path = [.artifacts]
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
