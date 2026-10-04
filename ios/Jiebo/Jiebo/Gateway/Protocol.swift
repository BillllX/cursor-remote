import Foundation

// Mirrors shared/protocol.ts. Keep field names and `type` tags in sync with the TypeScript source.

enum AgentMode: String, Sendable, Hashable, CaseIterable {
    case agent
    case plan
    case ask

    var label: String {
        switch self {
        case .agent: return "动手"
        case .plan: return "方案"
        case .ask: return "只问"
        }
    }
}

struct WorkspaceItem: Sendable, Hashable, Identifiable {
    var path: String
    var name: String
    var user: Bool = false
    var id: String { path }
}

struct PromptImage: Sendable, Hashable {
    var data: String
    var mimeType: String
}

struct CheckpointInfo: Sendable, Hashable, Identifiable {
    var id: String
    var label: String
    var createdAt: Double
}

/// P11：第三方模型的会话历史条目（prompt.history；客户端是内容权威源，网关无状态）
struct HistoryItem: Sendable, Hashable {
    var role: String // "user" | "assistant"
    var text: String
}

/// /media 下载票据（file_content 带过来，签名过期由网关校验）
struct MediaTicket: Sendable, Hashable {
    var exp: Double
    var sig: String
}

/// 一轮里新增或改过的文件（turn.files / turn_files）。sha 缺省时只能打开当前版本；
/// diffSha 只有文本类才有，读它要配 diff=true
struct TurnFile: Sendable, Hashable, Identifiable {
    var path: String
    var kind: PreviewKind
    /// "added" | "modified"
    var op: String
    var size: Double?
    var sha: String?
    var diffSha: String?
    var added: Int?
    var removed: Int?
    var id: String { path }

    static func from(_ json: JSONValue) -> TurnFile? {
        guard let row = json.object, let path = row["path"]?.string?.nilIfEmpty else { return nil }
        return TurnFile(
            path: path,
            kind: row["kind"]?.string.flatMap(PreviewKind.init(rawValue:)) ?? previewKind(of: path),
            op: row["op"]?.string == "added" ? "added" : "modified",
            size: row["size"]?.number,
            sha: row["sha"]?.string?.nilIfEmpty,
            diffSha: row["diffSha"]?.string?.nilIfEmpty,
            added: row["added"]?.int,
            removed: row["removed"]?.int
        )
    }

    func json() -> JSONValue {
        var object: [String: JSONValue] = [
            "path": .string(path),
            "kind": .string(kind.rawValue),
            "op": .string(op),
        ]
        if let size { object["size"] = .number(size) }
        if let sha { object["sha"] = .string(sha) }
        if let diffSha { object["diffSha"] = .string(diffSha) }
        if let added { object["added"] = .number(Double(added)) }
        if let removed { object["removed"] = .number(Double(removed)) }
        return .object(object)
    }
}

/// 当前 API Key 的官方账单，口径与 Cursor CLI `/usage` 相同。金额单位是美分。
struct CursorOnDemand: Sendable, Hashable {
    var kind: String
    var usedCents: Double
    var limitCents: Double?
}

struct CursorModelSpend: Sendable, Hashable, Identifiable {
    var id: String { name }
    var name: String
    var spendCents: Double
}

struct CursorBill: Sendable, Hashable {
    var ok: Bool
    var error: String?
    var plan: String?
    var cycleStart: Double
    var cycleEnd: Double
    var includedPercent: Double?
    var autoPercent: Double?
    var apiPercent: Double?
    var spendCents: Double?
    var inputTokens: Double?
    var outputTokens: Double?
    var onDemand: CursorOnDemand?
    var models: [CursorModelSpend]
    var fetchedAt: Double

    static func from(_ json: JSONValue) -> CursorBill? {
        guard let row = json.object else { return nil }
        let demand = row["onDemand"]?.object.flatMap { item -> CursorOnDemand? in
            guard let kind = item["kind"]?.string else { return nil }
            return CursorOnDemand(
                kind: kind,
                usedCents: item["usedCents"]?.number ?? 0,
                limitCents: item["limitCents"]?.number
            )
        }
        let models = row["models"]?.array?.compactMap { item -> CursorModelSpend? in
            guard let name = item["name"]?.string, !name.isEmpty else { return nil }
            return CursorModelSpend(name: name, spendCents: item["spendCents"]?.number ?? 0)
        } ?? []
        return CursorBill(
            ok: row["ok"]?.bool ?? false,
            error: row["error"]?.string,
            plan: row["plan"]?.string,
            cycleStart: row["cycleStart"]?.number ?? 0,
            cycleEnd: row["cycleEnd"]?.number ?? 0,
            includedPercent: row["includedPercent"]?.number,
            autoPercent: row["autoPercent"]?.number,
            apiPercent: row["apiPercent"]?.number,
            spendCents: row["spendCents"]?.number,
            inputTokens: row["inputTokens"]?.number,
            outputTokens: row["outputTokens"]?.number,
            onDemand: demand,
            models: models,
            fetchedAt: row["fetchedAt"]?.number ?? 0
        )
    }
}

/// P9：单租户使用统计（admin_stats 应答的行）。estTokens 是网关按字符估算（≈4 字符/token），
/// 用来看各账号的相对消耗。官方账单在 admin_stats.cursor。
struct AdminTenantStats: Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var admin: Bool
    var online: Int
    var chats: Int
    var turns: Int
    var runs: Int
    var toolCalls: Int
    var runMs: Double
    var inChars: Int
    var outChars: Int
    var estTokens: Int
    var firstSeenAt: Double
    var lastActiveAt: Double

    static func from(_ json: JSONValue) -> AdminTenantStats? {
        guard let row = json.object, let id = row["id"]?.string else { return nil }
        return AdminTenantStats(
            id: id,
            name: row["name"]?.string ?? id,
            admin: row["admin"]?.bool ?? false,
            online: row["online"]?.int ?? 0,
            chats: row["chats"]?.int ?? 0,
            turns: row["turns"]?.int ?? 0,
            runs: row["runs"]?.int ?? 0,
            toolCalls: row["toolCalls"]?.int ?? 0,
            runMs: row["runMs"]?.number ?? 0,
            inChars: row["inChars"]?.int ?? 0,
            outChars: row["outChars"]?.int ?? 0,
            estTokens: row["estTokens"]?.int ?? 0,
            firstSeenAt: row["firstSeenAt"]?.number ?? 0,
            lastActiveAt: row["lastActiveAt"]?.number ?? 0
        )
    }
}

/// hello 携带的客户端标识（P2 协议护栏：网关可据此区分客户端与版本）
struct ClientInfo: Sendable, Equatable {
    var name: String
    var version: String
    /// 单条 WS 消息接收上限：URLSessionWebSocketTask 超过约 1MiB 会以「信息太长」断连，
    /// 声明后网关对超限的 stored_state 改发 stored_state_deferred，走 HTTP /state 拉取
    var maxMessageBytes: Int?
    /// 能力集：sync_chat（增量上传）+ stored_digest（分叉时目录对账）+ slim_state（P8 懒加载：
    /// stored_state/stored_chat 只给元数据，内容走 load_chat 分页；sync_chat 可不写 turns 键）
    /// + slim_chats（load_chats 也只回元数据壳）
    var caps: [String]

