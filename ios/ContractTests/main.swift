// iOS 协议契约测试（Linux / macOS 命令行，不进 App target）。
// 1. 读 shared/fixtures/protocol.json，每条 server 样本走 ServerMessage.decode(from:)，
//    确定性地打印解码结果，与 server-decode.snapshot.txt 比对（--update 重写）。
// 2. 解码成 .ignored 的 type 必须列在 ios-ignored-server-types.txt，列了的必须解码成 .ignored。
// 3. 为 ClientMessage 每个 case 造一条样本，编码成 JSON 写到 --client-out，交给 TS 脚本查字段。
// 由 scripts/check-ios-protocol.sh 编译运行。
import Foundation
#if canImport(JieboProtocol)
@testable import JieboProtocol
#endif

// MARK: 参数

struct Options {
    var fixtures = ""
    var snapshot = ""
    var ignored = ""
    var clientOut = ""
    var actual: String?
    var update = false
}

func parseOptions() -> Options {
    var options = Options()
    var args = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = args.next() {
        switch arg {
        case "--fixtures": options.fixtures = args.next() ?? ""
        case "--snapshot": options.snapshot = args.next() ?? ""
        case "--ignored": options.ignored = args.next() ?? ""
        case "--client-out": options.clientOut = args.next() ?? ""
        case "--actual": options.actual = args.next()
        case "--update": options.update = true
        default:
            fail("不认识的参数：\(arg)")
        }
    }
    if options.fixtures.isEmpty || options.snapshot.isEmpty || options.ignored.isEmpty || options.clientOut.isEmpty {
        fail("用法：contract --fixtures <json> --snapshot <txt> --ignored <txt> --client-out <json> [--actual <txt>] [--update]")
    }
    return options
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("❌ \(message)\n".utf8))
    exit(1)
}

// MARK: 确定性打印

func formatNumber(_ value: Double) -> String {
    if value.isFinite, value == value.rounded(), abs(value) < 1e15 { return String(Int64(value)) }
    return String(value)
}

func quote(_ text: String) -> String { text.debugDescription }

/// JSONValue 打成紧凑 JSON，键按字典序
func renderJSON(_ value: JSONValue) -> String {
    switch value {
    case .string(let text): return quote(text)
    case .number(let number): return formatNumber(number)
    case .bool(let flag): return flag ? "true" : "false"
    case .null: return "null"
    case .array(let items): return "[" + items.map(renderJSON).joined(separator: ", ") + "]"
    case .object(let object):
        return "{" + object.keys.sorted().map { "\(quote($0)): \(renderJSON(object[$0]!))" }.joined(separator: ", ") + "}"
    }
}

/// Mirror 递归：字典按键排序，浮点固定格式，类只打类型名和字段（不打地址）
func render(_ value: Any, _ indent: String) -> String {
    switch value {
    case let json as JSONValue: return "JSON " + renderJSON(json)
    case let text as String: return quote(text)
    case let flag as Bool: return flag ? "true" : "false"
    case let number as Int: return String(number)
    case let number as Double: return formatNumber(number)
    default: break
    }
    let mirror = Mirror(reflecting: value)
    let inner = indent + "  "
    switch mirror.displayStyle {
    case .optional:
        guard let child = mirror.children.first else { return "nil" }
        return render(child.value, indent)
    case .enum:
        guard let child = mirror.children.first else { return ".\(value)" }
        let payload = Mirror(reflecting: child.value)
        if payload.displayStyle == .tuple {
            return ".\(child.label ?? "?")" + renderFields(payload, indent)
        }
        return ".\(child.label ?? "?")(" + render(child.value, indent) + ")"
    case .collection, .set:
        if mirror.children.isEmpty { return "[]" }
        var items = mirror.children.map { inner + render($0.value, inner) }
        if mirror.displayStyle == .set { items.sort() }
        return "[\n" + items.joined(separator: "\n") + "\n\(indent)]"
    case .dictionary:
        if mirror.children.isEmpty { return "[:]" }
        let rows = mirror.children.map { pair -> (String, String) in
            let parts = Array(Mirror(reflecting: pair.value).children)
            return (render(parts[0].value, inner), render(parts[1].value, inner))
        }.sorted { $0.0 < $1.0 }
        return "[\n" + rows.map { "\(inner)\($0.0): \($0.1)" }.joined(separator: "\n") + "\n\(indent)]"
    case .struct, .class, .tuple:
        return "\(type(of: value))" + renderFields(mirror, indent)
    default:
        return String(describing: value)
    }
}

func renderFields(_ mirror: Mirror, _ indent: String) -> String {
    if mirror.children.isEmpty { return "()" }
    let inner = indent + "  "
    let rows = mirror.children.map { "\(inner)\($0.label ?? "_"): \(render($0.value, inner))" }
    return "(\n" + rows.joined(separator: "\n") + "\n\(indent))"
}

// MARK: server 样本

func loadIgnoredList(_ path: String) -> [String: String] {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { fail("读不到 \(path)") }
    var list: [String: String] = [:]
    for (index, raw) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.isEmpty || line.hasPrefix("#") { continue }
        let parts = line.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "\t" })
        let type = String(parts[0])
        let reason = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
        if reason.isEmpty { fail("\(path) 第 \(index + 1) 行：\(type) 后面要写理由") }
        if list[type] != nil { fail("\(path) 第 \(index + 1) 行：\(type) 重复") }
        list[type] = reason
    }
    return list
}

func checkServer(_ options: Options, samples: [JSONValue]) -> [String] {
    let ignoredList = loadIgnoredList(options.ignored)
    var problems: [String] = []
    var lines = [
        "# ServerMessage.decode(from:) 对 shared/fixtures/protocol.json 每条 server 样本的解码结果。",
        "# 由 npm run check:ios-protocol -- --update 生成，不要手改。",
        "",
    ]
    var seenTypes = Set<String>()
    var ordinal: [String: Int] = [:]
    for (index, sample) in samples.enumerated() {
        let type = sample["type"]?.string ?? ""
        seenTypes.insert(type)
        ordinal[type, default: 0] += 1
        let message: ServerMessage
        do {
            message = try ServerMessage.decode(from: try sample.data())
        } catch {
            problems.append("server[\(index)] \(type)：解码抛错 \(error)")
            continue
        }
        lines.append("## server[\(index)] \(type) #\(ordinal[type]!)")
        lines.append(render(message, ""))
        lines.append("")
        let isIgnored: Bool
        if case .ignored = message { isIgnored = true } else { isIgnored = false }
        if isIgnored, ignoredList[type] == nil {
            problems.append("server[\(index)] \(type)：iOS 解码成 .ignored，但不在 ios-ignored-server-types.txt 里（要么补解码，要么写进清单并说明理由）")
        }
        if !isIgnored, ignoredList[type] != nil {
            problems.append("server[\(index)] \(type)：列在 ios-ignored-server-types.txt 里，但 iOS 已经能解码了，从清单删掉")
        }
    }
    for type in ignoredList.keys.sorted() where !seenTypes.contains(type) {
        problems.append("ios-ignored-server-types.txt 里的 \(type) 没有对应的 server 样本（TS 里删掉了？）")
    }

    let actual = lines.joined(separator: "\n")
    if options.update {
        do {
            try actual.write(toFile: options.snapshot, atomically: true, encoding: .utf8)
        } catch {
            fail("写不了 \(options.snapshot)：\(error)")
        }
        print("已更新 server 解码快照：\(samples.count) 条")
    } else {
        let expected = (try? String(contentsOfFile: options.snapshot, encoding: .utf8)) ?? ""
        if expected != actual {
            if let path = options.actual { try? actual.write(toFile: path, atomically: true, encoding: .utf8) }
            problems.append("server 解码结果与 \(options.snapshot) 不一致（确认是预期变化后跑 npm run check:ios-protocol -- --update）")
        } else {
            print("server 解码快照一致：\(samples.count) 条，iOS 不处理的 type \(ignoredList.count) 个")
        }
    }
    return problems
}

// MARK: client 样本

/// 与 ClientMessage 一一对应。ClientMessage 加了 case，clientCase(of:) 的 switch 编译不过；
/// 这里补上 case 后 sample(_:) 的 switch 又编译不过，逼着补样本
enum ClientCase: String, CaseIterable {
    case hello, setWorkspace, listWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace
    case workspaceAgentList, workspaceAgentOpen, workspaceAgentProfile, workspaceAgentRead, workspaceAgentViewing
    case prompt, cancel
    case dropQueued, setModel, newSession, deleteSession, resumeSession, syncState, approvalReply, setPolicy
    case uploadFile, listFiles, searchText, revertFile, listCheckpoints, restore, readFile, writeFile, undo, ping
    case syncChat, truncateTurns, toolReview, loadChats, loadChat, loadState, adminStats, loopStart, loopStop
    case assistantGet, assistantOp
    case imContacts, imList, imHistory, imSend, imRecall, imRead, imSettings, imProfile, imBlock, imPresence
    case deviceResult, devicePermissionReport
}

