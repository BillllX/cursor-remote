import SwiftUI

struct ToolCardView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var tool: ToolCall
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                // 展开/收起做成独立 Button：容器挂 onTapGesture 会和内部按钮抢手势（P5a 页签同款坑）
                Button {
                    withAnimation(.easeOut(duration: 0.28)) {
                        expanded.toggle()
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: kindSymbol)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(statusColor)
                            .frame(width: 16, height: 16)
                        Text(verb)
                            .font(JieboFont.mono(13))
                            .fontWeight(.medium)
                            .foregroundStyle(JieboColor.ink)
                        Text(titleLine)
                            .font(JieboFont.mono(11))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "收起工具结果" : "展开工具结果")
                // P5b：edit/write 工具给文件入口——按类型路由（diff 页签/原文页签/Quick Look）
                if Self.isImageTool(tool) || Self.imagePath(tool) != nil {
                    let imagePath = Self.imagePath(tool)
                    Button {
                        if let imagePath { store.openPreview(imagePath) }
                    } label: {
                        Label(imagePath == nil ? "正在生成图片" : "预览图片", systemImage: "photo")
                            .font(JieboFont.ui(12, weight: .medium))
                            .foregroundStyle(JieboColor.ink)
                            .padding(.horizontal, 8)
                            .frame(height: 26)
                            .background(JieboColor.mist)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(imagePath == nil)
                    .accessibilityLabel(imagePath == nil ? "正在生成图片" : "预览 \(imagePath ?? "")")
                } else if tool.kind.isMutating,
                   let path = ChatStore.toolPath(args: tool.args, result: tool.result),
                   !path.isEmpty
                {
                    Button {
                        store.openToolFile(path)
                    } label: {
                        Image(systemName: "plus.forwardslash.minus")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(JieboColor.brass)
                            .frame(width: 26, height: 26)
                            .background(JieboColor.brass.opacity(0.12))
                            .clipShape(Circle())
                            .hitTarget() // P6：视觉 26，命中 44
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("打开 \(path)")
                }
                badge
            }
            if expanded {
                ToolDetail(tool: tool)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: expanded ? 12 : 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: expanded ? 12 : 8, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        )
        .animation(JieboMotion.fade(reduceMotion), value: tool.status)
        .onAppear {
            if tool.status == "running" { expanded = true }
        }
        .onChange(of: tool.status) { _, status in
            if status == "running" { expanded = true }
        }
    }

    private var titleLine: String {
        let summary = tool.summary
        guard let model = tool.model?.nilIfEmpty else { return summary }
        let name = ModelCatalog.label(for: model)
        return summary.isEmpty ? name : "\(summary) · \(name)"
    }

    /// 和网页工具卡同一套动词、状态字。子代理角色占动词位。
    private var verb: String {
        let crew = Crew.label(name: tool.name, args: tool.args, agent: tool.agent)
        if !crew.isEmpty { return crew }
        switch tool.kind {
        case .shell: return "Ran"
        case .search: return "Searched"
        case .edit: return "Edited"
        case .write: return "Wrote"
        case .read: return "Read"
        case .other:
            if tool.name.range(of: "task", options: .caseInsensitive) != nil { return "Task" }
            return tool.name.isEmpty ? "Tool" : tool.name
        }
    }

    private var kindSymbol: String {
        switch tool.kind {
        case .search: "magnifyingglass"
        case .read: "doc.text"
        case .edit: "pencil"
        case .write: "square.and.pencil"
        case .shell: "terminal"
        case .other: "wrench.and.screwdriver"
        }
    }

    private var statusColor: Color {
        switch tool.status {
        case "running": JieboColor.run
        case "error": JieboColor.danger
        default: JieboColor.ok
        }
    }

    /// 状态只留字，不再用绿色胶囊。
    @ViewBuilder
    private var badge: some View {
        switch tool.status {
        case "running":
            badgeView("Processing", fg: JieboColor.run)
        case "error":
            badgeView("Error", fg: JieboColor.danger)
        default:
            badgeView("Completed", fg: JieboColor.ok)
        }
    }

    private func badgeView(_ text: String, fg: Color) -> some View {
        Text(text)
            .font(JieboFont.mono(11))
            .foregroundStyle(fg)
    }

    static func isImageTool(_ tool: ToolCall) -> Bool {
        let name = tool.name.lowercased()
        return name.contains("generateimage") || name.contains("generate_image") || name.contains("image_gen")
    }

    /// 生图工具，或结果路径本身就是图片。
    static func imagePath(_ tool: ToolCall) -> String? {
        guard let raw = ChatStore.toolPath(args: tool.args, result: tool.result)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty
        else { return nil }
        let kind = previewKind(of: raw)
        if isImageTool(tool) || kind == .image || kind == .svg { return raw }
        return nil
    }

    private func clip(_ text: String) -> String {
        if text.count <= 2_000 { return text }
        return String(text.prefix(2_000)) + "\n…"
    }
}

