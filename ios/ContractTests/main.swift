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

// MARK: 入口

let options = parseOptions()
guard let fixtureData = FileManager.default.contents(atPath: options.fixtures),
      let fixtures = try? JSONValue.parse(fixtureData),
      let serverSamples = fixtures["server"]?.array
else { fail("读不到或解析不了 \(options.fixtures)") }

let problems = checkServer(options, samples: serverSamples) + writeClientSamples(options) + checkToolNames() + checkImBodies() + checkJSONValue() + checkDeferredTurnFiles() + checkTurnFilesState()
if !problems.isEmpty {
    for problem in problems { FileHandle.standardError.write(Data("❌ \(problem)\n".utf8)) }
    exit(1)
}
