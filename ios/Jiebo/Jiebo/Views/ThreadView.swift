import SwiftUI
import UIKit

/// 对话页的外壳：pad = iPad 大标题；phoneLegacy = iPad 窄窗（PhoneWorkbench）的旧手机标题栏；
/// embedded = iPhone 助理页（PhoneShell）：头部为空、导航栏由宿主管理。
enum ThreadChrome { case pad, phoneLegacy, embedded }

struct ThreadView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var chrome: ThreadChrome = .pad
    var openDrawer: () -> Void = {}
    /// 仅 .embedded 使用：渲染在消息列表与输入框之间的插槽（ActionDock）。输入框仍然只有 ThreadView 里这一个。
    var dock: AnyView? = nil
    @State private var composerFocusNonce = 0
    /// 和当前会话对齐之后，新消息才做进入动画。切会话那一帧两者还不一致，避免整列重播。
    @State private var motionChatId = ""

    init(chrome: ThreadChrome = .pad, openDrawer: @escaping () -> Void = {}, dock: AnyView? = nil) {
        self.chrome = chrome
        self.openDrawer = openDrawer
        self.dock = dock
    }

    /// 旧写法：窄屏手机标题栏。保留给 PhoneWorkbench 等现有调用点。
    init(phoneChrome: Bool, openDrawer: @escaping () -> Void = {}) {
        self.init(chrome: phoneChrome ? .phoneLegacy : .pad, openDrawer: openDrawer)
    }

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            header
            VStack(spacing: 0) {
                if !store.notice.isEmpty {
                    banner(store.notice, color: JieboColor.dim)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                if !store.bannerError.isEmpty {
                    banner(friendlyError(store.bannerError), color: JieboColor.danger)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(JieboMotion.fade(reduceMotion), value: store.notice.isEmpty)
            .animation(JieboMotion.fade(reduceMotion), value: store.bannerError.isEmpty)
            thread
            // .embedded：委派审批由 ActionDock 接管，这里不再出现同一张确认卡
            let delegated: [AssistantApproval] = chrome == .embedded ? [] : store.assistantApprovals(forParent: store.activeId)
            Group {
                if let approval = delegated.first {
                    delegatedApprovalBanner(approval, more: delegated.count - 1)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(JieboMotion.fade(reduceMotion), value: delegated.first?.id)
            if chrome == .embedded, let dock {
                dock
            }
            ComposerView(
                focusNonce: composerFocusNonce,
                style: store.assistantChatActive && chrome == .embedded ? .assistant : .full
            )
                // 上面的出现动画不要套到输入框上，否则打字时的高度变化会被当成动画。
                .transaction { $0.animation = nil }
        }
        .frame(maxWidth: JieboMeasure.thread)
        .frame(maxWidth: .infinity)
        .background(JieboColor.paper.ignoresSafeArea())
        .toolbar(chrome == .embedded ? .automatic : .hidden, for: .navigationBar)
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

    /// 本会话派出去的委派子会话停在审批上：在输入框上方直接作答
    /// 样式与输入框里的待批条（ComposerView.approvalBar）一致，只是按钮用委派的「批准 / 拒绝」
    private func delegatedApprovalBanner(_ approval: AssistantApproval, more: Int) -> some View {
        let tool = approval.tool.nilIfEmpty ?? "工具调用"
        return VStack(alignment: .leading, spacing: 8) {
            Text(more > 0 ? "委派要用 \(tool)（另有 \(more) 条待批）" : "委派要用 \(tool)")
                .font(JieboFont.ui(13))
                .foregroundStyle(JieboColor.ink)
                .lineLimit(1)
            if !approval.summary.isEmpty {
                Text(approval.summary)
                    .font(JieboFont.mono(12))
                    .foregroundStyle(JieboColor.ink2)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            HStack(spacing: 8) {
                Button("批准") { store.answerAssistantApproval(approval, allow: true) }
                    .buttonStyle(.plain)
                    .font(JieboFont.ui(13, weight: .semibold))
                    .foregroundStyle(JieboColor.fillFg)
                    .padding(.horizontal, 12)
                    .frame(height: 32)
                    .background(JieboColor.pine)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                Button("拒绝") { store.answerAssistantApproval(approval, allow: false) }
                    .buttonStyle(.plain)
                    .font(JieboFont.ui(13, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 12)
                    .frame(height: 32)
                    .background(JieboColor.mist)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.runBg.opacity(0.65))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
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

    @ViewBuilder
    private var header: some View {
        switch chrome {
        case .pad:
            padHeader
        case .phoneLegacy:
            phoneHeader
        case .embedded:
            EmptyView()
        }
    }

    private var headerTitle: String {
        store.assistantChatActive ? store.assistantName : (store.active?.title ?? "新对话")
    }

    /// 助理会话里打开今日/收件箱/记忆层；有未读或待批时挂点
    private var assistantTodayButton: some View {
        AssistantTodayButton(
            on: store.toolLayer == .assistant,
            marked: store.assistantBadgeCount > 0
        ) {
            store.toggleTool(.assistant)
        }
    }

    private var phoneSubtitle: String {
        if !store.connected { return "正在重连…" }
        if store.assistantChatActive {
            return store.hasApiKey ? "个人助理 · \(store.mode.label)" : "服务器还没配 API Key"
        }
        let place = store.currentWorkspaceName
        return store.hasApiKey ? "\(place) · \(store.mode.label)" : "服务器还没配 API Key"
    }

    private var phoneStatus: String? {
        if let row = store.loops[store.activeId], row.status == "armed" || row.status == "running" {
            if let summary = row.lastSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
                return "Loop · 第 \(row.tick) 拍 · \(summary)"
            }
            return "Loop · 第 \(row.tick) 拍"
        }
        if store.busy { return "正在回复" }
        return nil
    }

    private var phoneHeader: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                phoneIcon("line.3.horizontal", label: "菜单", action: openDrawer)
                VStack(spacing: 1) {
                    Text(headerTitle)
                        .font(JieboFont.display(17))
                        .tracking(0.34)
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    Text(phoneSubtitle)
                        .font(JieboFont.ui(11, weight: .medium))
                        .tracking(0.3)
                        .foregroundStyle(store.hasApiKey || !store.connected ? JieboColor.dim : JieboColor.danger)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
                if store.assistantChatActive {
                    assistantTodayButton
                }
                if store.canUndo {
                    phoneIcon("arrow.uturn.backward", label: "还原上一轮的改动", action: store.undoLast)
                }
                phoneIcon("folder", label: "文件") {
                    if !(store.fileBrowserOpen && store.fileBrowserPane == .files) {
                        store.toggleFileBrowser(.files)
                    }
                }
                phoneIcon("plus", label: "新对话", action: store.openNewChat)
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
            .padding(.bottom, phoneStatus == nil ? 8 : 4)
            if let phoneStatus {
                Button {
                    if store.loops[store.activeId] != nil { store.toggleTool(.loop) }
                } label: {
                    HStack(spacing: 6) {
                        Circle().fill(JieboColor.ok).frame(width: 6, height: 6)
                        Text(phoneStatus)
                            .font(JieboFont.ui(12))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(JieboColor.white)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .disabled(store.loops[store.activeId] == nil)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
        }
    }

    private func phoneIcon(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .frame(width: 32, height: 32)
                .background(JieboColor.mist)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(label)
    }

    private var padHeader: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(headerTitle)
                    .font(JieboFont.display(22))
                    .tracking(0.44)
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Text(store.hasApiKey ? store.mode.label : "服务器还没配 API Key")
                    .font(JieboFont.ui(12, weight: .medium))
                    .tracking(0.4)
                    .foregroundStyle(store.hasApiKey ? JieboColor.dim : JieboColor.danger)
            }
            Spacer()
            if store.previewLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(JieboColor.dim)
            }
            if store.assistantChatActive {
                assistantTodayButton
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
    /// 滚动视口高度，与底部锚点的 maxY 比较得出是否还在底部
    @State private var viewportHeight: CGFloat = 0
    /// 程序在滚到底时，几何探针的中间帧不能把跟随关掉
    @State private var scrollingProgrammatically = false
    @State private var followTask: Task<Void, Never>?

    private var thread: some View {
        // 外层先量出视口宽。不锁宽的话，计划里的长行会按「不折行」的理想高度去撑滚动区，看起来到底了，下面还有一大段。
        GeometryReader { geo in
        ScrollViewReader { proxy in
            ScrollView {
                // 不用 LazyVStack：流式增高时未实现的底部锚点会让 scrollTo 落空，跟随就断。
                VStack(alignment: .leading, spacing: 18) {
                    if let chat = store.active, chat.turns.isEmpty, chat.turnsComplete {
                        // 未加载完的壳（!turnsComplete）不算空会话——由下方遮罩覆盖
                        if chrome == .embedded {
                            assistantEmptyState
                        } else {
                            emptyState
                        }
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
                    let turns = store.active?.turns ?? []
                    ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                        TurnView(
                            turn: turn,
                            canAnswer: index == turns.count - 1 && !turn.running && !turn.queued,
                            embedded: chrome == .embedded
                        )
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
                .padding(.top, 12)
                .padding(.bottom, 28)
                .frame(width: geo.size.width, alignment: .topLeading)
            }
            .scrollDismissesKeyboard(.interactively)
            .coordinateSpace(name: "threadScroll")
            .onAppear { viewportHeight = geo.size.height }
            .onChange(of: geo.size.height) { _, h in viewportHeight = h }
            .onChange(of: geo.size.width) { _, _ in
                // 侧栏或转屏改变折行，高度会变，停在底部时再对齐一次
                followBottom(proxy)
            }
            .overlay(alignment: .bottom) {
                Group {
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
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .stroke(JieboColor.line, lineWidth: 1)
                            )
                            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
                        }
                        .buttonStyle(.plain)
                        .padding(.bottom, 10)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .accessibilityLabel("滚动到最新消息")
                    }
                }
                .animation(JieboMotion.fade(reduceMotion), value: stickToBottom)
            }
            .overlay {
                // P8 slim：会话内容分页加载遮罩（只盖住对话区，侧栏/输入框可操作）
                Group {
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
            }
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
            // 计划正文是逐行排的，高度常常晚于前两帧才定下来。停早了会落在旧高度上。
            // 间隔累加后大约落在 40 / 140 / 320 / 700 毫秒。
            for delay in [40, 100, 180, 380] {
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
        // 长方案折行后底锚点会先被顶出视口。这不是用户离开底部，离开只认手势。
        if gap <= 64 {
            stickToBottom = true
        }
    }

    private var showThreadLoading: Bool {
        guard let chat = store.active else { return false }
        return !chat.turnsComplete && chat.turns.isEmpty
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 40)
            JieboMark(size: 36)
            Text("从这里开始")
                .font(JieboFont.display(34))
                .tracking(0.68)
                .foregroundStyle(JieboColor.ink)
            Text("网页说话，远端动手。从左侧接着聊，或先打开一个工作区文件。")
                .font(JieboFont.ui(15))
                .foregroundStyle(JieboColor.dim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            ViewThatFits(in: .horizontal) {
                starterRow(axis: .horizontal)
                starterRow(axis: .vertical)
            }
            .padding(.top, 8)
            Text("点左上角打开对话列表 · 可粘贴图片")
                .font(JieboFont.ui(13))
                .foregroundStyle(JieboColor.dim)
                .multilineTextAlignment(.center)
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: viewportHeight > 120 ? viewportHeight - 24 : 0)
        .padding(.horizontal, 24)
    }

    /// iPhone 助理页的空状态：不是「工作区」语境，快捷句也是跟助理说的话
    private var assistantEmptyState: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 40)
            JieboMark(size: 36)
            Text("\(store.assistantName) 在这儿")
                .font(JieboFont.display(30))
                .tracking(0.6)
                .foregroundStyle(JieboColor.ink)
                .multilineTextAlignment(.center)
            Text("记事、提醒、查东西，或者让它去某个项目里干活，不用你自己打开任何东西。")
                .font(JieboFont.ui(15))
                .foregroundStyle(JieboColor.dim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            VStack(spacing: 8) {
                ForEach(assistantStarters, id: \.self) { text in
                    Button {
                        store.saveDraft(text)
                        composerFocusNonce += 1
                    } label: {
                        Text(text)
                            .font(JieboFont.ui(13))
                            .foregroundStyle(JieboColor.ink)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 36)
                            .background(JieboColor.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .stroke(JieboColor.line, lineWidth: 1)
                            )
                            .hitTarget()
                    }
                    .buttonStyle(PressScaleButtonStyle())
                }
            }
            .padding(.top, 8)
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: viewportHeight > 120 ? viewportHeight - 24 : 0)
        .padding(.horizontal, 24)
    }

    private let assistantStarters = [
        "今天有什么安排？",
        "帮我记一下：",
        "明早 9 点提醒我",
        "让 acrabat 里的讲稿再顺一遍",
    ]

    private func starterRow(axis: Axis) -> some View {
        let row = ForEach(starters, id: \.self) { text in
            Button {
                if text == "打开工作区文件" {
                    if !(store.fileBrowserOpen && store.fileBrowserPane == .files) {
                        store.toggleFileBrowser(.files)
                    }
                } else {
                    store.saveDraft(text)
                    composerFocusNonce += 1
                }
            } label: {
                Text(text)
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 14)
                    .frame(height: 36)
                    .background(JieboColor.white)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    )
            }
            .buttonStyle(PressScaleButtonStyle())
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
        "打开工作区文件",
        "看一下这个项目的结构",
        "最近改了哪些文件？",
        "用 Canvas 概括这个仓库",
    ]

    private func banner(_ text: String, color: Color) -> some View {
        Text(text)
            .font(JieboFont.ui(13))
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
            .padding(.horizontal, 16)
    }
}

private struct TurnView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var turn: Turn
    var canAnswer = false
    /// iPhone 助理页：记忆类工具不出卡片，delegate / create_workspace 写成人话
    var embedded = false
    @State private var thinkingOpen = false
    @State private var confirmRestore = false

    private func turnThumb(_ image: PromptImage) -> some View {
        Group {
            if let data = Data(base64Encoded: image.data), let uiImage = UIImage(data: data) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
            } else {
                JieboColor.mist
            }
        }
        .frame(width: 72, height: 72)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        )
    }

    /// .embedded 下 memory_* / chat_search 整张不渲染；其它端原样
    private var visibleTools: [ToolCall] {
        embedded ? turn.tools.filter { !AssistantToolText.isSilent($0) } : turn.tools
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
                                HStack(spacing: 8) {
                                    ForEach(Array(turn.images.enumerated()), id: \.offset) { _, image in
                                        turnThumb(image)
                                    }
                                }
                            }
                            if turn.user != "（附图）" || turn.images.isEmpty {
                                Text(turn.user)
                                    .font(JieboFont.ui(16))
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
                        if let meta = turnMeta {
                            Text(meta)
                                .font(JieboFont.ui(11))
                                .foregroundStyle(JieboColor.dim)
                        }
                        if turn.queued {
                            HStack(spacing: 8) {
                                Text("排队中")
                                    .font(JieboFont.ui(12))
                                    .foregroundStyle(JieboColor.run)
                                Button("去掉") { store.dropQueuedTurn(turn.id) }
                                    .font(JieboFont.ui(12))
                                    .foregroundStyle(JieboColor.dim)
                                    .buttonStyle(.plain)
                            }
                        } else if !turn.running {
                            HStack(spacing: 12) {
                                Button("编辑") { store.editTurn(turn.id) }
                                    .buttonStyle(.plain)
                                Button("重试") { store.retryTurn(turn.id) }
                                    .buttonStyle(.plain)
                            }
                            .font(JieboFont.ui(12))
                            .foregroundStyle(JieboColor.dim)
                        }
                    }
                }
            }
            if !turn.thinking.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(JieboMotion.snappy(reduceMotion)) {
                            thinkingOpen.toggle()
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(JieboColor.ink2)
                                .rotationEffect(.degrees(thinkingOpen ? 90 : 0))
                            if turn.running {
                                ShimmerText(text: "正在思考", font: JieboFont.ui(13))
                            } else if let duration = formatDuration(turn.durationMs).nilIfEmpty {
                                Text("思考了 \(duration)")
                                    .font(JieboFont.ui(13, weight: .medium))
                                    .foregroundStyle(JieboColor.ink2)
                            } else {
                                Text("思考")
                                    .font(JieboFont.ui(13, weight: .medium))
                                    .foregroundStyle(JieboColor.ink2)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .frame(minHeight: 32, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(thinkingOpen ? "收起思考" : "展开思考")
                    if thinkingOpen {
                        Text(turn.thinking)
                            .font(JieboFont.ui(13))
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
                .overlay(
                    RoundedRectangle(cornerRadius: thinkingOpen ? 12 : 8, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                )
                .onAppear {
                    if turn.running { thinkingOpen = true }
                }
                .onChange(of: turn.running) { _, running in
                    if running { thinkingOpen = true }
                }
            }
            ForEach(visibleTools) { tool in
                if let asked = AskedForm.parse(tool) {
                    QuestionCardView(asked: asked, canAnswer: canAnswer)
                } else if embedded, let text = AssistantToolText.friendly(tool) {
                    AssistantActionRow(tool: tool, text: text)
                } else {
                    ToolCardView(tool: tool)
                }
            }
            if !turn.assistant.isEmpty {
                HStack(alignment: .top, spacing: 12) {
                    BotAvatar()
                    VStack(alignment: .leading, spacing: 6) {
                        if let duration = formatDuration(turn.durationMs).nilIfEmpty, !turn.running {
                            Text(duration)
                                .font(JieboFont.ui(12, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                        }
                        if let inline {
                            // 卡片插在正文中间：逐段渲染，段后跟这段写出的文件
                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(Array(inline.parts.enumerated()), id: \.offset) { _, part in
                                    if part.text.contains(where: { !$0.isWhitespace }) {
                                        AssistantMessage(text: linkMentions(part.text))
                                    }
                                    if !part.files.isEmpty {
                                        TurnFileCards(turn: turn, chatId: store.activeId, files: part.files)
                                    }
                                }
                            }
                        } else {
                            AssistantMessage(text: linkMentions(turn.assistant))
                        }
                        if turn.mode == .plan, !turn.running, !turn.queued {
                            Button("执行这个计划") { store.applyPlan(turn.id) }
                                .buttonStyle(.plain)
                                .font(JieboFont.ui(13, weight: .medium))
                                .foregroundStyle(JieboColor.fillFg)
                                .padding(.horizontal, 12)
                                .frame(height: 32)
                                .background(JieboColor.pine)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                    }
                }
            }
            if turn.running, turn.assistant.isEmpty {
                ShimmerText(text: turn.task?.nilIfEmpty ?? "开始动手")
                    .padding(.leading, 0)
            }
            if let error = turn.error, !error.isEmpty {
                Text(friendlyError(error))
                    .font(JieboFont.ui(14))
                    .foregroundStyle(JieboColor.danger)
            }
            if turn.needsFileReview, store.localTurnReviews[turn.id] == nil {
                HStack(spacing: 8) {
                    Text("\(turn.reviewPaths.count) 个文件改动")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.ink2)
                    Button("全部保留") { store.keepTurnFiles(turn.id) }
                        .buttonStyle(.plain)
                    Button(store.restoringTurnIds.contains(turn.id) ? "还原中" : "全部还原") { confirmRestore = true }
                        .buttonStyle(.plain)
                        .disabled(store.restoringTurnIds.contains(turn.id))
                }
                .font(JieboFont.ui(12, weight: .medium))
                .foregroundStyle(JieboColor.ink)
                .confirmationDialog(
                    "还原这一轮的 \(turn.reviewPaths.count) 个文件？",
                    isPresented: $confirmRestore,
                    titleVisibility: .visible
                ) {
                    Button("全部还原", role: .destructive) { store.restoreTurnFiles(turn.id) }
                    Button("取消", role: .cancel) {}
                }
            }
            if let inline {
                if !inline.tail.isEmpty {
                    TurnFileCards(turn: turn, chatId: store.activeId, files: inline.tail)
                        .padding(.leading, 40)
                }
            } else if !turn.cardFiles.isEmpty {
                TurnFileCards(turn: turn, chatId: store.activeId)
                    .padding(.leading, 40)
            }
            // 无助手正文时耗时仍贴在轮次底部，用 ink2 保证可读
            if turn.assistant.isEmpty,
               let duration = formatDuration(turn.durationMs).nilIfEmpty,
               !turn.running
            {
                Text(duration)
                    .font(JieboFont.ui(12, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .padding(.leading, 40)
            }
        }
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

private struct CodeHeader: View {
    var lang: String
    var code: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            Text(lang.isEmpty ? "代码" : lang)
                .font(JieboFont.mono(11))
                .foregroundStyle(JieboColor.dim)
                .tracking(0.4)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button(copied ? "已复制" : "复制") {
                UIPasteboard.general.string = code
                copied = true
            }
            .buttonStyle(.plain)
            .font(JieboFont.ui(12))
            .foregroundStyle(JieboColor.ink2)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .overlay(alignment: .bottom) {
            Rectangle().fill(JieboColor.line).frame(height: 0.5)
        }
    }
}

private struct AssistantMessage: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let code, let lang):
                    VStack(alignment: .leading, spacing: 0) {
                        CodeHeader(lang: lang, code: code)
                        Text(Self.expandTabs(code.isEmpty ? " " : code))
                            .font(JieboFont.mono(12))
                            .foregroundStyle(JieboColor.ink)
                            .textSelection(.enabled)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                    }
                    .background(Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    )
                case .prose(let prose):
                    ProseLines(text: prose)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private enum Block {
        case prose(String)
        case code(String, lang: String)
    }

    private var blocks: [Block] {
        var result: [Block] = []
        var prose: [String] = []
        var code: [String] = []
        var lang = ""
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
                    result.append(.code(code.joined(separator: "\n"), lang: lang))
                    code = []
                    lang = ""
                    inCode = false
                } else {
                    flushProse()
                    lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    inCode = true
                }
                continue
            }
            if inCode { code.append(line) } else { prose.append(line) }
        }
        if inCode { result.append(.code(code.joined(separator: "\n"), lang: lang)) }
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
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .lines(let lines):
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            if line.allSatisfy({ $0 == " " || $0 == "\t" }) {
                                Color.clear.frame(height: 10)
                            } else {
                                lineRow(line)
                            }
                        }
                    }
                case .table(let headers, let rows):
                    HairlineTable(headers: headers, rows: rows)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private enum Segment {
        case lines([String])
        case table(headers: [String], rows: [[String]])
    }

    private var segments: [Segment] {
        let lines = text.components(separatedBy: "\n")
        var result: [Segment] = []
        var prose: [String] = []
        var index = 0
        func flush() {
            if !prose.isEmpty {
                result.append(.lines(prose))
                prose = []
            }
        }
        while index < lines.count {
            if let parsed = Self.parseTable(lines, from: index) {
                flush()
                result.append(.table(headers: parsed.headers, rows: parsed.rows))
                index = parsed.next
            } else {
                prose.append(lines[index])
                index += 1
            }
        }
        flush()
        if result.isEmpty { result.append(.lines(lines)) }
        return result
    }

    private static func parseTable(_ lines: [String], from start: Int) -> (headers: [String], rows: [[String]], next: Int)? {
        guard start + 1 < lines.count, isRow(lines[start]), isSeparator(lines[start + 1]) else { return nil }
        let headers = cells(lines[start])
        guard headers.count >= 2 else { return nil }
        var rows: [[String]] = []
        var index = start + 2
        while index < lines.count, isRow(lines[index]), !isSeparator(lines[index]) {
            rows.append(cells(lines[index]))
            index += 1
        }
        return (headers, rows, index)
    }

    private static func isRow(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("|") && trimmed.dropFirst().contains("|")
    }

    private static func isSeparator(_ line: String) -> Bool {
        let parts = cells(line)
        guard parts.count >= 2 else { return false }
        return parts.allSatisfy { part in
            let marks = part.filter { !$0.isWhitespace }
            return !marks.isEmpty && marks.allSatisfy { $0 == "-" || $0 == ":" }
        }
    }

    private static func cells(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        return trimmed.split(separator: "|", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
    }

    private func lineRow(_ line: String) -> some View {
        let expanded = line.replacingOccurrences(of: "\t", with: "    ")
        let indent = expanded.prefix { $0 == " " }.count
        let body = String(expanded.dropFirst(indent))
        let heading = headingLevel(of: body)
        let item = listItem(of: body)
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            if indent > 0 {
                Color.clear.frame(width: CGFloat(indent) * 8)
            }
            if let item {
                Text(item.marker)
                    .font(JieboFont.ui(13, weight: .medium))
                    .foregroundStyle(JieboColor.dim)
                    .frame(width: 22, alignment: .leading)
            }
            Text(Self.inline(item?.rest ?? heading?.rest ?? body))
                .font(headingFont(heading?.level))
                .foregroundStyle(JieboColor.ink)
                .tint(JieboColor.pine)
                .textSelection(.enabled)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func listItem(of line: String) -> (marker: String, rest: String)? {
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
            return ("•", String(line.dropFirst(2)))
        }
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty else { return nil }
        let after = line.dropFirst(digits.count)
        guard after.hasPrefix(". ") else { return nil }
        return ("\(digits).", String(after.dropFirst(2)))
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
        case 3: return 16
        case 4: return 15
        default: return 15
        }
    }

    /// 一、二级标题用宋体，和网页 .markdown h1/h2 一样。更深的标题仍是无衬线。
    private func headingFont(_ level: Int?) -> Font {
        guard let level else { return JieboFont.ui(16) }
        if level <= 2 { return JieboFont.display(headingSize(level)) }
        return JieboFont.ui(headingSize(level), weight: .semibold)
    }

    fileprivate static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

/// 对话里的 Markdown 表。表头比单元格更淡，文件名用等宽，行与行之间只留发丝线。
private struct HairlineTable: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row(headers, header: true, last: rows.isEmpty)
            ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                row(fit(cells), header: false, last: index == rows.count - 1)
            }
        }
        .padding(.top, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func fit(_ cells: [String]) -> [String] {
        let count = headers.count
        if cells.count == count { return cells }
        if cells.count > count { return Array(cells.prefix(count)) }
        return cells + Array(repeating: "", count: count - cells.count)
    }

    private func row(_ cells: [String], header: Bool, last: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 18) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                Text(ProseLines.inline(cell))
                    .font(font(index: index, header: header))
                    .foregroundStyle(color(index: index, header: header))
                    .tracking(header ? 0.4 : 0)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) {
            if !last {
                Rectangle()
                    .fill(JieboColor.line)
                    .frame(height: header ? 1 : 0.5)
            }
        }
    }

    private func font(index: Int, header: Bool) -> Font {
        if header { return JieboFont.ui(11, weight: .medium) }
        if index == 0 { return JieboFont.mono(12) }
        return JieboFont.ui(14)
    }

    private func color(index: Int, header: Bool) -> Color {
        if header { return JieboColor.dim }
        if index == 0 { return JieboColor.ink2 }
        return JieboColor.ink
    }
}

