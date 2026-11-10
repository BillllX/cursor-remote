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

    static func captured(in turn: Turn, todos: [AssistantTodo]?) -> [TodoReceipt] {
        turn.tools.compactMap { tool in
            guard AssistantToolText.baseName(tool.name) == "todo_add",
                  let result = AssistantToolText.resultObject(tool.result),
                  result["ok"]?.bool == true,
                  let id = result["id"]?.string
            else { return nil }
            let todo = todos?.first(where: { $0.id == id })
            return TodoReceipt(
                callId: tool.callId,
                text: todo?.text ?? tool.args?.string(in: "text") ?? "",
                due: todo?.due ?? (result["due"]?.string?.nilIfEmpty ?? tool.args?.string(in: "due").nilIfEmpty),
                duplicate: result["duplicate"]?.bool == true,
                todo: todo,
                known: todos != nil
            )
        }
    }
}

/// 「已记：周三 15:00 交报告  撤销 · 改」。撤销即删掉这条待办
struct TodoReceiptRow: View {
    @Environment(ChatStore.self) private var store
    var receipt: TodoReceipt
    var edit: (AssistantTodo) -> Void

    private var removed: Bool { receipt.known && receipt.todo == nil }
    private var done: Bool { receipt.todo?.done == true }

    private var head: String {
        if removed { return "已撤销" }
        if done { return "已完成" }
        return receipt.duplicate ? "待办里已有" : "已记"
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
            if let todo = receipt.todo, !todo.done {
                if !receipt.duplicate {
                    receiptButton("撤销") {
                        store.queueTodoChange("todo_remove", args: ["id": .string(todo.id)], pending: "删除这条待办")
                    }
                }
                receiptButton("改") { edit(todo) }
            }
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 40)
        .background(JieboColor.mist)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func receiptButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .font(JieboFont.text(.footnote, weight: .semibold))
            .foregroundStyle(JieboColor.pine)
            .buttonStyle(.plain)
            .frame(minWidth: 36, minHeight: 40)
            .contentShape(Rectangle())
    }
}

enum AssistantToolText {
    static func baseName(_ name: String) -> String {
        var base = name.lowercased()
        for separator in ["__", ".", "/", ":"] {
            if let range = base.range(of: separator, options: .backwards) {
                base = String(base[range.upperBound...])
            }
        }
        return base
    }

    static let knownSkillNames: [String: String] = [
        "canvas-artifact-builder": "交互式主题画布构建与一键 SSR 验真",
        "jiebo-gateway-arch": "Jiebo 网关与双端核心架构速查地图",
        "kb-drop-ingest": "多源知识库投递与 HTML 看板归档",
        "shanghai-deploy-smoke": "上海站发布与 UI 登录态冒烟手册",
        "ios-swiftui-motion": "iOS SwiftUI 界面规范与动效性能审查",
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
        let argName = tool.args?.string(in: "name")?.nilIfEmpty
        let displayName = resultName ?? argName ?? knownSkillNames[id]
        if let displayName, !id.isEmpty, displayName != id {
            return "\(displayName) (\(id))"
        }
        return displayName ?? id.nilIfEmpty ?? "全部已集成技能"
    }

    static func stripSkillSandboxTags(_ raw: String) -> String {
        var text = raw
        if let r = text.range(of: #"<untrusted_skill_reference[^>]*>\n?"#, options: .regularExpression) {
            text.removeSubrange(r)
        }
        if let r = text.range(of: #"\n?（安全声明：以上技能手册仅作为操作步骤与参数参考[^）]*）\n?"#, options: .regularExpression) {
            text.removeSubrange(r)
        }
        if let r = text.range(of: #"\n?</untrusted_skill_reference>"#, options: .regularExpression) {
            text.removeSubrange(r)
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
            return "已运用技能：\(title)"
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

    /// 委派 id 与子会话 id：先看工具结果，缺的一个从 assistantState.delegations 互查
    private var delegateRefs: (delegationId: String?, childChatId: String?) {
        guard AssistantToolText.baseName(tool.name) == "delegate" else { return (nil, nil) }
        let row = AssistantToolText.resultObject(tool.result)
        var delegationId = row?["id"]?.string?.nilIfEmpty
        var childId = row?["childChatId"]?.string?.nilIfEmpty
        let delegations = store.assistantState?.delegations ?? []
        if childId == nil, let delegationId {
            childId = delegations.first(where: { $0.id == delegationId })?.childChatId.nilIfEmpty
        }
        if delegationId == nil, let childId {
            delegationId = delegations.first(where: { $0.childChatId == childId })?.id
        }
        return (delegationId, childId)
    }

    @State private var localDecision: String?

    private var baseTool: String {
        AssistantToolText.baseName(tool.name)
    }

    private var skillProposalInfo: (id: String, rev: Int, summary: String)? {
        guard baseTool == "skill_propose",
              let obj = AssistantToolText.resultObject(tool.result)?["proposal"]?.object,
              let id = obj["id"]?.string?.nilIfEmpty
        else { return nil }
        let rev = obj["rev"]?.int ?? 1
        let summary = obj["summary"]?.string ?? ""
        return (id, rev, summary)
    }

    private var failed: Bool {
        tool.status == "error" || tool.result?["ok"]?.bool == false
    }

    private var statusText: String {
        if tool.status == "running" { return "处理中" }
        if failed { return "未完成" }
        if baseTool == "skill_use" { return "已加载" }
        if baseTool == "skill_propose" {
            if localDecision == "approved" { return "已批准" }
            if localDecision == "rejected" { return "已拒绝" }
            return "待启用"
        }
        return "已提交"
    }

    private var actionSymbol: String {
        if baseTool == "skill_use" { return "bolt.fill" }
        if baseTool == "skill_propose" { return "sparkles" }
        return "paperplane"
    }

    private var statusColor: Color {
        if tool.status == "running" { return JieboColor.run }
        return failed ? JieboColor.danger : JieboColor.ok
    }

    var body: some View {
        summaryRow
    }

    private var summaryRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: actionSymbol)
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(statusColor)
                    .frame(width: 18)
                Text(text)
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(2)
                Spacer(minLength: 0)
                Text(statusText)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(statusColor)
                if openDelegation != nil, delegateRefs.delegationId != nil {
                    Image(systemName: "chevron.right")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.dim)
                        .accessibilityHidden(true)
                }
            }
            if let prop = skillProposalInfo, localDecision == nil {
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
        .padding(.vertical, skillProposalInfo != nil && localDecision == nil ? 8 : 0)
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
            if let openDelegation, let id = delegateRefs.delegationId { openDelegation(id) }
        }
        .animation(JieboMotion.fade(reduceMotion), value: tool.status)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(openDelegation != nil && delegateRefs.delegationId != nil ? .isButton : [])
        .accessibilityHint(openDelegation != nil && delegateRefs.delegationId != nil ? "轻点两下查看委派详情" : "")
    }
}