    static var current: ClientInfo {
        var limit = 900_000
        #if DEBUG
        // 调试开关：defaults write ai.jiebo.ipad jiebo.maxMessageBytes -int 1 可强制走 deferred 路径
        if let override = UserDefaults.standard.object(forKey: "jiebo.maxMessageBytes") as? Int {
            limit = override
        }
        #endif
        return ClientInfo(
            name: "jiebo-ios",
            version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
            maxMessageBytes: limit,
            caps: ["sync_chat", "stored_digest", "slim_state", "slim_chats"]
        )
    }

    var json: JSONValue {
        var object: [String: JSONValue] = ["name": .string(name), "version": .string(version)]
        if let maxMessageBytes { object["maxMessageBytes"] = .number(Double(maxMessageBytes)) }
        object["caps"] = .array(caps.map { .string($0) })
        return .object(object)
    }
}

enum ClientMessage {
    case hello(token: String?)
    case setWorkspace(cwd: String, chatId: String?, create: Bool?)
    case listWorkspaces
    case createWorkspace(name: String)
    case prompt(
        text: String,
        model: String?,
        mode: AgentMode?,
        chatId: String,
        files: [String]?,
        images: [PromptImage]?,
        confirmWrites: Bool?,
        autoApprove: Bool?,
        fresh: Bool?,
        nameChat: Bool?,
        policy: String?,
        history: [HistoryItem]?,
        turnId: String?
    )
    case cancel(chatId: String)
    case dropQueued(chatId: String, text: String?)
    case setModel(model: String, chatId: String?)
    case newSession(chatId: String, cwd: String?)
    case deleteSession(chatId: String)
    case resumeSession(chatId: String, agentId: String)
    case syncState(chats: JSONValue, rev: Int?)
    case approvalReply(chatId: String, callId: String, allow: Bool)
    case setPolicy(policy: String, chatId: String?)
    case uploadFile(chatId: String, name: String, data: String, mimeType: String?, id: String?)
    case listFiles(query: String?, chatId: String?, mention: Bool?)
    case searchText(query: String, chatId: String?)
    case revertFile(chatId: String, path: String)
    case listCheckpoints(chatId: String)
    case restore(chatId: String, checkpointId: String)
    /// P5：读工作区文件内容（diff=true 拿 unified diff）；应答是 file_content。
    /// sha 读某一轮的快照（diff=true 时它指 diffSha）；reqId 原样回显。两者只发给声明了 read_sha / read_req_id 的网关
    case readFile(path: String, chatId: String?, diff: Bool, sha: String? = nil, reqId: String? = nil)
    case writeFile(path: String, content: String, chatId: String?)
    case undo(chatId: String)
    case ping
    /// P4b：单会话增量上传（只带变化的那个会话）
    case syncChat(chat: JSONValue, rev: Int)
    /// 删掉 turnId 这一轮及之后的回合（编辑、重试）；回执是 sync_ack(truncated:)
    case truncateTurns(chatId: String, turnId: String, rev: Int)
    /// 只改工具的保留/还原标记，不回传工具正文
    case toolReview(chatId: String, turnId: String, reviews: [[String: JSONValue]])
    /// P4c：stored_digest 后按需拉取单个会话全量
    case loadChats(ids: [String])
    /// P8 slim：会话内容分页。from 省略=最后一页，否则拉 turns[..<from] 的上一页。
    /// nonce 为分页代际标记（网关原样回显）：降级/重启分页后旧链迟到页据此丢弃（Kimi R2 M1）
    case loadChat(chatId: String, from: Int?, nonce: Int?)
    /// 重拉一份 stored_state（slim 客户端只有元数据和 preview）。digest 对账用它代替 load_chats，不下载整条正文
    case loadState
    /// P9：管理员查询全租户使用统计（非管理员会被网关拒绝）
    case adminStats
    /// 产品 Loop（docs/IDE.md L1）：开始 / 停止。调度在 L2，这里只发消息
    case loopStart(chatId: String, goal: String, intervalSec: Int, maxTicks: Int?, model: String?, mode: AgentMode?)
    case loopStop(chatId: String)
    /// 个人助理：拉今日页状态。memory=true 时一并下发记忆全量，之后的推送也带记忆
    case assistantGet(memory: Bool)
    /// 个人助理操作（inbox_read / todo_add / memory_* / approval_answer …），args 由网关逐项校验
    case assistantOp(op: String, args: [String: JSONValue], reqId: String?)

