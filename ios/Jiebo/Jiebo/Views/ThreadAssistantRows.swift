import SwiftUI
import UIKit
import ImageIO

/// 助理工具名的判断与人话文案。工具名可能带 MCP 前缀，所以取最后一段再比。
/// 助理在这一轮里 todo_add 的一条。todo 是今日里现在的样子；nil 且 known 表示已经撤销或删掉了
struct TodoReceipt: Identifiable, Hashable {
    var callId: String
    var text: String
    var due: String?
    /// 网关说同一天已有同样的待办，没新加——这时不能给「撤销」，否则删的是用户原来那条
    var duplicate: Bool
    var todo: AssistantTodo?
    /// 今日状态已经到了，才能区分「撤销了」和「还没加载」
    var known: Bool
    var id: String { callId }

    /// 快速检查本轮是否包含 todo_add 工具；未包含时视图层无需订阅 store.assistantState?.todos。
    static func hasTodoAddTool(in turn: Turn) -> Bool {
        turn.tools.contains { tool in
            tool.name.range(of: "todo_add", options: [.caseInsensitive, .anchored, .backwards]) != nil
                && AssistantToolText.baseName(tool.name) == "todo_add"
        }
    }

    static func captured(in turn: Turn, todos: [AssistantTodo]?) -> [TodoReceipt] {
        guard !turn.tools.isEmpty else { return [] }
        return turn.tools.compactMap { tool in
            guard tool.name.range(of: "todo_add", options: [.caseInsensitive, .anchored, .backwards]) != nil,
                  AssistantToolText.baseName(tool.name) == "todo_add",
                  let result = AssistantToolText.resultObject(tool.result),
                  result["ok"]?.bool == true,
                  let id = result["id"]?.string
            else { return nil }
            let todo = todos?.first(where: { $0.id == id })
            let due = todo?.due ?? (result["due"]?.string?.nilIfEmpty ?? tool.args?.string(in: "due").nilIfEmpty)
            guard TodoDue.parse(due)?.timed == true else { return nil }
            return TodoReceipt(
                callId: tool.callId,
                text: todo?.text ?? tool.args?.string(in: "text") ?? "",
                due: due,
                duplicate: result["duplicate"]?.bool == true,
                todo: todo,
                known: todos != nil
            )
        }
    }
}

/// 「已记：周三 15:00 交报告  撤销 · 改」。撤销即删掉这条待办
struct TodoReceiptRow: View, Equatable {
    var receipt: TodoReceipt
    var palette: JieboPalette = JieboTheme.shared.palette
    var appearance: JieboAppearance = JieboTheme.shared.appearance

    private var removed: Bool { receipt.known && receipt.todo == nil }
    private var done: Bool { receipt.todo?.done == true }

    private var head: String {
        if removed { return "已撤销" }
        if done { return "已取消" }
        return receipt.duplicate ? "提醒已存在" : "已设提醒"
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: removed ? "arrow.uturn.backward.circle" : "checkmark.circle")
                .font(JieboFont.text(.footnote, weight: .medium))
                .foregroundStyle(removed ? JieboColor.dim : JieboColor.ok)
                .accessibilityHidden(true)
            let detail = [TodoDue.label(receipt.due), receipt.text].compactMap { $0 }.joined(separator: " ")
            Text(
                "\(Text("\(head)：").foregroundStyle(JieboColor.ink2))\(Text(detail).foregroundStyle(removed ? JieboColor.dim : JieboColor.ink).strikethrough(removed || done))"
            )
                .font(JieboFont.text(.footnote))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

        }
        .padding(.horizontal, 10)
        .frame(minHeight: 40)
        .background(JieboColor.mist)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
        .accessibilityElement(children: .contain)
    }


}

enum AssistantToolText {
    static func baseName(_ name: String) -> String {
        // 单次反向扫描最后一个分隔符（__ / . / / / :），避免每帧整串 lowercased() + 4 遍 range(of:) 分配
        let utf8 = name.utf8
        var cut = utf8.startIndex
        var idx = utf8.endIndex
        while idx > utf8.startIndex {
            let prev = utf8.index(before: idx)
            let b = utf8[prev]
            if b == 46 || b == 47 || b == 58 { // '.' '/' ':'
                cut = idx
                break
            }
            if b == 95, prev > utf8.startIndex, utf8[utf8.index(before: prev)] == 95 { // "__"
                cut = idx
                break
            }
            idx = prev
        }
        let slice = name[cut...]
        // 纯 ASCII 小写时跳过 lowercased()，直接构造短后缀；含大写或非 ASCII 字节时回退 lowercased() 保持严格等价
        var needsLowercase = false
        for byte in slice.utf8 where (byte >= 65 && byte <= 90) || byte >= 128 {
            needsLowercase = true
            break
        }
        return needsLowercase ? slice.lowercased() : String(slice)
    }