func clientCase(of message: ClientMessage) -> ClientCase {
    switch message {
    case .hello: return .hello
    case .setWorkspace: return .setWorkspace
    case .listWorkspaces: return .listWorkspaces
    case .createWorkspace: return .createWorkspace
    case .renameWorkspace: return .renameWorkspace
    case .deleteWorkspace: return .deleteWorkspace
    case .workspaceAgentList: return .workspaceAgentList
    case .workspaceAgentOpen: return .workspaceAgentOpen
    case .workspaceAgentProfile: return .workspaceAgentProfile
    case .workspaceAgentRead: return .workspaceAgentRead
    case .workspaceAgentViewing: return .workspaceAgentViewing
    case .prompt: return .prompt
    case .cancel: return .cancel
    case .dropQueued: return .dropQueued
    case .setModel: return .setModel
    case .newSession: return .newSession
    case .deleteSession: return .deleteSession
    case .resumeSession: return .resumeSession
    case .syncState: return .syncState
    case .approvalReply: return .approvalReply
    case .setPolicy: return .setPolicy
    case .uploadFile: return .uploadFile
    case .listFiles: return .listFiles
    case .searchText: return .searchText
    case .revertFile: return .revertFile
    case .listCheckpoints: return .listCheckpoints
    case .restore: return .restore
    case .readFile: return .readFile
    case .writeFile: return .writeFile
    case .undo: return .undo
    case .ping: return .ping
    case .syncChat: return .syncChat
    case .truncateTurns: return .truncateTurns
    case .toolReview: return .toolReview
    case .loadChats: return .loadChats
    case .loadChat: return .loadChat
    case .loadState: return .loadState
    case .adminStats: return .adminStats
    case .loopStart: return .loopStart
    case .loopStop: return .loopStop
    case .assistantGet: return .assistantGet
    case .assistantOp: return .assistantOp
    case .imContacts: return .imContacts
    case .imList: return .imList
    case .imHistory: return .imHistory
    case .imSend: return .imSend
    case .imRecall: return .imRecall
    case .imRead: return .imRead
    case .imSettings: return .imSettings
    case .imProfile: return .imProfile
    case .imBlock: return .imBlock
    case .imPresence: return .imPresence
    case .deviceResult: return .deviceResult
    case .devicePermissionReport: return .devicePermissionReport
    }
}

let conv = "dm~alice~bob-2"
let blobA = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
let blobB = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"

let chat = "c-7f3a9e21"
let turn = "t-1739000000000-k2"
let slimChat: JSONValue = .object([
    "id": .string(chat),
    "title": .string("修登录"),
    "updatedAt": .number(1_739_000_009_000),
])

/// 可选参数都给值，布尔取非默认值
func sample(_ which: ClientCase) -> ClientMessage {
    switch which {
    case .hello: return .hello(token: "example-token")
    case .deviceResult:
        return .deviceResult(
            reqId: "dev-req-01",
            op: "calendar_event_upsert",
            status: "ok",
            result: .object(["id": .string("event-42")]),
            error: nil,
            externalId: "event-42"
        )
    case .devicePermissionReport:
        return .devicePermissionReport(
            reqId: "dev-req-01",
            grants: [.object(["permission": .string("calendar"), "status": .string("authorized"), "canRequest": .bool(false)])]
        )
    case .setWorkspace: return .setWorkspace(cwd: "/workspace/demo/notes", chatId: chat, create: true)
    case .listWorkspaces: return .listWorkspaces
    case .createWorkspace: return .createWorkspace(name: "slides")
    case .renameWorkspace: return .renameWorkspace(path: "/workspace/demo/slides", name: "talks")
    case .deleteWorkspace: return .deleteWorkspace(path: "/workspace/demo/old")
    case .workspaceAgentList: return .workspaceAgentList(cursor: "notes")
    case .workspaceAgentOpen: return .workspaceAgentOpen(path: "/workspace/demo/notes")
    case .workspaceAgentProfile:
        return .workspaceAgentProfile(path: "/workspace/demo/notes", displayName: "讲稿项目", avatar: blobA)
    case .workspaceAgentRead: return .workspaceAgentRead(chatId: chat, seq: 9)
    case .workspaceAgentViewing: return .workspaceAgentViewing(chatId: chat)
    case .prompt:
        return .prompt(
            text: "登录页白屏，帮我看看",
            model: "claude-4.6-sonnet",
            mode: .plan,
            chatId: chat,
            files: ["src/login.ts"],
            images: [PromptImage(data: "iVBORw0KGgo=", mimeType: "image/png")],
            confirmWrites: true,
            autoApprove: true,
            fresh: true,
            nameChat: true,
            policy: "plane",
            history: [HistoryItem(role: "user", text: "上次的问题"), HistoryItem(role: "assistant", text: "上次的回答")],
            turnId: turn
        )
    case .cancel: return .cancel(chatId: chat)
    case .dropQueued: return .dropQueued(chatId: chat, text: "再加个测试")
    case .setModel: return .setModel(model: "claude-4.6-sonnet", chatId: chat)
    case .newSession: return .newSession(chatId: chat, cwd: "/workspace/demo/notes")
    case .deleteSession: return .deleteSession(chatId: chat)
    case .resumeSession: return .resumeSession(chatId: chat, agentId: "agent-4d2c8b6a-0e1f")
    case .syncState: return .syncState(chats: .array([slimChat]), rev: 41)
    case .approvalReply: return .approvalReply(chatId: chat, callId: "call-w1", allow: true)
    case .setPolicy: return .setPolicy(policy: "plane", chatId: chat)
    case .uploadFile:
        return .uploadFile(chatId: chat, name: "截图.png", data: "iVBORw0KGgo=", mimeType: "image/png", id: "up-3")
    case .listFiles: return .listFiles(query: "login", chatId: chat, mention: true)
    case .searchText: return .searchText(query: "await guard", chatId: chat)
    case .revertFile: return .revertFile(chatId: chat, path: "src/login.ts")
    case .listCheckpoints: return .listCheckpoints(chatId: chat)
    case .restore: return .restore(chatId: chat, checkpointId: "cp-2")
    case .readFile: return .readFile(path: "src/login.ts", chatId: chat, diff: true, sha: "9a8b7c6d", reqId: "rq-17")
    case .writeFile: return .writeFile(path: "notes/todo.md", content: "- [ ] 回报价\n", chatId: chat)
    case .undo: return .undo(chatId: chat)
    case .ping: return .ping
    case .syncChat: return .syncChat(chat: slimChat, rev: 41)
    case .truncateTurns: return .truncateTurns(chatId: chat, turnId: turn, rev: 42)
    case .toolReview:
        return .toolReview(chatId: chat, turnId: turn, reviews: [["callId": .string("call-w1"), "review": .string("rejected")]])
    case .loadChats: return .loadChats(ids: [chat, "c-child-5b10"])
    case .loadChat: return .loadChat(chatId: chat, from: 100, nonce: 3)
    case .loadState: return .loadState
    case .adminStats: return .adminStats
    case .loopStart:
        return .loopStart(chatId: chat, goal: "每小时检查一次构建", intervalSec: 3600, maxTicks: 24, model: "composer-2.5", mode: .ask)
    case .loopStop: return .loopStop(chatId: chat)
    case .assistantGet: return .assistantGet(memory: true)
    case .assistantOp:
        return .assistantOp(op: "todo_add", args: ["text": .string("周三前回复报价"), "due": .string("2026-02-11")], reqId: "rq-todo-1")
    case .imContacts: return .imContacts
    case .imList: return .imList(cursor: "WzEsMTczOTAwMDAwMDAwMCwiZG1-YWxpY2V-Ym9iLTIiXQ", limit: 50)
    case .imHistory: return .imHistory(convId: conv, before: 50, after: 10, limit: 20)
    case .imSend:
        return .imSend(
            clientId: "c-ios-1739000003000-1",
            to: "bob-2",
            convId: conv,
            kind: "image",
            body: .image(blob: blobA, thumb: blobB, w: 1170, h: 2532, original: true),
            replyTo: 35
        )
    case .imRecall: return .imRecall(convId: conv, seq: 42)
    case .imRead: return .imRead(convId: conv, seq: 41)
    case .imSettings: return .imSettings(convId: conv, pin: true, mute: true, hideBefore: 3)
    case .imProfile: return .imProfile(nickname: "爱丽丝", avatar: "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e", notifyPreview: true)
    case .imBlock: return .imBlock(tenantId: "mallory", on: true)
    case .imPresence: return .imPresence(foreground: false)
    }
}