    func json() -> JSONValue {
        switch self {
        case .hello(let token):
            var object: [String: JSONValue] = ["type": .string("hello")]
            if let token, !token.isEmpty { object["token"] = .string(token) }
            object["client"] = ClientInfo.current.json
            return .object(object)
        case .setWorkspace(let cwd, let chatId, let create):
            var object: [String: JSONValue] = ["type": .string("set_workspace"), "cwd": .string(cwd)]
            if let chatId { object["chatId"] = .string(chatId) }
            if let create { object["create"] = .bool(create) }
            return .object(object)
        case .listWorkspaces:
            return .object(["type": .string("list_workspaces")])
        case .createWorkspace(let name):
            return .object(["type": .string("create_workspace"), "name": .string(name)])
        case .prompt(let text, let model, let mode, let chatId, let files, let images, let confirmWrites, let autoApprove, let fresh, let nameChat, let policy, let history, let turnId):
            var object: [String: JSONValue] = [
                "type": .string("prompt"),
                "text": .string(text),
                "chatId": .string(chatId),
            ]
            if let model { object["model"] = .string(model) }
            if let mode { object["mode"] = .string(mode.rawValue) }
            if let files, !files.isEmpty { object["files"] = .array(files.map(JSONValue.string)) }
            if let images, !images.isEmpty {
                object["images"] = .array(images.map { .object(["data": .string($0.data), "mimeType": .string($0.mimeType)]) })
            }
            if let confirmWrites { object["confirmWrites"] = .bool(confirmWrites) }
            if let autoApprove { object["autoApprove"] = .bool(autoApprove) }
            if let fresh { object["fresh"] = .bool(fresh) }
            if let nameChat { object["nameChat"] = .bool(nameChat) }
            if let policy { object["policy"] = .string(policy) }
            if let history, !history.isEmpty {
                object["history"] = .array(history.map { .object(["role": .string($0.role), "text": .string($0.text)]) })
            }
            if let turnId, !turnId.isEmpty { object["turnId"] = .string(turnId) }
            return .object(object)
        case .cancel(let chatId):
            return .object(["type": .string("cancel"), "chatId": .string(chatId)])
        case .dropQueued(let chatId, let text):
            var object: [String: JSONValue] = ["type": .string("drop_queued"), "chatId": .string(chatId)]
            if let text { object["text"] = .string(text) }
            return .object(object)
        case .setModel(let model, let chatId):
            var object: [String: JSONValue] = ["type": .string("set_model"), "model": .string(model)]
            if let chatId { object["chatId"] = .string(chatId) }
            return .object(object)
        case .newSession(let chatId, let cwd):
            var object: [String: JSONValue] = ["type": .string("new_session"), "chatId": .string(chatId)]
            if let cwd { object["cwd"] = .string(cwd) }
            return .object(object)
        case .deleteSession(let chatId):
            return .object(["type": .string("delete_session"), "chatId": .string(chatId)])
        case .resumeSession(let chatId, let agentId):
            return .object(["type": .string("resume_session"), "chatId": .string(chatId), "agentId": .string(agentId)])
        case .syncState(let chats, let rev):
            var object: [String: JSONValue] = ["type": .string("sync_state"), "chats": chats]
            if let rev { object["rev"] = .number(Double(rev)) }
            return .object(object)
        case .approvalReply(let chatId, let callId, let allow):
            return .object([
                "type": .string("approval_reply"),
                "chatId": .string(chatId),
                "callId": .string(callId),
                "allow": .bool(allow),
            ])
        case .setPolicy(let policy, let chatId):
            var object: [String: JSONValue] = ["type": .string("set_policy"), "policy": .string(policy)]
            if let chatId { object["chatId"] = .string(chatId) }
            return .object(object)
        case .uploadFile(let chatId, let name, let data, let mimeType, let id):
            var object: [String: JSONValue] = [
                "type": .string("upload_file"),
                "chatId": .string(chatId),
                "name": .string(name),
                "data": .string(data),
            ]
            if let mimeType { object["mimeType"] = .string(mimeType) }
            if let id { object["id"] = .string(id) }
            return .object(object)
        case .listFiles(let query, let chatId, let mention):
            var object: [String: JSONValue] = ["type": .string("list_files")]
            if let query { object["query"] = .string(query) }
            if let chatId { object["chatId"] = .string(chatId) }
            if let mention { object["mention"] = .bool(mention) }
            return .object(object)
        case .searchText(let query, let chatId):
            var object: [String: JSONValue] = ["type": .string("search_text"), "query": .string(query)]
            if let chatId { object["chatId"] = .string(chatId) }
            return .object(object)
        case .revertFile(let chatId, let path):
            return .object([
                "type": .string("revert_file"),
                "chatId": .string(chatId),
                "path": .string(path),
            ])
        case .listCheckpoints(let chatId):
            return .object(["type": .string("list_checkpoints"), "chatId": .string(chatId)])
        case .restore(let chatId, let checkpointId):
            return .object([
                "type": .string("restore"),
                "chatId": .string(chatId),
                "checkpointId": .string(checkpointId),
            ])
        case .readFile(let path, let chatId, let diff, let sha, let reqId):
            var object: [String: JSONValue] = ["type": .string("read_file"), "path": .string(path)]
            if let chatId { object["chatId"] = .string(chatId) }
            if diff { object["diff"] = .bool(true) }
            if let sha, !sha.isEmpty { object["sha"] = .string(sha) }
            if let reqId, !reqId.isEmpty { object["reqId"] = .string(reqId) }
            return .object(object)
        case .writeFile(let path, let content, let chatId):
            var object: [String: JSONValue] = [
                "type": .string("write_file"),
                "path": .string(path),
                "content": .string(content),
            ]
            if let chatId { object["chatId"] = .string(chatId) }
            return .object(object)
        case .undo(let chatId):
            return .object(["type": .string("undo"), "chatId": .string(chatId)])
        case .ping:
            return .object(["type": .string("ping")])
        case .syncChat(let chat, let rev):
            return .object(["type": .string("sync_chat"), "chat": chat, "rev": .number(Double(rev))])
        case .truncateTurns(let chatId, let turnId, let rev):
            return .object([
                "type": .string("truncate_turns"),
                "chatId": .string(chatId),
                "turnId": .string(turnId),
                "rev": .number(Double(rev)),
            ])
        case .toolReview(let chatId, let turnId, let reviews):
            return .object([
                "type": .string("tool_review"),
                "chatId": .string(chatId),
                "turnId": .string(turnId),
                "reviews": .array(reviews.map { .object($0) }),
            ])
        case .loadChats(let ids):
            return .object(["type": .string("load_chats"), "ids": .array(ids.map { .string($0) })])
        case .loadChat(let chatId, let from, let nonce):
            var obj: [String: JSONValue] = ["type": .string("load_chat"), "chatId": .string(chatId)]
            if let from { obj["from"] = .number(Double(from)) }
            if let nonce { obj["nonce"] = .number(Double(nonce)) }
            return .object(obj)
        case .loadState:
            return .object(["type": .string("load_state")])
        case .adminStats:
            return .object(["type": .string("admin_stats")])
        case .loopStart(let chatId, let goal, let intervalSec, let maxTicks, let model, let mode):
            var object: [String: JSONValue] = [
                "type": .string("loop_start"),
                "chatId": .string(chatId),
                "goal": .string(goal),
                "intervalSec": .number(Double(intervalSec)),
            ]
            if let maxTicks { object["maxTicks"] = .number(Double(maxTicks)) }
            if let model { object["model"] = .string(model) }
            if let mode { object["mode"] = .string(mode.rawValue) }
            return .object(object)
        case .loopStop(let chatId):
            return .object(["type": .string("loop_stop"), "chatId": .string(chatId)])
        case .assistantGet(let memory):
            var object: [String: JSONValue] = ["type": .string("assistant_get")]
            if memory { object["memory"] = .bool(true) }
            return .object(object)
        case .assistantOp(let op, let args, let reqId):
            var object: [String: JSONValue] = ["type": .string("assistant_op"), "op": .string(op)]
            if !args.isEmpty { object["args"] = .object(args) }
            if let reqId { object["reqId"] = .string(reqId) }
            return .object(object)
        }
    }
}

struct LoopSnapshot: Sendable, Hashable, Identifiable {
    var chatId: String
    var status: String
    var goal: String
    var intervalSec: Int
    var tick: Int
    var maxTicks: Int?
    var lastSummary: String?
    var nextAt: Double?
    var id: String { chatId }

    static func from(_ row: [String: JSONValue]?) -> LoopSnapshot? {
        guard let row, let chatId = row["chatId"]?.string, !chatId.isEmpty else { return nil }
        return LoopSnapshot(
            chatId: chatId,
            status: row["status"]?.string ?? "",
            goal: row["goal"]?.string ?? "",
            intervalSec: row["intervalSec"]?.int ?? 0,
            tick: row["tick"]?.int ?? 0,
            maxTicks: row["maxTicks"]?.int,
            lastSummary: row["lastSummary"]?.string,
            nextAt: row["nextAt"]?.number
        )
    }
}

func gitLetters(_ value: JSONValue?) -> [String: String] {
    guard let raw = value?.object else { return [:] }
    var status: [String: String] = [:]
    for (path, letter) in raw {
        if let letter = letter.string, !letter.isEmpty { status[path] = letter }
    }
    return status
}