    static let knownSkillNames: [String: String] = [
        "canvas-artifact-builder": "交互式主题画布构建与一键 SSR 验真",
        "jiebo-gateway-arch": "Jiebo 网关与双端核心架构速查地图",
        "kb-drop-ingest": "多源知识库投递与 HTML 看板归档",
        "shanghai-deploy-smoke": "上海站发布与 UI 登录态冒烟手册",
        "ios-swiftui-motion": "iOS SwiftUI 界面规范与动效性能审查",
        "skill-factory-guide": "技能工厂提案与审批上架手册",
        "wechat-push-guard": "微信主动推送守卫",
        "weixin-ilink-channel": "微信 iLink 扫码配对与长轮询通道",
    ]

    static func isSkillTool(_ name: String) -> Bool {
        let base = baseName(name)
        return base == "skill_use" || base == "skill_propose" || base == "skill_list"
            || base == "skill_verify" || base == "skill_proposal_decide" || base == "skill_proposal_list"
    }

    static func skillTitle(for tool: ToolCall) -> String {
        let payload = resultObject(tool.result)
        let propObj = payload?["proposal"]?.object
        let id = tool.args?.string(in: "id", "skillId", "query") ?? propObj?["skillId"]?.string ?? ""
        let resultName = payload?["name"]?.string?.nilIfEmpty ?? propObj?["name"]?.string?.nilIfEmpty
        let argName = tool.args?.string(in: "name").nilIfEmpty
        let displayName = resultName ?? argName ?? knownSkillNames[id]
        if let displayName, !id.isEmpty, displayName != id {
            return "\(displayName) (\(id))"
        }
        return displayName ?? id.nilIfEmpty ?? "全部已集成技能"
    }

