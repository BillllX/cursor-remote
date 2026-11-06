import SwiftUI
import UIKit

struct RootView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        Group {
            if store.unlocked || store.resumingLogin {
                HomeShell()
            } else {
                LoginView()
            }
        }
        .background(JieboColor.paper.ignoresSafeArea())
        .tint(JieboColor.pine)
    }
}
struct WorkbenchView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.sceneSessionState) private var sceneSession
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.homeActive) private var homeActive
    @Environment(\.assistantSceneToken) private var sceneToken
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var workbenchWidth: CGFloat = 0
    /// 侧栏实际宽（用户可拖 240–380）
    @State private var sidebarWidth: CGFloat = 300

    /// 预览分栏宽：窗口的四成，夹在 420–600
    private var previewColumnWidth: CGFloat {
        min(max(workbenchWidth * 0.4, 420), 600)
    }

    /// 侧栏（或收起后的图标栏）和预览栏都放下后，对话区还剩 400 以上才分栏；否则预览照旧盖满
    private var previewSplit: Bool {
        let side: CGFloat = columnVisibility == .detailOnly ? 56 : sidebarWidth
        return workbenchWidth - side - previewColumnWidth - 1 >= 400
    }

    private var activePreviewTab: PreviewTab? {
        if let sceneSession { return sceneSession.previewTab(in: store) }
        return store.activePreviewTab
    }

    private var previewPanelOpen: Bool {
        if sceneSession != nil { return activePreviewTab != nil }
        return store.previewPanelOpen
    }

    private var previewFullscreen: Bool { sceneSession?.previewFullscreen == true }

    private var previewOverlaid: Bool { previewPanelOpen && !previewSplit }

    private func closePreview() {
        if let sceneSession {
            sceneSession.dismissPreview()
        } else {
            store.collapsePreview()
        }
    }

    var body: some View {
        Group {
            if UIDevice.current.userInterfaceIdiom == .phone {
                PhoneTabShell()
            } else if sizeClass == .compact {
                PhoneWorkbench() // iPad 窄窗保持原样
            } else {
                padWorkbench
            }
        }
        .background(JieboColor.paper)
        // 切到聊天主页时文件浏览器先收起（状态留着，切回来再盖上）
        .fullScreenCover(isPresented: Binding(
            get: { store.fileBrowserOpen && homeActive },
            set: { open in if homeActive { store.fileBrowserOpen = open } }
        )) {
            FileBrowserCover()
        }
        #if DEBUG
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--open-file-browser") {
                store.fileBrowserOpen = true
            }
        }
        #endif
        .onReceive(NotificationCenter.default.publisher(for: .padSceneSidebarToggleRequested)) { note in
            guard let delivery = note.object as? PadSceneCommandDelivery,
                  delivery.sceneToken == sceneToken,
                  UIDevice.current.userInterfaceIdiom == .pad,
                  sizeClass == .regular
            else { return }
            withAnimation(JieboMotion.panel(reduceMotion)) {
                columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
            }
        }
    }

    @ViewBuilder
    private var padWorkbench: some View {
        @Bindable var store = store
        ZStack(alignment: .trailing) {
        HStack(spacing: 0) {
            // 图标栏一直挂着，只改宽度。收起时不必等分栏动画结束再创建，图标就不会晚一拍才出现。
            CollapsedSidebarRail(expand: {
                withAnimation(JieboMotion.panel(reduceMotion)) {
                    columnVisibility = .all
                }
            })
            .frame(width: columnVisibility == .detailOnly ? 56 : 0)
            .clipped()
            .allowsHitTesting(columnVisibility == .detailOnly)
            .animation(JieboMotion.panel(reduceMotion), value: columnVisibility == .detailOnly)
            NavigationSplitView(columnVisibility: $columnVisibility) {
                SidebarView(collapse: {
                    withAnimation(JieboMotion.panel(reduceMotion)) {
                        columnVisibility = .detailOnly
                    }
                })
                    .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 380)
                    .background {
                        GeometryReader { geo in
                            Color.clear
                                .onAppear { sidebarWidth = geo.size.width }
                                .onChange(of: geo.size.width) { _, width in
                                    if width > 0, abs(width - sidebarWidth) > 1 { sidebarWidth = width }
                                }
                        }
                    }
            } detail: {
                ZStack(alignment: .leading) {
                    ThreadView(chatId: sceneSession?.workbenchChatId ?? store.activeId)
                    if let layer = store.toolLayer {
                        ToolLayerOverlay(layer: layer)
                            .id(layer)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .animation(JieboMotion.panel(reduceMotion), value: store.toolLayer)
            }
            .navigationSplitViewStyle(.balanced)
            // 系统会在分栏顶上再放一个侧栏开关，和侧栏里、收起后图标栏里的是同一个动作
            .toolbar(removing: .sidebarToggle)
            // 预览盖满时，底下的侧栏和对话不再让 VoiceOver 摸到；分栏时两边都能摸
            .accessibilityHidden(previewOverlaid || previewFullscreen)
            if previewSplit, previewPanelOpen, !previewFullscreen {
                Color.clear
                    .frame(width: previewColumnWidth)
                    .frame(maxHeight: .infinity)
                    .accessibilityHidden(true)
            }
        }
        .allowsHitTesting(!previewFullscreen)
        if previewSplit, previewPanelOpen, let tab = activePreviewTab {
            PreviewPanelView(tab: tab, modal: previewFullscreen, canFullscreen: true)
                .frame(maxWidth: previewFullscreen ? .infinity : previewColumnWidth, maxHeight: .infinity)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
                .transition(.jieboPanel(from: .trailing, reduceMotion: reduceMotion))
        }
        }
        .animation(JieboMotion.panel(reduceMotion), value: previewPanelOpen && previewSplit)
        .animation(JieboMotion.panel(reduceMotion), value: previewFullscreen)
        .onChange(of: previewSplit) { _, split in
            if !split, previewFullscreen, !store.fileBrowserOpen {
                sceneSession?.setPreviewFullscreen(false)
            }
        }
        .background {
            GeometryReader { geo in
                Color.clear
                    .onAppear { workbenchWidth = geo.size.width }
                    .onChange(of: geo.size.width) { _, width in
                        if abs(width - workbenchWidth) > 1 { workbenchWidth = width }
                    }
            }
        }
        // 竖屏、窄窗放不下分栏：预览盖住侧栏和对话（与 PhoneWorkbench 同一写法）
        .overlay {
            ZStack {
                if previewOverlaid, let tab = activePreviewTab {
                    Color.black.opacity(0.28)
                        .ignoresSafeArea()
                        .onTapGesture { closePreview() }
                        .transition(.opacity)
                        .accessibilityHidden(true)
                    PreviewPanelView(tab: tab)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(JieboColor.white)
                        .transition(.jieboPanel(from: .trailing, reduceMotion: reduceMotion))
                        .zIndex(3)
                }
            }
            .animation(JieboMotion.panel(reduceMotion), value: previewPanelOpen)
        }
        .task {
            #if DEBUG
            guard ProcessInfo.processInfo.arguments.contains("--motion-demo") else { return }
            for _ in 0 ..< 40 {
                try? await Task.sleep(for: .milliseconds(250))
                if store.unlocked { break }
            }
            guard store.unlocked else { return }
            let home = store.activeId
            for mode in [AgentMode.agent, .plan, .ask, .agent] {
                withAnimation(JieboMotion.snappy(false)) {
                    store.chooseMode(mode)
                }
                try? await Task.sleep(for: .milliseconds(700))
            }
            if let other = store.currentWorkspaceChats.first(where: { $0.id != home })?.id {
                withAnimation(JieboMotion.fade(false)) {
                    store.select(other)
                }
                try? await Task.sleep(for: .milliseconds(800))
                withAnimation(JieboMotion.fade(false)) {
                    store.select(home)
                }
                try? await Task.sleep(for: .milliseconds(700))
            }
            // 收起/展开侧栏：触发分栏与图标栏宽度动画
            withAnimation(JieboMotion.panel(false)) {
                // 通过 toggle 工具层 Loop 的选中底淡入（不打开文件浮层）
                store.toggleTool(.loop)
            }
            try? await Task.sleep(for: .milliseconds(650))
            withAnimation(JieboMotion.panel(false)) {
                if store.toolLayer == .loop { store.toggleTool(.loop) }
            }
            try? await Task.sleep(for: .milliseconds(500))
            withAnimation(JieboMotion.snappy(false)) {
                store.chooseMode(.plan)
            }
            try? await Task.sleep(for: .milliseconds(600))
            withAnimation(JieboMotion.snappy(false)) {
                store.chooseMode(.agent)
            }
            #endif
        }
    }
}
struct CollapsedSidebarRail: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var expand: () -> Void
    @State private var settingsOpen = false

    var body: some View {
        VStack(spacing: 8) {
            railButton("sidebar.right", label: "展开侧栏", action: expand)
            ForEach(ToolLayer.workTools) { layer in
                railButton(
                    layer.symbol,
                    label: marked(layer) ? "\(layer.title)，\(StatusLegendId.running.label)" : layer.title,
                    marked: marked(layer),
                    on: store.toolSelected(layer)
                ) {
                    store.toggleTool(layer)
                }
            }
            Spacer()
            railButton(NavigationIconId.workspace.symbol, label: "切换文件夹", action: store.openWorkspaceSwitcher)
            if store.linkState == .offline {
                Button {
                    store.retryConnection()
                } label: {
                    LinkStatusDot(state: store.linkState, size: 8)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(store.linkState.title)
                .accessibilityHint("重新连接")
            } else {
                LinkStatusDot(state: store.linkState, size: 8)
                    .padding(.top, 4)
                    .accessibilityLabel("连接状态，\(store.linkState.title)")
            }
            railButton(NavigationIconId.account.symbol, label: "设置") { settingsOpen = true }
                .padding(.bottom, 12)
        }
        .padding(.top, 16)
        .frame(width: 56)
        .frame(maxHeight: .infinity)
        .background(JieboColor.sidebar)
        .sheet(isPresented: $settingsOpen) {
            NavigationStack {
                PhoneSettingsScreen()
                    .navigationDestination(for: PhoneRoute.self) { route in
                        PhoneSettingsDestination(route: route)
                    }
            }
        }
    }

    private var loopLive: Bool {
        guard let row = store.loops[store.activeId] else { return false }
        return row.status == "armed" || row.status == "running"
    }

    private func marked(_ layer: ToolLayer) -> Bool {
        layer == .loop && loopLive
    }

    private func railButton(
        _ symbol: String,
        label: String,
        badge: Int = 0,
        marked: Bool = false,
        on: Bool = false,
        tint: Color? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: symbol)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(on ? (tint ?? JieboColor.pine) : (tint ?? JieboColor.ink2))
                    .frame(width: 36, height: 36)
                    .background(on ? (tint ?? JieboColor.pine).opacity(0.12) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                            .stroke(on ? (tint ?? JieboColor.pine).opacity(0.42) : JieboColor.line, lineWidth: 1)
                    )
                    .overlay(alignment: .leading) {
                        if on {
                            Capsule()
                                .fill(tint ?? JieboColor.pine)
                                .frame(width: 3, height: 22)
                        }
                    }
                    .animation(JieboMotion.fade(reduceMotion), value: on)
                Circle()
                    .fill(JieboColor.run)
                    .frame(width: 6, height: 6)
                    .offset(x: badge > 0 ? -28 : 2, y: -2)
                    .opacity(marked ? 1 : 0)
                    .animation(JieboMotion.fade(reduceMotion), value: marked)
                if badge > 0 {
                    PendingBadge(count: badge)
                        .offset(x: 5, y: -5)
                }
            }
            .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(label)
        .accessibilityValue(on ? "当前" : "")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