struct SearchHit: Sendable, Hashable, Identifiable {
    var path: String
    var line: Int
    var text: String
    var id: String { "\(path):\(line):\(text)" }

    static func from(_ value: JSONValue) -> SearchHit? {
        guard let object = value.object, let path = object["path"]?.string, !path.isEmpty else { return nil }
        return SearchHit(
            path: path,
            line: object["line"]?.int ?? 0,
            text: object["text"]?.string ?? ""
        )
    }
}

enum AssistantDefaults {
    static let name = "小驳"
}

// MARK: 个人助理（assistant_state 及增量）。kind/status 等枚举一律存 String：网关加新值不能让整条消息解不出来

struct AssistantInboxItem: Sendable, Hashable, Identifiable {
    var id: String
    var kind: String
    var title: String
    var body: String
    var createdAt: Double
    var read: Bool
    var chatId: String?
    var scheduleId: String?
    var delegationId: String?

    static func from(_ json: JSONValue) -> AssistantInboxItem? {
        guard let row = json.object, let id = row["id"]?.string, !id.isEmpty else { return nil }
        return AssistantInboxItem(
            id: id,
            kind: row["kind"]?.string ?? "info",
            title: row["title"]?.string ?? "",
            body: row["body"]?.string ?? "",
            createdAt: row["createdAt"]?.number ?? 0,
            read: row["read"]?.bool ?? false,
            chatId: row["chatId"]?.string?.nilIfEmpty,
            scheduleId: row["scheduleId"]?.string?.nilIfEmpty,
            delegationId: row["delegationId"]?.string?.nilIfEmpty
        )
    }
}

struct AssistantMemoryEntry: Sendable, Hashable, Identifiable {
    var id: String
    var rev: Int
    var topic: String
    var kind: String
    var text: String
    /// "user_said" | "inferred"
    var basis: String
    var confidence: Double
    var sourceChatId: String?
    var createdAt: String
    var updatedAt: String
    /// 网关用 null 表示「有效」，字段缺失也按有效算
    var invalidAt: String?
    var invalidReason: String?

    var isValid: Bool { invalidAt?.isEmpty ?? true }
    var inferred: Bool { basis == "inferred" }

    static func from(_ json: JSONValue) -> AssistantMemoryEntry? {
        guard let row = json.object, let id = row["id"]?.string, !id.isEmpty else { return nil }
        return AssistantMemoryEntry(
            id: id,
            rev: row["rev"]?.int ?? 0,
            topic: row["topic"]?.string ?? "",
            kind: row["kind"]?.string ?? "",
            text: row["text"]?.string ?? "",
            basis: row["basis"]?.string ?? "user_said",
            confidence: row["confidence"]?.number ?? 0,
            sourceChatId: row["source"]?.object?["chatId"]?.string?.nilIfEmpty,
            createdAt: row["createdAt"]?.string ?? "",
            updatedAt: row["updatedAt"]?.string ?? "",
            invalidAt: row["invalidAt"]?.string?.nilIfEmpty,
            invalidReason: row["invalidReason"]?.string?.nilIfEmpty
        )
    }
}

struct AssistantDelegation: Sendable, Hashable, Identifiable {
    var id: String
    var parentChatId: String?
    var childChatId: String
    var workspace: String
    var title: String
    /// "foreground" | "background"
    var mode: String
    /// "running" | "awaiting" | "done" | "failed"
    var status: String
    var createdAt: Double
    var endedAt: Double?
    var result: String?

    static func from(_ json: JSONValue) -> AssistantDelegation? {
        guard let row = json.object, let id = row["id"]?.string, !id.isEmpty else { return nil }
        return AssistantDelegation(
            id: id,
            parentChatId: row["parentChatId"]?.string?.nilIfEmpty,
            childChatId: row["childChatId"]?.string ?? "",
            workspace: row["workspace"]?.string ?? "",
            title: row["title"]?.string ?? "",
            mode: row["mode"]?.string ?? "background",
            status: row["status"]?.string ?? "running",
            createdAt: row["createdAt"]?.number ?? 0,
            endedAt: row["endedAt"]?.number,
            result: row["result"]?.string?.nilIfEmpty
        )
    }
}

struct AssistantApproval: Sendable, Hashable, Identifiable {
    var id: String
    var chatId: String
    var callId: String
    var tool: String
    /// 参数摘要，不含文件全文
    var summary: String
    var delegationId: String?
    var parentChatId: String?
    var createdAt: Double
    var expiresAt: Double

    static func from(_ json: JSONValue) -> AssistantApproval? {
        guard let row = json.object,
              let chatId = row["chatId"]?.string, !chatId.isEmpty,
              let callId = row["callId"]?.string, !callId.isEmpty
        else { return nil }
        return AssistantApproval(
            id: row["id"]?.string?.nilIfEmpty ?? "\(chatId):\(callId)",
            chatId: chatId,
            callId: callId,
            tool: row["tool"]?.string ?? "",
            summary: row["summary"]?.string ?? "",
            delegationId: row["delegationId"]?.string?.nilIfEmpty,
            parentChatId: row["parentChatId"]?.string?.nilIfEmpty,
            createdAt: row["createdAt"]?.number ?? 0,
            expiresAt: row["expiresAt"]?.number ?? 0
        )
    }
}

struct AssistantTodo: Sendable, Hashable, Identifiable {
    var id: String
    var text: String
    var due: String?
    var done: Bool
    var doneAt: Double?
    var createdAt: Double

    static func from(_ json: JSONValue) -> AssistantTodo? {
        guard let row = json.object, let id = row["id"]?.string, !id.isEmpty else { return nil }
        return AssistantTodo(
            id: id,
            text: row["text"]?.string ?? "",
            due: row["due"]?.string?.nilIfEmpty,
            done: row["done"]?.bool ?? false,
            doneAt: row["doneAt"]?.number,
            createdAt: row["createdAt"]?.number ?? 0
        )
    }
}

struct AssistantSchedule: Sendable, Hashable, Identifiable {
    var id: String
    var title: String
    /// "prompt" | "brief" | "remind"
    var kind: String
    var cron: String
    var tz: String
    var prompt: String
    var enabled: Bool
    var nextAt: Double?
    var lastStatus: String?
    var failCount: Int
    var pausedReason: String?

    static func from(_ json: JSONValue) -> AssistantSchedule? {
        guard let row = json.object, let id = row["id"]?.string, !id.isEmpty else { return nil }
        return AssistantSchedule(
            id: id,
            title: row["title"]?.string ?? "",
            kind: row["kind"]?.string ?? "prompt",
            cron: row["cron"]?.string ?? "",
            tz: row["tz"]?.string ?? "",
            prompt: row["prompt"]?.string ?? "",
            enabled: row["enabled"]?.bool ?? false,
            nextAt: row["nextAt"]?.number,
            lastStatus: row["lastStatus"]?.string?.nilIfEmpty,
            failCount: row["failCount"]?.int ?? 0,
            pausedReason: row["pausedReason"]?.string?.nilIfEmpty
        )
    }
}