/// 展开后的工具内容：改文件画 diff，命令拆成命令行和输出，其余仍是原文。
private struct ToolDetail: View {
    var tool: ToolCall

    var body: some View {
        let diff = Self.extractDiff(tool)
        let shell = tool.kind == .shell ? Self.extractShell(tool) : nil
        VStack(alignment: .leading, spacing: 6) {
            if tool.result == nil, tool.status == "running", diff.unified.isEmpty, diff.before.isEmpty, diff.after.isEmpty {
                Text("正在跑…")
                    .font(JieboFont.ui(12))
                    .foregroundStyle(JieboColor.dim)
            } else if !diff.unified.isEmpty {
                DiffLines(lines: Self.unifiedLines(diff.unified))
            } else if !diff.before.isEmpty || !diff.after.isEmpty {
                DiffLines(lines: Self.pairLines(before: diff.before, after: diff.after))
            } else if let shell, shell.hasOutput || !shell.command.isEmpty {
                if !shell.command.isEmpty {
                    Text("$ \(shell.command)")
                        .font(JieboFont.mono(12))
                        .foregroundStyle(JieboColor.ink2)
                        .textSelection(.enabled)
                }
                if let exit = shell.exit {
                    Text("exit \(exit)")
                        .font(JieboFont.mono(11))
                        .foregroundStyle(JieboColor.dim)
                }
                if !shell.stdout.isEmpty {
                    Text(clip(shell.stdout))
                        .font(JieboFont.mono(12))
                        .foregroundStyle(JieboColor.ink)
                        .textSelection(.enabled)
                }
                if !shell.stderr.isEmpty {
                    Text(clip(shell.stderr))
                        .font(JieboFont.mono(12))
                        .foregroundStyle(JieboColor.danger)
                        .textSelection(.enabled)
                }
            } else if let result = tool.result {
                Text(clip(result.pretty(8_000)))
                    .font(JieboFont.mono(12))
                    .foregroundStyle(JieboColor.ink)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func clip(_ text: String) -> String {
        if text.count <= 2_000 { return text }
        return String(text.prefix(2_000)) + "\n…"
    }

    private struct ShellBits {
        var command: String
        var stdout: String
        var stderr: String
        var exit: String?
        var hasOutput: Bool { !stdout.isEmpty || !stderr.isEmpty || exit != nil }
    }

    private struct DiffBits {
        var before: String
        var after: String
        var unified: String
    }

    private static func extractShell(_ tool: ToolCall) -> ShellBits {
        let command = tool.args?.string(in: "command", "cmd") ?? ""
        let result = tool.result
        var stdout = result?.string(in: "stdout", "output", "out", "text") ?? ""
        if stdout.isEmpty, case .string(let raw) = result { stdout = raw }
        return ShellBits(
            command: command,
            stdout: stdout,
            stderr: result?.string(in: "stderr", "err", "errorMessage") ?? "",
            exit: result?.string(in: "exitCode", "exit_code", "code", "status").nilIfEmpty
        )
    }

    private static func extractDiff(_ tool: ToolCall) -> DiffBits {
        let before = tool.args?.string(in: "old_string", "oldString", "oldText").nilIfEmpty
            ?? tool.result?.string(in: "old_string", "oldString", "before", "original")
            ?? ""
        let after = tool.args?.string(in: "new_string", "newString", "newText", "contents", "content").nilIfEmpty
            ?? tool.result?.string(in: "new_string", "newString", "after", "updated", "contents", "content")
            ?? ""
        var unified = tool.args?.string(in: "diff", "patch").nilIfEmpty
            ?? tool.result?.string(in: "diff", "patch")
            ?? ""
        if unified.isEmpty, case .string(let raw) = tool.result, raw.range(of: #"^(diff |@@ |\+|-)"#, options: .regularExpression) != nil {
            unified = raw
        }
        if tool.kind != .edit && tool.kind != .write {
            return DiffBits(before: "", after: "", unified: "")
        }
        return DiffBits(before: before, after: after, unified: unified)
    }

    private static func unifiedLines(_ text: String) -> [(kind: String, text: String)] {
        text.split(separator: "\n", omittingEmptySubsequences: false).map { line in
            let row = String(line)
            if row.hasPrefix("+"), !row.hasPrefix("+++") { return ("add", row) }
            if row.hasPrefix("-"), !row.hasPrefix("---") { return ("del", row) }
            return ("same", row)
        }
    }

    private static func pairLines(before: String, after: String) -> [(kind: String, text: String)] {
        let old = before.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let new = after.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var rows: [(kind: String, text: String)] = []
        let count = max(old.count, new.count)
        let cap = min(count, 80)
        for index in 0..<cap {
            let a = index < old.count ? old[index] : nil
            let b = index < new.count ? new[index] : nil
            if a == b, let a { rows.append(("same", " \(a)")) }
            else {
                if let a { rows.append(("del", "-\(a)")) }
                if let b { rows.append(("add", "+\(b)")) }
            }
        }
        if count > cap { rows.append(("same", "…")) }
        return rows
    }
}

private struct DiffLines: View {
    var lines: [(kind: String, text: String)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.prefix(200).enumerated()), id: \.offset) { _, line in
                    Text(line.text.isEmpty ? " " : line.text)
                        .font(JieboFont.mono(12))
                        .foregroundStyle(line.kind == "add" ? JieboColor.ok : line.kind == "del" ? JieboColor.danger : JieboColor.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(line.kind == "add" ? JieboColor.okBg : line.kind == "del" ? JieboColor.dangerBg : Color.clear)
                }
            }
        }
        .frame(maxHeight: 240)
    }
}

