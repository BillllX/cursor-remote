import Foundation

// Mirrors shared/protocol.ts. Keep field names and `type` tags in sync with the TypeScript source.

enum AgentMode: String, Sendable, Hashable, CaseIterable {
    case agent
    case plan
    case ask

    var label: String {
        switch self {
        case .agent: return "代理"
        case .plan: return "计划"
        case .ask: return "询问"
        }
    }
}

struct WorkspaceItem: Sendable, Hashable, Identifiable {
    var path: String
    var name: String
    var id: String { path }
}

struct PromptImage: Sendable, Hashable {
    var data: String
    var mimeType: String
}

/// /media 下载票据（file_content 带过来，签名过期由网关校验）
struct MediaTicket: Sendable, Hashable {
    var exp: Double
    var sig: String
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
            caps: ["sync_chat", "stored_digest", "slim_state"]
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
        policy: String?
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
    /// P5：读工作区文件内容（diff=true 拿 unified diff）；应答是 file_content
    case readFile(path: String, chatId: String?, diff: Bool)
    case undo(chatId: String)
    case ping
    /// P4b：单会话增量上传（只带变化的那个会话）
    case syncChat(chat: JSONValue, rev: Int)
    /// P4c：stored_digest 后按需拉取单个会话全量
    case loadChats(ids: [String])
    /// P8 slim：会话内容分页。from 省略=最后一页，否则拉 turns[..<from] 的上一页
    case loadChat(chatId: String, from: Int?)

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
        case .prompt(let text, let model, let mode, let chatId, let files, let images, let confirmWrites, let autoApprove, let fresh, let nameChat, let policy):
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
        case .readFile(let path, let chatId, let diff):
            var object: [String: JSONValue] = ["type": .string("read_file"), "path": .string(path)]
            if let chatId { object["chatId"] = .string(chatId) }
            if diff { object["diff"] = .bool(true) }
            return .object(object)
        case .undo(let chatId):
            return .object(["type": .string("undo"), "chatId": .string(chatId)])
        case .ping:
            return .object(["type": .string("ping")])
        case .syncChat(let chat, let rev):
            return .object(["type": .string("sync_chat"), "chat": chat, "rev": .number(Double(rev))])
        case .loadChats(let ids):
            return .object(["type": .string("load_chats"), "ids": .array(ids.map { .string($0) })])
        case .loadChat(let chatId, let from):
            var obj: [String: JSONValue] = ["type": .string("load_chat"), "chatId": .string(chatId)]
            if let from { obj["from"] = .number(Double(from)) }
            return .object(obj)
        }
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
        tenantName: String?
    )
    case workspaces(root: String, items: [WorkspaceItem])
    case workspaceCreated(path: String, name: String)
    case session(chatId: String, agentId: String, cwd: String)
    case runMeta(chatId: String, model: String, mode: AgentMode?)
    case textDelta(chatId: String, text: String)
    case thinkingDelta(chatId: String, text: String)
    case toolStarted(chatId: String, callId: String, name: String, args: JSONValue?, parentCallId: String?, agent: String?, model: String?)
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
    case syncAck(rev: Int?, chatRevs: [String: Int])
    /// P4c：分叉时的目录推送（比对 chatRevs 后用 loadChats 拉差异会话）
    case storedDigest(rev: Int?, deletedIds: [String], chatRevs: [String: Int])
    /// P4c：load_chats 的应答（单个会话全量——slim 客户端也是全量：digest 对账是跨设备 turns 更新唯一通道）
    case storedChat(chat: JSONValue, rev: Int?)
    /// P8 slim：load_chat 的应答（turns[from..] 一页；hasMore=前面还有）
    case chatTurns(chatId: String, turns: [JSONValue], from: Int, hasMore: Bool)
    case auth(ok: Bool, message: String?)
    case history(chatId: String, turns: [JSONValue])
    case chatTitle(chatId: String, title: String)
    case fileUploaded(path: String, chatId: String?, name: String?, error: String?, size: Double?, id: String?)
    case files(query: String, paths: [String], mention: Bool, truncated: Bool, chatId: String?)
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
        media: MediaTicket?
    )
    case undone(chatId: String, paths: [String], error: String?)
    case pong
    case ignored(String)

    var chatId: String? {
        switch self {
        case .session(let chatId, _, _),
             .runMeta(let chatId, _, _),
             .textDelta(let chatId, _),
             .thinkingDelta(let chatId, _),
             .toolStarted(let chatId, _, _, _, _, _, _),
             .toolCompleted(let chatId, _, _, _, _, _, _, _),
             .toolOutput(let chatId, _, _, _, _, _),
             .task(let chatId, _),
             .approval(let chatId, _, _, _),
             .done(let chatId, _, _),
             .history(let chatId, _),
             .chatTitle(let chatId, _):
            return chatId
        case .status(let chatId, _, _), .error(let chatId, _):
            return chatId
        case .fileUploaded(_, let chatId, _, _, _, _):
            return chatId
        case .files(_, _, _, _, let chatId):
            return chatId
        case .fileContent(_, let chatId, _, _, _, _, _, _, _, _, _):
            return chatId
        case .undone(let chatId, _, _):
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
                tenantName: object["tenantName"]?.string
            )
        case "workspaces":
            let items = object["items"]?.array?.compactMap { item -> WorkspaceItem? in
                guard let row = item.object, let path = row["path"]?.string else { return nil }
                return WorkspaceItem(path: path, name: row["name"]?.string ?? URL(fileURLWithPath: path).lastPathComponent)
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
                model: object["model"]?.string
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
            return .syncAck(rev: object["rev"]?.int, chatRevs: object["chatRevs"]?.intMap ?? [:])
        case "stored_digest":
            return .storedDigest(
                rev: object["rev"]?.int,
                deletedIds: object["deletedIds"]?.array?.compactMap(\.string) ?? [],
                chatRevs: object["chatRevs"]?.intMap ?? [:]
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
                hasMore: object["hasMore"]?.bool ?? false
            )
        case "auth":
            return .auth(ok: object["ok"]?.bool ?? false, message: object["message"]?.string)
        case "history":
            return .history(chatId: chatId, turns: object["turns"]?.array ?? [])
        case "chat_title":
            return .chatTitle(chatId: chatId, title: object["title"]?.string ?? "")
        case "files":
            // 网关还会回 git status（M/A/D/U/R），iOS 自 P7 后决定不展示改动，忽略该字段
            return .files(
                query: object["query"]?.string ?? "",
                paths: object["paths"]?.array?.compactMap(\.string) ?? [],
                mention: object["mention"]?.bool ?? false,
                truncated: object["truncated"]?.bool ?? false,
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
                }
            )
        case "undone":
            return .undone(
                chatId: chatId,
                paths: object["paths"]?.array?.compactMap(\.string) ?? [],
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

    /// 带查询参数的 /media 下载地址（Bearer 鉴权在请求头里加）
    static func mediaURL(path: String, chatId: String) -> URL {
        var components = URLComponents(url: mediaBaseURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "chatId", value: chatId),
        ]
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