struct AssistantRun: Sendable, Hashable, Identifiable {
    var runId: String
    var origin: String
    var label: String
    var status: String
    var startedAt: Double
    var endedAt: Double?
    var summary: String?
    var error: String?
    var id: String { runId }

    static func from(_ json: JSONValue) -> AssistantRun? {
        guard let row = json.object, let runId = row["runId"]?.string, !runId.isEmpty else { return nil }
        return AssistantRun(
            runId: runId,
            origin: row["origin"]?.string ?? "",
            label: row["label"]?.string ?? "",
            status: row["status"]?.string ?? "",
            startedAt: row["startedAt"]?.number ?? 0,
            endedAt: row["endedAt"]?.number,
            summary: row["summary"]?.string?.nilIfEmpty,
            error: row["error"]?.string?.nilIfEmpty
        )
    }
}

struct AssistantBackground: Sendable, Hashable {
    var model: String
    var ok: Bool
    var reason: String?
}

struct AssistantBrief: Sendable, Hashable {
    var day: String
    var text: String
}

struct AssistantMemory: Sendable, Hashable {
    /// 网关 CORE_FIELDS 的顺序；fields 里多出来的键排在后面
    static let coreFieldKeys = ["关于我", "偏好", "近况", "人物", "工作偏好"]

    var rev: Int
    var coreRev: Int
    var coreFields: [String: String]
    var entries: [AssistantMemoryEntry]
    var paused: Bool
    var coreTokens: Int
    var coreBudget: Int

    var orderedCoreKeys: [String] {
        Self.coreFieldKeys + coreFields.keys.filter { !Self.coreFieldKeys.contains($0) }.sorted()
    }

    static func from(_ json: JSONValue) -> AssistantMemory? {
        guard let row = json.object else { return nil }
        let core = row["core"]?.object
        var fields: [String: String] = [:]
        for (key, value) in core?["fields"]?.object ?? [:] {
            if let text = value.string { fields[key] = text }
        }
        return AssistantMemory(
            rev: row["rev"]?.int ?? 0,
            coreRev: core?["rev"]?.int ?? 0,
            coreFields: fields,
            entries: row["entries"]?.array?.compactMap(AssistantMemoryEntry.from) ?? [],
            paused: row["settings"]?.object?["paused"]?.bool ?? false,
            coreTokens: row["coreTokens"]?.int ?? 0,
            coreBudget: row["coreBudget"]?.int ?? 0
        )
    }
}

struct AssistantState: Sendable, Hashable {
    var name: String
    var background: AssistantBackground
    var pushKey: String?
    /// 网关配置了 APNs 且能发（iPhone 通知是否可用）；老网关不带，默认 false
    var pushApns: Bool = false
    var inbox: [AssistantInboxItem]
    var todos: [AssistantTodo]
    var schedules: [AssistantSchedule]
    var delegations: [AssistantDelegation]
    var approvals: [AssistantApproval]
    var runs: [AssistantRun]
    var brief: AssistantBrief?
    /// 只有发过 assistant_get(memory: true) 的连接才带
    var memory: AssistantMemory?

    var unreadInbox: Int { inbox.filter { !$0.read }.count }

    static func from(_ json: JSONValue) -> AssistantState? {
        guard let row = json.object else { return nil }
        let background = row["background"]?.object
        let brief = row["brief"]?.object.flatMap { item -> AssistantBrief? in
            guard let text = item["text"]?.string else { return nil }
            return AssistantBrief(day: item["day"]?.string ?? "", text: text)
        }
        return AssistantState(
            name: row["name"]?.string?.nilIfEmpty ?? AssistantDefaults.name,
            background: AssistantBackground(
                model: background?["model"]?.string ?? "",
                ok: background?["ok"]?.bool ?? false,
                reason: background?["reason"]?.string?.nilIfEmpty
            ),
            pushKey: row["pushKey"]?.string?.nilIfEmpty,
            pushApns: row["pushApns"]?.bool ?? false,
            inbox: row["inbox"]?.array?.compactMap(AssistantInboxItem.from) ?? [],
            todos: row["todos"]?.array?.compactMap(AssistantTodo.from) ?? [],
            schedules: row["schedules"]?.array?.compactMap(AssistantSchedule.from) ?? [],
            delegations: row["delegations"]?.array?.compactMap(AssistantDelegation.from) ?? [],
            approvals: row["approvals"]?.array?.compactMap(AssistantApproval.from) ?? [],
            runs: row["runs"]?.array?.compactMap(AssistantRun.from) ?? [],
            brief: brief,
            memory: row["memory"].flatMap(AssistantMemory.from)
        )
    }
}

