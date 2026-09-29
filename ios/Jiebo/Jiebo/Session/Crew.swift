import Foundation

/// 子代理（crew）徽章：对齐 web/lib/crew.ts 的判定与文案
enum Crew {
    static let labels: [String: String] = [
        "explore": "摸仓库",
        "builder": "改代码",
        "reviewer": "交叉审",
    ]

    /// review-2 / reviewer-3 与 reviewer 同属交叉审，绑的是另一个模型。
    static func canonicalRole(_ value: String?) -> String? {
        guard let value else { return nil }
        let n = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if labels[n] != nil { return n }
        if n == "review" { return "reviewer" }
        if n.range(of: #"^review-\d+$"#, options: .regularExpression) != nil { return "reviewer" }
        if n.range(of: #"^reviewer-\d+$"#, options: .regularExpression) != nil { return "reviewer" }
        return nil
    }

    static func isRole(_ value: String?) -> Bool {
        canonicalRole(value) != nil
    }

    /// 从工具名或参数里识别 crew 角色（task/agent 工具的 subagent_type 等字段）
    static func roleOf(name: String, args: JSONValue?) -> String? {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if n != "task" && n != "agent", let role = canonicalRole(n) { return role }
        guard let object = args?.object else { return nil }
        for key in ["subagent_type", "subagentType", "subagent", "agent", "name", "type", "role"] {
            if let role = canonicalRole(object[key]?.string) { return role }
        }
        return nil
    }

    /// 徽章文案：agent 字段优先（对齐网页 crewLabel），归一化后查表，未命中回落工具名/参数
    static func label(name: String, args: JSONValue?, agent: String?) -> String {
        if let role = canonicalRole(agent), let text = labels[role] { return text }
        if let role = roleOf(name: name, args: args) { return labels[role] ?? "" }
        return ""
    }
}
