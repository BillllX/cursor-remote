import Foundation

/// 子代理（crew）徽章：对齐 web/lib/crew.ts 的判定与文案
enum Crew {
    static let labels: [String: String] = [
        "explore": "摸仓库",
        "builder": "改代码",
        "reviewer": "交叉审",
    ]

    static func isRole(_ value: String?) -> Bool {
        guard let value else { return false }
        return labels[value.trimmingCharacters(in: .whitespaces).lowercased()] != nil
    }

    /// 从工具名或参数里识别 crew 角色（task/agent 工具的 subagent_type 等字段）
    static func roleOf(name: String, args: JSONValue?) -> String? {
        let n = name.trimmingCharacters(in: .whitespaces).lowercased()
        if isRole(n) { return n }
        guard let object = args?.object else { return nil }
        for key in ["subagent_type", "subagentType", "subagent", "agent", "name", "type", "role"] {
            if let value = object[key]?.string?.trimmingCharacters(in: .whitespaces).lowercased(), isRole(value) {
                return value
            }
        }
        return nil
    }

    /// 徽章文案：agent 字段优先（对齐网页 crewLabel），归一化后查表，未命中回落工具名/参数
    static func label(name: String, args: JSONValue?, agent: String?) -> String {
        if let agent {
            let key = agent.trimmingCharacters(in: .whitespaces).lowercased()
            if let label = labels[key] { return label }
        }
        if let role = roleOf(name: name, args: args) { return labels[role] ?? "" }
        return ""
    }
}