enum ServerMessage {
    case ready(
        cwd: String,
        hasApiKey: Bool,
        model: String,
        models: [String],
        agentId: String?,
        runningChatIds: [String],
        queuedChatIds: [String],
        workspaceRoot: String?,
        tenantId: String?,
        tenantName: String?,
        admin: Bool,
        loops: [LoopSnapshot],
        assistantName: String?,
        /// 每个租户唯一的助理会话。旧网关不带
        assistantChatId: String?,
        /// 网关能力（turn_files / read_sha / read_req_id）。旧网关不带，为空数组
        features: [String]
    )
    case workspaces(root: String, items: [WorkspaceItem])
    case workspaceCreated(path: String, name: String)
    case session(chatId: String, agentId: String, cwd: String)
    case runMeta(chatId: String, model: String, mode: AgentMode?)
    case textDelta(chatId: String, text: String)
    case thinkingDelta(chatId: String, text: String)
    /// at：工具开始时 assistant 正文的 UTF-16 长度（tool_at 能力）
    case toolStarted(chatId: String, callId: String, name: String, args: JSONValue?, parentCallId: String?, agent: String?, model: String?, at: Int?)
    case toolCompleted(chatId: String, callId: String, name: String, status: String, result: JSONValue?, parentCallId: String?, agent: String?, model: String?)
    case toolOutput(chatId: String, callId: String, stream: String?, chunk: String?, stdout: String?, stderr: String?)
    case task(chatId: String, text: String)
    case status(chatId: String?, status: String, message: String?)
    case error(chatId: String?, message: String)
    case approval(chatId: String, callId: String, name: String, args: JSONValue?)
    case done(chatId: String, status: String, durationMs: Double?)
    /// chatRevs 为 nil 表示网关是旧版（不支持 P4 增量），客户端应回落全量 sync_state
    case storedState(chats: [JSONValue], rev: Int?, deletedIds: [String], chatRevs: [String: Int]?)
    /// stored_state 超过 maxMessageBytes 时的替代通知：应 HTTP GET /state 拉全量
    case storedStateDeferred(rev: Int?)
    /// P4b：sync_state / sync_chat 被接受后的回执
    /// truncated：truncate_turns 的回执（nil = 普通 sync_chat 回执）
    case syncAck(rev: Int?, chatRevs: [String: Int], reviewOnly: Bool, truncated: Bool?)
    /// P4c：分叉时的目录推送（比对 chatRevs 后用 loadChats 拉差异会话）
    /// rejected：本连接的推送被拒（旧网关不带 reason，按被拒处理）；false 是别处写入后的广播
    case storedDigest(rev: Int?, deletedIds: [String], chatRevs: [String: Int], rejected: Bool)
    /// P4c：load_chats 的应答（单个会话全量——slim 客户端也是全量：digest 对账是跨设备 turns 更新唯一通道）
    case storedChat(chat: JSONValue, rev: Int?)
    /// P8 slim：load_chat 的应答（turns[from..] 一页；hasMore=前面还有；nonce 回显请求代际）
    case chatTurns(chatId: String, turns: [JSONValue], from: Int, hasMore: Bool, nonce: Int?)
    case auth(ok: Bool, message: String?)
    case history(chatId: String, turns: [JSONValue])
    case runSnapshot(
        chatId: String,
        turnId: String?,
        phase: String,
        status: String?,
        userText: String,
        assistant: String,
        thinking: String,
        tools: [JSONValue],
        task: String?,
        model: String?,
        mode: AgentMode?,
        awaitingApproval: JSONValue?,
        queued: [JSONValue],
        durationMs: Double?,
        clipped: Bool
    )
    case chatTitle(chatId: String, title: String)
    /// P9：admin_stats 应答（仅管理员收得到）。cursor 是当前 API Key 的官方账单
    case adminStats(tenants: [AdminTenantStats], serverTime: Double, cursor: CursorBill?)
    case loopState(
        chatId: String,
        status: String,
        goal: String,
        intervalSec: Int,
        tick: Int,
        maxTicks: Int?,
        lastSummary: String?,
        nextAt: Double?
    )
    case loopTick(chatId: String, tick: Int, status: String, summary: String)
    case fileUploaded(path: String, chatId: String?, name: String?, error: String?, size: Double?, id: String?)
    case fileWritten(path: String, chatId: String?, error: String?)
    case files(query: String, paths: [String], mention: Bool, truncated: Bool, chatId: String?, status: [String: String])
    case searchHits(query: String, hits: [SearchHit], chatId: String?)
    /// P5：read_file 的应答。文本内联 content；图片/PDF 等给 url+media 票据走 HTTP /media；
    /// headUrl 是图片/svg diff 的「改前」对照地址（rev=HEAD，P5c 图片 diff 用）
    case fileContent(
        path: String,
        chatId: String?,
        content: String?,
        error: String?,
        diff: Bool,
        kind: String?,
        mime: String?,
        size: Double?,
        url: String?,
        headUrl: String?,
        media: MediaTicket?,
        /// read_file 带的 reqId / sha 原样回显
        reqId: String?,
        sha: String?
    )
    /// 每轮结束后下发这一轮的文件清单
    case turnFiles(chatId: String, turnId: String, files: [TurnFile])
    case undone(chatId: String, paths: [String], error: String?)
    case checkpoints(chatId: String, items: [CheckpointInfo])
    case restored(chatId: String, checkpointId: String?, label: String?, error: String?, silent: Bool)
    /// 个人助理全量状态（替换本地）
    case assistantState(AssistantState)
    case assistantResult(reqId: String?, op: String, ok: Bool, error: String?, data: JSONValue?)
    case inboxItem(AssistantInboxItem)
    /// 委派开始、待批、继续、完成、失败时下发；approval 只在待批时带
    case delegationState(delegation: AssistantDelegation, approval: AssistantApproval?)
    case memoryWritten(chatId: String?, entry: AssistantMemoryEntry)
    case pong
    case ignored(String)

    var chatId: String? {
        switch self {
        case .session(let chatId, _, _),
             .runMeta(let chatId, _, _),
             .textDelta(let chatId, _),
             .thinkingDelta(let chatId, _),
             .toolStarted(let chatId, _, _, _, _, _, _, _),
             .toolCompleted(let chatId, _, _, _, _, _, _, _),
             .toolOutput(let chatId, _, _, _, _, _),
             .task(let chatId, _),
             .approval(let chatId, _, _, _),
             .done(let chatId, _, _),
             .history(let chatId, _),
             .runSnapshot(let chatId, _, _, _, _, _, _, _, _, _, _, _, _, _, _),
             .chatTitle(let chatId, _):
            return chatId
        case .status(let chatId, _, _), .error(let chatId, _):
            return chatId
        case .fileUploaded(_, let chatId, _, _, _, _):
            return chatId
        case .files(_, _, _, _, let chatId, _):
            return chatId
        case .fileContent(_, let chatId, _, _, _, _, _, _, _, _, _, _, _):
            return chatId
        case .turnFiles(let chatId, _, _):
            return chatId
        case .undone(let chatId, _, _),
             .checkpoints(let chatId, _),
             .restored(let chatId, _, _, _, _):
            return chatId
        case .chatTurns(let chatId, _, _, _, _):
            return chatId
        default:
            return nil
        }
    }