/// 每种消息体编码后再解回来要一样（本机缓存和 im_send 都靠它）
func checkImBodies() -> [String] {
    let bodies: [(String, ImBody)] = [
        ("text", .text("晚上一起吃饭？")),
        ("image", .image(blob: blobA, thumb: blobB, w: 1170, h: 2532, original: false)),
        ("voice", .voice(blob: blobA, durationMs: 12000, waveform: [0.1, 0.5, 0.9])),
        ("file", .file(blob: blobB, name: "报价单.pdf", size: 48213, mime: "application/pdf")),
        ("link", .link(url: "https://example.com/a", title: "示例", desc: nil, icon: blobB)),
        ("location", .location(lat: 31.2304, lng: 121.4737, name: "人民广场", address: "上海市黄浦区人民大道")),
    ]
    var problems: [String] = []
    for (kind, body) in bodies {
        let back = ImBody.from(kind: kind, body.json())
        if back != body { problems.append("ImBody \(kind) 编码再解码不一致：\(String(describing: back))") }
    }
    if ImConv.dm("bob-2", "alice") != conv { problems.append("ImConv.dm 排序不对") }
    if ImConv.peer(of: conv, me: "alice") != "bob-2" || ImConv.peer(of: conv, me: "bob-2") != "alice" {
        problems.append("ImConv.peer 解析不对")
    }
    if ImConv.peer(of: conv, me: "carol") != nil { problems.append("ImConv.peer 不含自己时应为 nil") }
    print("即时消息体往返：\(bodies.count) 种，\(problems.count) 条不符")
    return problems
}

func writeClientSamples(_ options: Options) -> [String] {
    var problems: [String] = []
    var rows: [JSONValue] = []
    for which in ClientCase.allCases {
        let message = sample(which)
        if clientCase(of: message) != which {
            problems.append("client 样本 \(which.rawValue) 构造成了 \(clientCase(of: message).rawValue)")
        }
        rows.append(.object(["case": .string(which.rawValue), "message": message.json()]))
    }
    do {
        try JSONValue.array(rows).data().write(to: URL(fileURLWithPath: options.clientOut))
    } catch {
        fail("写不了 \(options.clientOut)：\(error)")
    }
    print("client 样本已编码：\(rows.count) 条 → \(options.clientOut)")
    return problems
}

// MARK: 工具名判定（用例同 gateway/test/toolNames.test.ts、turnFiles.test.ts、web/test/toolKinds.test.ts）

func checkToolNames() -> [String] {
    var problems: [String] = []
    var count = 0
    func expect<T: Equatable>(_ label: String, _ name: String, _ actual: T, _ expected: T) {
        count += 1
        if actual != expected { problems.append("\(label)(\(quote(name))) = \(actual)，应为 \(expected)") }
    }
    for (name, words) in [("MultiEdit", "multi_edit"), ("StrReplace", "str_replace"), ("apply_patch", "apply_patch")] {
        expect("words", name, ToolNames.words(name), words)
    }
    for name in ["edit", "MultiEdit", "multiedit", "StrReplace", "search_replace", "apply_patch", "EditNotebook"] {
        expect("isEdit", name, ToolNames.isEdit(name), true)
    }
    for name in ["credit_check", "open_editor", "patchwork", "TodoWrite", "write"] {
        expect("isEdit", name, ToolNames.isEdit(name), false)
    }
    for name in ["Write", "write_file", "createFile", "create_files"] {
        expect("isWrite", name, ToolNames.isWrite(name), true)
    }
    for name in ["rewriter", "CreatePlan", "create_issue", "todo_write"] {
        expect("isWrite", name, ToolNames.isWrite(name), false)
    }
    for (name, value) in [("delete_file", true), ("Unlink", true), ("remove_label", false)] {
        expect("isDelete", name, ToolNames.isDelete(name), value)
    }
    for name in [
        "edit", "Write", "StrReplace", "apply_patch", "EditNotebook", "createFile", "generate_image", "GenerateImage",
        "image_gen", "MultiEdit", "multiedit", "search_replace", "str_replace_editor", "write_file", "mcp_fs_edit_file",
    ] {
        expect("writesFiles", name, ToolNames.writesFiles(name), true)
    }
    for name in [
        "todo_write", "TodoWrite", "CreatePlan", "delete", "delete_file", "remove", "read", "grep", "shell",
        "credit_check", "CreditCheck", "open_editor", "rewriter", "creator", "patchwork",
    ] {
        expect("writesFiles", name, ToolNames.writesFiles(name), false)
    }
    for (name, value) in [("GenerateImage", true), ("generate_image", true), ("image_gen", true), ("imagegen", true), ("read_image", false)] {
        expect("isImage", name, ToolNames.isImage(name), value)
    }
    for name in ["edit", "MultiEdit", "multiedit", "StrReplace", "apply_patch", "EditNotebook"] {
        expect("toolKind", name, ToolKind.from(name: name, args: nil).rawValue, "edit")
    }
    for name in ["Write", "write_file", "createFile", "delete_file", "unlink"] {
        expect("toolKind", name, ToolKind.from(name: name, args: nil).rawValue, "write")
    }
    for name in ["credit_check", "CreditCheck", "open_editor", "rewriter"] {
        expect("isMutating", name, ToolKind.from(name: name, args: nil).isMutating, false)
    }
    let kinds: [(String, JSONValue?, String)] = [
        ("TodoWrite", nil, "other"), ("CreatePlan", nil, "other"), ("Shell", nil, "shell"), ("grep", nil, "search"),
        ("read_file", nil, "read"), ("x", .object(["glob_pattern": .string("*.ts")]), "search"),
    ]
    for (name, args, kind) in kinds {
        expect("toolKind", name, ToolKind.from(name: name, args: args).rawValue, kind)
    }
    for (name, value) in [("MultiEdit", true), ("Write", true), ("read", false)] {
        expect("isMutating", name, ToolKind.from(name: name, args: nil).isMutating, value)
    }
    print("工具名判定：\(count) 条用例，\(problems.count) 条不符")
    return problems
}

// MARK: JSONValue 数字 / 布尔（JSON 里的 0/1 是数字，不能借 NSNumber 解成布尔）

