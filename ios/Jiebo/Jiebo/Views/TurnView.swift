import SwiftUI
import UIKit
import ImageIO

struct TurnView: View, Equatable {
    @Environment(ChatStore.self) private var store
    @Environment(\.threadChatId) private var environmentChatId
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var turn: Turn
    var canAnswer = false
    /// iPhone 助理页：记忆类工具不出卡片，delegate / create_workspace 写成人话
    var embedded = false
    var isLastAssistant = false
    /// 本机审阅记录与还原中：都存在 store 里而不在 Turn 上，作为入参让 == 能看到它们的变化
    var reviewMark: String? = nil
    var restoring = false
    /// 这一轮 todo_add 记下的待办（按工具结果里的 id 对上今日里的那条），回执里能撤销和改
    var captured: [TodoReceipt] = []
    var calendarInvite: AssistantCalendar? = nil
    @State private var editingTodo: AssistantTodo?
    @State private var thinkingOpen = false
    @State private var thinkingPinned = false
    @State private var shareItem: ShareItem?
    @State private var viewerItem: AttachmentViewerItem?
    private var chatId: String { environmentChatId.isEmpty ? store.activeId : environmentChatId }

    static func == (lhs: TurnView, rhs: TurnView) -> Bool {
        lhs.turn == rhs.turn && lhs.canAnswer == rhs.canAnswer
            && lhs.embedded == rhs.embedded && lhs.isLastAssistant == rhs.isLastAssistant
            && lhs.reviewMark == rhs.reviewMark && lhs.restoring == rhs.restoring
            && lhs.captured == rhs.captured && lhs.calendarInvite == rhs.calendarInvite
    }
    private func turnThumb(_ image: PromptImage, index: Int, total: Int) -> some View {
        let base64 = image.data
        let title = total > 1 ? "附图 \(index + 1)/\(total)" : "附图"
        return Button {
            viewerItem = AttachmentViewerItem(title: title, load: { Data(base64Encoded: base64) })
        } label: {
            AttachmentThumb(key: JieboThumbDecoder.key(base64: base64, size: 72), side: 72) {
                Data(base64Encoded: base64)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(title)
        .accessibilityHint("轻点两下查看大图")
    }

    /// .embedded 下 memory_* / chat_search 整张不渲染；其它端原样
    private var visibleTools: [ToolCall] {
        let tools = ToolCall.uniqued(turn.tools)
        return embedded ? tools.filter { !AssistantToolText.isSilent($0) } : tools
    }

    private var processTools: [ToolCall] {
        visibleTools.filter { tool in
            if AskedForm.parse(tool) != nil { return false }
            if captured.contains(where: { $0.callId == tool.callId }) { return false }
            if embedded, AssistantToolText.friendly(tool) != nil { return false }
            return true
        }
    }

    private var userFailed: Bool {
        !turn.running && !turn.queued && turn.error?.nilIfEmpty != nil && turn.assistant.isEmpty
    }

    private var turnMeta: String? {
        let mode = turn.mode?.label
        let model = turn.model?.nilIfEmpty.map { ModelCatalog.label(for: $0) }
        let parts = [mode, model].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        let inline = InlineFileCards.split(turn)
        VStack(alignment: .leading, spacing: 10) {
            if !turn.user.isEmpty {
                HStack {
                    Spacer(minLength: 80)
                    VStack(alignment: .trailing, spacing: 4) {
                        VStack(alignment: .trailing, spacing: 8) {
                            if !turn.images.isEmpty {
                                let thumbs = HStack(spacing: 8) {
                                    ForEach(Array(turn.images.enumerated()), id: \.offset) { index, image in
                                        turnThumb(image, index: index, total: turn.images.count)
                                    }
                                }
                                // 放得下就排一行，放不下改横向滑动（最多 5 张，窄屏放不下）
                                ViewThatFits(in: .horizontal) {
                                    thumbs
                                    ScrollView(.horizontal, showsIndicators: false) { thumbs }
                                }
                            }
                            if turn.user != "（附图）" || turn.images.isEmpty {
                                Text(turn.user)
                                    .font(JieboFont.text(.callout))
                                    .foregroundStyle(JieboColor.ink)
                                    .textSelection(.enabled)
                                    .lineSpacing(4)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(.horizontal, 15)
                        .padding(.vertical, 11)
                        .background(JieboColor.userBubble)
                        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14, bottomTrailingRadius: 4, topTrailingRadius: 14, style: .continuous))
                        .overlay(
                            UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14, bottomTrailingRadius: 4, topTrailingRadius: 14, style: .continuous)
                                .stroke(JieboColor.pine.opacity(0.1), lineWidth: 1)
                        )
                        .frame(maxWidth: JieboMeasure.bubble, alignment: .trailing)
                        .contextMenu {
                            if let meta = turnMeta {
                                Section(meta) {}
                            }
                            Button { store.editTurn(turn.id, chatId: chatId) } label: { Label("编辑", systemImage: "pencil") }
                            Button { store.retryTurn(turn.id, chatId: chatId) } label: { Label("重试", systemImage: "arrow.clockwise") }
                            Button { copy(turn.user) } label: { Label("复制", systemImage: "doc.on.doc") }
                        }
                        .fullScreenCover(item: $viewerItem) { item in
                            AttachmentViewer(item: item)
                        }
                        if turn.queued {
                            HStack(spacing: 4) {
                                Text("排队中")
                                    .font(JieboFont.text(.caption, weight: .medium))
                                    .foregroundStyle(JieboColor.run)
                                Button("去掉") { store.dropQueuedTurn(turn.id, chatId: chatId) }
                                    .font(JieboFont.text(.caption))
                                    .foregroundStyle(JieboColor.ink2)
                                    .buttonStyle(.plain)
                                    .hitTarget()
                                    .accessibilityLabel("去掉这条排队消息")
                            }
                        } else if userFailed {
                            Button("重试") { store.retryTurn(turn.id, chatId: chatId) }
                                .font(JieboFont.text(.caption, weight: .semibold))
                                .foregroundStyle(JieboColor.danger)
                                .buttonStyle(.plain)
                                .hitTarget()
                        }
                    }
                }
            }
            if !turn.thinking.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(JieboMotion.snappy(reduceMotion)) {
                            thinkingOpen.toggle()
                            thinkingPinned = thinkingOpen
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "chevron.right")
                                .font(JieboFont.text(.caption2, weight: .semibold))
                                .foregroundStyle(JieboColor.ink2)
                                .rotationEffect(.degrees(thinkingOpen ? 90 : 0))
                            if turn.running {
                                ShimmerText(text: "正在思考", font: JieboFont.text(.footnote))
                            } else {
                                Text("思考过程")
                                    .font(JieboFont.text(.footnote, weight: .medium))
                                    .foregroundStyle(JieboColor.ink2)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, thinkingOpen ? 12 : 0)
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(turn.running ? "正在思考" : "思考过程")
                    .accessibilityValue(thinkingOpen ? "已展开" : "已收起")
                    .accessibilityHint(thinkingOpen ? "轻点两下收起" : "轻点两下展开")
                    if thinkingOpen {
                        Text(turn.thinking)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 10)
                            .textSelection(.enabled)
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: thinkingOpen ? 12 : 8, style: .continuous))
                .overlay {
                    if thinkingOpen {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    }
                }
                .onAppear { syncThinkingOpen() }
                .onChange(of: turn.running) { _, _ in syncThinkingOpen() }
            }
            ForEach(visibleTools) { tool in
                if let asked = AskedForm.parse(tool) {
                    QuestionCardView(asked: asked, canAnswer: canAnswer)
                } else if embedded, let text = AssistantToolText.friendly(tool) {
                    AssistantActionRow(tool: tool, text: text)
                }
            }
            if processTools.count >= 2 {
                ToolRunSummaryView(tools: processTools, turnRunning: turn.running, durationMs: turn.durationMs)
            } else {
                ForEach(processTools) { tool in
                    ToolCardView(tool: tool, showBorder: false)
                }
            }
            if !turn.assistant.isEmpty {
                HStack(alignment: .top, spacing: embedded ? 0 : 12) {
                    if !embedded { BotAvatar() }
                    VStack(alignment: .leading, spacing: 6) {
                        if let inline {
                            // 卡片插在正文中间：逐段渲染，段后跟这段写出的文件
                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(Array(inline.parts.enumerated()), id: \.offset) { _, part in
                                    if part.text.contains(where: { !$0.isWhitespace }) {
                                        StreamingAssistantText(
                                            text: part.text,
                                            live: turn.running,
                                            transform: linkMentions
                                        )
                                    }
                                    if !part.files.isEmpty {
                                        TurnFileCards(
                                            turn: turn,
                                            chatId: chatId,
                                            files: part.files
                                        )
                                    }
                                }
                            }
                        } else {
                            StreamingAssistantText(
                                text: turn.assistant,
                                live: turn.running,
                                transform: linkMentions
                            )
                        }
                        if turn.mode == .plan, !turn.running, !turn.queued {
                            Button("执行这个计划") { store.applyPlan(turn.id, chatId: chatId) }
                                .buttonStyle(.borderedProminent)
                                .tint(JieboColor.pine)
                                .font(JieboFont.text(.subheadline, weight: .semibold))
                                .padding(.top, 2)
                        }
                    }
                    .contextMenu {
                        if !turn.assistant.isEmpty {
                            Button { copy(turn.assistant) } label: { Label("复制", systemImage: "doc.on.doc") }
                            Button { store.retryTurn(turn.id, chatId: chatId) } label: { Label("重新生成", systemImage: "arrow.clockwise") }
                            // 菜单收起后 ShareLink 的宿主会被销毁：改成先记下、再由本视图弹分享面板
                            Button { shareItem = ShareItem(text: turn.assistant) } label: {
                                Label("分享", systemImage: "square.and.arrow.up")
                            }
                        }
                    }
                    .sheet(item: $shareItem) { item in
                        ActivityView(items: [item.text])
                            .presentationDetents([.medium, .large])
                    }
                }
            }
            if turn.running, turn.assistant.isEmpty {
                ShimmerText(text: turn.task?.nilIfEmpty ?? "开始动手", font: JieboFont.text(.subheadline))
            }
            if turn.running, isLastAssistant {
                StallHintRow()
            }
            if !captured.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(captured) { receipt in
                        TodoReceiptRow(receipt: receipt) { editingTodo = $0 }
                    }
                    if let calendarInvite, !turn.running {
                        CalendarInviteCard(calendar: calendarInvite, compact: true)
                    }
                }
                .padding(.leading, embedded ? 0 : 40)
                .sheet(item: $editingTodo) { todo in
                    TodoEditSheet(todo: todo)
                }
            }
            if let error = turn.error, !error.isEmpty, !turn.running {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(JieboFont.text(.subheadline))
                        .foregroundStyle(JieboColor.danger)
                        .accessibilityHidden(true)
                    Text(friendlyError(error))
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("重试") { store.retryTurn(turn.id, chatId: chatId) }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                        .tint(JieboColor.danger)
                        .font(JieboFont.text(.footnote, weight: .semibold))
                }
                .padding(.leading, 12)
                .padding(.trailing, 8)
                .frame(minHeight: 48)
                .background(JieboColor.dangerBg)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                .accessibilityElement(children: .contain)
            }
            // 顺序：正文 → 文件 → 审阅 → 操作。审阅条是对上面这些文件的决定，放在它们之后
            if let inline {
                if !inline.tail.isEmpty {
                    TurnFileCards(turn: turn, chatId: chatId, files: inline.tail)
                        .padding(.leading, embedded ? 0 : 40)
                }
            } else if !turn.cardFiles.isEmpty {
                TurnFileCards(turn: turn, chatId: chatId)
                    .padding(.leading, embedded ? 0 : 40)
            }
            if turn.needsFileReview, store.localTurnReviews[turn.id] == nil {
                TurnReviewBar(turn: turn)
                    .padding(.leading, embedded ? 0 : 40)
            }
            if isLastAssistant, !turn.running, !turn.assistant.isEmpty {
                assistantActionRow
                    .padding(.leading, embedded ? 0 : 40)
            } else if !turn.running, !turn.assistant.isEmpty {
                // 更早的轮次只留复制：发了新消息以后，上一轮的按钮不该整个消失
                Button { copy(turn.assistant) } label: {
                    Image(systemName: "doc.on.doc")
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.dim)
                        .frame(width: 44, height: 32, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("复制回复")
                .padding(.leading, embedded ? 0 : 40)
            }
            // 无助手正文时耗时仍贴在轮次底部，用 ink2 保证可读
            if turn.assistant.isEmpty,
               let duration = formatDuration(turn.durationMs).nilIfEmpty,
               !turn.running
            {
                Text(duration)
                    .font(JieboFont.text(.caption, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .padding(.leading, embedded ? 0 : 40)
            }
        }
    }

    /// 最后一轮的复制 / 重试 / 分享：只放图标（系统同款），每个 44pt 热区；更早的轮次走长按菜单
    private var assistantActionRow: some View {
        HStack(spacing: 0) {
            actionIcon("doc.on.doc", label: "复制回复") { copy(turn.assistant) }
            actionIcon("arrow.clockwise", label: "重新生成") { store.retryTurn(turn.id, chatId: chatId) }
            ShareLink(item: turn.assistant) {
                Image(systemName: "square.and.arrow.up")
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("分享回复")
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func actionIcon(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func copy(_ text: String) {
        UIPasteboard.general.string = text
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        store.flash("已复制")
    }

    private func syncThinkingOpen() {
        if turn.running {
            thinkingOpen = true
        } else if !thinkingPinned {
            thinkingOpen = false
        }
    }

    /// 把正文里的 @路径 转成可点链接（jiebo-file://open?path=…），由 openURL 拦截打开预览面板。
    /// 对齐网页 splitCiteParts：字符集排除 @: 与 CJK 标点，:行号/-区间 只显示不进路径；
    /// 跳过 ``` 围栏与行内 `代码` 段；只链接「像文件」的 token（isFileMention）。
    /// group1=前导空白 group2=路径 group3=:行号后缀（可选，仅显示用）
    private static let mentionRegex = try? NSRegularExpression(pattern: #"(^|\s)@([^\s@:，。；、！？,;!?)]+)((?::\d+(?:-\d+)?)?)"#)
    private static let mentionAllowed: CharacterSet = {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&#+=") // query 里这些字符必须编码，否则 openURL 侧解析会断
        return allowed
    }()

    private func linkMentions(_ text: String) -> String {
        guard text.contains("@") else { return text }
        let regex = Self.mentionRegex
        let allowed = Self.mentionAllowed
        var inFence = false
        return text.components(separatedBy: "\n").map { line in
            if line.hasPrefix("```") { inFence.toggle(); return line }
            guard !inFence, let regex else { return line }
            // 按反引号切段，只处理非代码段（偶数段）
            let segments = line.components(separatedBy: "`")
            var rebuilt: [String] = []
            for (index, segment) in segments.enumerated() {
                guard index % 2 == 0, !segment.isEmpty else {
                    rebuilt.append(segment)
                    continue
                }
                rebuilt.append(linkMentionsInSegment(segment, regex: regex, allowed: allowed))
            }
            return rebuilt.joined(separator: "`")
        }.joined(separator: "\n")
    }

    private func linkMentionsInSegment(_ segment: String, regex: NSRegularExpression, allowed: CharacterSet) -> String {
        let matches = regex.matches(in: segment, range: NSRange(segment.startIndex..., in: segment))
        guard !matches.isEmpty else { return segment }
        var out = ""
        var cursor = segment.startIndex
        for match in matches {
            guard let full = Range(match.range, in: segment),
                  let pathRange = Range(match.range(at: 2), in: segment),
                  let suffixRange = Range(match.range(at: 3), in: segment)
            else { continue }
            let path = String(segment[pathRange])
            guard TurnView.isFileMention(path) else { continue }
            let suffix = String(segment[suffixRange]) // :12-34 仅显示
            out += segment[cursor ..< full.lowerBound]
            let leading = segment[full].first.map { $0 == " " || $0 == "\t" ? String($0) : "" } ?? ""
            let encoded = path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path
            out += "\(leading)[@\(path)\(suffix)](jiebo-file://open?path=\(encoded))"
            cursor = full.upperBound
        }
        out += segment[cursor...]
        return out
    }

    /// 对齐网页 isFileMention：含 . / : 或常见无扩展名文件
    static func isFileMention(_ token: String) -> Bool {
        if token.lowercased() == "diff" || token.hasSuffix("/") { return true }
        if token.range(of: #"[./:]"#, options: .regularExpression) != nil { return true }
        return token.range(
            of: #"^(readme|license|makefile|dockerfile|changelog|gemfile|procfile|jenkinsfile)(\.[a-z0-9]+)?$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }
}

/// 文件卡片插回正文：工具开始时记下的正文偏移（ToolCall.at，UTF-16）往后吸到块边界，正文在那里切开、卡片跟在后面。
/// 边界只取行首（换行之后），不切进 ``` 围栏，也不切开表格（连续以 | 开头的行）
private enum InlineFileCards {
    struct Part {
        var text: String
        var files: [TurnFile]
    }

    /// nil：没有落在正文中间的卡片，照旧整段正文 + 末尾卡片。tail 是挂在末尾的（没有偏移或偏移在正文之后）
    static func split(_ turn: Turn) -> (parts: [Part], tail: [TurnFile])? {
        let text = turn.assistant
        guard !text.isEmpty, turn.tools.contains(where: { $0.at != nil }) else { return nil }
        let files = turn.cardFiles
        guard !files.isEmpty else { return nil }
        let lines = text.components(separatedBy: "\n")
        // starts[i]：第 i 行起点的 UTF-16 偏移
        var starts: [Int] = []
        starts.reserveCapacity(lines.count)
        var offset = 0
        for line in lines {
            starts.append(offset)
            offset += line.utf16.count + 1
        }
        // allowed[k]：能否在第 k 行之前切开（k == lines.count 即末尾）
        var allowed = [Bool](repeating: true, count: lines.count + 1)
        // 围栏：最多缩进 3 格的 ``` 或 ~~~，只由同一种符号关上。fenced[i]：第 i 行在围栏里（含起止行）
        var fenced = [Bool](repeating: false, count: lines.count)
        var fenceOpenAfter = [Bool](repeating: false, count: lines.count)
        var openMark: Character?
        for index in lines.indices {
            if let mark = fenceMark(lines[index]) {
                if openMark == nil {
                    openMark = mark
                } else if openMark == mark {
                    openMark = nil
                }
                fenced[index] = true
            } else {
                fenced[index] = openMark != nil
            }
            fenceOpenAfter[index] = openMark != nil
        }
        // 表格块：含 | 的表头 + 分隔行 + 之后连续的非空且含 | 的行。table[i] 是所在块的首行号，不在块里为 -1
        var table = [Int](repeating: -1, count: lines.count)
        var row = 0
        while row < lines.count {
            if row + 1 < lines.count, !fenced[row], !fenced[row + 1],
               lines[row].contains("|"), isDelimiterRow(lines[row + 1])
            {
                var end = row + 2
                while end < lines.count, !fenced[end], lines[end].contains("|"),
                      lines[end].contains(where: { !$0.isWhitespace })
                {
                    end += 1
                }
                for member in row ..< end { table[member] = row }
                row = end
            } else {
                row += 1
            }
        }
        for index in lines.indices {
            let next = index + 1
            guard next < lines.count else { break }
            let sameTable = table[index] >= 0 && table[index] == table[next]
            allowed[next] = !fenceOpenAfter[index] && !sameTable
                && !(isTableRow(lines[index]) && isTableRow(lines[next]))
        }
        // 最后一行有字的行之后只剩空行：落在那里的算末尾
        let lastContent = lines.lastIndex(where: { line in line.contains(where: { !$0.isWhitespace }) }) ?? -1
        let total = max(offset - 1, 0)
        var groups: [Int: [TurnFile]] = [:]
        var tail: [TurnFile] = []
        for file in files {
            guard let at = anchor(of: file, in: turn) else {
                tail.append(file)
                continue
            }
            let cut = boundary(at: at, total: total, starts: starts, allowed: allowed)
            if cut > lastContent {
                tail.append(file)
            } else {
                groups[cut, default: []].append(file)
            }
        }
        guard !groups.isEmpty else { return nil }
        var parts: [Part] = []
        var previous = 0
        for cut in groups.keys.sorted() {
            parts.append(Part(text: lines[previous ..< cut].joined(separator: "\n"), files: groups[cut] ?? []))
            previous = cut
        }
        parts.append(Part(text: lines[previous...].joined(separator: "\n"), files: []))
        return (parts, tail)
    }

    /// 写这个文件的第一个带偏移的工具（路径归一同 Turn.cardPath / samePath）
    private static func anchor(of file: TurnFile, in turn: Turn) -> Int? {
        turn.tools.first { tool in
            guard tool.at != nil, let path = Turn.cardPath(of: tool) else { return false }
            return Turn.samePath(path, file.path)
        }?.at
    }

    /// 偏移所在行的下一个行首（偏移正好在行首就是这一行），再跳过围栏/表格内部。返回「在第几行之前切」
    private static func boundary(at raw: Int, total: Int, starts: [Int], allowed: [Bool]) -> Int {
        let count = starts.count
        let at = min(max(raw, 0), total)
        if at == 0 { return 0 }
        if at >= total { return count }
        var low = 0
        var high = count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if starts[mid] <= at { low = mid } else { high = mid - 1 }
        }
        var cut = starts[low] == at ? low : low + 1
        while cut < count, !allowed[cut] { cut += 1 }
        return cut
    }

    private static func isTableRow(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("|")
    }

    /// 围栏起止行的符号（` 或 ~）；前面最多 3 个空格
    private static func fenceMark(_ line: String) -> Character? {
        let indent = line.prefix(while: { $0 == " " }).count
        guard indent <= 3 else { return nil }
        let rest = line.dropFirst(indent)
        if rest.hasPrefix("```") { return "`" }
        if rest.hasPrefix("~~~") { return "~" }
        return nil
    }

    /// 表格分隔行：只由 - : | 和空白组成，至少一个 - 和一个 |
    private static func isDelimiterRow(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.contains("|") else { return false }
        return trimmed.allSatisfy { $0 == "-" || $0 == ":" || $0 == "|" || $0 == " " || $0 == "\t" }
    }
}

private struct ShareItem: Identifiable {
    let id = UUID()
    let text: String
}

/// 一段时间没有新输出时的提示：4 秒起「仍在处理…」，15 秒起带秒数并给一个停止按钮（对齐网页）。
/// 单独成 View，只有它读 store.stallSeconds，每秒刷新不影响整条对话。
struct StallHintRow: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        let seconds = store.stallSeconds
        if seconds >= 4 {
            HStack(spacing: 8) {
                Text(seconds >= 15 ? "仍在处理… 已 \(seconds) 秒没有新输出" : "仍在处理…")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                    .monospacedDigit()
                if seconds >= 15 {
                    Button("停止") { store.stop(chatId: chatId) }
                        .font(JieboFont.text(.caption, weight: .semibold))
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                        .tint(JieboColor.clay)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}
