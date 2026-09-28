import SwiftUI

struct ThreadView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var composerFocusNonce = 0
    /// 和当前会话对齐之后，新消息才做进入动画。切会话那一帧两者还不一致，避免整列重播。
    @State private var motionChatId = ""

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            header
            if !store.notice.isEmpty {
                banner(store.notice, color: JieboColor.pine)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if !store.bannerError.isEmpty {
                banner(friendlyError(store.bannerError), color: JieboColor.danger)
                    .transition(.move(edge: .top).combined(with: .opacity))
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
            ComposerView(focusNonce: composerFocusNonce)
        }
        .frame(maxWidth: JieboMeasure.thread)
        .frame(maxWidth: .infinity)
        .animation(JieboMotion.fade(reduceMotion), value: store.pendingDiffPaths.isEmpty)
        .animation(JieboMotion.fade(reduceMotion), value: store.notice.isEmpty)
        .animation(JieboMotion.fade(reduceMotion), value: store.bannerError.isEmpty)
        .background(JieboColor.paper.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(removing: .sidebarToggle)
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
        // P10：分享 sheet（与 QL 同一套 cover 期间不抢守卫）
        .sheet(item: exportFileBinding, onDismiss: store.closeExport) { file in
            ActivityView(items: [file.url])
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

    /// P10：同上——cover 期间分享 sheet 由 FileBrowserCover 自己 present
    private var exportFileBinding: Binding<PreviewFile?> {
        Binding(
            get: { store.fileBrowserOpen ? nil : store.exportFile },
            set: { store.exportFile = $0 }
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
                        .shadow(color: .black.opacity(0.06), radius: 4, y: 1)
                        .hitTarget() // P6：视觉 30，命中 44
                }
                .buttonStyle(PressScaleButtonStyle())
                .accessibilityLabel("还原上一轮的改动")
            }
            if store.busy {
                ProgressView()
                    .tint(JieboColor.pine)
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 18)
        .padding(.bottom, 18)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(JieboColor.line)
                .frame(height: 1)
        }
    }

    // MARK: 对话流（P8：滚动跟随改造）

    /// 停在底部时才跟随流式输出。用户往上拖超过一段距离后松开跟随。
    @State private var stickToBottom = true
    /// 键盘或转屏刚改变视口时，先别把跟随关掉
    @State private var holdStickUntil = Date.distantPast
    /// 滚动视口高度（overlay 探针量得），与底部锚点的 maxY 比较得出是否还在底部
    @State private var viewportHeight: CGFloat = 0
    /// 程序在滚到底时，几何探针的中间帧不能把跟随关掉
    @State private var scrollingProgrammatically = false
    @State private var followTask: Task<Void, Never>?

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // 不用 LazyVStack：流式增高时未实现的底部锚点会让 scrollTo 落空，跟随就断。
                VStack(alignment: .leading, spacing: 18) {
                    if let chat = store.active, chat.turns.isEmpty, chat.turnsComplete {
                        // 未加载完的壳（!turnsComplete）不算空会话——由下方遮罩覆盖
                        emptyState
                    }
                    if let chat = store.active, !chat.turnsComplete, !chat.turns.isEmpty {
                        // 分页加载更早内容的轻提示（不抢滚动，对齐「分段加载」的可感知性）
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("正在加载更早的内容…")
                                .font(JieboFont.ui(12))
                                .foregroundStyle(JieboColor.ink2)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                    }
                    ForEach(store.active?.turns ?? []) { turn in
                        TurnView(turn: turn)
                            .id(turn.id)
                            .transition(.opacity.combined(with: .offset(y: 10)))
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
            .scrollDismissesKeyboard(.interactively)
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
                if !stickToBottom {
                    Button {
                        stickToBottom = true
                        followBottom(proxy, animated: true)
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
                    .padding(.bottom, store.pendingDiffPaths.isEmpty ? 10 : 52)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityLabel("滚动到最新消息")
                }
            }
            .overlay {
                // P8 slim：会话内容分页加载遮罩（只盖住对话区，侧栏/输入框可操作）
                if showThreadLoading {
                    VStack(spacing: 12) {
                        ProgressView().controlSize(.large)
                        Text("正在加载会话…")
                            .font(JieboFont.ui(13, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(JieboColor.paper.opacity(0.92))
                    .transition(.opacity)
                }
            }
            .animation(JieboMotion.fade(reduceMotion), value: showThreadLoading)
            .animation(JieboMotion.fade(reduceMotion), value: stickToBottom)
            .simultaneousGesture(
                DragGesture(minimumDistance: 12).onChanged { value in
                    // 手指向下拖是在离开底部、看更早的内容
                    guard value.translation.height > 16 else { return }
                    followTask?.cancel()
                    scrollingProgrammatically = false
                    stickToBottom = false
                }
            )
            .onChange(of: store.active?.turns.count) { _, _ in followBottom(proxy) }
            .onChange(of: liveTail) { _, _ in followBottom(proxy) }
            .onChange(of: viewportHeight) { _, _ in
                holdStickUntil = Date().addingTimeInterval(0.4)
                followBottom(proxy)
            }
            .onChange(of: store.activeId) { _, id in
                // 切会话：直接落底。motionChatId 晚一帧对齐，插入动画不会在切换时重播。
                followTask?.cancel()
                stickToBottom = true
                motionChatId = id
                followBottom(proxy)
            }
            .onAppear {
                motionChatId = store.activeId
                stickToBottom = true
                followBottom(proxy)
            }
        }
    }

    /// 跟随流式输出。布局往往晚一帧才完成，所以紧接着再滚一次，避免停在旧高度。
    private func followBottom(_ proxy: ScrollViewProxy, animated: Bool = false) {
        guard stickToBottom else { return }
        scrollingProgrammatically = true
        let scroll = {
            proxy.scrollTo("thread-end", anchor: .bottom)
        }
        if animated {
            withAnimation(.easeOut(duration: 0.25)) { scroll() }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { scroll() }
        }
        followTask?.cancel()
        followTask = Task { @MainActor in
            // 工具卡和正文是后一帧才撑开高度的，补滚两次才落得住底
            for delay in [40, 140] {
                try? await Task.sleep(for: .milliseconds(delay))
                guard !Task.isCancelled, stickToBottom else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { proxy.scrollTo("thread-end", anchor: .bottom) }
            }
            guard !Task.isCancelled else { return }
            scrollingProgrammatically = false
        }
    }

    /// 最后一轮的正文、思考、工具和确认都会变高。只盯 assistant 的话，调工具时不会滚。
    private var liveTail: String {
        guard let turn = store.active?.turns.last else { return "" }
        let tools = turn.tools.map { tool in
            let size = tool.result?.pretty(160).count ?? 0
            return "\(tool.callId):\(tool.status):\(size):\(tool.summary.count)"
        }.joined(separator: ",")
        return "\(turn.id)|\(turn.running)|\(turn.assistant.count)|\(turn.thinking.count)|\(turn.task ?? "")|\(turn.pendingTool?.callId ?? "")|\(tools)"
    }

    private func noteEndPosition(_ endMaxY: CGFloat) {
        guard viewportHeight > 1 else { return }
        let gap = endMaxY - viewportHeight
        if scrollingProgrammatically {
            if gap <= 72 { stickToBottom = true }
            return
        }
        // 答复进行中只靠手势取消跟随。工具卡一插入就会把底锚点顶出视口，不能当成用户离开了底部。
        let replying = store.active?.turns.last?.running == true
        if gap <= 64 {
            stickToBottom = true
        } else if gap > 160, !replying, Date() > holdStickUntil {
            stickToBottom = false
        }
    }

    private var showThreadLoading: Bool {
        guard let chat = store.active else { return false }
        return !chat.turnsComplete && chat.turns.isEmpty
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
            ViewThatFits(in: .horizontal) {
                starterRow(axis: .horizontal)
                starterRow(axis: .vertical)
            }
            .padding(.top, 8)
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: viewportHeight > 120 ? viewportHeight - 24 : 0)
        .padding(.horizontal, 24)
    }

    private func starterRow(axis: Axis) -> some View {
        let row = ForEach(starters, id: \.self) { text in
            Button {
                store.saveDraft(text)
                composerFocusNonce += 1
            } label: {
                Text(text)
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 14)
                    .frame(height: 36)
                    .background(JieboColor.white)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(JieboColor.borderStrong, lineWidth: 1))
                    .shadow(color: .black.opacity(0.04), radius: 6, y: 2)
            }
            .buttonStyle(.plain)
        }
        return Group {
            if axis == .horizontal {
                HStack(spacing: 8) { row }
            } else {
                VStack(spacing: 8) { row }
            }
        }
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
    @Environment(ChatStore.self) private var store
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
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .shadow(color: .black.opacity(0.05), radius: 8, y: 2)
                        .frame(maxWidth: JieboMeasure.bubble, alignment: .trailing)
                }
            }
            if !turn.thinking.isEmpty {
                DisclosureGroup("思考") {
                    Text(turn.thinking)
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .font(JieboFont.ui(13, weight: .medium))
                .foregroundStyle(JieboColor.dim)
                .tint(JieboColor.pine)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(JieboColor.white)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                )
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
                    AssistantMessage(text: linkMentions(turn.assistant))
                }
            }
            if turn.running {
                ShimmerText(text: turn.assistant.isEmpty ? (turn.task?.nilIfEmpty ?? "正在想…") : "正在写")
                    .padding(.leading, turn.assistant.isEmpty ? 0 : 40)
            }
            if let error = turn.error, !error.isEmpty {
                Text(friendlyError(error))
                    .font(JieboFont.ui(14))
                    .foregroundStyle(JieboColor.danger)
            }
            let files = relatedFiles(turn)
            if !files.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("相关文件")
                        .font(JieboFont.ui(12, weight: .medium))
                        .foregroundStyle(JieboColor.dim)
                    ForEach(files, id: \.self) { path in
                        Button {
                            store.openPreview(path)
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: fileGlyph(path, isDir: false, open: false))
                                    .font(.system(size: 13))
                                    .foregroundStyle(JieboColor.ink2)
                                    .frame(width: 18)
                                Text((path as NSString).lastPathComponent)
                                    .font(JieboFont.ui(14, weight: .medium))
                                    .foregroundStyle(JieboColor.ink)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 10)
                            .frame(height: 36)
                            .background(JieboColor.white)
                            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                                    .stroke(JieboColor.line, lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("预览 \(path)")
                    }
                }
                .padding(.leading, 40)
            }
            if let duration = formatDuration(turn.durationMs).nilIfEmpty, !turn.running {
                Text(duration)
                    .font(JieboFont.ui(11))
                    .foregroundStyle(JieboColor.dim)
            }
        }
    }

    /// 这一轮写过、生成过，或回复里 @ 到的文件。
    private func relatedFiles(_ turn: Turn) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        func add(_ raw: String?) {
            guard var path = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty else { return }
            if path.hasPrefix("./") { path.removeFirst(2) }
            guard !path.hasSuffix("/"), path.lowercased() != "diff" else { return }
            guard seen.insert(path).inserted else { return }
            out.append(path)
        }
        for tool in turn.tools {
            let name = tool.name.lowercased()
            let generated = name.contains("generateimage") || name.contains("generate_image") || name.contains("image_gen")
            let path = ChatStore.toolPath(args: tool.args, result: tool.result)
            if generated || tool.kind.isMutating {
                add(path)
            } else if let path {
                let kind = previewKind(of: path)
                if kind == .image || kind == .svg { add(path) }
            }
        }
        let mention = try? NSRegularExpression(pattern: #"(^|\s)@([^\s@:，。；、！？,;!?)]+)"#)
        if let mention {
            let text = turn.assistant
            for match in mention.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let range = Range(match.range(at: 2), in: text) else { continue }
                let token = String(text[range])
                if Self.isFileMention(token) { add(token) }
            }
        }
        return out
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

