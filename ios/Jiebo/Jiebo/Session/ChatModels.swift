import Foundation

struct ToolCall: Identifiable, Hashable {
    var callId: String
    var name: String
    var args: JSONValue?
    var result: JSONValue?
    var status: String
    var parentCallId: String?
    var agent: String?
    var model: String?
    var id: String { callId }

    var kind: ToolKind { ToolKind.from(name: name, args: args) }

    var summary: String {
        let path = args?.string(in: "path", "file", "target", "file_path", "target_file")
            ?? result?.string(in: "path", "file") ?? ""
        if !path.isEmpty { return path }
        let query = args?.string(in: "pattern", "query", "globPattern", "glob", "glob_pattern", "command", "cmd") ?? ""
        if !query.isEmpty { return query }
        return name
    }
}

enum ToolKind: String {
    case read, edit, write, shell, search, other

    static func from(name: String, args: JSONValue?) -> ToolKind {
        let n = name.lowercased()
        if n.range(of: "todo|createplan", options: .regularExpression) != nil { return .other }
        if n.range(of: "shell|bash|terminal|command", options: .regularExpression) != nil { return .shell }
        if n.range(of: "grep|glob|search|find|ripgrep", options: .regularExpression) != nil { return .search }
        if n.range(of: "strreplace|replace|apply.?patch|editnotebook|edit", options: .regularExpression) != nil { return .edit }
        if n.range(of: "write|create|delete|unlink", options: .regularExpression) != nil { return .write }
        if n.range(of: "read|cat|open|getfile", options: .regularExpression) != nil { return .read }
        if let args, !args.string(in: "globPattern", "glob", "glob_pattern", "pattern", "query").isEmpty {
            return .search
        }
        return .other
    }

    /// 会改文件的工具（对齐网页 mutatingTool：edit/write 才自动开 diff）
    var isMutating: Bool { self == .edit || self == .write }

    var label: String {
        switch self {
        case .read: return "读取"
        case .edit: return "改写"
        case .write: return "写入"
        case .shell: return "命令"
        case .search: return "搜索"
        case .other: return "工具"
        }
    }
}

struct PendingTool: Hashable {
    var callId: String
    var name: String
    var args: JSONValue?
}

/// 正在上传的附件（完成后从列表移除，@path 写进草稿）
struct UploadItem: Identifiable, Hashable {
    var id: String
    var name: String
}

struct Turn: Identifiable, Hashable {
    var id: String
    var user: String
    var assistant: String
    var thinking: String
    var tools: [ToolCall]
    var task: String?
    var error: String?
    var running: Bool
    var queued: Bool
    var mode: AgentMode?
    var model: String?
    var status: String?
    var durationMs: Double?
    var pendingTool: PendingTool?
    /// 网页端写入、iOS 还不认识的字段原样保留，sync_state 回写时不丢
    var extra: [String: JSONValue] = [:]

    static let knownKeys: Set<String> = [
        "id", "user", "assistant", "thinking", "tools", "task", "error",
        "running", "queued", "mode", "model", "status", "durationMs",
    ]

    static func blank(user: String, model: String?, mode: AgentMode?, running: Bool) -> Turn {
        Turn(
            id: UUID().uuidString.lowercased(),
            user: user,
            assistant: "",
            thinking: "",
            tools: [],
            task: nil,
            error: nil,
            running: running,
            queued: !running,
            mode: mode,
            model: model,
            status: nil,
            durationMs: nil,
            pendingTool: nil
        )
    }

    func json() -> JSONValue {
        var object = extra
        object["id"] = .string(id)
        object["user"] = .string(user)
        object["assistant"] = .string(assistant)
        object["thinking"] = .string(thinking)
        object["tools"] = .array(tools.map { tool in
            var row: [String: JSONValue] = [
                "callId": .string(tool.callId),
                "name": .string(tool.name),
                "status": .string(tool.status == "running" ? "error" : tool.status),
            ]
            if let args = tool.args { row["args"] = args }
            if let result = tool.result { row["result"] = result }
            if let parentCallId = tool.parentCallId { row["parentCallId"] = .string(parentCallId) }
            if let agent = tool.agent { row["agent"] = .string(agent) }
            if let model = tool.model { row["model"] = .string(model) }
            return .object(row)
        })
        object["running"] = .bool(false)
        // queued 只在 true 时写（缺失即 false 语义），与 from() 对称，避免运行态在 diff 中被掩盖
        if queued { object["queued"] = .bool(true) }
        if let task { object["task"] = .string(task) }
        if let error { object["error"] = .string(error) }
        if let mode { object["mode"] = .string(mode.rawValue) }
        if let model { object["model"] = .string(model) }
        if let status { object["status"] = .string(status) }
        if let durationMs { object["durationMs"] = .number(durationMs) }
        return .object(object)
    }