func checkJSONValue() -> [String] {
    var problems: [String] = []
    let sample = Data(#"{"n0":0,"n1":1,"f":false,"t":true,"big":2}"#.utf8)
    guard let object = try? JSONValue.parse(sample).object else {
        return ["JSONValue：样例解析失败"]
    }
    func expectNumber(_ key: String) {
        guard case .number(let value)? = object[key] else {
            problems.append("JSONValue：\(key) 应解成 .number，实得 \(renderJSON(object[key] ?? .null))")
            return
        }
        let expected: Double = key == "n0" ? 0 : (key == "n1" ? 1 : 2)
        if value != expected { problems.append("JSONValue：\(key) = \(value)，应为 \(expected)") }
    }
    expectNumber("n0")
    expectNumber("n1")
    expectNumber("big")
    if case .bool? = object["n0"] { problems.append("JSONValue：数字 0 被解成了 .bool") }
    if case .bool? = object["n1"] { problems.append("JSONValue：数字 1 被解成了 .bool") }
    if case .bool(let f)? = object["f"], !f {} else { problems.append("JSONValue：false 应解成 .bool(false)") }
    if case .bool(let t)? = object["t"], t {} else { problems.append("JSONValue：true 应解成 .bool(true)") }
    print("JSONValue 数字 / 布尔：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

func checkDeviceRequestValidation() -> [String] {
    var problems: [String] = []
    func rejects(_ label: String, _ body: () throws -> Void) {
        do {
            try body()
            problems.append("device validation：\(label) 应拒绝")
        } catch {}
    }

    let valid: JSONValue = .object([
        "start": .string("2026-10-23T12:00:00.123Z"),
        "end": .string("2027-01-21T12:00:00.123Z"),
        "limit": .number(50),
    ])
    do {
        let parsed = try DeviceRequestValidator.calendarList(valid)
        if parsed.limit != 50 || parsed.end.timeIntervalSince(parsed.start) != DeviceRequestValidator.maximumRange {
            problems.append("device validation：合法 90 天范围或 limit 解析不符")
        }
    } catch {
        problems.append("device validation：合法 ISO 日期被拒绝：\(error)")
    }
    rejects("坏日期") {
        _ = try DeviceRequestValidator.calendarList(.object([
            "start": .string("2026/10/23"),
            "end": .string("2026-10-24T12:00:00Z"),
        ]))
    }
    rejects("超过 90 天") {
        _ = try DeviceRequestValidator.calendarList(.object([
            "start": .string("2026-01-01T00:00:00Z"),
            "end": .string("2026-04-02T00:00:01Z"),
        ]))
    }
    rejects("倒置日期") {
        _ = try DeviceRequestValidator.calendarEvent(.object([
            "title": .string("评审"),
            "start": .string("2026-10-24T10:00:00Z"),
            "end": .string("2026-10-24T09:00:00Z"),
        ]))
    }
    rejects("日历 limit 超限") {
        _ = try DeviceRequestValidator.calendarList(.object([
            "start": .string("2026-10-23T12:00:00Z"),
            "end": .string("2026-10-24T12:00:00Z"),
            "limit": .number(51),
        ]))
    }
    rejects("联系人 limit 超限") {
        _ = try DeviceRequestValidator.contactsSearch(.object([
            "query": .string("张"),
            "limit": .number(21),
        ]))
    }
    rejects("空联系人查询") {
        _ = try DeviceRequestValidator.contactsSearch(.object(["query": .string("  ")]))
    }
    if DeviceWriteConfirmationPolicy.begin(hasPendingConfirmation: true) != .busy {
        problems.append("device confirmation：已有确认时必须 busy")
    }
    if DeviceWriteConfirmationPolicy.outcome(allowed: false) != .denied {
        problems.append("device confirmation：拒绝必须映射为 denied")
    }
    print("设备桥参数与确认策略：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

func checkProductNavigation() -> [String] {
    var problems: [String] = []
    let navigationKeys = [
        "assistant", "collab", "workspace", "account", "overview", "chats", "files",
        "search", "git", "memory", "terminal", "loop", "stats",
    ]
    let statusKeys = [
        "normal", "running", "attention", "publishing", "succeeded", "cancelled",
        "error", "disabled", "unread",
    ]
    if NavigationIconId.allCases.map(\.rawValue) != navigationKeys {
        problems.append("product navigation：NavigationIconId 键或顺序不符")
    }
    if StatusLegendId.allCases.map(\.rawValue) != statusKeys {
        problems.append("product navigation：StatusLegendId 键或顺序不符")
    }
    if NavigationIconId.allCases.contains(where: { $0.symbol.isEmpty || $0.label.isEmpty }) {
        problems.append("product navigation：导航项缺 SF Symbol 或文案")
    }
    if StatusLegendId.allCases.contains(where: { $0.symbol.isEmpty || $0.label.isEmpty }) {
        problems.append("product navigation：状态项缺 SF Symbol 或文案")
    }
    if StatusLegendId.unread.accessibilityLabel(count: 3) != "未读 3"
        || StatusLegendId.running.accessibilityLabel(count: 3) != "运行中 3"
    {
        problems.append("product navigation：状态 accessibilityLabel(count:) 不符")
    }
    print("产品导航与状态语义：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

// MARK: turn_files 迟到合并

func checkDeferredTurnFiles() -> [String] {
    var pending = DeferredTurnFiles()
    let file = TurnFile(
        path: "Sources/App.swift",
        kind: .text,
        op: "modified",
        size: nil,
        sha: nil,
        diffSha: nil,
        added: 2,
        removed: 1
    )
    pending.store(chatId: "chat-a", turnId: "turn-late", files: [file])
    if !pending.take(chatId: "chat-a", availableTurnIds: []).isEmpty {
        return ["turn_files：回合出现前不应提前消费"]
    }
    let merged = pending.take(chatId: "chat-a", availableTurnIds: ["turn-late"])
    guard merged["turn-late"]?.first?.path == file.path else {
        return ["turn_files：回合出现后没有合并暂存文件"]
    }
    if !pending.isEmpty { return ["turn_files：成功合并后暂存没有清理"] }
    print("turn_files 迟到合并：通过")
    return []
}

// MARK: 回合文件来源 / 恢复合并

func checkTurnFilesState() -> [String] {
    var problems: [String] = []
    let provisionalJSON: JSONValue = .object([
        "id": .string("turn-files"),
        "assistant": .string("done"),
        "tools": .array([
            .object([
                "callId": .string("write-a"),
                "name": .string("Write"),
                "status": .string("completed"),
                "args": .object(["path": .string("A.swift")]),
            ]),
            .object([
                "callId": .string("write-b"),
                "name": .string("Write"),
                "status": .string("completed"),
                "args": .object(["path": .string("B.swift")]),
            ]),
        ]),
    ])
    guard let provisional = Turn.from(provisionalJSON) else { return ["turn files state：provisional 解析失败"] }
    if provisional.cardFilesState.source != .provisional || provisional.cardFiles.map(\.path) != ["A.swift", "B.swift"] {
        problems.append("turn files state：缺少 files 时没有按工具形成 provisional")
    }
    let settled = provisional.settled(status: "finished")
    if settled.filesSource != .provisional || settled.files.map(\.path) != ["A.swift", "B.swift"] {
        problems.append("turn files state：done 后没有冻结 provisional 清单")
    }

    let fileA = TurnFile(path: "A.swift", kind: .text, op: "modified", size: 10, sha: "sha-a", diffSha: "diff-a", added: 2, removed: 1)
    let fileB = TurnFile(path: "B.swift", kind: .text, op: "modified", size: 20, sha: "sha-b", diffSha: "diff-b", added: 3, removed: 0)
    var authoritative = provisional
    authoritative.files = [fileB, fileA]
    authoritative.filesSource = .authoritative
    let merged = provisional.mergingFiles(from: authoritative)
    if merged.cardFilesState.source != .authoritative || merged.cardFiles.map(\.path) != ["A.swift", "B.swift"] {
        problems.append("turn files state：权威切换没有保持 provisional 路径顺序")
    }
    if merged.cardFiles.first?.sha != "sha-a" || merged.cardFiles.first?.diffSha != "diff-a" {
        problems.append("turn files state：权威 sha/diffSha 没有合入")
    }
    var delegated = fileA
    delegated.sourceChatId = "child-chat"
    delegated.sourceTurnId = "child-turn"
    let delegatedRoundTrip = TurnFile.from(delegated.json())
    if delegatedRoundTrip?.sourceChatId != "child-chat" || delegatedRoundTrip?.sourceTurnId != "child-turn" {
        problems.append("turn files state：委派来源会话/回合没有协议往返")
    }

    var stale = provisional
    stale.files = []
    stale.filesSource = .none
    let preserved = merged.mergingFiles(from: stale)
    if preserved.filesSource != .authoritative || preserved.files.map(\.path) != ["A.swift", "B.swift"] {
        problems.append("turn files state：history 的无 files 旧副本抹掉了权威清单")
    }

    var empty = provisional
    empty.files = []
    empty.filesSource = .authoritative
    guard let restored = Turn.from(empty.json()) else {
        problems.append("turn files state：权威空数组无法恢复")
        print("回合文件来源 / 恢复合并：\(problems.count) 条不符")
        return problems
    }
    if restored.filesSource != .authoritative || !restored.cardFiles.isEmpty {
        problems.append("turn files state：权威空数组恢复后退回了工具推导")
    }

    print("回合文件来源 / 恢复合并：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

func checkMemoryCenter() -> [String] {
    var problems: [String] = []
    let overviewJSON = """
    {"mode":"overview","overview":{"personal":{"validEntries":2,"invalidEntries":0,"coreFieldLines":1,"workPreferenceLines":1,"paused":false,"coreBudget":1200,"coreTokens":10,"workPreferenceBudget":200},"scopes":[{"id":"personal","label":"关于我","kind":"personal","layer":"L0","memoryCount":2,"hot":2,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":1200,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0}],"scopesTruncated":true},"payloadTruncated":false}
    """
    guard let overviewValue = try? JSONValue.parse(Data(overviewJSON.utf8)),
          let parsed = MemoryCenterGetData.from(overviewValue)
    else {
        problems.append("memory center：overview JSON 无法解码")
        return problems
    }
    if parsed.mode != "overview" || parsed.overview?.personal.validEntries != 2 || parsed.overview?.scopes.count != 1 {
        problems.append("memory center：overview 字段不符")
    }
    if parsed.overview?.scopesTruncated != true {
        problems.append("memory center：scopesTruncated 未解码")
    }
    let detailJSON = """
    {"mode":"detail","detail":{"scope":{"id":"notes","label":"notes","kind":"workspace_memory","layer":"L2","memoryCount":1,"hot":1,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":600,"injectionSelected":1,"injectionSkipped":0,"pendingCount":0},"items":[{"id":"m1","kind":"workspace_memory","layer":"L2","scopeId":"notes","text":"hello","refs":["a.ts"],"missingRefs":[],"effectiveState":"hot","pinned":true,"revision":"rev1"}],"rules":[],"diagnostics":{"total":1,"selected":1,"skippedBudget":0,"hotSelected":1,"coldRecalled":0,"terminalSkipped":0,"pinnedSelected":1,"relevantSelected":0,"strategy":"test","selectedIds":[{"id":"m1","reason":"pinned"}],"skippedReasons":[]}},"payloadTruncated":true}
    """
    var detailParsed: MemoryCenterGetData?
    if let detailValue = try? JSONValue.parse(Data(detailJSON.utf8)) {
        detailParsed = MemoryCenterGetData.from(detailValue)
    }
    if detailParsed == nil {
        problems.append("memory center：detail JSON 无法解码")
    } else if detailParsed?.detail?.items.first?.refs != ["a.ts"] || detailParsed?.payloadTruncated != true {
        problems.append("memory center：detail 字段不符")
    }
    let searchJSON = """
    {"hits":[{"scopeId":"personal","kind":"personal","layer":"L0","id":"m1","text":"x","refs":[],"missingRefs":[],"effectiveState":"hot","reasons":["text"],"score":1}],"truncated":true}
    """
    guard let searchValue = try? JSONValue.parse(Data(searchJSON.utf8)),
          let search = MemoryCenterSearchData.from(searchValue)
    else {
        problems.append("memory center：search JSON 无法解码")
        return problems
    }
    if search.hits.count != 1 || !search.truncated || search.hits.first?.reasons.first != "text" {
        problems.append("memory center：search 字段不符")
    }

    var data = MemoryCenterDataState.initial
    data = MemoryCenterReducer.registerPending(
        data,
        req: MemoryCenterPendingRequest(reqId: "o1", kind: .overview, scopeId: nil, query: nil),
        replaceSameKind: true
    )
    let okOverview = MemoryCenterIncomingResult(
        reqId: "o1",
        op: "memory_center_get",
        ok: true,
        error: nil,
        getData: parsed,
        searchData: nil
    )
    if let applied = MemoryCenterReducer.applyResult(data, message: okOverview), applied.overview != nil {
        data = applied
    } else {
        problems.append("memory center reducer：overview 成功结果未应用")
    }
    data = MemoryCenterReducer.registerPending(
        data,
        req: MemoryCenterPendingRequest(reqId: "o2", kind: .overview, scopeId: nil, query: nil),
        replaceSameKind: true
    )
    let stale = MemoryCenterIncomingResult(
        reqId: "o1",
        op: "memory_center_get",
        ok: true,
        error: nil,
        getData: parsed,
        searchData: nil
    )
    if MemoryCenterReducer.applyResult(data, message: stale) != nil {
        problems.append("memory center reducer：非 pending 的 overview 响应不应应用")
    }

    var scopeData = MemoryCenterReducer.registerPending(
        MemoryCenterDataState.initial,
        req: MemoryCenterPendingRequest(reqId: "a1", kind: .scope, scopeId: "alpha", query: nil),
        replaceSameKind: true
    )
    scopeData = MemoryCenterReducer.registerPending(
        scopeData,
        req: MemoryCenterPendingRequest(reqId: "b1", kind: .scope, scopeId: "beta", query: nil),
        replaceSameKind: true
    )
    let betaDetailJSON = """
    {"mode":"detail","detail":{"scope":{"id":"beta","label":"beta","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0},"items":[],"rules":[],"diagnostics":null}}
    """
    if let betaValue = try? JSONValue.parse(Data(betaDetailJSON.utf8)),
       let betaPayload = MemoryCenterGetData.from(betaValue)
    {
        let betaOk = MemoryCenterIncomingResult(
            reqId: "b1", op: "memory_center_get", ok: true, error: nil, getData: betaPayload, searchData: nil
        )
        if let applied = MemoryCenterReducer.applyResult(scopeData, message: betaOk) {
            scopeData = applied
        } else {
            problems.append("memory center reducer：beta scope 成功结果未应用")
        }
        let alphaDetailJSON = """
        {"mode":"detail","detail":{"scope":{"id":"alpha","label":"alpha","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0},"items":[],"rules":[],"diagnostics":null}}
        """
        if let alphaValue = try? JSONValue.parse(Data(alphaDetailJSON.utf8)),
           let alphaPayload = MemoryCenterGetData.from(alphaValue)
        {
            let alphaStale = MemoryCenterIncomingResult(
                reqId: "a1", op: "memory_center_get", ok: true, error: nil, getData: alphaPayload, searchData: nil
            )
            if MemoryCenterReducer.applyResult(scopeData, message: alphaStale) != nil {
                problems.append("memory center reducer：过期 alpha scope 响应不应覆盖 beta")
            } else if scopeData.detail?.scope.id != "beta" {
                problems.append("memory center reducer：scope 乱序后 detail 不是 beta")
            }
        }
    }

    problems += checkMemoryCenterLayoutMetrics()
    problems += checkMemoryCenterDoubleColumnUI()
    problems += checkMemoryCenterNegativeDecode()
    problems += checkMemoryCenterNullableAccept()
    problems += checkMemoryCenterReducerLifecycle()
    problems += checkMemoryCenterExtrasRace()

    print("Memory center 结构解码：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

func checkMemoryCenterExtrasRace() -> [String] {
    var problems: [String] = []
    var state = MemoryCenterExtrasDataState.initial
    state = MemoryCenterExtrasReducer.beginActivityLoad(state, reqId: "a1", refresh: true)
    state = MemoryCenterExtrasReducer.beginActivityLoad(state, reqId: "a2", refresh: true)
    let sample = MemoryCenterActivityData(
        entries: [
            MemoryCenterActivityEntry(
                auditId: "aud1",
                scope: "ws",
                itemId: "wm1",
                action: "create",
                actor: "user",
                at: "2026-01-01T00:00:00.000Z",
                before: nil,
                after: MemoryCenterActivitySnapshotSummary(
                    id: "wm1",
                    section: "约定",
                    text: "x",
                    revision: "r1",
                    state: nil,
                    pinned: nil
                ),
                canRestore: true,
                restoreBlockedReason: nil,
                degraded: nil
            ),
        ],
        nextCursor: nil,
        truncated: nil,
        degraded: nil
    )
    if MemoryCenterExtrasReducer.applyActivity(state, reqId: "a1", generation: 1, append: false, cursor: nil, data: sample) != nil {
        problems.append("extras reducer：过期 generation 不应应用 activity")
    }
    if let applied = MemoryCenterExtrasReducer.applyActivity(state, reqId: "a2", generation: 2, append: false, cursor: nil, data: sample) {
        if applied.activityRows.count != 1 {
            problems.append("extras reducer：最新 generation 应写入 activity 行")
        }
    } else {
        problems.append("extras reducer：最新 activity 响应应应用")
    }
    state.suggestionRows = [
        MemoryCenterSuggestionRow(id: "s1", scope: "ws", kind: "stale_hot", summary: "a", risk: "low"),
        MemoryCenterSuggestionRow(id: "s2", scope: "ws", kind: "stale_hot", summary: "b", risk: "low"),
    ]
    state = MemoryCenterExtrasReducer.beginAnswer(state, reqId: "ans1", suggestionId: "s1")
    state = MemoryCenterExtrasReducer.beginAnswer(state, reqId: "ans2", suggestionId: "s2")
    guard let mid = MemoryCenterExtrasReducer.applyAnswer(state, reqId: "ans2", suggestionId: "s2", ok: false, error: "冲突", removeId: nil) else {
        problems.append("extras reducer：answer 应按 reqId 路由")
        return problems
    }
    if let afterOk = MemoryCenterExtrasReducer.applyAnswer(mid, reqId: "ans1", suggestionId: "s1", ok: true, error: nil, removeId: "s1") {
        if afterOk.suggestionErrorById["s2"] != "冲突" {
            problems.append("extras reducer：一条失败不应清另一条错误")
        }
    } else {
        problems.append("extras reducer：第二条 answer 成功应独立应用")
    }
    return problems
}

func checkMemoryCenterLayoutMetrics() -> [String] {
    var problems: [String] = []
    if MemoryCenterLayoutMetrics.tier(containerWidth: 420.0) != .single {
        problems.append("layout：420pt 应为 single")
    }
    if MemoryCenterLayoutMetrics.tier(containerWidth: 559.0) != .single {
        problems.append("layout：559pt 应为 single")
    }
    if MemoryCenterLayoutMetrics.tier(containerWidth: 560.0) != .double {
        problems.append("layout：560pt 应为 double")
    }
    if MemoryCenterLayoutMetrics.tier(containerWidth: 899.0) != .double {
        problems.append("layout：899pt 应为 double")
    }
    if MemoryCenterLayoutMetrics.tier(containerWidth: 900.0) != .triple {
        problems.append("layout：900pt 应为 triple")
    }
    if MemoryCenterLayoutMetrics.tripleColumnMinWidth != 900.0 || MemoryCenterLayoutMetrics.doubleColumnMinWidth != 560.0 {
        problems.append("layout：断点常量不符")
    }
    print("Memory center 布局断点：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

func checkMemoryCenterDoubleColumnUI() -> [String] {
    var problems: [String] = []
    if MemoryCenterUILayoutLogic.doubleColumnRightPane(searchActive: true, selectedKey: "k", navId: "notes") != .searchDetail {
        problems.append("double UI：搜索+选中应为 searchDetail")
    }
    if MemoryCenterUILayoutLogic.doubleColumnRightPane(searchActive: true, selectedKey: nil, navId: "notes") != .searchList {
        problems.append("double UI：搜索无选中应为 searchList")
    }
    if MemoryCenterUILayoutLogic.doubleColumnRightPane(searchActive: false, selectedKey: "k", navId: "notes") != .scopeItemDetail {
        problems.append("double UI：scope 选中应为 scopeItemDetail")
    }
    if MemoryCenterUILayoutLogic.doubleColumnRightPane(searchActive: false, selectedKey: nil, navId: "overview") != .embeddedMiddle {
        problems.append("double UI：默认应为 embeddedMiddle")
    }
    var navId = "overview"
    var searchActive = true
    var searchText = "redis"
    var selectedKey: String? = "personal:m1"
    MemoryCenterUILayoutLogic.applyNavSelection(
        selectedKey: &selectedKey,
        searchText: &searchText,
        searchActive: &searchActive,
        navId: &navId,
        targetNavId: "personal"
    )
    if searchActive || !searchText.isEmpty || selectedKey != nil || navId != "personal" {
        problems.append("double UI：切导航应退出搜索并清选中")
    }
    print("Memory center 双栏 UI 逻辑：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

func checkMemoryCenterNegativeDecode() -> [String] {
    var problems: [String] = []
    let badOverview = """
    {"mode":"overview","overview":{"personal":{"validEntries":"2","invalidEntries":0,"coreFieldLines":1,"workPreferenceLines":1,"paused":false,"coreBudget":1200,"coreTokens":10,"workPreferenceBudget":200},"scopes":[]}}
    """
    if let v = try? JSONValue.parse(Data(badOverview.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：personal.validEntries 为 string 应失败")
    }
    let badItemRefs = """
    {"mode":"detail","detail":{"scope":{"id":"n","label":"n","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0},"items":[{"id":null,"kind":"workspace_memory","layer":"L2","scopeId":"n","text":"t","refs":[1],"missingRefs":[],"effectiveState":"hot"}],"rules":[],"diagnostics":null}}
    """
    if let v = try? JSONValue.parse(Data(badItemRefs.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：refs 含非 string 应使整个 detail 失败")
    }
    let badHit = """
    {"hits":[{"scopeId":"p","kind":"personal","layer":"L0","id":null,"text":"x","refs":[],"missingRefs":[],"effectiveState":"hot","reasons":["a"],"score":"bad"}]}
    """
    if let v = try? JSONValue.parse(Data(badHit.utf8)), MemoryCenterSearchData.from(v) != nil {
        problems.append("负向：hit.score 非 number 应失败")
    }
    let badRule = """
    {"mode":"detail","detail":{"scope":{"id":"n","label":"n","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0},"items":[],"rules":[{"relPath":"AGENTS.md","appliesDir":".","chars":"x","body":""}],"diagnostics":null}}
    """
    if let v = try? JSONValue.parse(Data(badRule.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：rule.chars 非 int 应失败")
    }
    let badDiag = """
    {"mode":"detail","detail":{"scope":{"id":"n","label":"n","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0},"items":[],"rules":[],"diagnostics":{"total":1,"selected":"1","skippedBudget":0,"hotSelected":0,"coldRecalled":0,"terminalSkipped":0,"pinnedSelected":0,"relevantSelected":0,"strategy":"x","selectedIds":[]}}}
    """
    if let v = try? JSONValue.parse(Data(badDiag.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：diagnostics.selected 非 int 应失败")
    }
    let badScopeInList = """
    {"mode":"overview","overview":{"personal":{"validEntries":0,"invalidEntries":0,"coreFieldLines":0,"workPreferenceLines":0,"paused":false,"coreBudget":1,"coreTokens":0,"workPreferenceBudget":1},"scopes":[{"id":"x","label":"x","kind":"workspace_memory","layer":"L2","memoryCount":"1","hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0}]}}
    """
    if let v = try? JSONValue.parse(Data(badScopeInList.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：scopes 数组内坏元素应使整个 overview 失败")
    }
    let badPinned = """
    {"mode":"detail","detail":{"scope":{"id":"n","label":"n","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0},"items":[{"id":null,"kind":"workspace_memory","layer":"L2","scopeId":"n","text":"t","refs":[],"missingRefs":[],"effectiveState":"hot","pinned":"wrong"}],"rules":[],"diagnostics":null}}
    """
    if let v = try? JSONValue.parse(Data(badPinned.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：item.pinned 为 string 应失败")
    }
    let badRuleTrunc = """
    {"mode":"detail","detail":{"scope":{"id":"n","label":"n","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0},"items":[],"rules":[{"relPath":"A.md","appliesDir":".","chars":1,"body":"","truncated":"no"}],"diagnostics":null}}
    """
    if let v = try? JSONValue.parse(Data(badRuleTrunc.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：rule.truncated 非 bool 应失败")
    }
    let badHealth = """
    {"mode":"overview","overview":{"personal":{"validEntries":0,"invalidEntries":0,"coreFieldLines":0,"workPreferenceLines":0,"paused":false,"coreBudget":1,"coreTokens":0,"workPreferenceBudget":1},"scopes":[{"id":"x","label":"x","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0,"health":true}]}}
    """
    if let v = try? JSONValue.parse(Data(badHealth.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：scope.health 非 string 应失败")
    }
    let badScopesTrunc = """
    {"mode":"overview","overview":{"personal":{"validEntries":0,"invalidEntries":0,"coreFieldLines":0,"workPreferenceLines":0,"paused":false,"coreBudget":1,"coreTokens":0,"workPreferenceBudget":1},"scopes":[],"scopesTruncated":"yes"}}
    """
    if let v = try? JSONValue.parse(Data(badScopesTrunc.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：scopesTruncated 非 bool 应失败")
    }
    let badPayloadTrunc = """
    {"mode":"overview","overview":{"personal":{"validEntries":0,"invalidEntries":0,"coreFieldLines":0,"workPreferenceLines":0,"paused":false,"coreBudget":1,"coreTokens":0,"workPreferenceBudget":1},"scopes":[]},"payloadTruncated":1}
    """
    if let v = try? JSONValue.parse(Data(badPayloadTrunc.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：payloadTruncated 非 bool 应失败")
    }
    let badColdSkip = """
    {"mode":"detail","detail":{"scope":{"id":"n","label":"n","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0},"items":[],"rules":[],"diagnostics":{"total":0,"selected":0,"skippedBudget":0,"hotSelected":0,"coldRecalled":0,"terminalSkipped":0,"coldUnrelatedSkipped":"x","pinnedSelected":0,"relevantSelected":0,"strategy":"s","selectedIds":[]}}}
    """
    if let v = try? JSONValue.parse(Data(badColdSkip.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：coldUnrelatedSkipped 非 int 应失败")
    }
    let badSection = """
    {"hits":[{"scopeId":"p","kind":"personal","layer":"L0","id":null,"text":"x","refs":[],"missingRefs":[],"effectiveState":"hot","reasons":[],"score":1,"section":1}]}
    """
    if let v = try? JSONValue.parse(Data(badSection.utf8)), MemoryCenterSearchData.from(v) != nil {
        problems.append("负向：hit.section 非 string 应失败")
    }
    let badUses = """
    {"mode":"detail","detail":{"scope":{"id":"n","label":"n","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0},"items":[{"id":null,"kind":"workspace_memory","layer":"L2","scopeId":"n","text":"t","refs":[],"missingRefs":[],"effectiveState":"hot","uses":"many"}],"rules":[],"diagnostics":null}}
    """
    if let v = try? JSONValue.parse(Data(badUses.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：item.uses 非 int 应失败")
    }
    let badSkipArr = """
    {"mode":"detail","detail":{"scope":{"id":"n","label":"n","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0},"items":[],"rules":[],"diagnostics":{"total":0,"selected":0,"skippedBudget":0,"hotSelected":0,"coldRecalled":0,"terminalSkipped":0,"pinnedSelected":0,"relevantSelected":0,"strategy":"s","selectedIds":[],"skippedReasons":{}}}}
    """
    if let v = try? JSONValue.parse(Data(badSkipArr.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：skippedReasons 非 array 应失败")
    }
    let badSearchTrunc = """
    {"hits":[],"truncated":"nope"}
    """
    if let v = try? JSONValue.parse(Data(badSearchTrunc.utf8)), MemoryCenterSearchData.from(v) != nil {
        problems.append("负向：search.truncated 非 bool 应失败")
    }
    let scopeStub = """
    {"id":"n","label":"n","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0}
    """
    let itemCore = """
    {"id":null,"kind":"workspace_memory","layer":"L2","scopeId":"n","text":"t","refs":[],"missingRefs":[],"effectiveState":"hot","revision":"r0","pinned":false,"truncated":false}
    """
    func detailWithItem(_ itemFragment: String) -> String {
        """
        {"mode":"detail","detail":{"scope":\(scopeStub),"items":[\(itemFragment)],"rules":[],"diagnostics":null}}
        """
    }
    if let v = try? JSONValue.parse(Data(detailWithItem(itemCore + ",\"section\":null").utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：section:null（?: string）应失败")
    }
    if let v = try? JSONValue.parse(Data(detailWithItem(itemCore + ",\"uses\":null").utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：uses:null（?: number）应失败")
    }
    if let v = try? JSONValue.parse(Data(detailWithItem(itemCore + ",\"pinned\":null").utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：pinned:null（?: boolean）应失败")
    }
    let diagNullCold = """
    {"mode":"detail","detail":{"scope":\(scopeStub),"items":[],"rules":[],"diagnostics":{"total":0,"selected":0,"skippedBudget":0,"hotSelected":0,"coldRecalled":0,"terminalSkipped":0,"coldUnrelatedSkipped":null,"pinnedSelected":0,"relevantSelected":0,"strategy":"s","selectedIds":[]}}}
    """
    if let v = try? JSONValue.parse(Data(diagNullCold.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：coldUnrelatedSkipped:null（?: number）应失败")
    }
    let diagNullSkip = """
    {"mode":"detail","detail":{"scope":\(scopeStub),"items":[],"rules":[],"diagnostics":{"total":0,"selected":0,"skippedBudget":0,"hotSelected":0,"coldRecalled":0,"terminalSkipped":0,"pinnedSelected":0,"relevantSelected":0,"strategy":"s","selectedIds":[],"skippedReasons":null}}}
    """
    if let v = try? JSONValue.parse(Data(diagNullSkip.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：skippedReasons:null（?: array）应失败")
    }
    let overviewNullTrunc = """
    {"mode":"overview","overview":{"personal":{"validEntries":0,"invalidEntries":0,"coreFieldLines":0,"workPreferenceLines":0,"paused":false,"coreBudget":1,"coreTokens":0,"workPreferenceBudget":1},"scopes":[],"scopesTruncated":null}}
    """
    if let v = try? JSONValue.parse(Data(overviewNullTrunc.utf8)), MemoryCenterGetData.from(v) != nil {
        problems.append("负向：scopesTruncated:null（?: boolean）应失败")
    }
    print("Memory center 负向解码：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

func checkMemoryCenterNullableAccept() -> [String] {
    var problems: [String] = []
    let scopeStub = """
    {"id":"n","label":"n","kind":"workspace_memory","layer":"L2","memoryCount":0,"hot":0,"cold":0,"done":0,"expired":0,"pinned":0,"missingRefs":0,"ruleFileCount":0,"tokenBudget":0,"injectionSelected":0,"injectionSkipped":0,"pendingCount":0,"parentId":null,"health":null,"error":null}
    """
    let itemNullable = """
    {"mode":"detail","detail":{"scope":\(scopeStub),"items":[{"id":null,"kind":"workspace_memory","layer":"L2","scopeId":"n","text":"t","refs":[],"missingRefs":[],"effectiveState":"hot","at":null,"from":null,"state":null,"used":null,"expires":null,"revision":"r0","pinned":false,"truncated":false}],"rules":[],"diagnostics":null}}
    """
    guard let itemVal = try? JSONValue.parse(Data(itemNullable.utf8)),
          let itemParsed = MemoryCenterGetData.from(itemVal),
          let item = itemParsed.detail?.items.first
    else {
        problems.append("正向：item at/from/state/used/expires:null 应解码")
        return problems
    }
    if item.at != nil || item.from != nil || item.state != nil || item.used != nil || item.expires != nil {
        problems.append("正向：nullable 字符串 null 应映射为 Swift nil")
    }
    if itemParsed.detail?.scope.parentId != nil || itemParsed.detail?.scope.health != nil || itemParsed.detail?.scope.error != nil {
        problems.append("正向：scope parentId/health/error:null 应解码为 nil")
    }
    let hitNullState = """
    {"hits":[{"scopeId":"p","kind":"personal","layer":"L0","id":null,"text":"x","refs":[],"missingRefs":[],"effectiveState":"hot","state":null,"reasons":[],"score":1}]}
    """
    if let hitVal = try? JSONValue.parse(Data(hitNullState.utf8)),
       let hits = MemoryCenterSearchData.from(hitVal)
    {
        if hits.hits.first?.state != nil {
            problems.append("正向：hit.state:null 应解码为 nil")
        }
    } else {
        problems.append("正向：hit.state:null payload 应解码")
    }
    print("Memory center nullable 正向：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

func checkMemoryCenterReducerLifecycle() -> [String] {
    var problems: [String] = []
    var cleared = MemoryCenterReducer.registerPending(
        MemoryCenterDataState.initial,
        req: MemoryCenterPendingRequest(reqId: "s1", kind: .search, scopeId: nil, query: "q"),
        replaceSameKind: true
    )
    cleared = MemoryCenterReducer.clearSearchSession(cleared)
    if cleared.loadingSearch || cleared.activeSearchReqId != nil || cleared.search != nil {
        problems.append("reducer：clearSearchSession 未清 search 槽")
    }
    if cleared.pending.contains(where: { $0.kind == .search }) {
        problems.append("reducer：clearSearchSession 未淘汰 search pending")
    }
    var withSearch = MemoryCenterReducer.registerPending(cleared, req: MemoryCenterPendingRequest(reqId: "s2", kind: .search, scopeId: nil, query: "q"), replaceSameKind: true)
    withSearch.search = MemoryCenterSearchData(hits: [], truncated: false, payloadTruncated: false)
    withSearch = MemoryCenterReducer.clearSearchSession(withSearch)
    let lateSearch = MemoryCenterIncomingResult(reqId: "s2", op: "memory_center_search", ok: true, error: nil, getData: nil, searchData: MemoryCenterSearchData(hits: [], truncated: false, payloadTruncated: false))
    if MemoryCenterReducer.applyResult(withSearch, message: lateSearch) != nil {
        problems.append("reducer：clear 后迟到 search 响应不应应用")
    }
    var disconnected = MemoryCenterReducer.registerPending(
        MemoryCenterDataState.initial,
        req: MemoryCenterPendingRequest(reqId: "o1", kind: .overview, scopeId: nil, query: nil),
        replaceSameKind: true
    )
    disconnected.overview = parsedOverviewStub()
    disconnected = MemoryCenterReducer.flushInFlight(disconnected)
    if disconnected.loadingOverview || !disconnected.pending.isEmpty || disconnected.activeOverviewReqId != nil {
        problems.append("reducer：flushInFlight 未清 overview 在途")
    }
    if disconnected.overview == nil {
        problems.append("reducer：flushInFlight 不应清 overview 缓存")
    }
    print("Memory center reducer 生命周期：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

private func parsedOverviewStub() -> MemoryCenterOverview {
    MemoryCenterOverview(
        personal: MemoryCenterPersonalOverview(
            validEntries: 1, invalidEntries: 0, coreFieldLines: 0, workPreferenceLines: 0,
            paused: false, coreBudget: 1, coreTokens: 0, workPreferenceBudget: 1
        ),
        scopes: [],
        scopesTruncated: false
    )
}

func checkMemoryCenterImportMalformedFixturesFile() -> [String] {
    var problems: [String] = []
    let path = "shared/fixtures/memory-center-import-malformed.json"
    guard let data = FileManager.default.contents(atPath: path),
          let root = try? JSONValue.parse(data),
          let obj = root.object
    else {
        problems.append("import malformed：无法读取 \(path)")
        return problems
    }
    func rejectExport(_ samples: [JSONValue]?) {
        for sample in samples ?? [] {
            if MemoryCenterExportData.from(sample) != nil {
                problems.append("import malformed：export 样本应拒绝")
            }
        }
    }
    func rejectPreview(_ samples: [JSONValue]?) {
        for sample in samples ?? [] {
            if MemoryCenterImportPreviewData.from(sample) != nil {
                problems.append("import malformed：preview 样本应拒绝")
            }
        }
    }
    func rejectApply(_ samples: [JSONValue]?) {
        for sample in samples ?? [] {
            if MemoryCenterImportApplyData.from(sample) != nil {
                problems.append("import malformed：apply 样本应拒绝")
            }
        }
    }
    func rejectRollback(_ samples: [JSONValue]?) {
        for sample in samples ?? [] {
            if MemoryCenterImportRollbackData.from(sample) != nil {
                problems.append("import malformed：rollback 样本应拒绝")
            }
        }
    }
    rejectExport(obj["memory_center_export"]?.array)
    rejectPreview(obj["memory_center_import_preview"]?.array)
    rejectApply(obj["memory_center_import_apply"]?.array)
    rejectRollback(obj["memory_center_import_rollback"]?.array)
    print("Memory center import malformed 共享文件：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

func checkMemoryCenterImportStrictDecoders() -> [String] {
    var problems: [String] = []
    let exportOK: JSONValue = .object([
        "relativePath": .string(".jiebo/memory-export/x.json"),
        "sha256": .string(String(repeating: "a", count: 64)),
        "bytes": .number(100),
        "summary": .object([
            "scopes": .array([.string("personal")]),
            "personalEntries": .number(0),
            "workspaceScopes": .number(0),
            "rulesInventory": .number(0),
        ]),
    ])
    if MemoryCenterExportData.from(exportOK) == nil { problems.append("import：export 金样本应解码") }
    if MemoryCenterExportData.from(.object(["relativePath": .string("x")])) != nil {
        problems.append("import：export 缺字段应拒绝")
    }
    let previewOK: JSONValue = .object([
        "planId": .string("p1"),
        "expiresAt": .string("2026-10-18T12:00:00.000Z"),
        "snapshotSummary": .object([
            "exportedAt": .string("2026-10-18T12:00:00.000Z"),
            "schemaVersion": .number(1),
            "scopeCount": .number(0),
            "personalEntryCount": .number(0),
            "rulesCount": .number(0),
            "bytes": .number(1),
            "checksum": .string("c"),
        ]),
        "changes": .array([]),
        "warnings": .array([.object(["code": .string("rules_changed"), "message": .string("m")])]),
    ])
    if MemoryCenterImportPreviewData.from(previewOK) == nil { problems.append("import：preview 金样本应解码") }
    if MemoryCenterImportPreviewData.from(.object(["planId": .string("p"), "expiresAt": .string("t"), "snapshotSummary": .object([:]), "changes": .array([]), "warnings": .array([.object(["message": .string("only")])])])) != nil {
        problems.append("import：preview warning 缺 code 应拒绝")
    }
    let applyOK: JSONValue = .object([
        "importId": .string("mcimp1"),
        "canRollback": .bool(true),
        "summary": .object(["applied": .number(1), "skipped": .number(0), "conflictsResolved": .number(0)]),
    ])
    if MemoryCenterImportApplyData.from(applyOK) == nil { problems.append("import：apply 金样本应解码") }
    if MemoryCenterImportApplyData.from(.object(["importId": .string("x"), "canRollback": .bool(false)])) != nil {
        problems.append("import：apply canRollback false 应拒绝")
    }
    let rbOK: JSONValue = .object(["importId": .string("mcimp1"), "status": .string("rolled_back")])
    if MemoryCenterImportRollbackData.from(rbOK) == nil { problems.append("import：rollback 金样本应解码") }
    if MemoryCenterImportRollbackData.from(.object(["importId": .string("x"), "status": .string("nope")])) != nil {
        problems.append("import：rollback status 枚举外应拒绝")
    }
    let changeBad: JSONValue = .object([
        "planId": .string("p"),
        "expiresAt": .string("t"),
        "snapshotSummary": .object([
            "exportedAt": .string("e"), "schemaVersion": .number(1), "scopeCount": .number(0),
            "personalEntryCount": .number(0), "rulesCount": .number(0), "bytes": .number(1), "checksum": .string("c"),
        ]),
        "changes": .array([.object(["changeId": .string("c1"), "layer": .string("x"), "action": .string("add")])]),
        "warnings": .array([]),
    ])
    if MemoryCenterImportPreviewData.from(changeBad) != nil {
        problems.append("import：change 缺 allowedResolutions 应拒绝")
    }
    print("Memory center import 严格解码：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

func checkMemoryCenterServerFixtures(_ samples: [JSONValue]) -> [String] {
    var problems: [String] = []
    for sample in samples {
        guard let row = sample.object,
              row["type"]?.string == "assistant_result",
              row["ok"]?.bool == true,
              let data = row["data"]
        else { continue }
        let op = row["op"]?.string ?? ""
        let reqId = row["reqId"]?.string ?? ""
        if op == "memory_center_get" {
            guard let parsed = MemoryCenterGetData.from(data) else {
                problems.append("memory center server[\(reqId)]：get data 无法解码")
                continue
            }
            if reqId == "rq-mc-get-1" {
                if parsed.mode != "overview" || parsed.overview?.personal.validEntries != 3 {
                    problems.append("memory center server：overview personal.validEntries 应为 3")
                }
                if parsed.overview?.scopes.first(where: { $0.id == "notes" })?.injectionSelected != 6 {
                    problems.append("memory center server：notes injectionSelected 应为 6")
                }
            }
        } else if op == "memory_center_search" {
            guard let search = MemoryCenterSearchData.from(data) else {
                problems.append("memory center server[\(reqId)]：search data 无法解码")
                continue
            }
            if reqId == "rq-mc-search-1" {
                let hit = search.hits.first
                if hit?.reasons.first != "text" || hit?.score != 4.2 {
                    problems.append("memory center server：search hit reasons/score 不符")
                }
            }
        } else if op == "memory_center_export", reqId == "rq-mc-export-1" {
            if MemoryCenterExportData.from(data) == nil {
                problems.append("memory center server：export 成功样本无法解码")
            }
        } else if op == "memory_center_import_preview", reqId == "rq-mc-import-preview" {
            if MemoryCenterImportPreviewData.from(data) == nil {
                problems.append("memory center server：import preview 成功样本无法解码")
            }
        } else if op == "memory_center_import_apply", reqId == "rq-mc-import-apply" {
            if MemoryCenterImportApplyData.from(data) == nil {
                problems.append("memory center server：import apply 成功样本无法解码")
            }
        } else if op == "memory_center_import_rollback", reqId == "rq-mc-import-rollback" {
            if MemoryCenterImportRollbackData.from(data) == nil {
                problems.append("memory center server：import rollback 成功样本无法解码")
            }
        }
    }
    if problems.isEmpty {
        print("Memory center server fixtures：通过")
    } else {
        print("Memory center server fixtures：\(problems.count) 条不符")
    }
    return problems
}

func checkPersonalTaskProjection(_ samples: [JSONValue]) -> [String] {
    var problems: [String] = []
    guard let fixture = samples.first(where: { $0["type"]?.string == "assistant_state" }),
          let state = fixture["state"].flatMap(AssistantState.from)
    else { return ["personal task：assistant_state fixture 无法解码"] }

    if state.projectionVersion != 1 || state.snapshotAt == nil {
        problems.append("personal task：projectionVersion/snapshotAt 不符")
    }
    if state.personalTasks?.count != 2 || state.draftCards?.count != 1 || state.dayThread?.count != 1 {
        problems.append("personal task：任务、草稿或 dayThread 数量不符")
    }
    if state.artifacts?.count != 3 {
        problems.append("artifact：file/link/capture 数量不符")
    } else {
        let file = state.artifacts?.first(where: { $0.kind == "file" })
        let link = state.artifacts?.first(where: { $0.kind == "link" })
        if file?.path != "docs/slides.md" || file?.provenance?.delegationId != "d_q7w3" {
            problems.append("artifact：文件路径或委派来源解码不符")
        }
        if link?.safeURL?.scheme != "https" || link?.sourceCitation?.excerpt != "可靠来源摘录" {
            problems.append("artifact：安全 URL 或来源引用解码不符")
        }
    }
    let futureJSON: JSONValue = .object([
        "id": .string("future:1"),
        "kind": .string("future_task_kind"),
        "title": .string("未来任务"),
        "phase": .string("future_phase"),
        "status": .string("future_status"),
        "priority": .string("normal"),
        "createdAt": .number(1),
        "sources": .array([]),
    ])
    let future = PersonalTask.from(futureJSON)
    if future?.kind != "future_task_kind" || future?.phase != "future_phase" {
        problems.append("personal task：未知 kind/phase 没有按 String 保留")
    }
    let draft = state.draftCards?.first
    if draft?.preview.kind != "create_workspace" || draft?.preview.summary != "在 /workspace/acme 创建 acme" {
        problems.append("personal task：approval draft preview 解码不符")
    }
    if draft?.actions.first?.op != "approval_answer" || draft?.actions.first?.allow != true {
        problems.append("personal task：approval draft action 解码不符")
    }
    print("Personal task projection fixture：\(problems.isEmpty ? "通过" : "\(problems.count) 条不符")")
    return problems
}

// MARK: 入口

let options = parseOptions()
guard let fixtureData = FileManager.default.contents(atPath: options.fixtures),
      let fixtures = try? JSONValue.parse(fixtureData),
      let serverSamples = fixtures["server"]?.array
else { fail("读不到或解析不了 \(options.fixtures)") }

let problems = checkServer(options, samples: serverSamples) + writeClientSamples(options) + checkToolNames() + checkImBodies() + checkJSONValue() + checkDeviceRequestValidation() + checkProductNavigation() + checkDeferredTurnFiles() + checkTurnFilesState() + checkMemoryCenter() + checkMemoryCenterImportStrictDecoders() + checkMemoryCenterImportMalformedFixturesFile() + checkMemoryCenterServerFixtures(serverSamples) + checkPersonalTaskProjection(serverSamples)
if !problems.isEmpty {
    for problem in problems { FileHandle.standardError.write(Data("❌ \(problem)\n".utf8)) }
    exit(1)
}
