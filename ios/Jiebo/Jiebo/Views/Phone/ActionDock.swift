import SwiftUI

/// iPhone 的单卡行动区，页面导航通过当前窗口的 PhoneRouter 提供。
struct ActionDock: View {
    @Environment(PhoneRouter.self) private var router

    var body: some View {
        AssistantReceiptDock()
            .environment(\.assistantReceiptNavigation, AssistantReceiptNavigation(
                openInbox: { router.go(.inbox) },
                openInboxItem: { router.openInboxItem($0) },
                openDelegation: { router.delegationDetail = DelegationRef(id: $0) },
                openDelegations: { router.go(.worklist(.delegation)) },
                openAutomation: { router.go(.automation) }
            ))
    }
}
