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

struct WorkspaceAgentItem: Sendable, Hashable, Identifiable {
    var path: String
    var directoryName: String
    var displayName: String
    var avatarBlob: String?
    var mainChatId: String?
    var status: String
    var unread: Int
    var readSeq: Int
    var finishedSeq: Int
    var lastActivityAt: Double
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
    /// 父回合聚合委派交付物时，文件仍应从来源子会话读取。
    var sourceChatId: String? = nil
    var sourceTurnId: String? = nil
    var id: String {
        sourceChatId.map { "\($0)|\(sourceTurnId ?? "")|\(path)" } ?? path
    }

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
            removed: row["removed"]?.int,
            sourceChatId: row["sourceChatId"]?.string?.nilIfEmpty,
            sourceTurnId: row["sourceTurnId"]?.string?.nilIfEmpty
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
        if let sourceChatId { object["sourceChatId"] = .string(sourceChatId) }
        if let sourceTurnId { object["sourceTurnId"] = .string(sourceTurnId) }
        return .object(object)
    }
}

struct ArtifactProvenance: Sendable, Hashable {
    var turnId: String?
    var delegationId: String?
    var collabTaskId: String?
    var inboxId: String?
    var captureId: String?
    var label: String?

    static func from(_ json: JSONValue?) -> ArtifactProvenance? {
        guard let row = json?.object else { return nil }
        return ArtifactProvenance(
            turnId: row["turnId"]?.string?.nilIfEmpty,
            delegationId: row["delegationId"]?.string?.nilIfEmpty,
            collabTaskId: row["collabTaskId"]?.string?.nilIfEmpty,
            inboxId: row["inboxId"]?.string?.nilIfEmpty,
            captureId: row["captureId"]?.string?.nilIfEmpty,
            label: row["label"]?.string?.nilIfEmpty
        )
    }
}

struct ArtifactSourceCitation: Sendable, Hashable {
    var url: String?
    var title: String?
    var capturedAt: Double?
    var excerpt: String?

    static func from(_ json: JSONValue?) -> ArtifactSourceCitation? {
        guard let row = json?.object else { return nil }
        return ArtifactSourceCitation(
            url: row["url"]?.string?.nilIfEmpty,
            title: row["title"]?.string?.nilIfEmpty,
            capturedAt: row["capturedAt"]?.number,
            excerpt: row["excerpt"]?.string?.nilIfEmpty
        )
    }
}

private func artifactPreviewKind(of path: String) -> PreviewKind {
    previewKind(of: path)
}

/// 由网关从既有事实源派生的只读产物；未知 kind 保留为字符串以兼容新网关。
struct Artifact: Sendable, Hashable, Identifiable {
    var id: String
    var title: String
    var kind: String
    var previewKind: PreviewKind?
    var createdAt: Double
    var path: String?
    var url: String?
    var sha: String?
    var diffSha: String?
    var sourceChatId: String?
    var sourceTurnId: String?
    var provenance: ArtifactProvenance?
    var sourceCitation: ArtifactSourceCitation?

    static func from(_ json: JSONValue) -> Artifact? {
        guard let row = json.object,
              let id = row["id"]?.string?.nilIfEmpty,
              let title = row["title"]?.string?.nilIfEmpty
        else { return nil }
        return Artifact(
            id: id,
            title: title,
            kind: row["kind"]?.string ?? "capture",
            previewKind: row["previewKind"]?.string.flatMap(PreviewKind.init(rawValue:)),
            createdAt: row["createdAt"]?.number ?? 0,
            path: row["path"]?.string?.nilIfEmpty,
            url: row["url"]?.string?.nilIfEmpty,
            sha: row["sha"]?.string?.nilIfEmpty,
            diffSha: row["diffSha"]?.string?.nilIfEmpty,
            sourceChatId: row["sourceChatId"]?.string?.nilIfEmpty,
            sourceTurnId: row["sourceTurnId"]?.string?.nilIfEmpty,
            provenance: ArtifactProvenance.from(row["provenance"]),
            sourceCitation: ArtifactSourceCitation.from(row["sourceCitation"])
        )
    }

    var safeURL: URL? {
        guard let url, let parsed = URL(string: url),
              parsed.scheme == "https" || parsed.scheme == "http",
              parsed.user == nil, parsed.password == nil
        else { return nil }
        return parsed
    }

