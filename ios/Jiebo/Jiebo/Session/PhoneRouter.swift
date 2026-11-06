import SwiftUI
import UIKit

/// 从助理页 push 出去的页面
enum PhoneRoute: Hashable {
    case inbox
    case inboxItem(String)      // AssistantInboxItem.id
    case worklist(AssistantWorkColumn)
    case artifacts
    case settings
    case memory                 // 资料菜单和设置页都能进来
    /// 记忆再往下的一层。必须跟 memory 同一条栈。
    /// 记忆页里再套一个 NavigationStack 时，点过记忆再点菜单里别的页面，外层换栈会把内层导航控制器拆掉，直接崩溃。
    case memoryPage(MemoryCenterPhoneRoute)
    case connections            // 只从设置页进入
}

enum PhoneTab: Hashable {
    case assistant
    case workspace
    case messages
}

/// 待处理这一页里的栏目。通知是原来的收件箱；待办、计划、委派不再从侧栏另开一页。
enum InboxLane: Hashable {
    case notices
    case work(AssistantWorkColumn)
    case artifacts
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

/// iPhone 三个大模块的路由状态。只在 PhoneTabShell 创建并下发，不放进 ChatStore。
/// 待处理是小驳聊天页里的一页，不单独占一个模块。
@Observable
@MainActor
final class PhoneRouter {
    var selectedTab: PhoneTab = .assistant
    /// 小驳空间的导航栈。待处理、通知详情都在这条栈上。
    var path: [PhoneRoute] = []
    var inboxLane: InboxLane = .notices
    /// 工作台左抽屉开着。底部空间栏要让开，抽屉底栏才点得到。
    var workbenchDrawerOpen = false
    /// 正在看的委派详情。sheet 挂在 PhoneTabShell 上，三个一级空间都能弹
    var delegationDetail: DelegationRef?
    /// 进入待办、计划或委派后要打开的那一条。栏目页取走后清空。
    var pendingWorkTaskId: String?
    /// 只由当前前台 scene 接收，再定向交给小驳页唯一可见的 Composer。
    var pendingVoiceCapture: AssistantCaptureBridge.Capture?
    var bootstrapped = false

    /// 小驳必须停在助理会话。工作区和即时消息可以打开别的会话。
    var locksActiveChatToAssistant: Bool {
        selectedTab == .assistant
    }
}

private struct PhoneSpaceSwitchKey: EnvironmentKey {
    static let defaultValue: ((PhoneTab) -> Void)? = nil
}

extension EnvironmentValues {
    /// iPhone 上切换小驳、工作台、即时消息。iPad 不注入。
    var switchPhoneSpace: ((PhoneTab) -> Void)? {
        get { self[PhoneSpaceSwitchKey.self] }
        set { self[PhoneSpaceSwitchKey.self] = newValue }
    }
}

extension PhoneRouter {
    private func dismissKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// 待处理、待办、计划、委派都留在小驳的导航栈里。其它页面回到小驳后 push（替换整个栈，不叠层）。
    func go(_ route: PhoneRoute) {
        dismissKeyboard()
        workbenchDrawerOpen = false
        selectedTab = .assistant
        switch route {
        case .inbox, .inboxItem:
            inboxLane = .notices
            path = [.inbox]
        case .worklist(let column):
            inboxLane = .work(column)
            path = [.inbox]
        case .artifacts:
            inboxLane = .artifacts
            path = [.inbox]
        default:
            path = [route]
        }
    }

    /// 三个大模块之间切换。回到小驳时落在聊天页，不留着上次推上去的页面。
    func openSpace(_ tab: PhoneTab) {
        dismissKeyboard()
        workbenchDrawerOpen = false
        if tab == .assistant {
            path = []
        }
        selectedTab = tab
    }

    /// 打开对应栏目，并在列表出现后展开这一条，而不是整页今日。
    func openWorkTask(_ id: String, column: AssistantWorkColumn) {
        pendingWorkTaskId = id
        go(.worklist(column))
    }

    func popToRoot() {
        selectedTab = .assistant
        path = []
        workbenchDrawerOpen = false
    }

    func openInboxItem(_ id: String) {
        dismissKeyboard()
        workbenchDrawerOpen = false
        selectedTab = .assistant
        if path.last != .inbox {
            path.append(.inbox)
        }
        path.append(.inboxItem(id))
    }

    func queueVoice(_ capture: AssistantCaptureBridge.Capture) {
        pendingVoiceCapture = capture
        popToRoot()
    }

    func takePendingVoice() -> AssistantCaptureBridge.Capture? {
        defer { pendingVoiceCapture = nil }
        return pendingVoiceCapture
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