struct ToolLayerOverlay: View {
    @Environment(ChatStore.self) private var store
    let layer: ToolLayer

    var body: some View {
        GeometryReader { geo in
            let narrow = geo.size.width < 600
            HStack(spacing: 0) {
                if !narrow {
                    Color.black.opacity(0.18)
                        .contentShape(Rectangle())
                        .onTapGesture { closeTopLayer() }
                }
                VStack(spacing: 0) {
                    HStack {
                        if narrow {
                            Button {
                                closeTopLayer()
                            } label: {
                                Label(store.contentPath == nil ? "对话" : layer.title, systemImage: "chevron.left")
                                    .font(JieboFont.text(.subheadline, weight: .medium))
                                    .foregroundStyle(JieboColor.ink)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(store.contentPath == nil ? "回到对话" : "返回")
                        }
                        Text(store.contentPath.map { ($0 as NSString).lastPathComponent } ?? (narrow ? "" : layer.title))
                            .font(JieboFont.text(.callout))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                        Spacer()
                        if store.contentDiff {
                            Button("保留") { store.keepContentDiff() }
                                .font(JieboFont.text(.subheadline, weight: .medium))
                                .foregroundStyle(JieboColor.ink)
                                .padding(.horizontal, 10)
                                .frame(minHeight: 44)
                                .background(Color.clear)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .stroke(JieboColor.line, lineWidth: 1)
                                )
                            Button("还原") { store.contentRevertPrompt = true }
                                .font(JieboFont.text(.subheadline, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                                .padding(.horizontal, 10)
                                .frame(minHeight: 44)
                                .background(Color.clear)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .stroke(JieboColor.line, lineWidth: 1)
                                )
                        } else if store.contentDirty {
                            Button("保存") { store.saveContentLayer() }
                                .font(JieboFont.text(.subheadline, weight: .medium))
                                .foregroundStyle(JieboColor.pine)
                        }
                        if !narrow {
                            Button {
                                closeTopLayer()
                            } label: {
                                Image(systemName: store.contentPath == nil ? "xmark" : "chevron.left")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(JieboColor.ink2)
                                    .frame(width: 32, height: 32)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(store.contentPath == nil ? "关闭" : "返回")
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    Divider()
                    // 滑层盖住对话后，ThreadView 上的横幅点不到。这里接上同一套动作。
                    if !store.connected || !store.bannerError.isEmpty || !store.notice.isEmpty {
                        layerStatus
                    }
                    layerBody
                }
                .frame(width: narrow ? geo.size.width : min(420, geo.size.width * 0.5))
                .frame(maxHeight: .infinity)
                .background(JieboColor.paper)
                .overlay(alignment: .leading) {
                    Rectangle().fill(JieboColor.line).frame(width: 1)
                }
            }
            .gesture(edgeDismiss)
        }
        .alert("放弃未保存的修改？", isPresented: Bindable(store).contentDiscardPrompt) {
            Button("放弃", role: .destructive) { store.confirmContentDiscard() }
            Button("继续编辑", role: .cancel) { store.cancelContentDiscard() }
        } message: {
            Text("这个文件里还有没保存的修改。")
        }
        .alert("还原这个文件？", isPresented: Bindable(store).contentRevertPrompt) {
            Button("还原", role: .destructive) { store.revertContentFile() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("未提交的改动会丢掉。")
        }
    }

    @ViewBuilder
    private var layerStatus: some View {
        VStack(spacing: 8) {
            if !store.connected {
                Button {
                    store.retryConnection()
                } label: {
                    Text(store.linkState.title)
                        .font(JieboFont.text(.caption, weight: .medium))
                        .foregroundStyle(JieboColor.danger)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 14)
                        .background(JieboColor.paper)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(store.linkState != .offline)
                .accessibilityHint(store.linkState == .offline ? "重新连接" : "")
            }
            if !store.bannerError.isEmpty {
                let message = friendlyError(store.bannerError)
                if store.bannerReconnects {
                    Button {
                        store.retryConnection()
                    } label: {
                        layerNotice(message, danger: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("重新连接")
                } else if store.bannerError == ChatStore.hydrationRetryTitle,
                          !store.hydrationRetryTurnId.isEmpty {
                    Button {
                        store.hydrateTurn(
                            chatId: store.hydrationRetryChatId,
                            turnId: store.hydrationRetryTurnId
                        )
                    } label: {
                        layerNotice(message, danger: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("再加载一次")
                } else {
                    Button {
                        store.dismissBannerError()
                    } label: {
                        layerNotice(message, danger: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("轻点关闭")
                }
            } else if store.notice == ChatStore.stallRecoveryNotice, let chatId = store.stallChatId {
                Button {
                    store.stop(chatId: chatId)
                    store.restoreLastPromptIfDraftEmpty(chatId: chatId)
                    store.notice = ""
                } label: {
                    layerNotice(store.notice, danger: false)
                }
                .buttonStyle(.plain)
                .accessibilityHint("停止这一轮，上一句回到输入框")
            } else if !store.notice.isEmpty {
                layerNotice(store.notice, danger: false)
                    .allowsHitTesting(false)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private func layerNotice(_ value: String, danger: Bool) -> some View {
        Text(value)
            .font(JieboFont.text(.footnote))
            .foregroundStyle(danger ? JieboColor.danger : JieboColor.ink)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(JieboColor.paper.opacity(0.92))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
    }

    private func closeTopLayer() {
        if store.contentPath != nil {
            store.closeContentLayer()
        } else {
            store.toolLayer = nil
            store.loopError = ""
        }
    }

    private var edgeDismiss: some Gesture {
        DragGesture(minimumDistance: 24, coordinateSpace: .local)
            .onEnded { value in
                guard value.startLocation.x < 28, value.translation.width > 70 else { return }
                closeTopLayer()
            }
    }

    @ViewBuilder
    private var layerBody: some View {
        switch layer {
        case .files, .search, .git:
            // 这三项由 ChatStore.toggleTool 转去全屏文件浏览器，不会落到工具滑层
            EmptyView()
        case .terminal:
            TerminalToolView()
        case .loop:
            LoopSheet()
        }
    }

    private func empty(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink)
            Text(body)
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.dim)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
    }
}
struct ContentLayerView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        Group {
            if store.contentDiff, store.contentKind == .image || store.contentKind == .svg,
               let path = store.contentPath,
               let tab = store.previewTabs.first(where: { $0.path == path }) {
                PreviewContentView(tab: tab)
            } else if store.contentDiff {
                diffText
            } else if store.contentKind == .text || store.contentKind == .markdown {
                textEditor
            } else if let path = store.contentPath, let tab = store.previewTabs.first(where: { $0.path == path }) {
                PreviewContentView(tab: tab)
            } else {
                missingPreviewBody
            }
        }
        .background(JieboColor.paper)
    }

    private var diffText: some View {
        VStack(alignment: .leading, spacing: 0) {
            if store.contentLoading {
                contentLoadingBody("正在读取改动…")
            } else if let error = store.contentError {
                VStack(spacing: 12) {
                    Text(error)
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.clay)
                        .multilineTextAlignment(.center)
                    if let path = store.contentPath {
                        Button("重试") { store.openContentDiff(path) }
                            .font(JieboFont.text(.footnote, weight: .medium))
                            .foregroundStyle(JieboColor.pine)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    Text(store.contentDraft.isEmpty ? "没有可显示的改动" : store.contentDraft)
                        .font(JieboFont.monoText(.caption))
                        .foregroundStyle(JieboColor.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(12)
                }
            }
        }
    }

    private var textEditor: some View {
        VStack(alignment: .leading, spacing: 0) {
            if store.contentLoading {
                contentLoadingBody("正在读取…")
            } else if let error = store.contentError, store.contentDraft == store.contentOriginal {
                VStack(spacing: 12) {
                    Text(error)
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.clay)
                        .multilineTextAlignment(.center)
                    if let path = store.contentPath {
                        Button("重试") { store.openContentFile(path) }
                            .font(JieboFont.text(.footnote, weight: .medium))
                            .foregroundStyle(JieboColor.pine)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.contentOversized {
                Text("超过 500KB，这里只能看，不能保存")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.clay)
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                ScrollView {
                    Text(store.contentDraft)
                        .font(JieboFont.monoText(.footnote))
                        .foregroundStyle(JieboColor.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(12)
                }
            } else {
                Text(store.contentDirty ? "未保存" : "已保存")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(store.contentDirty ? JieboColor.clay : JieboColor.dim)
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                TextEditor(text: Bindable(store).contentDraft)
                    .font(JieboFont.monoText(.footnote))
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 8)
            }
        }
    }

    /// 图片、网页这类内容靠预览页签。页签不在时不要无字转圈。
    @ViewBuilder
    private var missingPreviewBody: some View {
        if let blocked = store.contentReadBlockedTitle() {
            VStack(spacing: 12) {
                Text(blocked)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink)
                    .multilineTextAlignment(.center)
                if store.unlocked, store.linkState == .offline {
                    Button("重连") { store.retryConnection() }
                        .font(JieboFont.text(.footnote, weight: .medium))
                        .foregroundStyle(JieboColor.pine)
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = store.contentError {
            VStack(spacing: 12) {
                Text(error)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.clay)
                    .multilineTextAlignment(.center)
                if let path = store.contentPath {
                    Button("重试") { store.openContentFile(path) }
                        .font(JieboFont.text(.footnote, weight: .medium))
                        .foregroundStyle(JieboColor.pine)
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 12) {
                Text("这个预览还没打开。")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink)
                    .multilineTextAlignment(.center)
                if let path = store.contentPath {
                    Button("打开") { store.openContentFile(path) }
                        .font(JieboFont.text(.footnote, weight: .medium))
                        .foregroundStyle(JieboColor.pine)
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// 正文还在读。还没登录或没连上时不要写成正在读取。
    @ViewBuilder
    private func contentLoadingBody(_ title: String) -> some View {
        if let blocked = store.contentReadBlockedTitle() {
            VStack(spacing: 12) {
                Text(blocked)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink)
                    .multilineTextAlignment(.center)
                if store.unlocked, store.linkState == .offline {
                    Button("重连") { store.retryConnection() }
                        .font(JieboFont.text(.footnote, weight: .medium))
                        .foregroundStyle(JieboColor.pine)
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ProgressView(title)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
struct SearchToolView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool
    /// 在文件浮层里打开预览；不传则仍走内容层。
    var onOpen: ((String) -> Void)? = nil

    private var query: String {
        store.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField("搜文件名或内容", text: Bindable(store).searchQuery)
                .focused($focused)
                .textFieldStyle(.plain)
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(focused ? JieboColor.ink.opacity(0.28) : Color.clear)
                        .frame(height: focused ? 1.5 : 0)
                }
                .animation(JieboMotion.fade(reduceMotion), value: focused)
                .onChange(of: store.searchQuery) { _, _ in
                    store.scheduleSearch()
                }
            Divider()
            results
        }
        .onAppear { focused = true }
    }

    @ViewBuilder
    private var results: some View {
        if query.isEmpty {
            Text("搜文件名或内容")
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.dim)
                .padding(16)
            Spacer()
        } else if store.searchNameHits.isEmpty, store.searchHits.isEmpty {
            if store.searchLoading {
                ProgressView("正在搜索…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !store.searchContentNote.isEmpty {
                Text("文件名里没有「\(query)」。\(store.searchContentNote)")
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(JieboColor.dim)
                    .padding(16)
                Spacer()
            } else {
                Text("文件名和内容里都没有「\(query)」")
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(JieboColor.dim)
                    .padding(16)
                Spacer()
            }
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(store.searchNameHits, id: \.self) { path in
                        Button {
                            openHit(path)
                        } label: {
                            hitLabel(title: path, detail: "文件名")
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(Array(store.searchHits.enumerated()), id: \.offset) { _, hit in
                        Button {
                            openHit(hit.path)
                        } label: {
                            hitLabel(
                                title: hit.line > 0 ? "\(hit.path):\(hit.line)" : hit.path,
                                detail: hit.text
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    if store.searchTruncated, !store.searchLoading {
                        Text("结果太多，只显示前 \(store.searchHits.count) 条。换个更具体的关键词试试。")
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.dim)
                            .padding(16)
                    }
                    if !store.searchContentNote.isEmpty, !store.searchLoading {
                        Text(store.searchContentNote)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.dim)
                            .padding(16)
                    } else if store.searchLoading {
                        ProgressView("正在搜索内容…")
                            .padding(16)
                    }
                }
            }
        }
    }

    private func openHit(_ path: String) {
        if let onOpen {
            onOpen(path)
        } else {
            store.loadPreview(path, diff: false)
        }
    }

    private func hitLabel(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(JieboFont.text(.footnote, weight: .medium))
                .foregroundStyle(JieboColor.ink)
                .lineLimit(1)
            if !detail.isEmpty {
                Text(detail)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}
struct GitToolView: View {
    @Environment(ChatStore.self) private var store
    var onOpen: ((String) -> Void)? = nil

    private var paths: [String] { store.gitStatus.keys.sorted() }

    var body: some View {
        if paths.isEmpty {
            Text("没有未提交的改动")
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.dim)
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(paths, id: \.self) { path in
                        Button {
                            if let onOpen {
                                onOpen(path)
                            } else {
                                store.loadPreview(path, diff: true)
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Text(store.gitStatus[path] ?? "")
                                    .font(JieboFont.text(.caption, weight: .semibold))
                                    .foregroundStyle(JieboColor.brass)
                                    .frame(minWidth: 18)
                                Text(path)
                                    .font(JieboFont.text(.footnote))
                                    .foregroundStyle(JieboColor.ink)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}
struct TerminalToolView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        let rows = store.shellEntries
        if rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("这个会话还没有 shell 输出")
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(JieboColor.ink)
                Text("让 Agent 跑一条命令，输出会出现在这里。")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
                Spacer()
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(rows) { row in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("$ \(row.command)")
                                    .font(JieboFont.monoText(.footnote))
                                    .foregroundStyle(JieboColor.ink)
                                Text(row.output.isEmpty ? (row.running ? "正在跑…" : "没有输出") : row.output)
                                    .font(JieboFont.monoText(.caption))
                                    .foregroundStyle(row.output.isEmpty ? JieboColor.dim : JieboColor.ink2)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.horizontal, 14)
                            .id(row.id)
                        }
                    }
                    .padding(.vertical, 12)
                }
                .onAppear {
                    scrollTerminal(proxy, rows: rows)
                }
                .onChange(of: store.terminalFocusCallId) { _, _ in
                    scrollTerminal(proxy, rows: rows)
                }
                .onChange(of: rows.last?.output) { _, _ in
                    if let id = rows.last?.id {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private func scrollTerminal(_ proxy: ScrollViewProxy, rows: [ShellEntry]) {
        let id = store.terminalFocusCallId.isEmpty ? rows.last?.id : store.terminalFocusCallId
        if let id {
            proxy.scrollTo(id, anchor: .center)
        }
    }
}