    var turnFile: TurnFile? {
        guard kind == "file", let path else { return nil }
        return TurnFile(
            path: path,
            kind: previewKind ?? artifactPreviewKind(of: path),
            op: "modified",
            sha: sha,
            diffSha: diffSha,
            sourceChatId: sourceChatId,
            sourceTurnId: sourceTurnId
        )
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
    /// + slim_chats（load_chats 也只回元数据壳）+ deferred_turn（超大回合按需水合）
    /// + mobile_compact_v1（工作区变化只收索引，正文按需）
    /// + im（收发平台用户之间的即时消息）
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
            // Collab 沿用网关现有双 capability 门槛；iOS P3 只读取状态，不发送 collab_op。
            caps: [
                "sync_chat", "stored_digest", "slim_state", "slim_chats", "im", "im_group", "im_collab",
                "workspace_agents", "device_bridge", "device_bridge_v2", "mobile_compact_v1", "deferred_turn",
            ]
        )
    }

    var json: JSONValue {
        var object: [String: JSONValue] = ["name": .string(name), "version": .string(version)]
        if let maxMessageBytes { object["maxMessageBytes"] = .number(Double(maxMessageBytes)) }
        object["caps"] = .array(caps.map { .string($0) })
        return .object(object)
    }
}

struct DeviceApproval: Sendable, Hashable {
    var summary: String
    var risk: String
    var requiresConfirmation: Bool
}

struct DeviceInvoke: Sendable, Hashable {
    var reqId: String
    var op: String
    var params: JSONValue
    var timeoutMs: Int
    var idempotencyKey: String?
    var approval: DeviceApproval?
}

