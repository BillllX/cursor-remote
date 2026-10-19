import Foundation

/// 与 Web `NavigationIconId` 对齐的跨端导航语义。视图使用语义 ID，不直接选择同义图标。
enum NavigationIconId: String, CaseIterable {
    case assistant, workspace, account, overview, chats, files, search, git, memory, terminal, loop, stats

    var symbol: String {
        switch self {
        case .assistant: return "sparkles"
        case .workspace: return "rectangle.3.group"
        case .account: return "person.crop.circle"
        case .overview: return "square.grid.2x2"
        case .chats: return "bubble.left.and.bubble.right"
        case .files: return "folder"
        case .search: return "magnifyingglass"
        case .git: return "arrow.triangle.branch"
        case .memory: return "book.closed"
        case .terminal: return "terminal"
        case .loop: return "arrow.triangle.2.circlepath"
        case .stats: return "chart.bar"
        }
    }

    var label: String {
        switch self {
        case .assistant: return "助理"
        case .workspace: return "工作区"
        case .account: return "账户"
        case .overview: return "概览"
        case .chats: return "会话"
        case .files: return "文件"
        case .search: return "工作区搜索"
        case .git: return "源代码管理"
        case .memory: return "记忆与规则"
        case .terminal: return "终端输出"
        case .loop: return "Loop"
        case .stats: return "使用统计"
        }
    }

    func accessibilityLabel(count: Int? = nil) -> String {
        guard let count, count > 0 else { return label }
        return "\(label)，\(count) 项"
    }
}

/// 与 Web `STATUS_LEGEND` 对齐的状态图例；颜色只能辅助，不能代替此文案。
enum StatusLegendId: String, CaseIterable {
    case normal, running, attention, error, disabled, unread

    var symbol: String {
        switch self {
        case .normal: return "checkmark.circle"
        case .running: return "play.circle"
        case .attention: return "exclamationmark.triangle"
        case .error: return "exclamationmark.circle"
        case .disabled: return "circle.slash"
        case .unread: return "circle.fill"
        }
    }

    var label: String {
        switch self {
        case .normal: return "正常"
        case .running: return "运行中"
        case .attention: return "需要处理"
        case .error: return "错误"
        case .disabled: return "未启用"
        case .unread: return "未读"
        }
    }

    func accessibilityLabel(count: Int? = nil) -> String {
        guard let count, count > 0 else { return label }
        return "\(label) \(count)"
    }
}
