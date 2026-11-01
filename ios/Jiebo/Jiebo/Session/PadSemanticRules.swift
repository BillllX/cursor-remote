import Foundation

enum PadSemanticKind: String, Codable, CaseIterable {
    case task
    case inbox
    case draft
    case artifact
}

/// 待办、计划、委派各占一个栏目。没挂上委派的后台运行留在委派里，仍按状态分组。
enum AssistantWorkColumn: String, CaseIterable, Identifiable, Hashable {
    case todo
    case plan
    case delegation

    var id: String { rawValue }

    var title: String {
        switch self {
        case .todo: return "待办"
        case .plan: return "计划"
        case .delegation: return "委派"
        }
    }

    var symbol: String {
        switch self {
        case .todo: return "checkmark.circle"
        case .plan: return "calendar"
        case .delegation: return "person.2.wave.2"
        }
    }

    var emptyDetail: String {
        switch self {
        case .todo: return "对话里记下的待办会出现在这里。"
        case .plan: return "到点要做的计划会出现在这里。"
        case .delegation: return "交给小驳去办的事会出现在这里。没挂上的后台运行也在这一栏。"
        }
    }

    var section: PadAssistantSection {
        switch self {
        case .todo: return .todos
        case .plan: return .plans
        case .delegation: return .delegations
        }
    }

    static func matching(_ kind: String) -> AssistantWorkColumn {
        switch kind {
        case "schedule": return .plan
        case "delegation", "background_run": return .delegation
        default: return .todo
        }
    }

    static func section(forTaskId id: String) -> PadAssistantSection {
        if id.hasPrefix("schedule:") { return .plans }
        if id.hasPrefix("delegation:") || id.hasPrefix("run:") { return .delegations }
        return .todos
    }
}

enum PadSemanticDropTarget: String, CaseIterable {
    case today
    case inbox
    case todos
    case plans
    case delegations
    case artifacts

    /// 导航落点只接受同类实体；“今日”是交给小驳继续处理的汇总落点。
    func accepts(_ kind: PadSemanticKind) -> Bool {
        switch self {
        case .today:
            return true
        case .inbox:
            return kind == .inbox || kind == .draft
        case .todos, .plans, .delegations:
            return kind == .task
        case .artifacts:
            return kind == .artifact
        }
    }
}
