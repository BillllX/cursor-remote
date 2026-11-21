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
        case .automation:
            AssistantAutomationScreen()
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
        case .colleagues:
            AssistantColleaguesScreen()
        }
    }

}