enum ClientMessage {
    case hello(token: String?)
    case setWorkspace(cwd: String, chatId: String?, create: Bool?)
    case listWorkspaces
    case createWorkspace(name: String)
    /// 只改根目录下的一级工作区；网关把会话、断点里的路径一并改过去
    case renameWorkspace(path: String, name: String)
    /// 空目录真删，有文件只隐藏，还有对话就拒绝
    case deleteWorkspace(path: String)
    case workspaceAgentList(cursor: String?)
    case workspaceAgentOpen(path: String)
    case workspaceAgentProfile(path: String, displayName: String?, avatar: String?)
    case workspaceAgentRead(chatId: String, seq: Int)
    case workspaceAgentViewing(chatId: String?)
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
    case listFiles(query: String?, chatId: String?, mention: Bool?, reqId: String?)
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
    case assistantGet(memory: Bool, knownRevision: Int?, reqId: String?, generation: Int?)
    /// 个人助理操作（inbox_read / todo_add / memory_* / approval_answer …），args 由网关逐项校验
    case assistantOp(op: String, args: [String: JSONValue], reqId: String?)
    // 即时消息（见 docs/im.md）。只有 hello caps 含 "im" 的连接网关才处理
    case imContacts
    case imList(cursor: String?, limit: Int?)
    case imHistory(convId: String, before: Int?, after: Int?, limit: Int?)
    /// to（对方租户 id）和 convId 二选一；同一 clientId 重发只回原 ack
    case imSend(clientId: String, to: String?, convId: String?, kind: String, body: ImBody, replyTo: Int?)
    case imRecall(convId: String, seq: Int)
    case imRead(convId: String, seq: Int)
    /// hideBefore 只增不减（清空聊天记录）
    case imSettings(convId: String, pin: Bool?, mute: Bool?, hideBefore: Int?)
    /// avatar 传空串去掉头像，nil 不改
    case imProfile(nickname: String?, avatar: String?, notifyPreview: Bool?)
    case imBlock(tenantId: String, on: Bool)
    /// App 进出前台；没有回包
    case imPresence(foreground: Bool)
    /// iOS P3 只读同步 Collab 运行图；旧网关会忽略未知能力或返回 im_error，主聊天路径不受影响。
    case collabSync(convId: String, known: [(runId: String, version: Int)], cursor: String?)
    /// Apple 本地设备桥结果；执行器下一步接入，当前不会伪造成功。
    case deviceResult(reqId: String, op: String, status: String, result: JSONValue?, error: String?, externalId: String?)
    case devicePermissionReport(reqId: String?, grants: [JSONValue])

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
        case .renameWorkspace(let path, let name):
            return .object(["type": .string("rename_workspace"), "path": .string(path), "name": .string(name)])
        case .deleteWorkspace(let path):
            return .object(["type": .string("delete_workspace"), "path": .string(path)])
        case .workspaceAgentList(let cursor):
            var object: [String: JSONValue] = ["type": .string("workspace_agent_list")]
            if let cursor { object["cursor"] = .string(cursor) }
            return .object(object)
        case .workspaceAgentOpen(let path):
            return .object(["type": .string("workspace_agent_open"), "path": .string(path)])
        case .workspaceAgentProfile(let path, let displayName, let avatar):
            var object: [String: JSONValue] = ["type": .string("workspace_agent_profile"), "path": .string(path)]
            if let displayName { object["displayName"] = .string(displayName) }
            if let avatar { object["avatar"] = .string(avatar) }
            return .object(object)
        case .workspaceAgentRead(let chatId, let seq):
            return .object([
                "type": .string("workspace_agent_read"),
                "chatId": .string(chatId),
                "seq": .number(Double(seq)),
            ])
        case .workspaceAgentViewing(let chatId):
            var object: [String: JSONValue] = ["type": .string("workspace_agent_viewing")]
            object["chatId"] = chatId.map(JSONValue.string) ?? .null
            return .object(object)
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
            // 编码即发送：取发出那一刻的本机时间和系统时区，助理换算“明天”“下周三”用
            object["clientTime"] = .object([
                "now": .number((Date().timeIntervalSince1970 * 1000).rounded()),
                "tz": .string(TimeZone.current.identifier),
            ])
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
        case .listFiles(let query, let chatId, let mention, let reqId):
            var object: [String: JSONValue] = ["type": .string("list_files")]
            if let query { object["query"] = .string(query) }
            if let chatId { object["chatId"] = .string(chatId) }
            if let mention { object["mention"] = .bool(mention) }
            if let reqId, !reqId.isEmpty { object["reqId"] = .string(reqId) }
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
        case .assistantGet(let memory, let knownRevision, let reqId, let generation):
            var object: [String: JSONValue] = ["type": .string("assistant_get")]
            if memory { object["memory"] = .bool(true) }
            if let knownRevision, knownRevision > 0 { object["knownRevision"] = .number(Double(knownRevision)) }
            if let reqId, !reqId.isEmpty { object["reqId"] = .string(reqId) }
            if let generation, generation > 0 { object["generation"] = .number(Double(generation)) }
            return .object(object)
        case .assistantOp(let op, let args, let reqId):
            var object: [String: JSONValue] = ["type": .string("assistant_op"), "op": .string(op)]
            if !args.isEmpty { object["args"] = .object(args) }
            if let reqId { object["reqId"] = .string(reqId) }
            return .object(object)
        case .imContacts:
            return .object(["type": .string("im_contacts")])
        case .imList(let cursor, let limit):
            var object: [String: JSONValue] = ["type": .string("im_list")]
            if let cursor, !cursor.isEmpty { object["cursor"] = .string(cursor) }
            if let limit { object["limit"] = .number(Double(limit)) }
            return .object(object)
        case .imHistory(let convId, let before, let after, let limit):
            var object: [String: JSONValue] = ["type": .string("im_history"), "convId": .string(convId)]
            if let before { object["before"] = .number(Double(before)) }
            if let after { object["after"] = .number(Double(after)) }
            if let limit { object["limit"] = .number(Double(limit)) }
            return .object(object)
        case .imSend(let clientId, let to, let convId, let kind, let body, let replyTo):
            var object: [String: JSONValue] = [
                "type": .string("im_send"),
                "clientId": .string(clientId),
                "kind": .string(kind),
                "body": body.json(),
            ]
            if let to, !to.isEmpty { object["to"] = .string(to) }
            if let convId, !convId.isEmpty { object["convId"] = .string(convId) }
            if let replyTo { object["replyTo"] = .number(Double(replyTo)) }
            return .object(object)
        case .imRecall(let convId, let seq):
            return .object(["type": .string("im_recall"), "convId": .string(convId), "seq": .number(Double(seq))])
        case .imRead(let convId, let seq):
            return .object(["type": .string("im_read"), "convId": .string(convId), "seq": .number(Double(seq))])
        case .imSettings(let convId, let pin, let mute, let hideBefore):
            var object: [String: JSONValue] = ["type": .string("im_settings"), "convId": .string(convId)]
            if let pin { object["pin"] = .bool(pin) }
            if let mute { object["mute"] = .bool(mute) }
            if let hideBefore { object["hideBefore"] = .number(Double(hideBefore)) }
            return .object(object)
        case .imProfile(let nickname, let avatar, let notifyPreview):
            var object: [String: JSONValue] = ["type": .string("im_profile")]
            if let nickname { object["nickname"] = .string(nickname) }
            if let avatar { object["avatar"] = .string(avatar) }
            if let notifyPreview { object["notifyPreview"] = .bool(notifyPreview) }
            return .object(object)
        case .imBlock(let tenantId, let on):
            return .object(["type": .string("im_block"), "tenantId": .string(tenantId), "on": .bool(on)])
        case .imPresence(let foreground):
            return .object(["type": .string("im_presence"), "foreground": .bool(foreground)])
        case .collabSync(let convId, let known, let cursor):
            var object: [String: JSONValue] = [
                "type": .string("collab_sync"),
                "convId": .string(convId),
                "known": .array(known.map { .object([
                    "runId": .string($0.runId),
                    "version": .number(Double($0.version)),
                ]) }),
            ]
            if let cursor { object["cursor"] = .string(cursor) }
            return .object(object)
        case .deviceResult(let reqId, let op, let status, let result, let error, let externalId):
            var object: [String: JSONValue] = [
                "type": .string("device_result"),
                "reqId": .string(reqId),
                "op": .string(op),
                "status": .string(status),
            ]
            if let result { object["result"] = result }
            if let error { object["error"] = .string(error) }
            if let externalId { object["externalId"] = .string(externalId) }
            return .object(object)
        case .devicePermissionReport(let reqId, let grants):
            var object: [String: JSONValue] = [
                "type": .string("device_permission_report"),
                "grants": .array(grants),
            ]
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
    var actionPrompt: String?
    var chatId: String?
    var scheduleId: String?
    var delegationId: String?
    var capture: AssistantCaptureSource?