private struct AssistantMessage: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let code):
                    Text(Self.expandTabs(code.isEmpty ? " " : code))
                        .font(JieboFont.mono(13))
                        .foregroundStyle(JieboColor.ink)
                        .textSelection(.enabled)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                case .prose(let prose):
                    ProseLines(text: prose)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private enum Block {
        case prose(String)
        case code(String)
    }

    private var blocks: [Block] {
        var result: [Block] = []
        var prose: [String] = []
        var code: [String] = []
        var inCode = false
        func flushProse() {
            let joined = prose.joined(separator: "\n")
            if joined.contains(where: { !$0.isNewline && !$0.isWhitespace }) {
                result.append(.prose(joined))
            }
            prose = []
        }
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                if inCode {
                    result.append(.code(code.joined(separator: "\n")))
                    code = []
                    inCode = false
                } else {
                    flushProse()
                    inCode = true
                }
                continue
            }
            if inCode { code.append(line) } else { prose.append(line) }
        }
        if inCode { result.append(.code(code.joined(separator: "\n"))) }
        flushProse()
        if result.isEmpty { result.append(.prose(text)) }
        return result
    }

    private static func expandTabs(_ text: String) -> String {
        text.replacingOccurrences(of: "\t", with: "    ")
    }
}

/// 按原文逐行排。整段 Markdown 会把单个换行和行首空格吃掉。
private struct ProseLines: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                if line.allSatisfy({ $0 == " " || $0 == "\t" }) {
                    Color.clear.frame(height: 8)
                } else {
                    lineRow(line)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func lineRow(_ line: String) -> some View {
        let expanded = line.replacingOccurrences(of: "\t", with: "    ")
        let indent = expanded.prefix { $0 == " " }.count
        let body = String(expanded.dropFirst(indent))
        let heading = headingLevel(of: body)
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            if indent > 0 {
                Color.clear.frame(width: CGFloat(indent) * 8)
            }
            Text(Self.inline(heading?.rest ?? body))
                .font(heading == nil ? JieboFont.ui(16) : JieboFont.ui(headingSize(heading!.level), weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .tint(JieboColor.pine)
                .textSelection(.enabled)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func headingLevel(of line: String) -> (level: Int, rest: String)? {
        guard line.hasPrefix("#") else { return nil }
        let marks = line.prefix { $0 == "#" }.count
        guard (1...6).contains(marks) else { return nil }
        let rest = line.dropFirst(marks)
        guard rest.first == " " else { return nil }
        return (marks, String(rest.dropFirst()))
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return 22
        case 2: return 19
        default: return 17
        }
    }

    private static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
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
                ScrollView {
                    Text(args.pretty(2_000))
                        .font(JieboFont.mono(12))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 160)
            }
            HStack(spacing: 10) {
                Button("允许") { store.replyToApproval(allow: true) }
                    .buttonStyle(.plain)
                    .font(JieboFont.ui(14, weight: .semibold))
                    .foregroundStyle(JieboColor.paper)
                    .padding(.horizontal, 16)
                    .frame(height: 36)
                    .background(JieboColor.pine)
                    .clipShape(Capsule())
                Button("拒绝") { store.replyToApproval(allow: false) }
                    .buttonStyle(.plain)
                    .font(JieboFont.ui(14, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 16)
                    .frame(height: 36)
                    .background(JieboColor.mist)
                    .clipShape(Capsule())
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
        .shadow(color: JieboColor.brass.opacity(0.12), radius: 8, y: 2)
    }
}