private struct ReplyApprovalCard: View {
    @Environment(ChatStore.self) private var store
    var tool: PendingTool

    private var approvalTarget: String {
        let path = tool.args?.string(in: "path", "file", "target_file", "file_path", "target") ?? ""
        return path.isEmpty ? tool.name : path
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("要改文件：\(approvalTarget)。允许会先还原再写；拒绝还原到发送前。")
                .font(JieboFont.ui(14))
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
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                Button("拒绝") { store.replyToApproval(allow: false) }
                    .buttonStyle(.plain)
                    .font(JieboFont.ui(14, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 16)
                    .frame(height: 36)
                    .background(JieboColor.mist)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
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

/// 「今日」按钮：ThreadView 的助理标题栏和 iPhone 助理页导航栏共用，外观一致。
struct AssistantTodayButton: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var on: Bool
    var marked: Bool
    var action: () -> Void

    init(on: Bool, marked: Bool, action: @escaping () -> Void) {
        self.on = on
        self.marked = marked
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: ToolLayer.assistant.symbol)
                    .font(.system(size: 12, weight: .semibold))
                Text("今日")
                    .font(JieboFont.ui(13, weight: .medium))
            }
            .foregroundStyle(on ? JieboColor.pine : JieboColor.ink)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(on ? JieboColor.pine.opacity(0.12) : JieboColor.mist)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .overlay(alignment: .topTrailing) {
                Circle()
                    .fill(JieboColor.ok)
                    .frame(width: 6, height: 6)
                    .offset(x: 2, y: -2)
                    .opacity(marked ? 1 : 0)
                    .animation(JieboMotion.fade(reduceMotion), value: marked)
            }
            .animation(JieboMotion.fade(reduceMotion), value: on)
            .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(marked ? "今日，\(store.assistantBadgeCount) 条待处理" : "今日")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// 助理工具名的判断与人话文案。工具名可能带 MCP 前缀，所以取最后一段再比。
private enum AssistantToolText {
    static func baseName(_ name: String) -> String {
        var base = name.lowercased()
        for separator in ["__", ".", "/", ":"] {
            if let range = base.range(of: separator, options: .backwards) {
                base = String(base[range.upperBound...])
            }
        }
        return base
    }

    /// 记忆是沉默的：memory_* 与 chat_search 不出卡片
    static func isSilent(_ tool: ToolCall) -> Bool {
        let base = baseName(tool.name)
        return base.hasPrefix("memory_") || base == "chat_search"
    }

    static func friendly(_ tool: ToolCall) -> String? {
        switch baseName(tool.name) {
        case "delegate":
            let workspace = tool.args?.string(in: "workspace") ?? ""
            let detail = tool.args?.string(in: "title", "task") ?? ""
            let head = workspace.isEmpty ? "交给工作区" : "交给 \(workspace)"
            return detail.isEmpty ? head : "\(head)：\(String(detail.prefix(40)))"
        case "create_workspace":
            let name = tool.args?.string(in: "name") ?? ""
            return name.isEmpty ? "申请新建工作区" : "申请新建工作区：\(name)"
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
/// 委派能对上本机已同步的子会话时，下面挂它最后一轮的前 3 个文件，按子会话 id 读
private struct AssistantActionRow: View {
    @Environment(ChatStore.self) private var store
    /// 只有 PhoneShell 注入；为 nil 时不出「全部」
    @Environment(\.openDelegation) private var openDelegation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var tool: ToolCall
    var text: String

    private static let fileLimit = 3

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

    private var childTurn: (chatId: String, turn: Turn)? {
        guard let childId = delegateRefs.childChatId,
              let chat = store.chats.first(where: { $0.id == childId }),
              let turn = chat.turns.last,
              !turn.cardFiles.isEmpty
        else { return nil }
        return (chat.id, turn)
    }

    private var failed: Bool {
        tool.status == "error" || tool.result?["ok"]?.bool == false
    }

    private var statusText: String {
        if tool.status == "running" { return "处理中" }
        return failed ? "未完成" : "已提交"
    }

    private var statusColor: Color {
        if tool.status == "running" { return JieboColor.run }
        return failed ? JieboColor.danger : JieboColor.ok
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            summaryRow
            if let child = childTurn {
                childFiles(child.turn, chatId: child.chatId)
            }
        }
    }

    private var summaryRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "paperplane")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(statusColor)
                .frame(width: 16, height: 16)
            Text(text)
                .font(JieboFont.ui(13, weight: .medium))
                .foregroundStyle(JieboColor.ink)
                .lineLimit(2)
            Spacer(minLength: 0)
            Text(statusText)
                .font(JieboFont.ui(11))
                .foregroundStyle(statusColor)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        )
        .animation(JieboMotion.fade(reduceMotion), value: tool.status)
        .accessibilityElement(children: .combine)
    }

    private func childFiles(_ turn: Turn, chatId: String) -> some View {
        let files = Array(turn.cardFiles.prefix(Self.fileLimit))
        let delegationId = delegateRefs.delegationId
        return VStack(spacing: 0) {
            ForEach(Array(files.enumerated()), id: \.element.id) { index, file in
                if index > 0 {
                    Rectangle().fill(JieboColor.line).frame(height: 0.5)
                }
                TurnFileRow(file: file, turn: turn, chatId: chatId)
            }
            if let openDelegation, let delegationId {
                Rectangle().fill(JieboColor.line).frame(height: 0.5)
                Button {
                    openDelegation(delegationId)
                } label: {
                    HStack(spacing: 6) {
                        Text("全部")
                            .font(JieboFont.ui(12, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(JieboColor.dim)
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 34)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("查看委派的全部文件和过程")
            }
        }
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        )
        .frame(maxWidth: JieboMeasure.bubble, alignment: .leading)
    }
}
