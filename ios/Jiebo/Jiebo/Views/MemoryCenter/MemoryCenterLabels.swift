import Foundation

enum MemoryCenterLabels {
    static let kind: [String: String] = [
        "personal": "个人",
        "work_preference": "工作偏好",
        "workspace_memory": "工作区记忆",
        "rule": "规则",
        "document": "文档",
    ]

    static let searchableKinds = ["personal", "work_preference", "workspace_memory"]

    static let state: [String: String] = [
        "pinned": "常驻",
        "hot": "活跃",
        "cold": "冷门",
        "done": "完成",
        "expired": "过期",
        "待核实": "待核实",
    ]

    static let stateFilters = ["all", "hot", "cold", "done", "pinned", "expired", "待核实"]

    static let injectionReason: [String: String] = [
        "pinned": "常驻",
        "section_anchor": "章节锚点",
        "relevant": "相关召回",
        "rotation": "轮换",
    ]

    static let skipReason: [String: String] = [
        "budget": "预算",
        "cold_unrelated": "冷无关",
        "terminal": "终态",
    ]

    static let searchMatchReason: [String: String] = [
        "text": "正文匹配",
        "section": "分节匹配",
        "ref": "引用匹配",
        "scope": "作用域匹配",
        "state": "状态匹配",
        "pinned": "置顶匹配",
        "related": "相关",
    ]

    static func kindLabel(_ kind: String) -> String {
        Self.kind[kind] ?? kind
    }

    static func stateLabel(_ state: String) -> String {
        Self.state[state] ?? state
    }

    static func effectiveStateLabel(_ effective: String) -> String {
        stateLabel(effective)
    }

    static func injectionReasonLabel(_ reason: String) -> String {
        injectionReason[reason] ?? reason
    }

    static func skipReasonLabel(_ reason: String) -> String {
        skipReason[reason] ?? reason
    }

    static func searchMatchReasonLabel(_ code: String) -> String {
        searchMatchReason[code] ?? code
    }

    static func formatSearchMatchReasons(_ codes: [String]) -> String {
        codes.map { searchMatchReasonLabel($0) }.joined(separator: " · ")
    }

    static func scopeHealthText(health: String?, error: String?) -> String? {
        if let error, !error.isEmpty { return "错误：\(error)" }
        if health == "degraded" { return "降级" }
        if health == "error" { return "错误" }
        return nil
    }
}

func memoryCenterSearchDebounceKey(query: String, scope: String, kind: String, state: String) -> String {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return "\(q)\t\(scope)\t\(kind)\t\(state)"
}