    static func from(_ value: JSONValue) -> Turn? {
        guard let object = value.object else { return nil }
        let id = object["id"]?.string?.nilIfEmpty ?? UUID().uuidString.lowercased()
        let running = object["running"]?.bool ?? false
        let tools = object["tools"]?.array?.compactMap { item -> ToolCall? in
            guard let row = item.object else { return nil }
            var status = row["status"]?.string ?? "completed"
            if !running, status == "running" { status = "error" }
            return ToolCall(
                callId: row["callId"]?.string ?? UUID().uuidString.lowercased(),
                name: row["name"]?.string ?? "",
                args: row["args"],
                result: row["result"],
                status: status,
                parentCallId: row["parentCallId"]?.string,
                agent: row["agent"]?.string,
                model: row["model"]?.string
            )
        } ?? []
        return Turn(
            id: id,
            user: object["user"]?.string ?? "",
            assistant: object["assistant"]?.string ?? "",
            thinking: object["thinking"]?.string ?? "",
            tools: tools,
            task: object["task"]?.string,
            error: object["error"]?.string,
            running: running,
            queued: object["queued"]?.bool ?? false,
            mode: object["mode"]?.string.flatMap(AgentMode.init(rawValue:)),
            model: object["model"]?.string,
            status: object["status"]?.string,
            durationMs: object["durationMs"]?.number,
            pendingTool: nil,
            extra: object.filter { !Turn.knownKeys.contains($0.key) }
        )
    }

    func settled(status: String, durationMs: Double? = nil) -> Turn {
        let key = status.lowercased()
        var next = self
        next.running = false
        next.queued = false
        next.status = status
        if let durationMs { next.durationMs = durationMs }
        if key == "approval" { return next }
        next.pendingTool = nil
        let toolStatus = (key == "cancelled" || key == "canceled" || key == "error") ? "error" : "completed"
        next.tools = tools.map { tool in
            var row = tool
            if row.status == "running" { row.status = toolStatus }
            return row
        }
        return next
    }
}

struct ChatSession: Identifiable, Hashable {
    var id: String
    var title: String
    var turns: [Turn]
    var agentId: String?
    var draft: String
    var model: String?
    var mode: AgentMode
    var cwd: String?
    var unread: Bool
    var confirmWrites: Bool
    var policy: String
    /// 网页端写入、iOS 还不认识的字段原样保留，sync_state 回写时不丢
    var extra: [String: JSONValue] = [:]

    static let knownKeys: Set<String> = [
        "id", "title", "turns", "agentId", "draft", "model", "mode", "cwd", "unread", "confirmWrites", "policy",
    ]

    var isUntitled: Bool { title.isEmpty || title == "新对话" }
    var preview: String {
        turns.last(where: { !$0.user.isEmpty })?.user
            ?? turns.last(where: { !$0.assistant.isEmpty })?.assistant
            ?? ""
    }

    static func blank(id: String = UUID().uuidString.lowercased(), cwd: String? = nil, model: String? = nil, mode: AgentMode = .agent) -> ChatSession {
        ChatSession(
            id: id,
            title: "新对话",
            turns: [],
            agentId: nil,
            draft: "",
            model: model,
            mode: mode,
            cwd: cwd,
            unread: false,
            confirmWrites: false,
            policy: "baseline"
        )
    }

    var sessionModel: String? {
        if let model, !model.isEmpty { return model }
        return turns.reversed().compactMap(\.model).first
    }

    func json() -> JSONValue {
        var object = extra
        object["id"] = .string(id)
        object["title"] = .string(title)
        object["turns"] = .array(turns.map { $0.json() })
        object["draft"] = .string(draft)
        object["mode"] = .string(mode.rawValue)
        object["confirmWrites"] = .bool(confirmWrites)
        object["policy"] = .string(policy)
        if let agentId { object["agentId"] = .string(agentId) }
        if let model { object["model"] = .string(model) }
        if let cwd { object["cwd"] = .string(cwd) }
        return .object(object)
    }

    static func from(_ value: JSONValue) -> ChatSession? {
        guard let object = value.object, let id = object["id"]?.string, !id.isEmpty else { return nil }
        return ChatSession(
            id: id,
            title: object["title"]?.string?.nilIfEmpty ?? "新对话",
            turns: object["turns"]?.array?.compactMap(Turn.from) ?? [],
            agentId: object["agentId"]?.string,
            draft: object["draft"]?.string ?? "",
            model: object["model"]?.string,
            mode: object["mode"]?.string.flatMap(AgentMode.init(rawValue:)) ?? .agent,
            cwd: object["cwd"]?.string,
            unread: object["unread"]?.bool ?? false,
            confirmWrites: object["confirmWrites"]?.bool ?? false,
            policy: object["policy"]?.string == "plane" ? "plane" : "baseline",
            extra: object.filter { !ChatSession.knownKeys.contains($0.key) }
        )
    }
}

extension String {
    var nilIfEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

func friendlyError(_ text: String) -> String {
    if text.range(of: #"agent[- ].*not found"#, options: [.regularExpression, .caseInsensitive]) != nil {
        return "这条会话在服务器上已经不在了，重试会开新的。"
    }
    return text.replacingOccurrences(of: #"agent-[a-z0-9-]+"#, with: "Agent", options: [.regularExpression, .caseInsensitive])
}

func formatDuration(_ ms: Double?) -> String {
    guard let ms, ms.isFinite, ms >= 0 else { return "" }
    if ms < 1000 { return "\(Int(ms.rounded()))ms" }
    let seconds = Int((ms / 1000).rounded())
    if seconds < 60 { return "\(seconds)s" }
    return "\(seconds / 60)m \(seconds % 60)s"
}

func workspaceName(_ path: String) -> String {
    let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    return trimmed.split(separator: "/").last.map(String.init) ?? path
}
