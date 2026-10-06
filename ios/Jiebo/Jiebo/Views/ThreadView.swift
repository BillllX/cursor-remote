import SwiftUI
import UIKit
import ImageIO

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
    /// 长会话首屏只排版最近若干轮，往上翻再按批加载；按 chat id 记住已展开到多少轮
    private static let initialRenderedTurns = 12
    private static let renderedTurnStep = 12
    @State private var renderedTurnLimitByChat: [String: Int] = [:]
    @State private var loadingEarlierBatch = false
    @AppStorage(CalendarInvite.dismissedKey) private var calendarInviteDismissed = false

    init(chrome: ThreadChrome = .pad, openDrawer: @escaping () -> Void = {}, dock: AnyView? = nil) {
        self.chrome = chrome
        self.openDrawer = openDrawer
        self.dock = dock
    }

    /// 旧写法：窄屏手机标题栏。保留给 PhoneWorkbench 等现有调用点。
    init(phoneChrome: Bool, openDrawer: @escaping () -> Void = {}) {
        self.init(chrome: phoneChrome ? .phoneLegacy : .pad, openDrawer: openDrawer)
    }

    /// iPhone 助理页在 iOS 26+ 上把输入区做成浮在消息上的玻璃底栏（safeAreaBar），消息从它下面滚过去
    private var floatsComposer: Bool { chrome == .embedded && JieboGlass.available }

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            header
            thread
                .overlay(alignment: .top) { floatingBanners }
                .modifier(FloatingBottomBar(enabled: floatsComposer) { bottomStack })
            if !floatsComposer {
                bottomStack
            }
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

    /// 输入框上方的委派待批、ActionDock 和输入框本身。输入框只有这一个
    @ViewBuilder
    private var bottomStack: some View {
        VStack(spacing: 0) {
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
    }

    @ViewBuilder
    private var floatingBanners: some View {
        VStack(spacing: 6) {
            if !store.notice.isEmpty {
                floatingBanner(store.notice, color: JieboColor.dim)
                    .allowsHitTesting(false)
            }
            if !store.bannerError.isEmpty {
                Button {
                    store.dismissBannerError()
                } label: {
                    floatingBanner(friendlyError(store.bannerError), color: JieboColor.danger, closable: true)
                }
                .buttonStyle(.plain)
                .accessibilityHint("轻点关闭")
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 16)
        .animation(JieboMotion.fade(reduceMotion), value: store.notice.isEmpty)
        .animation(JieboMotion.fade(reduceMotion), value: store.bannerError.isEmpty)
    }

    private func floatingBanner(_ text: String, color: Color, closable: Bool = false) -> some View {
        HStack(spacing: 8) {
            Text(text)
                .multilineTextAlignment(.center)
            if closable {
                Image(systemName: "xmark")
                    .font(JieboFont.text(.caption2, weight: .bold))
                    .opacity(0.7)
                    .accessibilityHidden(true)
            }
        }
        .font(JieboFont.text(.footnote, weight: .medium))
        .foregroundStyle(color)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .jieboGlass(in: Capsule())
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(closable ? [] : .isStaticText)
    }

    /// 本会话派出去的委派子会话停在审批上：在输入框上方直接作答
    /// 样式与输入框里的待批条（ComposerView.approvalBar）一致，只是按钮用委派的「批准 / 拒绝」
    private func delegatedApprovalBanner(_ approval: AssistantApproval, more: Int) -> some View {
        let tool = approval.tool.nilIfEmpty ?? "工具调用"
        return VStack(alignment: .leading, spacing: 8) {
            Text(more > 0 ? "委派要用 \(tool)（另有 \(more) 条待批）" : "委派要用 \(tool)")
                .font(JieboFont.text(.subheadline, weight: .medium))
                .foregroundStyle(JieboColor.ink)
                .lineLimit(2)
            if !approval.summary.isEmpty {
                Text(approval.summary)
                    .font(JieboFont.monoText(.caption))
                    .foregroundStyle(JieboColor.ink2)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            HStack(spacing: 8) {
                Button("拒绝", role: .destructive) { store.answerAssistantApproval(approval, allow: false) }
                    .buttonStyle(.bordered)
                Button("批准") { store.answerAssistantApproval(approval, allow: true) }
                    .buttonStyle(.borderedProminent)
                    .tint(JieboColor.pine)
            }
            .font(JieboFont.text(.subheadline, weight: .semibold))
            .controlSize(.large)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.warnBg)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
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

    /// 优先级和 iPhone 首页一致：没连上 > 没配 API Key > 正在回复 > 模式
    private var padSubtitle: String {
        if !store.connected { return store.linkState.title }
        if !store.hasApiKey { return "服务器还没配 API Key" }
        if store.busy { return "正在回复" }
        return store.mode.label
    }

    private var phoneSubtitle: String {
        if !store.connected { return store.linkState.title }
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
                    HStack(spacing: 5) {
                        LinkStatusDot(state: store.linkState, syncing: store.threadSyncBusy)
                        Text(phoneSubtitle)
                            .font(JieboFont.text(.caption2, weight: .medium))
                            .tracking(0.3)
                            .foregroundStyle(store.hasApiKey || !store.connected ? JieboColor.dim : JieboColor.danger)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
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
                            .font(JieboFont.text(.caption))
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
                HStack(spacing: 6) {
                    LinkStatusDot(state: store.linkState, syncing: store.threadSyncBusy, size: 7)
                    Text(padSubtitle)
                        .font(JieboFont.text(.caption, weight: .medium))
                        .tracking(0.4)
                        .foregroundStyle(store.connected && !store.hasApiKey ? JieboColor.danger : JieboColor.dim)
                        .lineLimit(1)
                }
                .accessibilityElement(children: .combine)
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
    /// 节流用的时钟；引用类型，改它不触发重绘
    @State private var followClock = FollowClock()
    /// showThreadLoading 持续超过 350ms 才亮的加载遮罩
    @State private var loadingVisible = false

    private var thread: some View {
        // 外层先量出视口宽。不锁宽的话，计划里的长行会按「不折行」的理想高度去撑滚动区，看起来到底了，下面还有一大段。
        GeometryReader { geo in
        ScrollViewReader { proxy in
            ScrollView {
                // 不用 LazyVStack：流式增高时未实现的底部锚点会让 scrollTo 落空，跟随就断。
                VStack(alignment: .leading, spacing: 18) {
                    if let chat = store.active, chat.turns.isEmpty, chat.turnsComplete, !store.coldStartPlaceholder {
                        // 未加载完的壳（!turnsComplete）不算空会话——由下方遮罩覆盖
                        if chrome == .embedded {
                            assistantEmptyState
                        } else {
                            emptyState
                        }
                    }
                    if let chat = store.active, !chat.turnsComplete, !chat.turns.isEmpty,
                       store.loadingChatIds.contains(chat.id), !store.refreshingChatIds.contains(chat.id) {
                        // 只在真的往前翻页时出现；显示本机缓存、增量补齐期间由导航栏的同步转圈提示
                        // 分页加载更早内容的轻提示（不抢滚动，对齐「分段加载」的可感知性）
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("正在加载更早的内容…")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.ink2)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                    }
                    let allTurns = Turn.uniqued(store.active?.turns ?? [])
                    let renderLimit = renderedTurnLimit(for: store.activeId, total: allTurns.count)
                    let hiddenCount = max(0, allTurns.count - renderLimit)
                    let turns = Array(allTurns.suffix(renderLimit))
                    let inviteTurnId = calendarInviteTurnId(turns)
                    if hiddenCount > 0 {
                        let batch = min(hiddenCount, Self.renderedTurnStep)
                        Button {
                            loadEarlierTurns(proxy: proxy, allTurns: allTurns, limit: renderLimit)
                        } label: {
                            Text(batch < hiddenCount ? "显示更早 \(batch) 轮（还有 \(hiddenCount) 轮）" : "显示更早 \(hiddenCount) 轮")
                                .font(JieboFont.text(.footnote, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background {
                            GeometryReader { geo in
                                Color.clear
                                    .onChange(of: geo.frame(in: .named("threadScroll")).minY) { _, minY in
                                        // VStack 会一次性建好子视图，不能用 onAppear；看哨兵是否进视口
                                        guard minY >= -12, minY < viewportHeight - 48 else { return }
                                        guard !stickToBottom else { return }
                                        loadEarlierTurns(proxy: proxy, allTurns: allTurns, limit: renderLimit)
                                    }
                            }
                        }
                    }
                    ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                        if let gap = timeSeparator(before: turn, previous: index > 0 ? turns[index - 1] : nil) {
                            Text(gap)
                                .font(JieboFont.text(.caption, weight: .medium))
                                .foregroundStyle(JieboColor.dim)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 4)
                                .accessibilityAddTraits(.isHeader)
                        }
                        TurnView(
                            turn: turn,
                            canAnswer: index == turns.count - 1 && !turn.running && !turn.queued,
                            embedded: chrome == .embedded,
                            isLastAssistant: turn.id == allTurns.last?.id,
                            reviewMark: store.localTurnReviews[turn.id],
                            restoring: store.restoringTurnIds.contains(turn.id),
                            captured: TodoReceipt.captured(in: turn, todos: store.assistantState?.todos),
                            calendarInvite: turn.id == inviteTurnId ? store.assistantState?.calendar : nil
                        )
                            // 流式只改最后一轮：其余轮次入参不变就不重算 body
                            .equatable()
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
                .padding(.horizontal, chrome == .embedded ? 16 : 24)
                .padding(.top, 12)
                .padding(.bottom, 28)
                .frame(width: geo.size.width, alignment: .topLeading)
            }
            .scrollDismissesKeyboard(.interactively)
            .coordinateSpace(name: "threadScroll")
            // 浮动底栏盖住的那截不算可见区，否则「在底部」的判断会松一个底栏高
            .onAppear { viewportHeight = geo.size.height - geo.safeAreaInsets.bottom }
            .onChange(of: geo.size.height - geo.safeAreaInsets.bottom) { _, h in viewportHeight = h }
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
                            ZStack(alignment: .topTrailing) {
                                Image(systemName: "arrow.down")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(JieboColor.ink)
                                    .frame(width: 44, height: 44)
                                    .jieboGlass(in: Circle(), interactive: true)
                                if store.active?.turns.last?.running == true {
                                    Circle()
                                        .fill(JieboColor.run)
                                        .frame(width: 9, height: 9)
                                        .offset(x: 1, y: 1)
                                }
                            }
                            .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(store.active?.turns.last?.running == true ? "有新内容正在生成" : "")
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
                    if loadingVisible {
                        VStack(spacing: 12) {
                            ProgressView().controlSize(.large)
                            Text("正在加载会话…")
                                .font(JieboFont.text(.footnote, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(JieboColor.paper.opacity(0.92))
                        .transition(.opacity)
                    }
                }
                .animation(JieboMotion.fade(reduceMotion), value: loadingVisible)
            }
            .task(id: showThreadLoading) {
                // 本机缓存通常几十毫秒就读完：等一小会儿再盖遮罩，免得冷启动先闪一下
                guard showThreadLoading else {
                    loadingVisible = false
                    return
                }
                try? await Task.sleep(for: .milliseconds(350))
                if !Task.isCancelled, showThreadLoading { loadingVisible = true }
            }
            .modifier(StartAtBottom())
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
            .onChange(of: liveTail) { _, _ in followStream(proxy) }
            .onChange(of: store.active?.turns.last?.running) { _, running in
                // 流式时只补滚一次；停更后最后一块（代码、表格）还会长高，按完整节奏再对齐
                if running == false { followBottom(proxy) }
            }
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

    private func renderedTurnLimit(for chatId: String, total: Int) -> Int {
        let stored = renderedTurnLimitByChat[chatId] ?? Self.initialRenderedTurns
        return min(total, max(Self.initialRenderedTurns, stored))
    }

    /// 在列表顶部 prepend 更早轮次后，锚定原先最上面那一轮，避免整页跳动
    private func loadEarlierTurns(proxy: ScrollViewProxy, allTurns: [Turn], limit: Int) {
        guard !loadingEarlierBatch else { return }
        let hidden = allTurns.count - limit
        guard hidden > 0 else { return }
        loadingEarlierBatch = true
        let anchorId = Array(allTurns.suffix(limit)).first?.id
        let next = min(allTurns.count, limit + Self.renderedTurnStep)
        renderedTurnLimitByChat[store.activeId] = next
        followTask?.cancel()
        followTask = Task { @MainActor in
            defer { loadingEarlierBatch = false }
            guard let anchorId else { return }
            scrollingProgrammatically = true
            for delay in [0, 48, 120, 260] {
                try? await Task.sleep(for: .milliseconds(delay))
                guard !Task.isCancelled else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    proxy.scrollTo(anchorId, anchor: .top)
                }
            }
            scrollingProgrammatically = false
        }
    }

    /// 流式每个 token 都会改 liveTail：最多每 50ms 跟一次，其间来的合并成一次尾随滚动
    private func followStream(_ proxy: ScrollViewProxy) {
        guard stickToBottom else { return }
        let clock = followClock
        let elapsed = Date().timeIntervalSince(clock.last)
        if elapsed >= FollowClock.interval {
            clock.last = Date()
            followBottom(proxy, settle: [40])
            return
        }
        guard clock.pending == nil else { return }
        clock.pending = Task { @MainActor in
            try? await Task.sleep(for: .seconds(FollowClock.interval - elapsed))
            clock.pending = nil
            guard !Task.isCancelled else { return }
            clock.last = Date()
            followBottom(proxy, settle: [40])
        }
    }

    /// 跟随流式输出。布局往往晚一帧才完成，所以紧接着再滚几次，避免停在旧高度。
    /// settle：补滚的间隔；流式节流时只补一次，下一次 token 会接着跟
    private func followBottom(_ proxy: ScrollViewProxy, animated: Bool = false, settle: [Int] = [40, 100, 180, 380]) {
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
            for delay in settle {
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
        if store.coldStartPlaceholder { return true }
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
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.dim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            ViewThatFits(in: .horizontal) {
                starterRow(axis: .horizontal)
                starterRow(axis: .vertical)
            }
            .padding(.top, 8)
            Text("点左上角打开对话列表 · 可粘贴图片")
                .font(JieboFont.text(.footnote))
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
                .font(JieboFont.text(.subheadline))
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
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
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
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
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

    /// 订阅引导只挂在最近一轮记下带日期待办的回执下面，不在每条回执后面重复
    private func calendarInviteTurnId(_ turns: [Turn]) -> String? {
        guard CalendarInvite.pending(store.assistantState?.calendar, dismissed: calendarInviteDismissed) else { return nil }
        return turns.last(where: { turn in
            TodoReceipt.captured(in: turn, todos: store.assistantState?.todos).contains { !$0.duplicate && $0.due != nil }
        })?.id
    }

    private func timeSeparator(before turn: Turn, previous: Turn?) -> String? {
        guard let at = turn.startedAt, at > 0 else { return nil }
        guard let prev = previous?.startedAt, prev > 0 else { return nil }
        guard at - prev > 10 * 60 * 1000 else { return nil }
        return formatTurnTimeSeparator(at)
    }
}

private struct TurnView: View, Equatable {
    @Environment(ChatStore.self) private var store
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
                            Button { store.editTurn(turn.id) } label: { Label("编辑", systemImage: "pencil") }
                            Button { store.retryTurn(turn.id) } label: { Label("重试", systemImage: "arrow.clockwise") }
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
                                Button("去掉") { store.dropQueuedTurn(turn.id) }
                                    .font(JieboFont.text(.caption))
                                    .foregroundStyle(JieboColor.ink2)
                                    .buttonStyle(.plain)
                                    .hitTarget()
                                    .accessibilityLabel("去掉这条排队消息")
                            }
                        } else if userFailed {
                            Button("重试") { store.retryTurn(turn.id) }
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
                                            chatId: store.activeId,
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
                            Button("执行这个计划") { store.applyPlan(turn.id) }
                                .buttonStyle(.borderedProminent)
                                .tint(JieboColor.pine)
                                .font(JieboFont.text(.subheadline, weight: .semibold))
                                .padding(.top, 2)
                        }
                    }
                    .contextMenu {
                        if !turn.assistant.isEmpty {
                            Button { copy(turn.assistant) } label: { Label("复制", systemImage: "doc.on.doc") }
                            Button { store.retryTurn(turn.id) } label: { Label("重新生成", systemImage: "arrow.clockwise") }
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
                    Button("重试") { store.retryTurn(turn.id) }
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
                    TurnFileCards(turn: turn, chatId: store.activeId, files: inline.tail)
                        .padding(.leading, embedded ? 0 : 40)
                }
            } else if !turn.cardFiles.isEmpty {
                TurnFileCards(turn: turn, chatId: store.activeId)
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
            actionIcon("arrow.clockwise", label: "重新生成") { store.retryTurn(turn.id) }
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

private struct CodeHeader: View {
    var lang: String
    var code: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            Text(lang.isEmpty ? "代码" : lang)
                .font(JieboFont.monoText(.caption2))
                .foregroundStyle(JieboColor.dim)
                .tracking(0.4)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button {
                UIPasteboard.general.string = code
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                copied = true
            } label: {
                Label(copied ? "已复制" : "复制", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .font(JieboFont.text(.caption, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .padding(.horizontal, 4)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(copied ? "已复制代码" : "复制代码")
            .task(id: copied) {
                guard copied else { return }
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .overlay(alignment: .bottom) {
            Rectangle().fill(JieboColor.line).frame(height: 0.5)
        }
    }
}

private struct ShareItem: Identifiable {
    let id = UUID()
    let text: String
}

/// 附图解码：ImageIO 直接按目标像素解码，不先解出整张原图（相机图解开是几十 MB）。
/// 缓存按字节计；NSCache 本身线程安全，后台解码可以直接写。
enum JieboThumbDecoder {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 32 * 1024 * 1024
        return cache
    }()

    static func cached(_ key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    static func store(_ image: UIImage, key: String) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 1
        cache.setObject(image, forKey: key as NSString, cost: cost)
    }

    static func decode(_ data: Data, maxPixel: CGFloat) -> UIImage? {
        let options: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, options as CFDictionary) else { return nil }
        let thumbOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(maxPixel, 1),
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }

    /// base64 太长不能整段哈希（每次重算都要扫几 MB）：长度 + 头、中、尾各 48 字节，连续存储时 O(1) 取样
    static func key(base64 text: String, size: CGFloat) -> String {
        var text = text
        return text.withUTF8 { bytes in
            let n = bytes.count
            func slice(_ start: Int) -> String {
                let lo = max(0, min(start, n))
                let hi = min(n, lo + 48)
                return String(decoding: UnsafeBufferPointer(rebasing: bytes[lo..<hi]), as: UTF8.self)
            }
            return "b64|\(Int(size))|\(n)|\(slice(0))|\(slice(n / 2))|\(slice(n - 48))"
        }
    }
}

/// 附图缩略：先查缓存；没有就在后台解码，解好淡入。重算 body（流式每个 token、输入每个按键）不再碰原图。
struct AttachmentThumb: View {
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let key: String
    /// 视图边长（pt）；scaledToFill，长边按 2 倍解，短边也铺得满
    let side: CGFloat
    let load: @Sendable () -> Data?
    @State private var image: UIImage?

    init(key: String, side: CGFloat, load: @escaping @Sendable () -> Data?) {
        self.key = key
        self.side = side
        self.load = load
        _image = State(initialValue: JieboThumbDecoder.cached(key))
    }

    var body: some View {
        ZStack {
            JieboColor.well
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .frame(width: side, height: side)
        .clipped()
        .task(id: key) {
            if let hit = JieboThumbDecoder.cached(key) {
                image = hit
                return
            }
            let maxPixel = side * 2 * displayScale
            let load = self.load
            let key = self.key
            let decoded = await Task.detached(priority: .userInitiated) { () -> UIImage? in
                guard let data = load(), let image = JieboThumbDecoder.decode(data, maxPixel: maxPixel) else { return nil }
                JieboThumbDecoder.store(image, key: key)
                return image
            }.value
            guard !Task.isCancelled else { return }
            withAnimation(JieboMotion.fade(reduceMotion)) { image = decoded }
        }
    }
}

/// 点开附图：全屏看原图（按屏幕像素解码），双指缩放、双击放大、拖动平移，可分享
struct AttachmentViewerItem: Identifiable {
    let id = UUID()
    let title: String
    let load: @Sendable () -> Data?
}

struct AttachmentViewer: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    let item: AttachmentViewerItem
    @State private var image: UIImage?
    @State private var failed = false
    @State private var scale: CGFloat = 1
    @State private var pinch: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var pan: CGSize = .zero
    @State private var chromeHidden = false

    /// 解码按屏幕像素 × maxScale，放到最大也不糊
    private static let maxScale: CGFloat = 3
    private static let doubleTapScale: CGFloat = 2.5

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black
                // 视口取整屏（含安全区）：导航栏、状态栏浮在图上，显隐时图不跟着变大变小
                GeometryReader { geo in
                    content(in: geo.size)
                }
                if chromeHidden {
                    // 导航栏藏起来后「完成」不在层级里，Esc 靠这个隐形按钮
                    Button("完成") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .opacity(0)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .ignoresSafeArea()
            .navigationTitle(item.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar(chromeHidden ? .hidden : .visible, for: .navigationBar)
            .statusBarHidden(chromeHidden)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
                if let image {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(
                            item: Image(uiImage: image),
                            preview: SharePreview(item.title, image: Image(uiImage: image))
                        )
                    }
                }
            }
        }
        .accessibilityAction(.escape) { dismiss() }
    }

    @ViewBuilder
    private func content(in viewport: CGSize) -> some View {
        ZStack {
            if let image {
                let fit = Self.fitted(image.size, in: viewport)
                let live = min(max(scale * pinch, 1), Self.maxScale)
                let shown = Self.clamp(
                    CGSize(width: offset.width + pan.width, height: offset.height + pan.height),
                    fit: fit, scale: live, in: viewport
                )
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: fit.width, height: fit.height)
                    .scaleEffect(live)
                    .offset(shown)
                    .accessibilityLabel(item.title)
                    .accessibilityAddTraits(.isImage)
            } else if failed {
                Label("图片打不开", systemImage: "photo.badge.exclamationmark")
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(.white.opacity(0.8))
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(width: viewport.width, height: viewport.height)
        .contentShape(Rectangle())
        .gesture(zoom(in: viewport))
        .simultaneousGesture(drag(in: viewport), including: scale > 1 ? .all : .subviews)
        .gesture(taps(in: viewport))
        .task {
            let maxPixel = min(4096, max(viewport.width, viewport.height) * displayScale * Self.maxScale)
            let load = item.load
            let decoded = await Task.detached(priority: .userInitiated) {
                load().flatMap { JieboThumbDecoder.decode($0, maxPixel: maxPixel) }
            }.value
            guard !Task.isCancelled else { return }
            image = decoded
            failed = decoded == nil
        }
    }

    /// 双击优先于单击：双击在点击处放大 / 复原，单击显隐导航栏
    private func taps(in viewport: CGSize) -> some Gesture {
        SpatialTapGesture(count: 2)
            .onEnded { value in
                withAnimation(JieboMotion.snappy(reduceMotion)) {
                    if scale > 1 {
                        scale = 1
                        offset = .zero
                    } else {
                        let s = Self.doubleTapScale
                        let dx = value.location.x - viewport.width / 2
                        let dy = value.location.y - viewport.height / 2
                        scale = s
                        offset = clamped(CGSize(width: -dx * (s - 1), height: -dy * (s - 1)), scale: s, in: viewport)
                    }
                }
            }
            .exclusively(before: TapGesture().onEnded {
                guard !voiceOver else { return }
                withAnimation(JieboMotion.fade(reduceMotion)) { chromeHidden.toggle() }
            })
    }

    private func zoom(in viewport: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in pinch = value.magnification }
            .onEnded { value in
                let next = min(max(scale * value.magnification, 1), Self.maxScale)
                withAnimation(JieboMotion.snappy(reduceMotion)) {
                    scale = next
                    pinch = 1
                    offset = next == 1 ? .zero : clamped(offset, scale: next, in: viewport)
                }
            }
    }

    private func drag(in viewport: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in pan = value.translation }
            .onEnded { value in
                let moved = CGSize(
                    width: offset.width + value.translation.width,
                    height: offset.height + value.translation.height
                )
                offset = clamped(moved, scale: scale, in: viewport)
                pan = .zero
            }
    }

    private func clamped(_ value: CGSize, scale: CGFloat, in viewport: CGSize) -> CGSize {
        guard let image else { return .zero }
        return Self.clamp(value, fit: Self.fitted(image.size, in: viewport), scale: scale, in: viewport)
    }

    static func fitted(_ size: CGSize, in viewport: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return viewport }
        let ratio = min(viewport.width / size.width, viewport.height / size.height)
        return CGSize(width: size.width * ratio, height: size.height * ratio)
    }

    /// 放大后图边不离开屏幕边：可平移量 = (放大后尺寸 − 视口) / 2，图比视口小的方向不让移
    static func clamp(_ value: CGSize, fit: CGSize, scale: CGFloat, in viewport: CGSize) -> CGSize {
        let maxX = max(0, (fit.width * scale - viewport.width) / 2)
        let maxY = max(0, (fit.height * scale - viewport.height) / 2)
        return CGSize(
            width: min(max(value.width, -maxX), maxX),
            height: min(max(value.height, -maxY), maxY)
        )
    }
}

/// 流式时每个 token 都会改 text；排版（含 @路径改链接）最多每 100ms 一次，停下立刻排完整版
private struct StreamingAssistantText: View {
    let text: String
    let live: Bool
    let transform: @MainActor (String) -> String

    @State private var rendered: String?
    @State private var latest = ""
    @State private var flush: Task<Void, Never>?

    var body: some View {
        ChunkedAssistantMessage(text: live ? (rendered ?? transform(text)) : transform(text))
            .equatable()
            .onAppear {
                latest = text
                if live { rendered = transform(text) }
            }
            .onChange(of: text) { old, value in
                latest = value
                guard live else { return }
                // 不是在末尾追加（文件卡片插进来、分段重切，ForEach 按下标复用了这份状态）：立刻排，不等节流
                if !value.hasPrefix(old) {
                    flush?.cancel()
                    flush = nil
                    rendered = transform(value)
                    return
                }
                guard flush == nil else { return }
                flush = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(100))
                    guard !Task.isCancelled else { return }
                    rendered = transform(latest)
                    flush = nil
                }
            }
            .onChange(of: live) { _, isLive in
                flush?.cancel()
                flush = nil
                rendered = isLive ? transform(latest) : nil
            }
            .onDisappear {
                flush?.cancel()
                flush = nil
            }
    }
}

/// 正文按围栏外的空行切成段，每段是一个 equatable 的 AssistantMessage：
/// 流式时只有最后一段在变，前面的段不再重新拆块、解析表格和排版
private struct ChunkedAssistantMessage: View, Equatable {
    let text: String

    /// 段间距 = 原来一行空行的高度（5 + 12 + 5）
    private static let gap: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: Self.gap) {
            ForEach(Array(ChunkMemo.shared.chunks(text).enumerated()), id: \.offset) { _, chunk in
                AssistantMessage(text: chunk)
                    .equatable()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 围栏判定与 AssistantMessage.blocks 一致（行首 ```）。
    /// 返回值里 stableEnd 是最后一个「围栏外空行」之后的 UTF-8 偏移，stableCount 是它之前已经封口的段数。
    static func scan(_ text: Substring) -> (chunks: [String], stableEnd: Int, stableCount: Int) {
        var result: [String] = []
        var current: [Substring] = []
        var inFence = false
        var offset = 0
        var stableEnd = 0
        var stableCount = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let next = offset + line.utf8.count + 1
            defer { offset = next }
            if line.hasPrefix("```") { inFence.toggle() }
            if !inFence, line.allSatisfy({ $0 == " " || $0 == "\t" }) {
                if !current.isEmpty {
                    result.append(current.joined(separator: "\n"))
                    current = []
                }
                // 末行的空串只是还没写完的换行，后面的字会接在这一行上，不算封口
                if next <= text.utf8.count {
                    stableEnd = next
                    stableCount = result.count
                }
                continue
            }
            current.append(line)
        }
        if !current.isEmpty { result.append(current.joined(separator: "\n")) }
        return (result, stableEnd, stableCount)
    }
}

/// 流式时正文只在末尾追加：上次已经封口的段直接复用，只扫新增的尾巴
@MainActor
private final class ChunkMemo {
    static let shared = ChunkMemo()
    private var stablePrefix = ""
    private var stableChunks: [String] = []

    func chunks(_ text: String) -> [String] {
        var head: [String] = []
        var tail = Substring(text)
        if !stablePrefix.isEmpty, text.hasPrefix(stablePrefix) {
            head = stableChunks
            tail = text[text.utf8.index(text.startIndex, offsetBy: stablePrefix.utf8.count)...]
        }
        let scanned = ChunkedAssistantMessage.scan(tail)
        let all = head + scanned.chunks
        if scanned.stableEnd > 0 {
            let consumed = (text.utf8.count - tail.utf8.count) + scanned.stableEnd
            stablePrefix = String(text[..<text.utf8.index(text.startIndex, offsetBy: consumed)])
            stableChunks = head + scanned.chunks.prefix(scanned.stableCount)
        } else if head.isEmpty {
            stablePrefix = ""
            stableChunks = []
        }
        return all.isEmpty ? [text] : all
    }
}

private struct AssistantMessage: View, Equatable {
    let text: String

    static func == (lhs: AssistantMessage, rhs: AssistantMessage) -> Bool {
        lhs.text == rhs.text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let code, let lang):
                    CodeBlockView(code: code, lang: lang)
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
}

/// 代码块：字号跟 Dynamic Type。单独成视图，字号档变化只重画它，不受外层 equatable 拦截
private struct CodeBlockView: View {
    @Environment(\.sizeCategory) private var sizeCategory
    let code: String
    let lang: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CodeHeader(lang: lang, code: code)
            ScrollView(.horizontal, showsIndicators: true) {
                Text((code.isEmpty ? " " : code).replacingOccurrences(of: "\t", with: "    "))
                    .font(JieboFont.monoScaled(12, sizeCategory: sizeCategory))
                    .foregroundStyle(JieboColor.ink)
                    .textSelection(.enabled)
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
        }
        .background(JieboColor.well.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
    }
}

/// 按原文逐行排。整段 Markdown 会把单个换行和行首空格吃掉。
private struct ProseLines: View {
    @Environment(\.sizeCategory) private var sizeCategory
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .lines(let lines):
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            if line.allSatisfy({ $0 == " " || $0 == "\t" }) {
                                Color.clear.frame(height: 12)
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
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.dim)
                    .frame(width: 22, alignment: .leading)
            }
            Text(Self.inline(item?.rest ?? heading?.rest ?? body))
                .font(proseFont(heading?.level))
                .foregroundStyle(JieboColor.ink)
                .tint(JieboColor.pine)
                .textSelection(.enabled)
                .multilineTextAlignment(.leading)
                // 竖向只按自己的折行高度占位：被压矮时行尾出省略号、下一行叠上来
                .fixedSize(horizontal: false, vertical: true)
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

    private func proseFont(_ level: Int?) -> Font {
        guard let level else { return JieboFont.uiScaled(16, sizeCategory: sizeCategory) }
        if level <= 2 { return JieboFont.display(headingSize(level)) }
        return JieboFont.uiScaled(headingSize(level), sizeCategory: sizeCategory, weight: .semibold)
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
    @Environment(\.sizeCategory) private var sizeCategory
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        Group {
            if headers.count > 3 {
                ScrollView(.horizontal, showsIndicators: true) {
                    tableBody
                }
            } else {
                tableBody
            }
        }
        .padding(.top, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var tableBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            row(headers, header: true, last: rows.isEmpty)
            ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                row(fit(cells), header: false, last: index == rows.count - 1)
            }
        }
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
                    .fixedSize(horizontal: false, vertical: true)
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
        if header { return JieboFont.uiScaled(12, sizeCategory: sizeCategory, weight: .medium) }
        if index == 0 { return JieboFont.monoScaled(12, sizeCategory: sizeCategory) }
        return JieboFont.uiScaled(16, sizeCategory: sizeCategory)
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
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink)
            if let args = tool.args {
                ScrollView {
                    Text(args.pretty(2_000))
                        .font(JieboFont.monoText(.caption))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 160)
            }
            HStack(spacing: 10) {
                Button("拒绝", role: .destructive) { store.replyToApproval(allow: false) }
                    .buttonStyle(.bordered)
                Button("允许") { store.replyToApproval(allow: true) }
                    .buttonStyle(.borderedProminent)
                    .tint(JieboColor.pine)
            }
            .font(JieboFont.text(.subheadline, weight: .semibold))
            .controlSize(.large)
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
                    .font(JieboFont.text(.footnote, weight: .medium))
            }
            .foregroundStyle(on ? JieboColor.pine : JieboColor.ink)
            .padding(.horizontal, 10)
            .frame(minHeight: 30)
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
private struct TodoReceiptRow: View {
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
            (Text("\(head)：").foregroundStyle(JieboColor.ink2)
                + Text([TodoDue.label(receipt.due), receipt.text].compactMap { $0 }.joined(separator: " "))
                .foregroundStyle(removed ? JieboColor.dim : JieboColor.ink)
                .strikethrough(removed || done))
                .font(JieboFont.text(.footnote))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let todo = receipt.todo, !todo.done {
                if !receipt.duplicate {
                    receiptButton("撤销") {
                        store.assistantOp("todo_remove", args: ["id": .string(todo.id)])
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

    /// 记忆是沉默的：memory_*、work_preference_*、workspace_memory_read 与 chat_search 不出卡片
    static func isSilent(_ tool: ToolCall) -> Bool {
        let base = baseName(tool.name)
        return base.hasPrefix("memory_") || base.hasPrefix("work_preference_") || base == "workspace_memory_read" || base == "chat_search"
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
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .frame(maxWidth: .infinity, alignment: .leading)
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

    /// 委派产出的文件：与本轮文件同一套卡片（能预览的出缩略图），最多 3 个，更多进详情
    private func childFiles(_ turn: Turn, chatId: String) -> some View {
        let all = turn.cardFiles
        let files = Array(all.prefix(Self.fileLimit))
        let delegationId = delegateRefs.delegationId
        return VStack(alignment: .leading, spacing: 4) {
            TurnFileCards(turn: turn, chatId: chatId, files: files)
            if let openDelegation, let delegationId, all.count > files.count {
                Button {
                    openDelegation(delegationId)
                } label: {
                    HStack(spacing: 4) {
                        Text("查看全部 \(all.count) 个文件")
                            .font(JieboFont.text(.footnote, weight: .medium))
                        Image(systemName: "chevron.right")
                            .font(JieboFont.text(.caption2, weight: .semibold))
                    }
                    .foregroundStyle(JieboColor.pine)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("查看委派的全部 \(all.count) 个文件和过程")
            }
        }
        .frame(maxWidth: JieboMeasure.bubble, alignment: .leading)
    }
}

@MainActor
private final class FollowClock {
    static let interval: Double = 0.05
    var last = Date.distantPast
    var pending: Task<Void, Never>?
}

/// iOS 26+：内容挂一条底部 safeAreaBar（系统给滚动边缘做柔化）；其它情况原样返回，由调用方把底栏排在 VStack 里
private struct FloatingBottomBar<Bar: View>: ViewModifier {
    var enabled: Bool
    @ViewBuilder var bar: () -> Bar

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if enabled {
                content.safeAreaBar(edge: .bottom) { bar() }
            } else {
                content
            }
        } else {
            content
        }
    }
}

/// 打开会话时直接停在底部，不先从顶上画一帧再跳下去。
/// 只管初始位置：iOS 17 的 defaultScrollAnchor 还会在内容变高时贴底，会和 stickToBottom 的跟随打架
private struct StartAtBottom: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.defaultScrollAnchor(.bottom, for: .initialOffset)
        } else {
            content
        }
    }
}
