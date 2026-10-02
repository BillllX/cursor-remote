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
                        Text(tool.kind.label)
                            .font(JieboFont.mono(12))
                            .fontWeight(.medium)
                            .foregroundStyle(JieboColor.ink2)
                        // crew 徽章：子代理角色（摸仓库/改代码/交叉审）+ 模型（过 ModelCatalog 美化，对齐网页 modelLabel）
                        let crew = Crew.label(name: tool.name, args: tool.args, agent: tool.agent)
                        if !crew.isEmpty {
                            Text(crew + (tool.model?.nilIfEmpty.map { " · \(ModelCatalog.label(for: $0))" } ?? ""))
                                .font(JieboFont.ui(10, weight: .medium))
                                .foregroundStyle(JieboColor.brass)
                        }
                        Text(tool.summary)
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
            if expanded, let result = tool.result {
                let full = result.pretty(8_000)
                let shown = clip(full)
                ScrollView {
                    Text(shown)
                        .font(JieboFont.mono(12))
                        .foregroundStyle(JieboColor.ink)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240)
                if full.count > 2_000 {
                    Text("只显示前 2000 字，一共 \(full.count) 字")
                        .font(JieboFont.ui(11))
                        .foregroundStyle(JieboColor.dim)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        // 退为次级表面：mist 底 + 细描边，阴影收到更浅，避免和终稿同权
        .background(Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                .stroke(JieboColor.line.opacity(0.85), lineWidth: 0.5)
        )
        .animation(JieboMotion.fade(reduceMotion), value: tool.status)
    }

    /// 状态只留字，不再用绿色胶囊。
    @ViewBuilder
    private var badge: some View {
        switch tool.status {
        case "running":
            badgeView("运行中", fg: JieboColor.run)
        case "error":
            badgeView("出错", fg: JieboColor.danger)
        default:
            badgeView("完成", fg: JieboColor.okSoft)
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
