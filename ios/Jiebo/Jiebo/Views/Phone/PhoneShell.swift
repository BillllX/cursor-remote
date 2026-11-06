import SwiftUI
import UIKit

/// iPhone 的「小驳」空间。根页永远是 AssistantHome（唯一的 ComposerView 在它里面）。
/// PhoneRouter 由外层 PhoneTabShell 唯一持有，避免和待处理空间共用导航栈。
struct PhoneShell: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(PhoneRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.path) {
            AssistantHome()
                .navigationDestination(for: PhoneRoute.self) { route in
                    destination(route)
                }
        }
        .task { await bootstrap() }
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
        case .worklist(let column):
            DelegationListScreen(column: column)
        case .artifacts:
            ArtifactCenterView()
        case .settings:
            PhoneSettingsScreen()
        case .memory:
            AssistantMemoryScreen()
        case .memoryPage(let page):
            MemoryCenterPhonePageHost(route: page)
        case .connections:
            DeviceConnectionsScreen()
        }
    }

    // MARK: 冷启动对齐（§3.2）

    /// 等 unlocked（自动登录时可能要等网络）→ 再等助理会话 id 到手（最多 8 秒）→ 选中助理会话 → bootstrapped
    @MainActor
    private func bootstrap() async {
        store.assistantOnly = router.locksActiveChatToAssistant
        while !store.unlocked, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
        }
        var waited = 0
        while !(store.unlocked && store.assistantChatId != nil), waited < 80, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
            waited += 1
        }
        guard !Task.isCancelled else { return }
        store.assistantOnly = router.locksActiveChatToAssistant
        if router.locksActiveChatToAssistant {
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
    /// --phone-route=root|inbox|today|delegations|todos|plans|runs|artifacts|settings|memory
    /// runs 仍可用，打开的是委派。
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
            case "today": router.popToRoot()
            case "delegations": router.go(.worklist(.delegation))
            case "todos": router.go(.worklist(.todo))
            case "plans": router.go(.worklist(.plan))
            case "runs": router.go(.worklist(.delegation))
            case "artifacts": router.go(.artifacts)
            case "settings": router.path = [.settings]
            case "memory": router.path = [.settings, .memory]
            default: router.path = []
            }
        }
        if let id = value(of: "--phone-delegation="), !id.isEmpty {
            router.delegationDetail = DelegationRef(id: id)
        }
    }
    #endif
}
