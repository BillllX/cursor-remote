import SwiftUI
import UIKit

/// 从助理页 push 出去的页面
enum PhoneRoute: Hashable {
    case inbox
    case todayManage
    case delegations
    case artifacts
    case settings
    case memory                 // 只从设置页 push 进来，不直接挂在菜单上
    case connections            // 只从设置页进入
}

enum PhoneTab: Hashable {
    case assistant
    case inbox
    case messages
}

enum InboxRoute: Hashable {
    case item(String)           // AssistantInboxItem.id
}

struct DelegationRef: Identifiable, Hashable {
    let id: String   // AssistantDelegation.id
}

/// 打开委派详情（参数是 AssistantDelegation.id）。只有 PhoneShell 注入；
/// 没注入 PhoneRouter 的界面（iPad）拿到 nil，不出入口，也不会因为找不到 PhoneRouter 崩溃
private struct OpenDelegationKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

extension EnvironmentValues {
    var openDelegation: ((String) -> Void)? {
        get { self[OpenDelegationKey.self] }
        set { self[OpenDelegationKey.self] = newValue }
    }
}

/// iPhone 三个一级空间的路由状态。只在 PhoneTabShell 创建并下发，不放进 ChatStore。
@Observable
@MainActor
final class PhoneRouter {
    var selectedTab: PhoneTab = .assistant
    /// 小驳空间的导航栈；待处理使用独立的 inboxPath。
    var path: [PhoneRoute] = []
    var inboxPath: [InboxRoute] = []
    var menuOpen = false
    var hubOpen = false
    /// 打开今日面板后滚到的锚点："todos" / "schedules"，nil 不滚
    var hubAnchor: String?
    /// 正在看的委派详情。sheet 挂在 PhoneTabShell 上，三个一级空间都能弹
    var delegationDetail: DelegationRef?
    var bootstrapped = false
}

extension PhoneRouter {
    private func dismissKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// 待处理切一级 tab；其它页面回到小驳空间后 push（替换整个栈，不叠层）。
    func go(_ route: PhoneRoute) {
        dismissKeyboard()
        menuOpen = false
        hubOpen = false
        if route == .inbox {
            inboxPath = []
            selectedTab = .inbox
            return
        }
        selectedTab = .assistant
        path = [route]
    }

    func openMenu() {
        dismissKeyboard()
        hubOpen = false
        menuOpen = true
    }

    func closeMenu() {
        menuOpen = false
    }

    func openHub(anchor: String? = nil) {
        dismissKeyboard()
        menuOpen = false
        hubAnchor = anchor
        hubOpen = true
    }

    func popToRoot() {
        selectedTab = .assistant
        path = []
        menuOpen = false
    }

    func openInboxItem(_ id: String) {
        dismissKeyboard()
        selectedTab = .inbox
        inboxPath.append(.item(id))
    }

    /// 收件箱条目 / 推送 / 委派卡等「要打开某个会话」的统一入口。
    /// 绝不切换 store.activeId 到工作区会话（iPhone 不变量）。
    func open(chatId: String?, delegationId: String?, store: ChatStore) {
        if let delegationId, store.assistantState?.delegations.contains(where: { $0.id == delegationId }) == true {
            delegationDetail = DelegationRef(id: delegationId)
            return
        }
        if let chatId, store.isAssistantChat(chatId) {
            popToRoot()
            store.openAssistantChat()
            return
        }
        if let chatId, let row = store.assistantState?.delegations.first(where: { $0.childChatId == chatId }) {
            delegationDetail = DelegationRef(id: row.id)
            return
        }
        store.flash("这个会话在电脑或 iPad 上查看")
    }
}
