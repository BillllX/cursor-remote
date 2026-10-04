import SwiftUI
import UIKit

struct RootView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        Group {
            if store.unlocked || store.resumingLogin {
                WorkbenchView()
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
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var columnVisibility = NavigationSplitViewVisibility.all

    var body: some View {
        Group {
            if UIDevice.current.userInterfaceIdiom == .phone {
                // iPhone：纯个人助理（见 docs/iphone-assistant-first.md）
                PhoneShell()
            } else if sizeClass == .compact {
                PhoneWorkbench() // iPad 窄窗保持原样
            } else {
                padWorkbench
            }
        }
        .background(JieboColor.paper)
        .fullScreenCover(isPresented: Bindable(store).fileBrowserOpen) {
            FileBrowserCover()
        }
        #if DEBUG
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--open-file-browser") {
                store.fileBrowserOpen = true
            }
        }
        #endif
    }

    @ViewBuilder
    private var padWorkbench: some View {
        @Bindable var store = store
        HStack(spacing: 0) {
            // 图标栏一直挂着，只改宽度。收起时不必等分栏动画结束再创建，图标就不会晚一拍才出现。
            CollapsedSidebarRail(expand: {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) {
                    columnVisibility = .all
                }
            })
            .frame(width: columnVisibility == .detailOnly ? 56 : 0)
            .clipped()
            .allowsHitTesting(columnVisibility == .detailOnly)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: columnVisibility == .detailOnly)
            NavigationSplitView(columnVisibility: $columnVisibility) {
                SidebarView(collapse: {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) {
                        columnVisibility = .detailOnly
                    }
                })
                    .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 380)
            } detail: {
                ZStack(alignment: .leading) {
                    ThreadView()
                    if let layer = store.toolLayer {
                        ToolLayerOverlay(layer: layer)
                            .id(layer)
                            .transition(.move(edge: .leading).combined(with: .opacity))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .animation(JieboMotion.panel(reduceMotion), value: store.toolLayer)
            }
            .navigationSplitViewStyle(.balanced)
            // 系统会在分栏顶上再放一个侧栏开关，和侧栏里、收起后图标栏里的是同一个动作
            .toolbar(removing: .sidebarToggle)
        }
        // 预览层盖满时，底下的侧栏和对话不再让 VoiceOver 摸到
        .accessibilityHidden(store.previewPanelOpen)
        // 预览盖住侧栏和对话（与 PhoneWorkbench 同一写法），不再占右侧一栏
        .overlay {
            ZStack {
                if store.previewPanelOpen, let tab = store.activePreviewTab {
                    Color.black.opacity(0.28)
                        .ignoresSafeArea()
                        .onTapGesture { store.collapsePreview() }
                        .transition(.opacity)
                        .accessibilityHidden(true)
                    PreviewPanelView(tab: tab)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(JieboColor.white)
                        .transition(.move(edge: .trailing))
                        .zIndex(3)
                }
            }
            .animation(JieboMotion.panel(reduceMotion), value: store.previewPanelOpen)
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
            withAnimation(.easeOut(duration: 0.22)) {
                // 通过 toggle 工具层 Loop 的选中底淡入（不打开文件浮层）
                store.toggleTool(.loop)
            }
            try? await Task.sleep(for: .milliseconds(650))
            withAnimation(.easeOut(duration: 0.22)) {
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
    @State private var adminOpen = false
    @State private var themeOpen = false

    var body: some View {
        VStack(spacing: 8) {
            railButton("sidebar.right", label: "展开侧栏", action: expand)
            railButton(
                ToolLayer.assistant.symbol,
                label: store.assistantBadgeCount > 0 ? "\(store.assistantName)，\(store.assistantBadgeCount) 条待处理" : store.assistantName,
                marked: store.assistantBadgeCount > 0,
                on: store.assistantChatActive || store.toolLayer == .assistant,
                tint: JieboColor.pine,
                action: store.toggleAssistantRail
            )
            Rectangle()
                .fill(JieboColor.line)
                .frame(width: 24, height: 1)
                .padding(.vertical, 4)
            ForEach(ToolLayer.workTools) { layer in
                railButton(layer.symbol, label: layer.title, marked: marked(layer), on: store.toolSelected(layer)) {
                    store.toggleTool(layer)
                }
            }
            Spacer()
            railButton("square.stack.3d.up", label: "切换工作区", action: store.openWorkspaceSwitcher)
            railButton("paintpalette", label: "主题") { themeOpen = true }
            if store.isAdmin {
                railButton("chart.bar", label: "查看使用统计") { adminOpen = true }
            }
            ConnectionDot(connected: store.connected)
                .padding(.top, 4)
            railButton("rectangle.portrait.and.arrow.right", label: "退出登录", action: store.logout)
                .padding(.bottom, 12)
        }
        .padding(.top, 16)
        .frame(width: 56)
        .frame(maxHeight: .infinity)
        .background(JieboColor.sidebar)
        .sheet(isPresented: $adminOpen) {
            AdminStatsView()
        }
        .sheet(isPresented: $themeOpen) {
            ThemeSettingsSheet()
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
        marked: Bool = false,
        on: Bool = false,
        tint: Color? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: symbol)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(on ? JieboColor.ink : (tint ?? JieboColor.ink2))
                    .frame(width: 36, height: 36)
                    .background(on ? JieboColor.ink.opacity(0.06) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    )
                    .overlay(alignment: .leading) {
                        if on {
                            Rectangle()
                                .fill(JieboColor.ink)
                                .frame(width: 2)
                        }
                    }
                    .animation(JieboMotion.fade(reduceMotion), value: on)
                Circle()
                    .fill(JieboColor.pine)
                    .frame(width: 6, height: 6)
                    .offset(x: 2, y: -2)
                    .opacity(marked ? 1 : 0)
                    .animation(JieboMotion.fade(reduceMotion), value: marked)
            }
            .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(label)
    }
}

struct ToolLayerOverlay: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let layer: ToolLayer

    var body: some View {
        GeometryReader { geo in
            let narrow = geo.size.width < 600
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    HStack {
                        if narrow {
                            Button {
                                closeTopLayer()
                            } label: {
                                Label(store.contentPath == nil ? "对话" : layer.title, systemImage: "chevron.left")
                                    .font(JieboFont.ui(15, weight: .medium))
                                    .foregroundStyle(JieboColor.ink)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(store.contentPath == nil ? "回到对话" : "返回")
                        }
                        Text(store.contentPath.map { ($0 as NSString).lastPathComponent } ?? (narrow ? "" : layer.title))
                            .font(JieboFont.ui(16))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                        Spacer()
                        if store.contentDiff {
                            Button("保留") { store.keepContentDiff() }
                                .font(JieboFont.ui(14, weight: .medium))
                                .foregroundStyle(JieboColor.ink)
                                .padding(.horizontal, 10)
                                .frame(height: 28)
                                .background(Color.clear)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .stroke(JieboColor.line, lineWidth: 1)
                                )
                            Button("还原") { store.contentRevertPrompt = true }
                                .font(JieboFont.ui(14, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                                .padding(.horizontal, 10)
                                .frame(height: 28)
                                .background(Color.clear)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .stroke(JieboColor.line, lineWidth: 1)
                                )
                        } else if store.contentDirty {
                            Button("保存") { store.saveContentLayer() }
                                .font(JieboFont.ui(14, weight: .medium))
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
                    if !store.notice.isEmpty {
                        Text(store.notice)
                            .font(JieboFont.ui(13))
                            .foregroundStyle(JieboColor.dim)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(Color.clear)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .stroke(JieboColor.line, lineWidth: 1)
                            )
                    }
                    ZStack {
                        layerBody
                        if store.contentPath != nil {
                            ContentLayerView()
                                .transition(.move(edge: .trailing).combined(with: .opacity))
                        }
                    }
                    .animation(JieboMotion.panel(reduceMotion), value: store.contentPath != nil)
                }
                .frame(width: narrow ? geo.size.width : min(420, geo.size.width * 0.5))
                .frame(maxHeight: .infinity)
                .background(JieboColor.paper)
                .overlay(alignment: .leading) {
                    Rectangle().fill(JieboColor.line).frame(width: 1)
                }
                if !narrow {
                    Color.black.opacity(0.18)
                        .contentShape(Rectangle())
                        .onTapGesture { closeTopLayer() }
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
        case .files:
            FileTreeView(
                paths: store.fileIndex,
                truncated: store.treeTruncated,
                filter: "",
                selectedPath: store.contentPath ?? store.previewActivePath,
                onOpen: { store.openContentFile($0) },
                onPick: { store.appendMentionToDraft($0) },
                onCopyPath: { UIPasteboard.general.string = $0 },
                onQuickLook: { store.openMention($0) }
            )
        case .search:
            SearchToolView()
        case .git:
            GitToolView()
        case .terminal:
            TerminalToolView()
        case .loop:
            LoopSheet()
        case .assistant:
            AssistantView()
        }
    }

    private func empty(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(JieboFont.ui(15))
                .foregroundStyle(JieboColor.ink)
            Text(body)
                .font(JieboFont.ui(13))
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
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(JieboColor.paper)
    }

    private var diffText: some View {
        VStack(alignment: .leading, spacing: 0) {
            if store.contentLoading {
                ProgressView("正在读取改动…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = store.contentError {
                Text(error)
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.clay)
                    .padding(16)
                Spacer()
            } else {
                ScrollView {
                    Text(store.contentDraft.isEmpty ? "没有可显示的改动" : store.contentDraft)
                        .font(.system(size: 12, design: .monospaced))
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
                ProgressView("正在读取…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = store.contentError, store.contentDraft == store.contentOriginal {
                VStack(spacing: 12) {
                    Text(error)
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.clay)
                        .multilineTextAlignment(.center)
                    if let path = store.contentPath {
                        Button("重试") { store.openContentFile(path) }
                            .font(JieboFont.ui(13, weight: .medium))
                            .foregroundStyle(JieboColor.pine)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.contentOversized {
                Text("超过 500KB，这里只能看，不能保存")
                    .font(JieboFont.ui(12))
                    .foregroundStyle(JieboColor.clay)
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                ScrollView {
                    Text(store.contentDraft)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(JieboColor.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(12)
                }
            } else {
                Text(store.contentDirty ? "未保存" : "已保存")
                    .font(JieboFont.ui(12))
                    .foregroundStyle(store.contentDirty ? JieboColor.clay : JieboColor.dim)
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                TextEditor(text: Bindable(store).contentDraft)
                    .font(.system(size: 13, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 8)
            }
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
                .font(JieboFont.ui(15))
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
                .font(JieboFont.ui(14))
                .foregroundStyle(JieboColor.dim)
                .padding(16)
            Spacer()
        } else if store.searchNameHits.isEmpty, store.searchHits.isEmpty {
            if store.searchLoading {
                ProgressView("正在搜索…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Text("文件名和内容里都没有「\(query)」")
                    .font(JieboFont.ui(14))
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
                    if store.searchLoading {
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
            store.openContentFile(path)
        }
    }

    private func hitLabel(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(JieboFont.ui(13, weight: .medium))
                .foregroundStyle(JieboColor.ink)
                .lineLimit(1)
            if !detail.isEmpty {
                Text(detail)
                    .font(JieboFont.ui(12))
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
            Text("工作区干净")
                .font(JieboFont.ui(14))
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
                                store.openContentDiff(path)
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Text(store.gitStatus[path] ?? "")
                                    .font(JieboFont.ui(12, weight: .semibold))
                                    .foregroundStyle(JieboColor.brass)
                                    .frame(width: 18)
                                Text(path)
                                    .font(JieboFont.ui(13))
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
                    .font(JieboFont.ui(15))
                    .foregroundStyle(JieboColor.ink)
                Text("让 Agent 跑一条命令，输出会出现在这里。")
                    .font(JieboFont.ui(13))
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
                                    .font(JieboFont.ui(13, weight: .medium))
                                    .foregroundStyle(JieboColor.ink)
                                Text(row.output.isEmpty ? (row.running ? "正在跑…" : "没有输出") : row.output)
                                    .font(.system(size: 12, design: .monospaced))
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
                .onChange(of: rows.last?.output) { _, _ in
                    if let id = rows.last?.id {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
            }
        }
    }
}
