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
        nameChat: Bool?
    )
    case cancel(chatId: String)
    case dropQueued(chatId: String, text: String?)
    case setModel(model: String, chatId: String?)
    case newSession(chatId: String, cwd: String?)
    case deleteSession(chatId: String)
    case resumeSession(chatId: String, agentId: String)
    case syncState(chats: JSONValue, rev: Int?)
    case approvalReply(chatId: String, callId: String, allow: Bool)
    case ping

    func json() -> JSONValue {
        switch self {
        case .hello(let token):
            var object: [String: JSONValue] = ["type": .string("hello")]
            if let token, !token.isEmpty { object["token"] = .string(token) }
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
        case .prompt(let text, let model, let mode, let chatId, let files, let images, let confirmWrites, let autoApprove, let fresh, let nameChat):
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
        case .ping:
            return .object(["type": .string("ping")])
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
    case storedState(chats: [JSONValue], rev: Int?, deletedIds: [String])
    case auth(ok: Bool, message: String?)
    case history(chatId: String, turns: [JSONValue])
    case chatTitle(chatId: String, title: String)
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
                deletedIds: object["deletedIds"]?.array?.compactMap(\.string) ?? []
            )
        case "auth":
            return .auth(ok: object["ok"]?.bool ?? false, message: object["message"]?.string)
        case "history":
            return .history(chatId: chatId, turns: object["turns"]?.array ?? [])
        case "chat_title":
            return .chatTitle(chatId: chatId, title: object["title"]?.string ?? "")
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
}
