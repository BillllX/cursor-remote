import SwiftUI
import UIKit

struct RootView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        Group {
            if store.unlocked {
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
    /// P6：预览面板宽度（左缘拖拽可调，320 ~ 90% 窗口宽）
    @State private var panelWidth: CGFloat = 540
    @GestureState private var panelDrag: CGFloat = 0
    @State private var columnVisibility = NavigationSplitViewVisibility.all

    var body: some View {
        @Bindable var store = store
        HStack(spacing: 0) {
            if columnVisibility == .detailOnly {
                CollapsedSidebarRail(expand: { columnVisibility = .all })
            }
            NavigationSplitView(columnVisibility: $columnVisibility) {
                SidebarView(collapse: { columnVisibility = .detailOnly })
                    .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 380)
            } detail: {
                ZStack(alignment: .leading) {
                    ThreadView()
                    if let layer = store.toolLayer {
                        ToolLayerOverlay(layer: layer)
                    }
                }
            }
            .navigationSplitViewStyle(.balanced)
        }
        .background(JieboColor.paper)
        // P7a：文件浏览器 cover 挂在工作台根（NSV 之外）——从侧栏列弹 fullScreenCover 会继承
        // 侧栏的 compact sizeClass，双栏永远出不来；QL sheet 同理盖在 cover 之上
        .fullScreenCover(isPresented: $store.fileBrowserOpen) {
            FileBrowserCover()
        }
        #if DEBUG
        // UI 冒烟钩子：simctl launch ... --open-file-browser 直接打开文件浏览器（截图验证用）
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--open-file-browser") {
                store.fileBrowserOpen = true
            }
        }
        #endif
        // P5 预览面板：右侧 overlay，点外部收起。P6 从 ThreadView 上移到这里——
        // 遮罩盖住侧栏 + detail，面板从整个工作台右缘滑出，不再把对话列挤断。
        // ZStack 常驻、两个孩子各挂 transition——插入/删除的是谁，transition 就得挂在谁身上
        .overlay(alignment: .trailing) {
            GeometryReader { geo in
                ZStack(alignment: .trailing) {
                    if store.previewPanelOpen {
                        Color.black.opacity(0.3)
                            .ignoresSafeArea()
                            .onTapGesture { store.dismissPreviewPanel() }
                            .transition(.opacity)
                    }
                    if let tab = store.activePreviewTab {
                        PreviewPanelView(tab: tab)
                            // 始终留 10% 外部点击带（极窄 Stage Manager 窗口也不顶满）
                            .frame(width: clampedWidth(geo))
                            .transition(.move(edge: .trailing))
                            .overlay(alignment: .leading) { dragHandle(geo) }
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: store.previewPanelOpen)
            }
            // 面板关着时整个 overlay 不吞手势（常驻 GeometryReader 盖着侧栏+detail）
            .allowsHitTesting(store.previewPanelOpen)
        }
    }

    private func clampedWidth(_ geo: GeometryProxy) -> CGFloat {
        let maxW = geo.size.width * 0.9
        // 极窄窗口（maxW < 320）时下限自动让位，保证 10% 点击带还在
        return min(max(panelWidth - panelDrag, min(320, maxW)), maxW)
    }

    /// 面板左缘的拖拽手柄：16pt 隐形热区（半移到面板外，不压内容左缘）+ 3pt 抓柄指示
    private func dragHandle(_ geo: GeometryProxy) -> some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(JieboColor.line)
            .frame(width: 3, height: 36)
            .frame(width: 16, height: 160, alignment: .leading)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 2)
                    .updating($panelDrag) { value, state, _ in state = value.translation.width }
                    .onEnded { value in
                        let maxW = geo.size.width * 0.9
                        panelWidth = min(max(panelWidth - value.translation.width, min(320, maxW)), maxW)
                    }
            )
            .frame(maxHeight: .infinity, alignment: .center)
            .offset(x: -8) // 热区半移出面板，避免盖住内容左缘（代码行号列）的滚动/选择起点
            .accessibilityLabel("拖拽调整预览面板宽度")
            .accessibilityAdjustableAction { direction in
                let maxW = geo.size.width * 0.9
                switch direction {
                case .increment: panelWidth = min(panelWidth + 40, maxW)
                case .decrement: panelWidth = max(panelWidth - 40, min(320, maxW))
                @unknown default: break
                }
            }
    }
}

