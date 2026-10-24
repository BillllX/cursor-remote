import Foundation

/// iPad 小驳域可定位的实体。只保存稳定 ID，不复制任何服务端实体。
enum PadSelection: Hashable {
    case assistantChat
    case brief
    case dayEvent(String)
    case draft(String)
    case approval(String)
    case inboxItem(String)
    case task(String)
    case artifact(String)
    case delegation(String)

    /// 主会话本身由 Today 的 ThreadView 呈现，不应再打开一个空 Inspector。
    var hasInspectorDetail: Bool {
        self != .assistantChat
    }
}

/// Inspector 的唯一模式；预览记住来处，关闭后精确回到原详情。
enum PadInspectorMode: Equatable {
    case detail
    case preview(returnTo: PadSelection?)
}

/// 与 SwiftUI 无关的 Inspector 导航状态，供 App 和 Linux 契约测试共用。
struct PadInspectorNavigation: Equatable {
    var selection: PadSelection?
    var mode: PadInspectorMode

    init(selection: PadSelection? = .assistantChat, mode: PadInspectorMode = .detail) {
        self.selection = selection
        self.mode = mode
    }

    mutating func select(_ next: PadSelection?) {
        selection = next
        mode = .detail
    }

    mutating func openPreview(returningTo explicitSelection: PadSelection? = nil) {
        mode = .preview(returnTo: explicitSelection ?? selection)
    }

    mutating func restoreAfterPreview() {
        guard case let .preview(returnTo) = mode else { return }
        selection = returnTo
        mode = .detail
    }
}