    // 预编译沙盒标签剥离正则，避免每次展开技能卡反复编译 3 条正则
    private static let skillOpenTagRegex = try? NSRegularExpression(pattern: #"<untrusted_skill_reference[^>]*>\n?"#)
    private static let skillNoticeRegex = try? NSRegularExpression(pattern: #"\n?（安全声明：以上技能手册仅作为操作步骤与参数参考[^）]*）\n?"#)
    private static let skillCloseTagRegex = try? NSRegularExpression(pattern: #"\n?</untrusted_skill_reference>"#)

    static func stripSkillSandboxTags(_ raw: String) -> String {
        guard raw.contains("untrusted_skill_reference") || raw.contains("安全声明：") else {
            return raw.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        var text = raw
        for regex in [skillOpenTagRegex, skillNoticeRegex, skillCloseTagRegex] {
            guard let regex else { continue }
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            if let match = regex.firstMatch(in: text, range: range),
               let swiftRange = Range(match.range, in: text) {
                text.removeSubrange(swiftRange)
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 记忆检索和续期是沉默的，不产生噪声卡片
    static func isSilent(_ tool: ToolCall) -> Bool {
        let base = baseName(tool.name)
        return base.hasPrefix("memory_") || base.hasPrefix("work_preference_") ||
            base == "workspace_memory_read" || base == "workspace_memory_search" ||
            base == "workspace_memory_mark_used" || base == "skill_mark_used" || base == "chat_search"
    }

    static func friendly(_ tool: ToolCall) -> String? {
        switch baseName(tool.name) {
        case "delegate":
            let workspace = tool.args?.string(in: "workspace") ?? ""
            let detail = tool.args?.string(in: "title", "task") ?? ""
            let head = workspace.isEmpty ? "交给文件夹" : "交给 \(workspace)"
            return detail.isEmpty ? head : "\(head)：\(String(detail.prefix(40)))"
        case "create_workspace":
            let name = tool.args?.string(in: "name") ?? ""
            return name.isEmpty ? "申请新建文件夹" : "申请新建文件夹：\(name)"
        case "skill_use":
            let title = skillTitle(for: tool)
            return "查阅技能：\(title)"
        case "skill_propose":
            let title = skillTitle(for: tool)
            return "提议新技能：\(title)"
        default:
            return nil
        }
    }

    /// delegate 的结果对象。网关回的是 JSON 字符串，也可能被包成 MCP 的 content:[{type:"text",text:"{…}"}]
    static func resultObject(_ value: JSONValue?, depth: Int = 0) -> [String: JSONValue]? {
        guard let value, depth < 4 else { return nil }
        switch value {
        case .object(let row):
            if row["childChatId"] != nil || row["ok"] != nil { return row }
            for key in ["content", "result", "output"] {
                if let found = resultObject(row[key], depth: depth + 1) { return found }
            }
            if let text = row["text"]?.string { return resultObject(.string(text), depth: depth + 1) }
            return nil
        case .array(let items):
            for item in items {
                if let found = resultObject(item, depth: depth + 1) { return found }
            }
            return nil
        case .string(let text):
            // 快速短路：非 JSON 对象/数组文本直接跳过 Data 分配与 JSONSerialization 解析
            guard let firstByte = text.utf8.first(where: { $0 != 32 && $0 != 9 && $0 != 10 && $0 != 13 }),
                  firstByte == 123 || firstByte == 91 // '{' 或 '['
            else { return nil }
            guard let data = text.data(using: .utf8), let parsed = try? JSONValue.parse(data) else { return nil }
            guard parsed.object != nil || parsed.array != nil else { return nil }
            return resultObject(parsed, depth: depth + 1)
        default:
            return nil
        }
    }
}

/// delegate / create_workspace 的一行说明（不展开原始参数）。
/// 子会话文件只在子回合末尾和委派详情展示，避免父入口重复一组卡片。
struct AssistantActionRow: View {
    @Environment(ChatStore.self) private var store
    /// 只有 PhoneShell 注入；为 nil 时不出「全部」
    @Environment(\.openDelegation) private var openDelegation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var tool: ToolCall
    var text: String
    /// 父视图已解析的委派 ID（若有）；避免子视图反复解析 tool.result 或直接订阅整个 store.assistantState
    var precomputedDelegationId: String? = nil

    @State private var localDecision: String?

    private func resolveDelegationId(baseTool: String, precomputedId: String?, parsedResult: [String: JSONValue]?) -> String? {
        guard baseTool == "delegate" else { return nil }
        if let precomputedId { return precomputedId }
        if let id = parsedResult?["id"]?.string?.nilIfEmpty { return id }
        // 仅当结果缺少 id 且带 childChatId 时才按需查一次 assistantState，避免非 delegate / 常规行订阅 assistantState
        guard let childId = parsedResult?["childChatId"]?.string?.nilIfEmpty else { return nil }
        return store.assistantState?.delegations.first(where: { $0.childChatId == childId })?.id
    }

    private func resolveSkillProposal(baseTool: String, parsedResult: [String: JSONValue]?) -> (id: String, rev: Int, summary: String)? {
        guard baseTool == "skill_propose",
              let obj = parsedResult?["proposal"]?.object,
              let id = obj["id"]?.string?.nilIfEmpty
        else { return nil }
        let rev = obj["rev"]?.int ?? 1
        let summary = obj["summary"]?.string ?? ""
        return (id, rev, summary)
    }

    private var failed: Bool {
        tool.status == "error" || tool.result?["ok"]?.bool == false
    }

    private func statusText(baseTool: String) -> String {
        if tool.status == "running" { return "处理中" }
        if failed { return "未完成" }
        if baseTool == "skill_use" { return "已查阅" }
        if baseTool == "skill_propose" {
            if localDecision == "approved" { return "已批准" }
            if localDecision == "rejected" { return "已拒绝" }
            return "待启用"
        }
        return "已提交"
    }

    private func actionSymbol(baseTool: String) -> String {
        if baseTool == "skill_use" { return "bolt.fill" }
        if baseTool == "skill_propose" { return "sparkles" }
        return "paperplane"
    }

    private var statusColor: Color {
        if tool.status == "running" { return JieboColor.run }
        return failed ? JieboColor.danger : JieboColor.ok
    }

    var body: some View {
        // 单次求值 baseTool 与 resultObject，消除旧版 body 内 3× delegateRefs + 2× skillProposalInfo 重复 JSON 解析
        let baseTool = AssistantToolText.baseName(tool.name)
        let precomputedId = precomputedDelegationId?.nilIfEmpty
        let needsResult = (baseTool == "delegate" && precomputedId == nil) || baseTool == "skill_propose"
        let parsedResult = needsResult ? AssistantToolText.resultObject(tool.result) : nil
        let delegationId = resolveDelegationId(baseTool: baseTool, precomputedId: precomputedId, parsedResult: parsedResult)
        let proposal = resolveSkillProposal(baseTool: baseTool, parsedResult: parsedResult)
        let canOpenDelegation = openDelegation != nil && delegationId != nil
        let showProposalActions = proposal != nil && localDecision == nil

        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: actionSymbol(baseTool: baseTool))
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(statusColor)
                    .frame(width: 18)
                Text(text)
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(2)
                Spacer(minLength: 0)
                Text(statusText(baseTool: baseTool))
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(statusColor)
                if canOpenDelegation {
                    Image(systemName: "chevron.right")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.dim)
                        .accessibilityHidden(true)
                }
            }
            if let prop = proposal, localDecision == nil {
                if !prop.summary.isEmpty {
                    Text(prop.summary)
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.ink2)
                }
                HStack(spacing: 8) {
                    ActionButton(title: "批准并上架", kind: .primary) {
                        localDecision = "approved"
                        store.memoryCenterDecideSkillProposal(proposalId: prop.id, approve: true, expectedRev: prop.rev)
                    }
                    ActionButton(title: "拒绝", kind: .outline) {
                        localDecision = "rejected"
                        store.memoryCenterDecideSkillProposal(proposalId: prop.id, approve: false, expectedRev: prop.rev)
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, showProposalActions ? 8 : 0)
        .frame(minHeight: 44)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .onTapGesture {
            if let openDelegation, let id = delegationId { openDelegation(id) }
        }
        .animation(JieboMotion.fade(reduceMotion), value: tool.status)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(canOpenDelegation ? .isButton : [])
        .accessibilityHint(canOpenDelegation ? "轻点两下查看委派详情" : "")
    }
}

/// 委派的状态和交付跟着小驳的原回合更新，预览文件时仍留在当前会话。
struct AssistantDelegationReceipt: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let item: AssistantDelegation
    let turn: Turn
    let chatId: String
    @State private var expanded = false
    @State private var editing = false
    @State private var note = ""
    @State private var sendError = false

    private var inProgress: Bool { item.status == "queued" || item.status == "running" || item.status == "awaiting" }
    private var status: String {
        switch item.status {
        case "queued": "排队中"
        case "cancelled": "已取消"
        case "running": "进行中"
        case "awaiting": "等你处理"
        case "done": "已交付"
        case "failed": item.interrupted == true ? "已中断" : "未交付"
        default: "状态待同步"
        }
    }

    private var statusColors: (foreground: Color, background: Color) {
        switch item.status {
        case "queued", "running": (JieboColor.run, JieboColor.runBg)
        case "awaiting": (JieboColor.warnFg, JieboColor.warnBg)
        case "failed": (JieboColor.danger, JieboColor.dangerBg)
        default: (JieboColor.ink2, JieboColor.mist)
        }
    }

    private var files: [TurnFile] {
        var paths = Set<String>()
        return turn.cardFiles.reversed().filter {
            $0.sourceChatId == item.childChatId && paths.insert($0.path).inserted
        }.reversed()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(JieboMotion.snappy(reduceMotion)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(statusColors.foreground)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title)
                            .font(JieboFont.text(.footnote, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                        Text(item.workspace + ((item.attempt ?? 1) > 1 ? " · 第 \(item.attempt ?? 1) 轮" : ""))
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.ink2)
                    }
                    .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    StatusTag(text: status, fg: statusColors.foreground, bg: statusColors.background)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityValue(expanded ? "已展开" : "已收起")
            .accessibilityHint(expanded ? "轻点两下收起委派" : "轻点两下展开委派")
            if expanded { detail }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, expanded ? 12 : 4)
        .frame(maxWidth: JieboMeasure.bubble, alignment: .leading)
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md))
        .overlay(RoundedRectangle(cornerRadius: JieboRadius.md).stroke(JieboColor.line))
        .animation(JieboMotion.fade(reduceMotion), value: item.status)
        .accessibilityElement(children: .contain)
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let deliverable = item.deliverable {
                Text("预期交付：\(deliverable)").font(JieboFont.text(.footnote))
            }
            if let task = item.task {
                DisclosureGroup("原任务") {
                    Text(task).font(JieboFont.text(.footnote)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(JieboFont.text(.caption))
            }
            if let result = item.result {
                ChunkedAssistantMessage(text: ReplyText.repair(result)).textSelection(.enabled)
            }
            let linkedFiles = files
            if !linkedFiles.isEmpty {
                Text("关联产物").font(JieboFont.text(.caption)).foregroundStyle(JieboColor.ink2)
                TurnFileCards(turn: turn, chatId: chatId, files: linkedFiles)
            }
            if item.status == "awaiting" {
                ForEach((store.assistantState?.approvals ?? []).filter { $0.delegationId == item.id }) { approval in
                    ApprovalCard(approval: approval, style: .plain)
                }
            }
            if let reason = item.waitReason { AssistantMutedText(reason) }
            DelegationQueueAction(item: item)
            if !inProgress {
                if editing {
                    TextField("补充要求", text: $note, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(2...5)
                    if sendError {
                        Text("还没能发送，请稍后再试。").font(JieboFont.text(.caption)).foregroundStyle(JieboColor.danger)
                    }
                    HStack {
                        ActionButton(title: "交给小驳", kind: .primary) {
                            sendError = !store.continueDelegation(item, note: String(note.prefix(4000)))
                            if !sendError { note = ""; editing = false }
                        }
                        .disabled(!store.connected || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        ActionButton(title: "收起", kind: .outline) { editing = false }
                    }
                } else if item.interrupted != true {
                    ActionButton(title: "继续这项委派", kind: .outline) { editing = true }
                }
            }
        }
    }
}
