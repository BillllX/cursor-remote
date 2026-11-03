import Foundation

enum MemoryCenterLabels {
    static let kind: [String: String] = [
        "personal": "我",
        "work_preference": "偏好",
        "workspace_memory": "文件夹",
        "rule": "规则",
        "document": "文档",
    ]

    static let searchableKinds = ["personal", "work_preference", "workspace_memory"]

    static let state: [String: String] = [
        "pinned": "始终带上",
        "hot": "正在用",
        "cold": "很久没用",
        "done": "已办完",
        "expired": "已过期",
        "待核实": "待你确认",
    ]

    static let folderMenus = ["useful", "pinned", "confirm", "done", "all"]

    static let stateFilters = ["all", "hot", "cold", "done", "pinned", "expired", "待核实"]

    static let injectionReason: [String: String] = [
        "pinned": "始终带上",
        "section_anchor": "这一节正好用到",
        "relevant": "和你刚说的有关",
        "rotation": "轮到它",
    ]

    static let skipReason: [String: String] = [
        "budget": "这一轮太长，没带上",
        "cold_unrelated": "很久没用，也和这次无关",
        "terminal": "已经办完或过期",
    ]

    static let searchMatchReason: [String: String] = [
        "text": "正文匹配",
        "section": "分节匹配",
        "ref": "引用匹配",
        "scope": "在这个文件夹里",
        "state": "状态对上了",
        "pinned": "始终带上",
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

    /// 记忆文件还没写过。优先看 errorCode；旧网关只有「文件不存在。」这句。
    static func isAbsentMemoryFile(error: String?, code: String?) -> Bool {
        if code == "enoent" { return true }
        guard let error else { return false }
        return error == "文件不存在。" || error.hasPrefix("文件不存在：")
    }

    static func filterFolder(_ items: [WorkspaceMemoryItem], menu: String) -> [WorkspaceMemoryItem] {
        switch menu {
        case "pinned":
            return items.filter(\.pinned)
        case "confirm", "待核实":
            return items.filter { !$0.missingRefs.isEmpty }
        case "done":
            return items.filter { $0.effectiveState == "done" }
        case "all":
            return items
        default:
            return items.filter { $0.effectiveState != "done" && $0.effectiveState != "expired" }
        }
    }

    static func folderMenuLabel(_ menu: String) -> String {
        switch menu {
        case "pinned": return "始终带上"
        case "confirm": return "待你确认"
        case "done": return "已办完"
        case "all": return "全部"
        default: return "会用到的"
        }
    }

    static func listStatusWord(pinned: Bool, effectiveState: String, missingRefs: [String]) -> String? {
        if !missingRefs.isEmpty { return "待你确认" }
        if pinned { return "始终带上" }
        switch effectiveState {
        case "cold": return "很久没用"
        case "done": return "已办完"
        case "expired": return "已过期"
        default: return nil
        }
    }

    static func suggestionOutcome(_ kind: String) -> String {
        switch kind {
        case "missing_ref": return "引用已经处理"
        case "duplicate": return "合成一条"
        case "stale_hot": return "标成很久没用"
        case "stale_ongoing": return "标成已办完"
        case "budget_pressure": return "先放到一边"
        default: return "按建议处理"
        }
    }

    static func searchSource(kind: String, scopeLabel: String) -> String {
        if kind == "personal" { return "我" }
        if kind == "work_preference" { return "偏好" }
        return scopeLabel.isEmpty ? "文件夹" : scopeLabel
    }

    static func searchGroup(kind: String, scopeLabel: String) -> String {
        if kind == "personal" { return "关于我" }
        if kind == "work_preference" { return "工作偏好" }
        return scopeLabel.isEmpty ? "文件夹" : scopeLabel
    }

    static func currentFolder(scopes: [MemoryCenterScopeSummary], cwd: String, root: String) -> MemoryCenterScopeSummary? {
        let folders = scopes.filter { $0.id != "personal" && $0.id != "work_preference" }
        func norm(_ path: String) -> String {
            path.hasSuffix("/") ? String(path.dropLast()) : path
        }
        let here = norm(cwd)
        let base = norm(root)
        let rel: String
        if !base.isEmpty, here == base {
            rel = ""
        } else if !base.isEmpty, here.hasPrefix(base + "/") {
            rel = String(here.dropFirst(base.count + 1))
        } else {
            rel = here
        }
        if let exact = folders.first(where: { $0.id == rel || $0.id == here }) { return exact }
        return folders
            .filter { !$0.id.isEmpty && (rel == $0.id || rel.hasPrefix($0.id + "/")) }
            .max { $0.id.count < $1.id.count }
    }

    static func scopeHealthText(health: String?, error: String?, code: String?) -> String? {
        if isAbsentMemoryFile(error: error, code: code) { return nil }
        if code == "symlink" || error?.contains("符号链接") == true { return "路径含符号链接，不能读" }
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