struct CollapsedSidebarRail: View {
    @Environment(ChatStore.self) private var store
    var expand: () -> Void
    @State private var adminOpen = false

    var body: some View {
        VStack(spacing: 8) {
            railButton("sidebar.right", label: "展开侧栏", action: expand)
            ForEach(ToolLayer.allCases) { layer in
                railButton(layer.symbol, label: layer.title, marked: layer == .loop && loopLive, on: store.toolLayer == layer) {
                    store.toggleTool(layer)
                }
            }
            Spacer()
            if store.isAdmin {
                railButton("chart.bar", label: "统计") { adminOpen = true }
            }
            Circle()
                .fill(store.connected ? JieboColor.ok : JieboColor.clay)
                .frame(width: 8, height: 8)
                .padding(.bottom, 12)
        }
        .padding(.top, 16)
        .frame(width: 56)
        .frame(maxHeight: .infinity)
        .background(JieboColor.sidebar)
        .sheet(isPresented: $adminOpen) {
            AdminStatsView()
        }
    }

    private var loopLive: Bool {
        guard let row = store.loops[store.activeId] else { return false }
        return row.status == "armed" || row.status == "running"
    }

    private func railButton(_ symbol: String, label: String, marked: Bool = false, on: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: symbol)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(on ? JieboColor.paper : JieboColor.ink)
                    .frame(width: 36, height: 36)
                    .background(on ? JieboColor.pine : JieboColor.mist)
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                if marked {
                    Circle()
                        .fill(JieboColor.pine)
                        .frame(width: 6, height: 6)
                        .offset(x: 2, y: -2)
                }
            }
            .hitTarget()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

struct ToolLayerOverlay: View {
    @Environment(ChatStore.self) private var store
    let layer: ToolLayer

    var body: some View {
        GeometryReader { geo in
            let narrow = geo.size.width < 600
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    HStack {
                        Text(store.contentPath.map { ($0 as NSString).lastPathComponent } ?? layer.title)
                            .font(JieboFont.ui(16))
                            .foregroundStyle(JieboColor.ink)
                        Spacer()
                        if store.contentDiff {
                            Button("保留") { store.keepContentDiff() }
                                .font(JieboFont.ui(14, weight: .medium))
                                .foregroundStyle(JieboColor.pine)
                            Button("还原") { store.contentRevertPrompt = true }
                                .font(JieboFont.ui(14, weight: .medium))
                                .foregroundStyle(JieboColor.clay)
                        } else if store.contentDirty {
                            Button("保存") { store.saveContentLayer() }
                                .font(JieboFont.ui(14, weight: .medium))
                                .foregroundStyle(JieboColor.pine)
                        }
                        Button {
                            if store.contentPath != nil {
                                store.closeContentLayer()
                            } else {
                                store.toolLayer = nil
                                store.loopError = ""
                            }
                        } label: {
                            Image(systemName: store.contentPath == nil ? "xmark" : "chevron.left")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(JieboColor.ink2)
                                .frame(width: 32, height: 32)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(store.contentPath == nil ? "关闭" : "返回")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    Divider()
                    if !store.notice.isEmpty {
                        Text(store.notice)
                            .font(JieboFont.ui(13))
                            .foregroundStyle(JieboColor.ink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(JieboColor.mist)
                    }
                    ZStack {
                        layerBody
                        if store.contentPath != nil {
                            ContentLayerView()
                        }
                    }
                }
                .frame(width: narrow ? geo.size.width : min(420, geo.size.width * 0.5))
                .frame(maxHeight: .infinity)
                .background(JieboColor.paper)
                if !narrow {
                    Color.black.opacity(0.18)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if store.contentPath != nil {
                                store.closeContentLayer()
                            } else {
                                store.toolLayer = nil
                                store.loopError = ""
                            }
                        }
                }
            }
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
    @FocusState private var focused: Bool

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
                            store.openContentFile(path)
                        } label: {
                            hitLabel(title: path, detail: "文件名")
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(Array(store.searchHits.enumerated()), id: \.offset) { _, hit in
                        Button {
                            store.openContentFile(hit.path)
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
                            store.openContentDiff(path)
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