    static func decode(from data: Data) throws -> ServerMessage {
        let json = try JSONValue.parse(data)
        guard let object = json.object, let type = object["type"]?.string else {
            return .ignored("")
        }
        let chatId = object["chatId"]?.string ?? ""
        switch type {
        case "ready":
            return .ready(
                cwd: object["cwd"]?.string ?? "",
                hasApiKey: object["hasApiKey"]?.bool ?? false,
                model: object["model"]?.string ?? ModelCatalog.defaultModel,
                models: object["models"]?.array?.compactMap(\.string) ?? [],
                agentId: object["agentId"]?.string,
                runningChatIds: object["runningChatIds"]?.array?.compactMap(\.string) ?? [],
                queuedChatIds: object["queuedChatIds"]?.array?.compactMap(\.string) ?? [],
                workspaceRoot: object["workspaceRoot"]?.string,
                tenantId: object["tenantId"]?.string,
                tenantName: object["tenantName"]?.string,
                admin: object["admin"]?.bool ?? false,
                loops: object["loops"]?.array?.compactMap { LoopSnapshot.from($0.object) } ?? [],
                assistantName: object["assistantName"]?.string,
                assistantChatId: object["assistantChatId"]?.string?.nilIfEmpty,
                features: object["features"]?.array?.compactMap(\.string) ?? []
            )
        case "workspaces":
            let items = object["items"]?.array?.compactMap { item -> WorkspaceItem? in
                guard let row = item.object, let path = row["path"]?.string else { return nil }
                return WorkspaceItem(
                    path: path,
                    name: row["name"]?.string ?? URL(fileURLWithPath: path).lastPathComponent,
                    user: row["user"]?.bool ?? false
                )
            } ?? []
            return .workspaces(root: object["root"]?.string ?? "", items: items)
        case "workspace_created":
            return .workspaceCreated(path: object["path"]?.string ?? "", name: object["name"]?.string ?? "")
        case "session":
            return .session(chatId: chatId, agentId: object["agentId"]?.string ?? "", cwd: object["cwd"]?.string ?? "")
        case "run_meta":
            return .runMeta(chatId: chatId, model: object["model"]?.string ?? "", mode: object["mode"]?.string.flatMap(AgentMode.init(rawValue:)))
        case "text-delta":
            return .textDelta(chatId: chatId, text: object["text"]?.string ?? "")
        case "thinking-delta":
            return .thinkingDelta(chatId: chatId, text: object["text"]?.string ?? "")
        case "tool-started":
            return .toolStarted(
                chatId: chatId,
                callId: object["callId"]?.string ?? "",
                name: object["name"]?.string ?? "",
                args: object["args"],
                parentCallId: object["parentCallId"]?.string,
                agent: object["agent"]?.string,
                model: object["model"]?.string,
                at: object["at"]?.int
            )
        case "tool-completed":
            return .toolCompleted(
                chatId: chatId,
                callId: object["callId"]?.string ?? "",
                name: object["name"]?.string ?? "",
                status: object["status"]?.string ?? "completed",
                result: object["result"],
                parentCallId: object["parentCallId"]?.string,
                agent: object["agent"]?.string,
                model: object["model"]?.string
            )
        case "tool-output":
            return .toolOutput(
                chatId: chatId,
                callId: object["callId"]?.string ?? "",
                stream: object["stream"]?.string,
                chunk: object["chunk"]?.string,
                stdout: object["stdout"]?.string,
                stderr: object["stderr"]?.string
            )
        case "task":
            return .task(chatId: chatId, text: object["text"]?.string ?? "")
        case "status":
            return .status(chatId: object["chatId"]?.string, status: object["status"]?.string ?? "", message: object["message"]?.string)
        case "error":
            return .error(chatId: object["chatId"]?.string, message: object["message"]?.string ?? "")
        case "approval":
            return .approval(chatId: chatId, callId: object["callId"]?.string ?? "", name: object["name"]?.string ?? "", args: object["args"])
        case "done":
            return .done(chatId: chatId, status: object["status"]?.string ?? "", durationMs: object["durationMs"]?.number)
        case "stored_state":
            return .storedState(
                chats: object["chats"]?.array ?? [],
                rev: object["rev"]?.int,
                deletedIds: object["deletedIds"]?.array?.compactMap(\.string) ?? [],
                chatRevs: object["chatRevs"]?.intMap
            )
        case "stored_state_deferred":
            return .storedStateDeferred(rev: object["rev"]?.int)
        case "sync_ack":
            return .syncAck(
                rev: object["rev"]?.int,
                chatRevs: object["chatRevs"]?.intMap ?? [:],
                reviewOnly: object["reviewOnly"]?.bool ?? false,
                truncated: object["truncated"]?.bool
            )
        case "stored_digest":
            return .storedDigest(
                rev: object["rev"]?.int,
                deletedIds: object["deletedIds"]?.array?.compactMap(\.string) ?? [],
                chatRevs: object["chatRevs"]?.intMap ?? [:],
                rejected: object["reason"]?.string != "changed"
            )
        case "stored_chat":
            guard let chat = object["chat"] else { return .ignored("") }
            return .storedChat(chat: chat, rev: object["rev"]?.int)
        case "chat_turns":
            guard let chatId = object["chatId"]?.string else { return .ignored("") }
            return .chatTurns(
                chatId: chatId,
                turns: object["turns"]?.array ?? [],
                from: object["from"]?.int ?? 0,
                hasMore: object["hasMore"]?.bool ?? false,
                nonce: object["nonce"]?.int
            )
        case "auth":
            return .auth(ok: object["ok"]?.bool ?? false, message: object["message"]?.string)
        case "history":
            return .history(chatId: chatId, turns: object["turns"]?.array ?? [])
        case "run_snapshot":
            return .runSnapshot(
                chatId: chatId,
                turnId: object["turnId"]?.string,
                phase: object["phase"]?.string ?? "running",
                status: object["status"]?.string,
                userText: object["userText"]?.string ?? "",
                assistant: object["assistant"]?.string ?? "",
                thinking: object["thinking"]?.string ?? "",
                tools: object["tools"]?.array ?? [],
                task: object["task"]?.string,
                model: object["model"]?.string,
                mode: object["mode"]?.string.flatMap(AgentMode.init(rawValue:)),
                awaitingApproval: object["awaitingApproval"],
                queued: object["queued"]?.array ?? [],
                durationMs: object["durationMs"]?.number,
                clipped: object["clipped"]?.bool ?? false
            )
        case "chat_title":
            return .chatTitle(chatId: chatId, title: object["title"]?.string ?? "")
        case "loop_state":
            return .loopState(
                chatId: object["chatId"]?.string ?? "",
                status: object["status"]?.string ?? "",
                goal: object["goal"]?.string ?? "",
                intervalSec: object["intervalSec"]?.int ?? 0,
                tick: object["tick"]?.int ?? 0,
                maxTicks: object["maxTicks"]?.int,
                lastSummary: object["lastSummary"]?.string,
                nextAt: object["nextAt"]?.number
            )
        case "loop_tick":
            return .loopTick(
                chatId: object["chatId"]?.string ?? "",
                tick: object["tick"]?.int ?? 0,
                status: object["status"]?.string ?? "",
                summary: object["summary"]?.string ?? ""
            )
        case "admin_stats":
            return .adminStats(
                tenants: object["tenants"]?.array?.compactMap(AdminTenantStats.from) ?? [],
                serverTime: object["serverTime"]?.number ?? 0,
                cursor: object["cursor"].flatMap(CursorBill.from)
            )
        case "files":
            // 网关附带 git status（M/A/D/U/R），全量清单时写入 gitStatus
            return .files(
                query: object["query"]?.string ?? "",
                paths: object["paths"]?.array?.compactMap(\.string) ?? [],
                mention: object["mention"]?.bool ?? false,
                truncated: object["truncated"]?.bool ?? false,
                chatId: object["chatId"]?.string,
                status: gitLetters(object["status"])
            )
        case "search_hits":
            return .searchHits(
                query: object["query"]?.string ?? "",
                hits: object["hits"]?.array?.compactMap(SearchHit.from) ?? [],
                chatId: object["chatId"]?.string
            )
        case "file_content":
            let ticketRow = object["media"]?.object
            return .fileContent(
                path: object["path"]?.string ?? "",
                chatId: object["chatId"]?.string,
                content: object["content"]?.string,
                error: object["error"]?.string,
                diff: object["diff"]?.bool ?? false,
                kind: object["kind"]?.string,
                mime: object["mime"]?.string,
                size: object["size"]?.number,
                url: object["url"]?.string,
                headUrl: object["headUrl"]?.string,
                media: ticketRow.flatMap { row in
                    guard let exp = row["exp"]?.number, let sig = row["sig"]?.string else { return nil }
                    return MediaTicket(exp: exp, sig: sig)
                },
                reqId: object["reqId"]?.string?.nilIfEmpty,
                sha: object["sha"]?.string?.nilIfEmpty
            )
        case "turn_files":
            guard let turnId = object["turnId"]?.string, !turnId.isEmpty, !chatId.isEmpty else { return .ignored(type) }
            return .turnFiles(
                chatId: chatId,
                turnId: turnId,
                files: object["files"]?.array?.compactMap(TurnFile.from) ?? []
            )
        case "undone":
            return .undone(
                chatId: chatId,
                paths: object["paths"]?.array?.compactMap(\.string) ?? [],
                error: object["error"]?.string
            )
        case "checkpoints":
            let items = object["items"]?.array?.compactMap { item -> CheckpointInfo? in
                guard let row = item.object, let id = row["id"]?.string, !id.isEmpty else { return nil }
                return CheckpointInfo(
                    id: id,
                    label: row["label"]?.string?.nilIfEmpty ?? id,
                    createdAt: row["createdAt"]?.number ?? 0
                )
            } ?? []
            return .checkpoints(chatId: chatId, items: items)
        case "restored":
            return .restored(
                chatId: chatId,
                checkpointId: object["checkpointId"]?.string,
                label: object["label"]?.string,
                error: object["error"]?.string,
                silent: object["silent"]?.bool ?? false
            )
        case "file_written":
            return .fileWritten(
                path: object["path"]?.string ?? "",
                chatId: object["chatId"]?.string,
                error: object["error"]?.string
            )
        case "file_uploaded":
            return .fileUploaded(
                path: object["path"]?.string ?? "",
                chatId: object["chatId"]?.string,
                name: object["name"]?.string,
                error: object["error"]?.string,
                size: object["size"]?.number,
                id: object["id"]?.string
            )
        case "assistant_state":
            guard let state = object["state"].flatMap(AssistantState.from) else { return .ignored(type) }
            return .assistantState(state)
        case "assistant_result":
            return .assistantResult(
                reqId: object["reqId"]?.string,
                op: object["op"]?.string ?? "",
                ok: object["ok"]?.bool ?? false,
                error: object["error"]?.string?.nilIfEmpty,
                data: object["data"]
            )
        case "inbox_item":
            guard let item = object["item"].flatMap(AssistantInboxItem.from) else { return .ignored(type) }
            return .inboxItem(item)
        case "delegation_state":
            guard let delegation = object["delegation"].flatMap(AssistantDelegation.from) else { return .ignored(type) }
            return .delegationState(delegation: delegation, approval: object["approval"].flatMap(AssistantApproval.from))
        case "memory_written":
            guard let entry = object["entry"].flatMap(AssistantMemoryEntry.from) else { return .ignored(type) }
            return .memoryWritten(chatId: object["chatId"]?.string?.nilIfEmpty, entry: entry)
        case "pong":
            return .pong
        default:
            return .ignored(type)
        }
    }
}