    static func from(_ json: JSONValue) -> AssistantInboxItem? {
        guard let row = json.object, let id = row["id"]?.string, !id.isEmpty else { return nil }
        return AssistantInboxItem(
            id: id,
            kind: row["kind"]?.string ?? "info",
            title: row["title"]?.string ?? "",
            body: row["body"]?.string ?? "",
            createdAt: row["createdAt"]?.number ?? 0,
            read: row["read"]?.bool ?? false,
            actionPrompt: row["actionPrompt"]?.string?.nilIfEmpty,
            chatId: row["chatId"]?.string?.nilIfEmpty,
            scheduleId: row["scheduleId"]?.string?.nilIfEmpty,
            delegationId: row["delegationId"]?.string?.nilIfEmpty,
            capture: AssistantCaptureSource.from(row["capture"])
        )
    }
}

struct AssistantCaptureSource: Sendable, Hashable {
    var kind: String
    var title: String?
    var url: String?
    var path: String?
    var sha: String?
    var mime: String?
    var size: Int?
    var intent: String?

    static func from(_ json: JSONValue?) -> AssistantCaptureSource? {
        guard let row = json?.object, let kind = row["kind"]?.string?.nilIfEmpty else { return nil }
        return AssistantCaptureSource(
            kind: kind,
            title: row["title"]?.string?.nilIfEmpty,
            url: row["url"]?.string?.nilIfEmpty,
            path: row["path"]?.string?.nilIfEmpty,
            sha: row["sha"]?.string?.nilIfEmpty,
            mime: row["mime"]?.string?.nilIfEmpty,
            size: row["size"]?.int,
            intent: row["intent"]?.string?.nilIfEmpty
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
    /// 在哪个会话里记下的（助理在对话里记的才有）
    var chatId: String?
    /// "user" 手动加 / "chat" 对话里助理记下 / "nightly" 夜里补记；老数据没有
    var source: String?
    /// 助理记下时用户的原话
    var quote: String?

    /// 助理自己记的（不是用户手动加的），列表里要标出来，记错了用户才看得出
    var capturedByAssistant: Bool { source == "chat" || source == "nightly" }

    static func from(_ json: JSONValue) -> AssistantTodo? {
        guard let row = json.object, let id = row["id"]?.string, !id.isEmpty else { return nil }
        return AssistantTodo(
            id: id,
            text: row["text"]?.string ?? "",
            due: row["due"]?.string?.nilIfEmpty,
            done: row["done"]?.bool ?? false,
            doneAt: row["doneAt"]?.number,
            createdAt: row["createdAt"]?.number ?? 0,
            chatId: row["chatId"]?.string?.nilIfEmpty,
            source: row["source"]?.string?.nilIfEmpty,
            quote: row["quote"]?.string?.nilIfEmpty
        )
    }
}

/// 苹果日历订阅：token 拼进 /media/cal/<token>.ics；lastFetchAt 是日历最近一次来拉的时间（毫秒）
struct AssistantCalendar: Sendable, Hashable {
    var token: String
    var enabled: Bool
    var lastFetchAt: Double?

    /// 拉过就算订阅了；超过 3 天没来拉，多半是在日历里删掉了
    var subscribed: Bool { lastFetchAt != nil }
    var stale: Bool {
        guard let lastFetchAt else { return false }
        return Date().timeIntervalSince1970 * 1000 - lastFetchAt > 3 * 86_400_000
    }

    var webcalURL: URL? { GatewayConfig.calendarURL(token: token, scheme: "webcal") }
    var httpsURL: URL? { GatewayConfig.calendarURL(token: token, scheme: nil) }

    static func from(_ json: JSONValue) -> AssistantCalendar? {
        guard let row = json.object, let token = row["token"]?.string, !token.isEmpty else { return nil }
        return AssistantCalendar(token: token, enabled: row["enabled"]?.bool ?? true, lastFetchAt: row["lastFetchAt"]?.number)
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

/// 投影枚举故意保留 String：网关追加 kind/phase/status 时，旧 App 仍能解码整条状态。
typealias PersonalTaskKind = String
typealias PersonalTaskPhase = String

struct TaskSourceRef: Codable, Sendable, Hashable {
    var kind: String
    var id: String

    static func from(_ json: JSONValue) -> TaskSourceRef? {
        guard let row = json.object,
              let kind = row["kind"]?.string,
              let id = row["id"]?.string,
              !kind.isEmpty,
              !id.isEmpty
        else { return nil }
        return TaskSourceRef(kind: kind, id: id)
    }
}

struct TaskReceipt: Codable, Sendable, Hashable {
    var id: String
    var status: String
    var at: Double
    var summary: String?

    static func from(_ json: JSONValue) -> TaskReceipt? {
        guard let row = json.object,
              let id = row["id"]?.string,
              let status = row["status"]?.string,
              !id.isEmpty,
              !status.isEmpty
        else { return nil }
        return TaskReceipt(
            id: id,
            status: status,
            at: row["at"]?.number ?? 0,
            summary: row["summary"]?.string?.nilIfEmpty
        )
    }
}

struct PersonalTaskAction: Codable, Sendable, Hashable {
    var label: String
    var op: String
    var id: String?
    var delegationId: String?
    var chatId: String?
    var callId: String?
    var allow: Bool?
    var enabled: Bool?

    static func from(_ json: JSONValue) -> PersonalTaskAction? {
        guard let row = json.object,
              let label = row["label"]?.string,
              let op = row["op"]?.string,
              !op.isEmpty
        else { return nil }
        let args = row["args"]?.object
        return PersonalTaskAction(
            label: label,
            op: op,
            id: args?["id"]?.string?.nilIfEmpty,
            delegationId: args?["delegationId"]?.string?.nilIfEmpty,
            chatId: args?["chatId"]?.string?.nilIfEmpty,
            callId: args?["callId"]?.string?.nilIfEmpty,
            allow: args?["allow"]?.bool,
            enabled: args?["enabled"]?.bool
        )
    }
}

struct PersonalTask: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var kind: PersonalTaskKind
    var title: String
    var phase: PersonalTaskPhase
    var status: String
    var priority: String
    var attention: String?
    var detail: String?
    var due: String?
    var dueAt: Double?
    var createdAt: Double
    var updatedAt: Double?
    var sources: [TaskSourceRef]
    var receipt: TaskReceipt?
    var actions: [PersonalTaskAction]

    static func from(_ json: JSONValue) -> PersonalTask? {
        guard let row = json.object,
              let id = row["id"]?.string,
              let kind = row["kind"]?.string,
              let phase = row["phase"]?.string,
              !id.isEmpty
        else { return nil }
        return PersonalTask(
            id: id,
            kind: kind,
            title: row["title"]?.string ?? "",
            phase: phase,
            status: row["status"]?.string ?? "",
            priority: row["priority"]?.string ?? "normal",
            attention: row["attention"]?.string?.nilIfEmpty,
            detail: row["detail"]?.string?.nilIfEmpty,
            due: row["due"]?.string?.nilIfEmpty,
            dueAt: row["dueAt"]?.number,
            createdAt: row["createdAt"]?.number ?? 0,
            updatedAt: row["updatedAt"]?.number,
            sources: row["sources"]?.array?.compactMap(TaskSourceRef.from) ?? [],
            receipt: row["receipt"].flatMap(TaskReceipt.from),
            actions: row["actions"]?.array?.compactMap(PersonalTaskAction.from) ?? []
        )
    }
}

struct DraftPreview: Codable, Sendable, Hashable {
    var kind: String
    var title: String
    var summary: String
    var details: [String]

    static func from(_ json: JSONValue) -> DraftPreview? {
        guard let row = json.object else { return nil }
        return DraftPreview(
            kind: row["kind"]?.string ?? "",
            title: row["title"]?.string ?? "",
            summary: row["summary"]?.string ?? "",
            details: row["details"]?.array?.compactMap(\.string) ?? []
        )
    }
}

struct DraftCard: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var kind: String
    var status: String
    var createdAt: Double
    var expiresAt: Double
    var preview: DraftPreview
    var sources: [TaskSourceRef]
    var actions: [PersonalTaskAction]

    static func from(_ json: JSONValue) -> DraftCard? {
        guard let row = json.object,
              let id = row["id"]?.string,
              let preview = row["preview"].flatMap(DraftPreview.from),
              !id.isEmpty
        else { return nil }
        return DraftCard(
            id: id,
            kind: row["kind"]?.string ?? "approval",
            status: row["status"]?.string ?? "waiting_user",
            createdAt: row["createdAt"]?.number ?? 0,
            expiresAt: row["expiresAt"]?.number ?? 0,
            preview: preview,
            sources: row["sources"]?.array?.compactMap(TaskSourceRef.from) ?? [],
            actions: row["actions"]?.array?.compactMap(PersonalTaskAction.from) ?? []
        )
    }
}

struct DayThreadEvent: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var kind: String
    var title: String
    var body: String?
    var at: Double
    var priority: String
    var taskId: String?
    var draftCardId: String?
    var sources: [TaskSourceRef]
    var receipt: TaskReceipt?

    static func from(_ json: JSONValue) -> DayThreadEvent? {
        guard let row = json.object,
              let id = row["id"]?.string,
              !id.isEmpty
        else { return nil }
        return DayThreadEvent(
            id: id,
            kind: row["kind"]?.string ?? "",
            title: row["title"]?.string ?? "",
            body: row["body"]?.string?.nilIfEmpty,
            at: row["at"]?.number ?? 0,
            priority: row["priority"]?.string ?? "normal",
            taskId: row["taskId"]?.string?.nilIfEmpty,
            draftCardId: row["draftCardId"]?.string?.nilIfEmpty,
            sources: row["sources"]?.array?.compactMap(TaskSourceRef.from) ?? [],
            receipt: row["receipt"].flatMap(TaskReceipt.from)
        )
    }
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
    /// Opaque conditional-fetch revision. Old gateways omit it.
    var revision: Int?
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
    /// P4 统一只读投影；老网关不带时为 nil，界面回落到 delegations。
    var personalTasks: [PersonalTask]?
    var draftCards: [DraftCard]?
    var dayThread: [DayThreadEvent]?
    /// P7 只读产物投影；老网关不带时为 nil。
    var artifacts: [Artifact]?
    var projectionVersion: Int?
    var snapshotAt: Double?
    /// 只有发过 assistant_get(memory: true) 的连接才带
    var memory: AssistantMemory?
    /// 老网关不带
    var calendar: AssistantCalendar?
    /// Original wire projection, retained for lossless background persistence.
    var rawJSON: JSONValue

    var unreadInbox: Int { inbox.filter { !$0.read }.count }

    static func from(_ json: JSONValue) -> AssistantState? {
        guard let row = json.object else { return nil }
        let background = row["background"]?.object
        let brief = row["brief"]?.object.flatMap { item -> AssistantBrief? in
            guard let text = item["text"]?.string else { return nil }
            return AssistantBrief(day: item["day"]?.string ?? "", text: text)
        }
        let revision: Int?
        if let value = row["revision"], value != .null {
            guard let number = value.number,
                  number.isFinite,
                  number > 0,
                  number == number.rounded(),
                  number <= Double(Int.max)
            else { return nil }
            revision = Int(number)
        } else {
            revision = nil
        }
        return AssistantState(
            revision: revision,
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
            personalTasks: row["personalTasks"]?.array?.compactMap(PersonalTask.from),
            draftCards: row["draftCards"]?.array?.compactMap(DraftCard.from),
            dayThread: row["dayThread"]?.array?.compactMap(DayThreadEvent.from),
            artifacts: row["artifacts"]?.array?.compactMap(Artifact.from),
            projectionVersion: row["projectionVersion"]?.int,
            snapshotAt: row["snapshotAt"]?.number,
            memory: row["memory"].flatMap(AssistantMemory.from),
            calendar: row["calendar"].flatMap(AssistantCalendar.from),
            rawJSON: json
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
    case workspaceRenamed(from: String, path: String, name: String)
    /// mode：deleted（空目录已删）/ hidden（有文件，只从列表隐藏）
    case workspaceRemoved(path: String, name: String, mode: String)
    case workspaceAgents(items: [WorkspaceAgentItem], avatarTicket: ImTicket, reset: Bool, more: Bool, after: String?, cursor: String?)
    case workspaceAgentOpened(path: String, chatId: String)
    case workspaceAgentUpdate(chatId: String, unread: Int, readSeq: Int, finishedSeq: Int)
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
    case error(chatId: String?, message: String, reqId: String?)
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
    case chatTurns(chatId: String, turns: [JSONValue], from: Int, hasMore: Bool, nonce: Int?, chatRev: Int?)
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
    case files(
        query: String,
        paths: [String],
        mention: Bool,
        truncated: Bool,
        chatId: String?,
        status: [String: String],
        reqId: String?,
        error: String?
    )
    case searchHits(query: String, hits: [SearchHit], chatId: String?, truncated: Bool)
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
    /// 工作区文件已变化；客户端只刷新当前版本，不覆盖历史快照。
    case fileChanged(chatId: String, path: String)
    case undone(chatId: String, paths: [String], error: String?)
    case checkpoints(chatId: String, items: [CheckpointInfo])
    case restored(chatId: String, checkpointId: String?, label: String?, error: String?, silent: Bool)
    /// 个人助理全量状态（替换本地）
    case assistantState(AssistantState, reqId: String?, generation: Int?)
    /// 条件拉取命中；旧网关不会发送。
    case assistantNotModified(revision: Int, reqId: String?, generation: Int?)
    case assistantResult(reqId: String?, op: String, ok: Bool, error: String?, data: JSONValue?)
    case inboxItem(AssistantInboxItem)
    /// 委派开始、待批、继续、完成、失败时下发；approval 只在待批时带
    case delegationState(delegation: AssistantDelegation, approval: AssistantApproval?)
    case memoryWritten(chatId: String?, entry: AssistantMemoryEntry)
    /// 交给本地 coordinator；本层只解码，不执行 EventKit，也不自动回成功。
    case deviceInvoke(DeviceInvoke)
    /// 即时消息的全部下行（im_contacts / im_list / im_history / im_ack / im_message / im_update / im_error）
    case im(ImEvent)
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
             .chatTitle(let chatId, _),
             .workspaceAgentUpdate(let chatId, _, _, _):
            return chatId
        case .status(let chatId, _, _), .error(let chatId, _, _):
            return chatId
        case .fileUploaded(_, let chatId, _, _, _, _):
            return chatId
        case .files(_, _, _, _, let chatId, _, _, _):
            return chatId
        case .fileContent(_, let chatId, _, _, _, _, _, _, _, _, _, _, _):
            return chatId
        case .turnFiles(let chatId, _, _):
            return chatId
        case .fileChanged(let chatId, _):
            return chatId
        case .undone(let chatId, _, _),
             .checkpoints(let chatId, _),
             .restored(let chatId, _, _, _, _):
            return chatId
        case .chatTurns(let chatId, _, _, _, _, _):
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
        case "device_invoke":
            let approval: DeviceApproval?
            if let row = object["approval"]?.object {
                approval = DeviceApproval(
                    summary: row["summary"]?.string ?? "",
                    risk: row["risk"]?.string ?? "",
                    requiresConfirmation: row["requiresConfirmation"]?.bool ?? false
                )
            } else {
                approval = nil
            }
            return .deviceInvoke(DeviceInvoke(
                reqId: object["reqId"]?.string ?? "",
                op: object["op"]?.string ?? "",
                params: object["params"] ?? .object([:]),
                timeoutMs: object["timeoutMs"]?.int ?? 0,
                idempotencyKey: object["idempotencyKey"]?.string,
                approval: approval
            ))
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
        case "workspace_renamed":
            return .workspaceRenamed(
                from: object["from"]?.string ?? "",
                path: object["path"]?.string ?? "",
                name: object["name"]?.string ?? ""
            )
        case "workspace_removed":
            return .workspaceRemoved(
                path: object["path"]?.string ?? "",
                name: object["name"]?.string ?? "",
                mode: object["mode"]?.string ?? "hidden"
            )
        case "workspace_agents":
            let items = object["workspaces"]?.array?.compactMap { value -> WorkspaceAgentItem? in
                guard let row = value.object, let path = row["path"]?.string?.nilIfEmpty else { return nil }
                return WorkspaceAgentItem(
                    path: path,
                    directoryName: row["directoryName"]?.string ?? workspaceName(path),
                    displayName: row["displayName"]?.string ?? workspaceName(path),
                    avatarBlob: row["avatarBlob"]?.string?.nilIfEmpty,
                    mainChatId: row["mainChatId"]?.string?.nilIfEmpty,
                    status: row["status"]?.string ?? "idle",
                    unread: row["unread"]?.int ?? 0,
                    readSeq: row["readSeq"]?.int ?? 0,
                    finishedSeq: row["finishedSeq"]?.int ?? 0,
                    lastActivityAt: row["lastActivityAt"]?.number ?? 0
                )
            } ?? []
            let ticketRow = object["avatarTicket"]?.object
            let ticket = ImTicket(
                exp: ticketRow?["exp"]?.number ?? 0,
                sig: ticketRow?["sig"]?.string ?? ""
            )
            return .workspaceAgents(
                items: items,
                avatarTicket: ticket,
                reset: object["reset"]?.bool ?? true,
                more: object["more"]?.bool ?? false,
                after: object["after"]?.string,
                cursor: object["cursor"]?.string
            )
        case "workspace_agent_opened":
            return .workspaceAgentOpened(path: object["path"]?.string ?? "", chatId: chatId)
        case "workspace_agent_update":
            return .workspaceAgentUpdate(
                chatId: chatId,
                unread: object["unread"]?.int ?? 0,
                readSeq: object["readSeq"]?.int ?? 0,
                finishedSeq: object["finishedSeq"]?.int ?? 0
            )
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
            return .error(
                chatId: object["chatId"]?.string,
                message: object["message"]?.string ?? "",
                reqId: object["reqId"]?.string
            )
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
                nonce: object["nonce"]?.int,
                chatRev: object["chatRev"]?.int
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
                status: gitLetters(object["status"]),
                reqId: object["reqId"]?.string,
                error: object["error"]?.string
            )
        case "search_hits":
            return .searchHits(
                query: object["query"]?.string ?? "",
                hits: object["hits"]?.array?.compactMap(SearchHit.from) ?? [],
                chatId: object["chatId"]?.string,
                truncated: object["truncated"]?.bool ?? false
            )
        case "file_content":
            let ticketRow = object["media"]?.object
            let media = ticketRow.flatMap { row -> MediaTicket? in
                guard let exp = row["exp"]?.number, let sig = row["sig"]?.string else { return nil }
                return MediaTicket(exp: exp, sig: sig)
            }
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
                media: media,
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
        case "file_changed":
            guard !chatId.isEmpty, let path = object["path"]?.string?.nilIfEmpty else { return .ignored(type) }
            return .fileChanged(chatId: chatId, path: path)
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
            return .assistantState(
                state,
                reqId: object["reqId"]?.string,
                generation: object["generation"]?.int
            )
        case "assistant_not_modified":
            guard let number = object["revision"]?.number,
                  number.isFinite,
                  number > 0,
                  number == number.rounded(),
                  number <= Double(Int.max)
            else { return .ignored(type) }
            return .assistantNotModified(
                revision: Int(number),
                reqId: object["reqId"]?.string,
                generation: object["generation"]?.int
            )
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
        case _ where type.hasPrefix("im_") || type == "collab_state":
            guard let event = ImEvent.decode(type: type, object) else { return .ignored(type) }
            return .im(event)
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

    /// 日历订阅地址：scheme 传 "webcal" 让系统直接弹「订阅日历」，nil 保留 http(s) 供复制
    static func calendarURL(token: String, scheme: String?) -> URL? {
        var components = URLComponents(url: derive(path: "/media/cal/\(token).ics"), resolvingAgainstBaseURL: false)
        if let scheme { components?.scheme = scheme }
        return components?.url
    }

    /// stored_state 的 HTTP 拉取通道（WS 单条消息超 maxMessageBytes 时的兜底）。
    /// slim=1：与 WS cap 对齐——slim 客户端走 HTTP 回落时也只拿元数据壳（Grok 评审 MINOR4）
    static var stateURL: URL {
        var url = derive(path: "/state")
        url.append(queryItems: [URLQueryItem(name: "slim", value: "1")])
        return url
    }

    static func stateTurnURL(chatId: String, turnId: String) -> URL {
        var url = derive(path: "/state/turn")
        url.append(queryItems: [
            URLQueryItem(name: "chatId", value: chatId),
            URLQueryItem(name: "turnId", value: turnId),
        ])
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
