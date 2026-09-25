import SwiftUI

struct ThreadView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            header
            if !store.notice.isEmpty {
                banner(store.notice, color: JieboColor.pine)
            }
            if !store.bannerError.isEmpty {
                banner(friendlyError(store.bannerError), color: JieboColor.danger)
            }
            thread
            // P5b：agent 改完文件的待看入口（面板关着时不硬弹，点 pill 才进）
            if !store.pendingDiffPaths.isEmpty {
                Button(action: store.openDiffs) {
                    HStack(spacing: 6) {
                        Image(systemName: "plus.forwardslash.minus")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(JieboColor.brass)
                        Text("\(store.pendingDiffPaths.count) 个文件有改动")
                            .font(JieboFont.ui(12, weight: .medium))
                        Text("查看")
                            .font(JieboFont.ui(12, weight: .semibold))
                            .foregroundStyle(JieboColor.brass)
                    }
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(JieboColor.mist)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(JieboColor.brass.opacity(0.35), lineWidth: 1))
                    .shadow(color: .black.opacity(0.10), radius: 6, y: 3)
                }
                .buttonStyle(.plain)
                .padding(.bottom, 6)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            ComposerView()
        }
        .animation(.easeInOut(duration: 0.22), value: store.pendingDiffPaths.isEmpty)
        .background(JieboColor.paper.ignoresSafeArea())
        // @文件 链接 → 预览面板（媒体类内部转 Quick Look）；其他链接走系统
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "jiebo-file",
                  let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let path = components.queryItems?.first(where: { $0.name == "path" })?.value
            else { return .systemAction }
            store.openPreview(path)
            return .handled
        })
        // P6：预览面板 overlay 上移到 WorkbenchView（RootView）——遮罩盖住侧栏 + detail，
        // 不再只压对话列导致标题被切断；宽度拖拽手柄也在那层
        .sheet(item: previewFileBinding, onDismiss: store.closePreview) { file in
            QuickLookView(file: file, onClose: { store.dismissPreviewFile() })
                .ignoresSafeArea()
        }
    }

    /// P7：文件浏览器 cover 打开期间本层不 present QL——cover 自己挂了同一 previewFile 的 sheet，
    /// 两层抢同一个 item 会 present 失败/连闪（Grok R2 MINOR）。cover 关闭后绑定自动恢复。
    private var previewFileBinding: Binding<PreviewFile?> {
        Binding(
            get: { store.fileBrowserOpen ? nil : store.previewFile },
            set: { store.previewFile = $0 }
        )
    }

    private var header: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(store.active?.title ?? "新对话")
                    .font(JieboFont.display(26))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Text(store.hasApiKey ? store.mode.label : "服务器还没配 API Key")
                    .font(JieboFont.ui(13))
                    .foregroundStyle(store.hasApiKey ? JieboColor.dim : JieboColor.danger)
            }
            Spacer()
            if store.previewLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(JieboColor.dim)
            }
            if store.canUndo {
                Button(action: store.undoLast) {
                    Image(systemName: "arrow.uturn.backward")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(width: 30, height: 30)
                        .background(JieboColor.mist)
                        .clipShape(Circle())
                        .hitTarget() // P6：视觉 30，命中 44
                }
                .buttonStyle(.plain)
                .accessibilityLabel("还原上一轮的改动")
            }
            if store.busy {
                ProgressView()
                    .tint(JieboColor.pine)
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 18)
        .padding(.bottom, 10)
    }

    // MARK: 对话流（P8：滚动跟随改造）

    /// 用户是否停在底部——在底部时流式输出才自动跟随；不在底部不抢滚动，亮「显示最新」按钮
    @State private var atBottom = true
    /// 滚动视口高度（overlay 探针量得），与底部锚点的 maxY 比较得出 atBottom
    @State private var viewportHeight: CGFloat = 0
    /// atBottom=false 的 0.15s 去抖：流式增长瞬间锚点会先被顶出视口、跟随滚动再收回，
    /// 不去抖「显示最新」按钮会在每次流式输出时闪一下
    @State private var bottomDebounce: Task<Void, Never>?

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if let chat = store.active, chat.turns.isEmpty {
                        emptyState
                    }
                    ForEach(store.active?.turns ?? []) { turn in
                        TurnView(turn: turn)
                            .id(turn.id)
                    }
                    // 底部锚点兼任位置探针
                    Color.clear
                        .frame(height: 1)
                        .id("thread-end")
                        .background(
                            GeometryReader { geo in
                                Color.clear
                                    .onAppear { noteEndPosition(geo.frame(in: .named("threadScroll")).maxY) }
                                    .onChange(of: geo.frame(in: .named("threadScroll")).maxY) { _, y in
                                        noteEndPosition(y)
                                    }
                            }
                        )
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 12)
            }
            .coordinateSpace(name: "threadScroll")
            .overlay(
                // 视口高度探针（转屏/分屏会变）
                GeometryReader { geo in
                    Color.clear
                        .onAppear { viewportHeight = geo.size.height }
                        .onChange(of: geo.size.height) { _, h in viewportHeight = h }
                }
                .allowsHitTesting(false)
            )
            .overlay(alignment: .bottom) {
                if !atBottom {
                    Button {
                        withAnimation(.easeOut(duration: 0.25)) {
                            proxy.scrollTo("thread-end", anchor: .bottom)
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 11, weight: .bold))
                            Text("显示最新")
                                .font(JieboFont.ui(12, weight: .semibold))
                        }
                        .foregroundStyle(JieboColor.ink)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(JieboColor.white)
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(JieboColor.line, lineWidth: 1))
                        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityLabel("滚动到最新消息")
                }
            }
            .animation(.easeInOut(duration: 0.18), value: atBottom)
            .onChange(of: store.active?.turns.last?.assistant) { _, _ in followBottom(proxy) }
            .onChange(of: store.active?.turns.count) { _, _ in followBottom(proxy) }
            .onChange(of: store.activeId) { _, _ in
                // 切会话：直接落底（不动画）并复位跟随状态
                bottomDebounce?.cancel()
                atBottom = true
                proxy.scrollTo("thread-end", anchor: .bottom)
            }
            .onAppear { proxy.scrollTo("thread-end", anchor: .bottom) }
        }
    }

    /// 跟随流式输出：只有用户本来就在底部时才滚；不在底部保持阅读位置（按钮兜底）
    private func followBottom(_ proxy: ScrollViewProxy) {
        guard atBottom else { return }
        proxy.scrollTo("thread-end", anchor: .bottom)
    }

    private func noteEndPosition(_ endMaxY: CGFloat) {
        if endMaxY <= viewportHeight + 32 {
            bottomDebounce?.cancel()
            atBottom = true
            return
        }
        bottomDebounce?.cancel()
        bottomDebounce = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            atBottom = false
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 40)
            Text("从这里开始")
                .font(JieboFont.display(34))
                .tracking(-1.2)
                .foregroundStyle(JieboColor.ink)
            Text("消息经东京站送到 gateway，Agent 在那台机器上改文件、跑命令。")
                .font(JieboFont.ui(16))
                .foregroundStyle(JieboColor.ink2)
                .multilineTextAlignment(.center)
            HStack(spacing: 8) {
                ForEach(starters, id: \.self) { text in
                    Button {
                        store.saveDraft(text)
                    } label: {
                        Text(text)
                            .font(JieboFont.ui(13))
                            .foregroundStyle(JieboColor.ink)
                            .padding(.horizontal, 14)
                            .frame(height: 36)
                            .background(JieboColor.white)
                            .clipShape(Capsule())
                            .overlay(
                                Capsule().stroke(JieboColor.borderStrong, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 8)
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }

    private let starters = [
        "看看这个工作区里有什么",
        "把最近的改动讲一讲",
        "跑一下测试，看看过没过",
    ]

    private func banner(_ text: String, color: Color) -> some View {
        Text(text)
            .font(JieboFont.ui(13))
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.vertical, 8)
            .background(color.opacity(0.08))
    }
}

private struct TurnView: View {
    var turn: Turn

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !turn.user.isEmpty {
                HStack {
                    Spacer(minLength: 80)
                    Text(turn.user)
                        .font(JieboFont.ui(16))
                        .foregroundStyle(JieboColor.ink)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(JieboColor.userBubble)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                }
            }
            if !turn.thinking.isEmpty {
                DisclosureGroup("思考") {
                    Text(turn.thinking)
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(JieboFont.ui(13, weight: .medium))
                .foregroundStyle(JieboColor.dim)
                .tint(JieboColor.pine)
            }
            ForEach(turn.tools) { tool in
                ToolCardView(tool: tool)
            }
            if let pending = turn.pendingTool {
                ApprovalCard(tool: pending)
            }
            if !turn.assistant.isEmpty {
                HStack(alignment: .top, spacing: 12) {
                    BotAvatar()
                    Text(markdown(linkMentions(turn.assistant)))
                        .font(JieboFont.ui(16))
                        .foregroundStyle(JieboColor.ink)
                        .tint(JieboColor.pine)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if turn.running, turn.assistant.isEmpty {
                ShimmerText(text: turn.task?.nilIfEmpty ?? "正在想…")
            }
            if let error = turn.error, !error.isEmpty {
                Text(friendlyError(error))
                    .font(JieboFont.ui(14))
                    .foregroundStyle(JieboColor.danger)
            }
            if let duration = formatDuration(turn.durationMs).nilIfEmpty, !turn.running {
                Text(duration)
                    .font(JieboFont.ui(11))
                    .foregroundStyle(JieboColor.dim)
            }
        }
    }

    private func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    /// 把正文里的 @路径 转成可点链接（jiebo-file://open?path=…），由 openURL 拦截打开预览面板。
    /// 对齐网页 splitCiteParts：字符集排除 @: 与 CJK 标点，:行号/-区间 只显示不进路径；
    /// 跳过 ``` 围栏与行内 `代码` 段；只链接「像文件」的 token（isFileMention）。
    private func linkMentions(_ text: String) -> String {
        // group1=前导空白 group2=路径 group3=:行号后缀（可选，仅显示用）
        let regex = try? NSRegularExpression(pattern: #"(^|\s)@([^\s@:，。；、！？,;!?)]+)((?::\d+(?:-\d+)?)?)"#)
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&#+=") // query 里这些字符必须编码，否则 openURL 侧解析会断
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

private struct ApprovalCard: View {
    @Environment(ChatStore.self) private var store
    var tool: PendingTool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("允许 \(tool.name)？")
                .font(JieboFont.ui(15, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
            if let args = tool.args {
                Text(args.pretty(240))
                    .font(JieboFont.mono(12))
                    .foregroundStyle(JieboColor.ink2)
            }
            HStack(spacing: 10) {
                Button("允许") { store.replyToApproval(allow: true) }
                    .buttonStyle(.borderedProminent)
                Button("拒绝") { store.replyToApproval(allow: false) }
                    .buttonStyle(.bordered)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                .stroke(JieboColor.brass, lineWidth: 1)
        )
    }
}
