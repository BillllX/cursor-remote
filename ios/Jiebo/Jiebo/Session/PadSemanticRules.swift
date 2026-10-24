import Foundation

enum PadSemanticKind: String, Codable, CaseIterable {
    case task
    case inbox
    case draft
    case artifact
}

enum PadSemanticDropTarget: String, CaseIterable {
    case today
    case inbox
    case tasks
    case artifacts

    /// 导航落点只接受同类实体；“今日”是交给小驳继续处理的汇总落点。
    func accepts(_ kind: PadSemanticKind) -> Bool {
        switch self {
        case .today:
            return true
        case .inbox:
            return kind == .inbox || kind == .draft
        case .tasks:
            return kind == .task
        case .artifacts:
            return kind == .artifact
        }
    }
}
