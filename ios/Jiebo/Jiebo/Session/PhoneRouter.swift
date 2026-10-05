import SwiftUI
import UIKit

/// 从助理页 push 出去的页面
enum PhoneRoute: Hashable {
    case inbox
    case inboxItem(String)      // AssistantInboxItem.id
    case delegations
    case settings
    case memory                 // 只从设置页 push 进来，不直接挂在菜单上
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

/// iPhone 纯助理壳的路由状态。只在 PhoneShell 里创建并 `.environment(router)` 下发，不放进 ChatStore。
@Observable
@MainActor
final class PhoneRouter {
    var path: [PhoneRoute] = []
    var menuOpen = false
    var hubOpen = false
    /// 打开今日面板后滚到的锚点："todos" / "schedules"，nil 不滚
    var hubAnchor: String?
    /// 正在看的委派详情。sheet 挂在 PhoneShell 上，在任何 push 页上都能弹
    var delegationDetail: DelegationRef?
    var bootstrapped = false
}

extension PhoneRouter {
    private func dismissKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// 菜单里的条目（含「待处理」）：先收菜单和键盘，再 push（替换整个栈，不叠层）
    func go(_ route: PhoneRoute) {
        dismissKeyboard()
        menuOpen = false
        hubOpen = false
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
        path = []
        menuOpen = false
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