struct AskOption: Identifiable, Hashable {
    var id: String
    var label: String
}

struct AskedQuestion: Identifiable, Hashable {
    var id: String
    var prompt: String
    var allowMultiple: Bool
    var options: [AskOption]
}

struct AskedForm: Hashable {
    var title: String
    var questions: [AskedQuestion]

    static func parse(_ tool: ToolCall) -> AskedForm? {
        let name = tool.name.lowercased()
        guard name.contains("ask"), name.contains("question") else { return nil }
        guard let rows = tool.args?["questions"]?.array, !rows.isEmpty else { return nil }
        var questions: [AskedQuestion] = []
        for (index, row) in rows.enumerated() {
            guard let object = row.object else { continue }
            let prompt = object["prompt"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !prompt.isEmpty else { continue }
            let id = object["id"]?.string?.nilIfEmpty ?? "q\(index)"
            let allow = object["allowMultiple"]?.bool == true || object["allow_multiple"]?.bool == true
            var options: [AskOption] = []
            for (optIndex, option) in (object["options"]?.array ?? []).enumerated() {
                guard let opt = option.object else { continue }
                let label = opt["label"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !label.isEmpty else { continue }
                let optionId = opt["id"]?.string?.nilIfEmpty ?? "o\(optIndex)"
                options.append(AskOption(id: optionId, label: label))
            }
            questions.append(AskedQuestion(id: id, prompt: prompt, allowMultiple: allow, options: options))
        }
        guard !questions.isEmpty else { return nil }
        let title = tool.args?["title"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return AskedForm(title: title, questions: questions)
    }

    func answer(picks: [String: Set<String>], notes: [String: String]) -> String {
        var lines = ["对「\(title.isEmpty ? "刚才的问题" : title)」的回答："]
        for (index, question) in questions.enumerated() {
            let chosen = question.options.filter { picks[question.id]?.contains($0.id) == true }.map(\.label)
            let note = notes[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var answer = chosen.joined(separator: "、")
            if !note.isEmpty {
                answer = answer.isEmpty ? note : "\(answer)（\(note)）"
            }
            lines.append("\(index + 1). \(question.prompt)")
            lines.append("回答：\(answer)")
        }
        lines.append("")
        lines.append("请按这些回答继续。")
        return lines.joined(separator: "\n")
    }
}

struct QuestionCardView: View {
    @Environment(ChatStore.self) private var store
    var asked: AskedForm
    var canAnswer: Bool
    @State private var picks: [String: Set<String>] = [:]
    @State private var notes: [String: String] = [:]

    private var ready: Bool {
        asked.questions.allSatisfy { question in
            let chosen = picks[question.id] ?? []
            let note = notes[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return !chosen.isEmpty || !note.isEmpty
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(asked.title.isEmpty ? "需要你选一下" : asked.title)
                .font(JieboFont.ui(15, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
            Text(canAnswer ? "这一轮停在提问上。选好后会接着做。" : "模型问了这些问题。")
                .font(JieboFont.ui(12))
                .foregroundStyle(JieboColor.dim)
            ForEach(Array(asked.questions.enumerated()), id: \.element.id) { index, question in
                VStack(alignment: .leading, spacing: 6) {
                    Text(asked.questions.count > 1 ? "\(index + 1). \(question.prompt)" : question.prompt)
                        .font(JieboFont.ui(15))
                        .foregroundStyle(JieboColor.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if canAnswer {
                        ForEach(question.options) { option in
                            let on = picks[question.id]?.contains(option.id) == true
                            Button {
                                toggle(question, option.id)
                            } label: {
                                Text(option.label)
                                    .font(JieboFont.ui(14, weight: on ? .semibold : .regular))
                                    .foregroundStyle(JieboColor.ink)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .background(on ? JieboColor.brass.opacity(0.14) : JieboColor.mist)
                                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                                            .stroke(on ? JieboColor.brass : JieboColor.line, lineWidth: 1)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                        TextField(
                            question.options.isEmpty ? "写下回答" : "也可以补充一句",
                            text: noteBinding(question.id),
                            axis: .vertical
                        )
                        .lineLimit(2...4)
                        .font(JieboFont.ui(14))
                        .padding(10)
                        .background(JieboColor.paper)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                                .stroke(JieboColor.line, lineWidth: 1)
                        )
                    } else if !question.options.isEmpty {
                        Text(question.options.map(\.label).joined(separator: "  ·  "))
                            .font(JieboFont.ui(13))
                            .foregroundStyle(JieboColor.ink2)
                    }
                }
            }
            if canAnswer {
                Button("按这个回答继续") {
                    store.answerQuestion(asked.answer(picks: picks, notes: notes))
                }
                .buttonStyle(.plain)
                .font(JieboFont.ui(14, weight: .semibold))
                .foregroundStyle(ready ? JieboColor.paper : JieboColor.dim)
                .padding(.horizontal, 16)
                .frame(height: 36)
                .background(ready ? JieboColor.pine : JieboColor.mist)
                .clipShape(Capsule())
                .disabled(!ready)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                .stroke(JieboColor.brass.opacity(0.45), lineWidth: 1)
        )
    }

    private func toggle(_ question: AskedQuestion, _ optionId: String) {
        var current = picks[question.id] ?? []
        if question.allowMultiple {
            if current.contains(optionId) {
                current.remove(optionId)
            } else {
                current.insert(optionId)
            }
        } else if current.count == 1, current.contains(optionId) {
            current = []
        } else {
            current = [optionId]
        }
        picks[question.id] = current
    }

    private func noteBinding(_ id: String) -> Binding<String> {
        Binding(
            get: { notes[id] ?? "" },
            set: { notes[id] = $0 }
        )
    }
}