enum GatewayConfig {
    static let production = URL(string: "wss://jiebo.aiagentswitcher.com/bridge")!

    static var url: URL {
        #if DEBUG
        if let override = UserDefaults.standard.string(forKey: "jiebo.gateway")?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty,
           let url = URL(string: override)
        {
            return url
        }
        #endif
        return production
    }

    /// HTTP 上传通道：wss→https、/bridge→/upload（nginx 已反代，36MB 流式）
    static var uploadURL: URL {
        derive(path: "/upload")
    }

    /// /media 预览票据通道（P3 用）
    static var mediaBaseURL: URL {
        derive(path: "/media")
    }

    /// stored_state 的 HTTP 拉取通道（WS 单条消息超 maxMessageBytes 时的兜底）。
    /// slim=1：与 WS cap 对齐——slim 客户端走 HTTP 回落时也只拿元数据壳（Grok 评审 MINOR4）
    static var stateURL: URL {
        var url = derive(path: "/state")
        url.append(queryItems: [URLQueryItem(name: "slim", value: "1")])
        return url
    }

    /// 带查询参数的 /media 下载地址（Bearer 鉴权在请求头里加）。rev 形如 "sha:<sha>" 时下载那一轮的快照
    static func mediaURL(path: String, chatId: String, rev: String? = nil) -> URL {
        var components = URLComponents(url: mediaBaseURL, resolvingAgainstBaseURL: false)
        var items = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "chatId", value: chatId),
        ]
        if let rev, !rev.isEmpty { items.append(URLQueryItem(name: "rev", value: rev)) }
        components?.queryItems = items
        return components?.url ?? mediaBaseURL
    }

    /// file_content 的 url 字段是相对地址（/media?... 已带票据查询）：补上 scheme+host 即可用
    static func resolveHTTP(_ relative: String) -> URL? {
        guard relative.hasPrefix("/") else { return URL(string: relative) }
        let base = derive(path: "")
        return URL(string: "\(base.absoluteString)\(relative)")
    }

    /// canvas 运行时（P5d）：web 与 gateway 同域部署（nginx location / → cursor_web），
    /// 本地 dev 网关不服务 web 路由 → 返回 nil，上层降级源码视图。
    /// DEBUG 下可用 UserDefaults "jiebo.canvasRuntime" 显式指向本地 web dev server 做端到端验证。
    static var canvasRuntimeURL: URL? {
        #if DEBUG
        if let override = UserDefaults.standard.string(forKey: "jiebo.canvasRuntime")?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty,
           let url = URL(string: override)
        {
            return url
        }
        #endif
        guard let host = url.host?.lowercased() else { return nil }
        if isLocalGatewayHost(host) { return nil }
        return derive(path: "/canvas-runtime")
    }

    /// 本地/局域网网关不服务 web 路由（/canvas-runtime 在 web 应用上）：
    /// loopback、.local、私网段（真机 DEBUG 走局域网 IP）都降级源码视图
    private static func isLocalGatewayHost(_ host: String) -> Bool {
        if host == "127.0.0.1" || host == "localhost" || host == "::1" || host.hasSuffix(".local") { return true }
        if host.hasPrefix("192.168.") || host.hasPrefix("10.") || host.hasPrefix("169.254.") { return true }
        if host.hasPrefix("172.") {
            let second = host.dropFirst(4).prefix(while: { $0.isNumber })
            if let block = Int(second), (16 ... 31).contains(block) { return true }
        }
        return false
    }

    /// 从 ws(s)://host[:port][前缀]/bridge 派生 http(s)://host[:port][前缀]<path>。
    /// 只替换末尾 /bridge（对齐网页 .replace(/\/bridge$/, ...)），保留可能存在的部署前缀。
    private static func derive(path: String) -> URL {
        let ws = url
        var components = URLComponents(url: ws, resolvingAgainstBaseURL: false)
        switch ws.scheme {
        case "ws": components?.scheme = "http"
        case "wss": components?.scheme = "https"
        default: break
        }
        // 容忍尾斜杠：/bridge/ 与 /bridge 都认；本地直连网关挂 /ws 也要换掉
        let wsPath = (components?.path ?? "").replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        if wsPath.hasSuffix("/bridge") {
            components?.path = String(wsPath.dropLast("/bridge".count)) + path
        } else if wsPath.hasSuffix("/ws") {
            components?.path = String(wsPath.dropLast("/ws".count)) + path
        } else {
            components?.path = wsPath + path
        }
        components?.query = nil
        if let derived = components?.url { return derived }
        return URL(string: "https://jiebo.aiagentswitcher.com\(path)")!
    }
}
