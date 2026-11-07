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
    /// 最后一轮失败且输入框是空的：可以把这一句放回去，不自动发送。
    var canRestorePrompt = false
    /// 这句话还在本地，连接回来才会开始。不要写成已经动手。
    var waitingForLink = false
    /// 本机审阅记录与还原中：都存在 store 里而不在 Turn 上，作为入参让 == 能看到它们的变化
    var reviewMark: String? = nil
    var restoring = false
    /// 这一轮 todo_add 记下的待办（按工具结果里的 id 对上今日里的那条），回执里能撤销和改
    var captured: [TodoReceipt] = []
    var calendarInvite: AssistantCalendar? = nil
    var palette: JieboPalette = JieboTheme.shared.palette
    var appearance: JieboAppearance = JieboTheme.shared.appearance
    @State private var editingTodo: AssistantTodo?
    @State private var thinkingOpen = false
    @State private var thinkingPinned = false
    @State private var shareItem: ShareItem?
    @State private var viewerItem: AttachmentViewerItem?
    private var chatId: String { environmentChatId.isEmpty ? store.activeId : environmentChatId }
    private var assistantText: String { ReplyText.repair(turn.assistant) }
    private var thinkingText: String { ReplyText.repair(turn.thinking) }

    static func == (lhs: TurnView, rhs: TurnView) -> Bool {
        lhs.turn == rhs.turn && lhs.canAnswer == rhs.canAnswer
            && lhs.embedded == rhs.embedded && lhs.isLastAssistant == rhs.isLastAssistant
            && lhs.canRestorePrompt == rhs.canRestorePrompt
            && lhs.waitingForLink == rhs.waitingForLink
            && lhs.reviewMark == rhs.reviewMark && lhs.restoring == rhs.restoring
            && lhs.captured == rhs.captured && lhs.calendarInvite == rhs.calendarInvite
            && lhs.palette == rhs.palette && lhs.appearance == rhs.appearance
    }

    private var thinkingShimmerActive: Bool {
        turn.running && assistantText.isEmpty && turn.tools.isEmpty && turn.task?.nilIfEmpty == nil
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

    /// 所有 chrome（含 iPad）都隐藏沉默工具；propose 不属于 silent，仍正常显示
    private var visibleTools: [ToolCall] {
        guard !turn.deferred else { return [] }
        let tools = ToolCall.uniqued(turn.tools)
        return tools.filter { !AssistantToolText.isSilent($0) }
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
        !turn.running && !turn.queued && turn.error?.nilIfEmpty != nil && assistantText.isEmpty
    }

    private var turnMeta: String? {
        let mode = turn.mode?.label
        let model = turn.model?.nilIfEmpty.map { ModelCatalog.label(for: $0) }
        let parts = [mode, model].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
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
                            if !turn.deferred {
                                Button { store.editTurn(turn.id, chatId: chatId) } label: { Label("编辑", systemImage: "pencil") }
                                Button { store.retryTurn(turn.id, chatId: chatId) } label: { Label("重试", systemImage: "arrow.clockwise") }
                            }
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
                        } else if userFailed, !turn.deferred {
                            Button("重试") { store.retryTurn(turn.id, chatId: chatId) }
                                .font(JieboFont.text(.caption, weight: .semibold))
                                .foregroundStyle(JieboColor.danger)
                                .buttonStyle(.plain)
                                .hitTarget()
                        }
                    }
                }
            }
            if turn.deferred {
                deferredCard
            }
            if !turn.deferred, !thinkingText.isEmpty {
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
                            if thinkingShimmerActive {
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
                        Text(thinkingText)
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
            if !turn.deferred, !assistantText.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                        StreamingAssistantText(
                            text: assistantText,
                            live: turn.running,
                            transform: linkMentions
                        )
                        if turn.mode == .plan, !turn.running, !turn.queued {
                            ActionButton(title: "执行这个计划", kind: .primary) {
                                store.applyPlan(turn.id, chatId: chatId)
                            }
                            .padding(.top, 2)
                        }
                    }
                    .contextMenu {
                        if !assistantText.isEmpty {
                            Button { copy(assistantText) } label: { Label("复制", systemImage: "doc.on.doc") }
                            Button { store.retryTurn(turn.id, chatId: chatId) } label: { Label("重新生成", systemImage: "arrow.clockwise") }
                            // 菜单收起后 ShareLink 的宿主会被销毁：改成先记下、再由本视图弹分享面板
                            Button { shareItem = ShareItem(text: assistantText) } label: {
                                Label("分享", systemImage: "square.and.arrow.up")
                            }
                        }
                    }
                    .sheet(item: $shareItem) { item in
                        ActivityView(items: [item.text])
                            .presentationDetents([.medium, .large])
                    }
            }
            if turn.running, assistantText.isEmpty {
                if let task = turn.task?.nilIfEmpty {
                    Text(task)
                        .font(JieboFont.text(.subheadline))
                        .foregroundStyle(JieboColor.ink2)
                } else if waitingForLink {
                    HStack(spacing: 8) {
                        Text("等连上再开始")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.dim)
                        ActionButton(title: "不发送", kind: .outline) {
                            store.cancelUnsentTurn(turn.id, chatId: chatId)
                        }
                        .accessibilityHint("这句话回到输入框，连上后也不会发出去")
                    }
                } else if turn.thinking.isEmpty, turn.tools.isEmpty {
                    ShimmerText(text: "开始动手", font: JieboFont.text(.subheadline))
                }
            }
            if turn.running, isLastAssistant, !waitingForLink {
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
                .sheet(item: $editingTodo) { todo in
                    TodoEditSheet(todo: todo)
                }
            }
            if !turn.deferred, let error = turn.error, !error.isEmpty, !turn.running {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.danger)
                            .accessibilityHidden(true)
                        Text(friendlyError(error))
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        if canRestorePrompt {
                            ActionButton(title: "放回输入框", kind: .outline) {
                                store.restoreFailedPromptIfDraftEmpty(chatId: chatId)
                            }
                            .accessibilityHint("不发送，上一句回到输入框")
                        }
                        ActionButton(title: "重试", kind: .destructive) {
                            store.retryTurn(turn.id, chatId: chatId)
                        }
                    }
                }
                .padding(.leading, 12)
                .padding(.trailing, 8)
                .frame(minHeight: 48)
                .background(JieboColor.dangerBg)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                .accessibilityElement(children: .contain)
            }
            // 顺序：正文 → 文件 → 审阅 → 操作。审阅条是对上面这些文件的决定，放在它们之后
            if !turn.deferred, !turn.cardFiles.isEmpty {
                TurnFileCards(turn: turn, chatId: chatId)
            }
            if !turn.deferred, turn.needsFileReview, reviewMark == nil {
                TurnReviewBar(turn: turn)
            }
            if isLastAssistant, !turn.running, !turn.assistant.isEmpty {
                assistantActionRow
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
            }
            // 无助手正文时耗时仍贴在轮次底部，用 ink2 保证可读
            if turn.assistant.isEmpty,
               let duration = formatDuration(turn.durationMs).nilIfEmpty,
               !turn.running
            {
                Text(duration)
                    .font(JieboFont.text(.caption, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
            }
        }
    }

    private var deferredCard: some View {
        let loading = store.isHydratingTurn(turn.id, chatId: chatId)
        return VStack(alignment: .leading, spacing: 8) {
            Text("这条回复较大，完整内容尚未下载")
                .font(JieboFont.text(.subheadline, weight: .medium))
                .foregroundStyle(JieboColor.ink)
            if let bytes = turn.bodyBytes {
                Text(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
            }
            ActionButton(title: loading ? "取消加载" : "加载完整内容", kind: .primary) {
                if loading {
                    store.cancelTurnHydration(chatId: chatId, turnId: turn.id)
                } else {
                    store.hydrateTurn(chatId: chatId, turnId: turn.id)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.userBubble.opacity(0.55))
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
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
        JieboHaptic.notification(.success)
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

enum ReplyText {
    private static let strayJeom = try! NSRegularExpression(pattern: "점+(?=\\p{Script=Han})")

    /// 只删紧挨在汉字前面的「점」。单独一段先留着，拼上下一段再判断。
    static func repair(_ text: String) -> String {
        guard text.contains("점") else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return strayJeom.stringByReplacingMatches(in: text, range: range, withTemplate: "")
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
    @Environment(\.threadChatId) private var environmentChatId

    private var chatId: String { environmentChatId.isEmpty ? store.activeId : environmentChatId }

    var body: some View {
        let seconds = store.stallSeconds
        if seconds >= 4 {
            HStack(spacing: 8) {
                Text(seconds >= 15 ? "仍在处理… 已 \(seconds) 秒没有新输出" : "仍在处理…")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                    .monospacedDigit()
                if seconds >= 15 {
                    ActionButton(title: "停止并放回", kind: .outline) {
                        store.stop(chatId: chatId)
                        store.restoreLastPromptIfDraftEmpty(chatId: chatId)
                    }
                    .accessibilityHint("上一句回到输入框")
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}
