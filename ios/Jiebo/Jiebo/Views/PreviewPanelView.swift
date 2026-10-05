import SwiftUI
import UIKit

/// P5 预览面板本体（页签条 + 头部 + 内容）。
/// P6 起遮罩与滑入动画由 WorkbenchView（RootView）的 overlay 持有——transition 必须挂在被插入/删除的那一层上。
struct PreviewPanelView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let tab: PreviewTab
    /// 窄屏左缘右滑关闭时的位移
    @State private var dragX: CGFloat = 0

    private var compact: Bool { sizeClass == .compact }

    var body: some View {
        VStack(spacing: 0) {
            if compact {
                compactHeader
                if store.previewTabs.count > 1 {
                    Divider().overlay(JieboColor.line)
                    tabStrip
                }
            } else {
                tabStrip
                Divider().overlay(JieboColor.line)
                header
            }
            Divider().overlay(JieboColor.line)
            PreviewContentView(tab: tab)
        }
        .frame(maxHeight: .infinity)
        .background(JieboColor.white)
        .overlay(alignment: .leading) {
            Rectangle().fill(JieboColor.line).frame(width: 1)
        }
        .offset(x: dragX)
        .overlay(alignment: .leading) {
            // 窄屏：左缘一条 20pt 的手势带，和系统导航返回同一手势。只在这条带上识别，不和内容里的横向滚动抢
            if compact {
                Color.clear
                    .frame(width: 20)
                    .contentShape(Rectangle())
                    .gesture(edgeSwipe)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { store.collapsePreview() }
        .background { keyboardShortcuts }
    }

    /// 外接键盘：Esc / ⌘W 收起预览，⌘⇧[ / ⌘⇧] 切页签。按钮不可见，只为挂快捷键
    private var keyboardShortcuts: some View {
        Group {
            Button("收起预览") { store.collapsePreview() }
                .keyboardShortcut(.escape, modifiers: [])
            Button("关闭预览") { store.collapsePreview() }
                .keyboardShortcut("w", modifiers: .command)
            Button("上一个页签") { stepTab(-1) }
                .keyboardShortcut("[", modifiers: [.command, .shift])
            Button("下一个页签") { stepTab(1) }
                .keyboardShortcut("]", modifiers: [.command, .shift])
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    private func stepTab(_ delta: Int) {
        let tabs = store.previewTabs
        guard tabs.count > 1, let index = tabs.firstIndex(where: { $0.path == tab.path }) else { return }
        let next = (index + delta + tabs.count) % tabs.count
        store.selectPreviewTab(tabs[next].path)
    }

    /// 横向为主才跟手；拖过 120 或甩出去就关——不先归位，直接从当前位置滑出
    private var edgeSwipe: some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .onChanged { value in
                let dx = value.translation.width
                // 已经跟手后不再看方向，往回拉到 0 为止
                guard dragX > 0 || (dx > 0 && abs(dx) > abs(value.translation.height)) else { return }
                dragX = max(0, dx)
            }
            .onEnded { value in
                let dx = value.translation.width
                let horizontal = abs(dx) > abs(value.translation.height)
                if horizontal, dx > 120 || value.predictedEndTranslation.width > 260 {
                    store.collapsePreview()
                } else {
                    withAnimation(JieboMotion.snappy(reduceMotion)) { dragX = 0 }
                }
            }
    }

    // MARK: 窄屏头部：返回 · 文件名 · 分享 · 更多

    private var compactHeader: some View {
        HStack(spacing: 4) {
            Button {
                store.collapsePreview()
            } label: {
                Image(systemName: "chevron.backward")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(JieboColor.pine)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("返回对话")
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(tab.filename)
                        .font(JieboFont.text(.headline))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if tab.diff {
                        Text("改动")
                            .font(JieboFont.text(.caption2, weight: .bold))
                            .foregroundStyle(JieboColor.brass)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(JieboColor.brass.opacity(0.12))
                            .clipShape(Capsule())
                    }
                }
                compactSubtitle
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button {
                store.exportPreview(path: tab.path, content: tab.content, isDiff: tab.diff, chatId: tab.chatId)
            } label: {
                Group {
                    if store.exportLoading {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 17, weight: .regular))
                            .foregroundStyle(JieboColor.pine)
                    }
                }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(store.exportLoading || (tab.content == nil && tab.mediaURL == nil))
            .accessibilityLabel("分享 \(tab.filename)")
            moreMenu
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var compactSubtitle: some View {
        if tab.readSha != nil {
            Text("这一轮的版本")
                .font(JieboFont.text(.caption, weight: .medium))
                .foregroundStyle(JieboColor.run)
        } else {
            Text(headerSubtitle)
                .font(JieboFont.monoText(.caption2))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private var canToggleDiff: Bool {
        tab.kind == .text || tab.kind == .markdown || tab.kind == .html || tab.kind == .image || tab.kind == .svg
    }

    private var moreMenu: some View {
        Menu {
            if canToggleDiff {
                Toggle(isOn: Binding(get: { tab.diff }, set: { on in
                    if on != tab.diff { store.togglePreviewDiff(tab.path) }
                })) {
                    Label("查看改动", systemImage: "plus.forwardslash.minus")
                }
            }
            if tab.kind == .canvas, GatewayConfig.canvasRuntimeURL != nil {
                Toggle(isOn: Binding(get: { tab.showSource }, set: { on in
                    if on != tab.showSource { store.toggleCanvasSource(tab.path) }
                })) {
                    Label("查看源码", systemImage: "chevron.left.forwardslash.chevron.right")
                }
            }
            if tab.readSha != nil {
                Button { store.showCurrentVersion(tab.path) } label: {
                    Label("看当前版本", systemImage: "clock.arrow.circlepath")
                }
            }
            Section {
                if tab.kind == .image, !tab.diff {
                    Button { store.saveImageToPhotos(path: tab.path, chatId: tab.chatId) } label: {
                        Label("存到相册", systemImage: "square.and.arrow.down")
                    }
                    .disabled(store.exportLoading)
                }
                if let content = tab.content {
                    Button {
                        UIPasteboard.general.string = content
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    } label: {
                        Label(tab.diff ? "复制改动" : "复制全部内容", systemImage: "doc.on.doc")
                    }
                }
                Button { UIPasteboard.general.string = headerSubtitle } label: {
                    Label("复制路径", systemImage: "link")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(JieboColor.pine)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("更多操作")
    }

    // MARK: 页签条

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(store.previewTabs) { item in
                    tabChip(item)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 2)
        }
        .background(JieboColor.well)
    }

    /// 页签：文件名与 × 拆成两个独立 Button（容器挂 onTapGesture 会和 × 抢手势）
    private func tabChip(_ item: PreviewTab) -> some View {
        let isActive = item.path == store.previewActivePath
        return HStack(spacing: 0) {
            Button {
                store.selectPreviewTab(item.path)
            } label: {
                HStack(spacing: 6) {
                    if item.diff {
                        Image(systemName: "plus.forwardslash.minus")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(JieboColor.brass)
                    }
                    Text(item.filename)
                        .font(JieboFont.text(.caption, weight: .medium))
                        .foregroundStyle(isActive ? JieboColor.ink : JieboColor.ink2)
                        .lineLimit(1)
                }
                .padding(.leading, 10)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
                .hoverEffect(.highlight)
            }
            .buttonStyle(.plain)
            .draggableMention(item.path)
            .accessibilityLabel(item.filename)
            .accessibilityAddTraits(isActive ? [.isSelected, .isButton] : .isButton)
            Button {
                store.closePreviewTab(item.path)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭 \(item.filename)")
        }
        .background(
            RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                .fill(isActive ? JieboColor.white : Color.clear)
                .padding(.vertical, 6)
        )
    }

    // MARK: 头部

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(tab.filename)
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                    if tab.diff {
                        Text("DIFF")
                            .font(JieboFont.text(.caption2, weight: .bold))
                            .foregroundStyle(JieboColor.brass)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(JieboColor.brass.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                }
                // P6：副标题给工作区绝对路径（中段截断）——path==filename 时不再三遍重复同一文件名；
                // cwd 用页签打开时的快照（页签全局存活，store.cwd 随活跃会话变）
                Text(headerSubtitle)
                    .font(JieboFont.monoText(.caption2))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(1)
                    .truncationMode(.middle)
                versionLine
            }
            Spacer()
            // diff/原文 切换（对齐网页的类型集：text/image/svg/markdown/html）。
            // 图标固定、当前态高亮（对齐网页 IconDiff + active.diff 高亮），不做「目标态图标」
            if tab.kind == .text || tab.kind == .markdown || tab.kind == .html || tab.kind == .image || tab.kind == .svg {
                Button {
                    store.togglePreviewDiff(tab.path)
                } label: {
                    Image(systemName: "plus.forwardslash.minus")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(tab.diff ? JieboColor.ink : JieboColor.ink2)
                        .frame(width: 30, height: 30)
                        .background(tab.diff ? JieboColor.ink.opacity(0.06) : Color.clear)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(JieboColor.line, lineWidth: 1))
                        .hitTarget() // P6：视觉 30，命中 44
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.diff ? "查看原文" : "查看改动")
            }
            // canvas 的 源码/画布 切换（P5d；对齐网页 live 开关，图标固定、当前态高亮）。
            // 无运行时（本地 dev 降级源码）时隐藏——否则按钮点了视图不变
            if tab.kind == .canvas, GatewayConfig.canvasRuntimeURL != nil {
                Button {
                    store.toggleCanvasSource(tab.path)
                } label: {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(tab.showSource ? JieboColor.ink : JieboColor.ink2)
                        .frame(width: 30, height: 30)
                        .background(tab.showSource ? JieboColor.ink.opacity(0.06) : Color.clear)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(JieboColor.line, lineWidth: 1))
                        .hitTarget()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.showSource ? "查看画布" : "查看源码")
            }
            // P10：图片一键存相册（diff 对照态不给——diff 视图不是单张可存的图）
            if tab.kind == .image, !tab.diff {
                Button {
                    store.saveImageToPhotos(path: tab.path, chatId: tab.chatId)
                } label: {
                    Image(systemName: "square.and.arrow.down.on.square")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(width: 30, height: 30)
                        .background(JieboColor.mist)
                        .clipShape(Circle())
                        .hitTarget()
                }
                .buttonStyle(.plain)
                .disabled(store.exportLoading) // 与分享按钮同一互斥位（GLM R1 M2）
                .accessibilityLabel("保存 \(tab.filename) 到相册")
            }
            // P10：全类型分享（文本用内联 content 写 temp，媒体/大文件走 /media 下载）——
            // 系统分享 sheet 覆盖存文件/存相册/隔空投送；替代原媒体类的 Quick Look 逃生门
            //（QL 全屏预览仍可从文件树长按菜单进）
            Button {
                store.exportPreview(path: tab.path, content: tab.content, isDiff: tab.diff, chatId: tab.chatId)
            } label: {
                Group {
                    if store.exportLoading {
                        ProgressView().controlSize(.small).tint(JieboColor.dim)
                    } else {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                    }
                }
                .frame(width: 30, height: 30)
                .background(JieboColor.mist)
                .clipShape(Circle())
                .hitTarget()
            }
            .buttonStyle(.plain)
            .disabled(store.exportLoading || (tab.content == nil && tab.mediaURL == nil))
            .accessibilityLabel("分享 \(tab.filename)")
            if tab.content != nil {
                Button {
                    UIPasteboard.general.string = tab.content
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(width: 30, height: 30)
                        .background(JieboColor.mist)
                        .clipShape(Circle())
                        .hitTarget()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.diff ? "复制 diff" : "复制全部内容")
            }
            Button {
                store.collapsePreview()
            } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(width: 30, height: 30)
                    .background(JieboColor.mist)
                    .clipShape(Circle())
                    .hitTarget()
            }
            .buttonStyle(.plain)
            .accessibilityLabel("收起预览")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    /// 头部副标题：绝对路径（cwd 快照拼接，尾斜杠/已是绝对路径都兜底）
    /// 卡片打开的页签标出看的是哪个版本；diff 态按 diffSha 算（没有 diffSha 时对照是实时的）
    @ViewBuilder
    private var versionLine: some View {
        if tab.readSha != nil {
            HStack(spacing: 8) {
                Text("这一轮的版本")
                    .font(JieboFont.text(.caption2, weight: .medium))
                    .foregroundStyle(JieboColor.run)
                Button("看当前版本") { store.showCurrentVersion(tab.path) }
                    .buttonStyle(.plain)
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.pine)
            }
        } else if tab.fromCard {
            Text("当前版本")
                .font(JieboFont.text(.caption2, weight: .medium))
                .foregroundStyle(JieboColor.dim)
        }
    }

    private var headerSubtitle: String {
        if tab.path.hasPrefix("/") { return tab.path }
        let base = tab.cwd ?? store.cwd
        if base.isEmpty { return tab.path }
        return base.hasSuffix("/") ? base + tab.path : "\(base)/\(tab.path)"
    }
}

/// P7：内容区（loading/error/按 kind 路由渲染）从 PreviewPanelView 抽出——
/// 预览面板与文件浏览器右栏共用同一份，行为不分叉（评审共识：右栏不重写预览管线）。
struct PreviewContentView: View {
    @Environment(ChatStore.self) private var store
    let tab: PreviewTab

    // MARK: 内容区

    @ViewBuilder
    var body: some View {
        if tab.loading, tab.content == nil, tab.mediaURL == nil {
            VStack(spacing: 10) {
                ProgressView().controlSize(.regular).tint(JieboColor.dim)
                Text("正在读取 \(tab.filename)…")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = tab.error {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 22))
                    .foregroundStyle(JieboColor.danger)
                Text(error)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink2)
                    .multilineTextAlignment(.center)
                Button("重试") { store.retryPreviewTab(tab.path) }
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.pine)
                    .hitTarget()
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            switch tab.kind {
            // P5c 富媒体：票据 URL 直接渲染，不需要 content
            case .image:
                ImageFileView(url: tab.mediaURL, headUrl: tab.headMediaURL, diff: tab.diff, caption: mediaCaption)
                    .id(tab.path) // 页签级 @State 隔离（zoomed/scale/natural 不串图，对齐 html/canvas 分支）
            case .svg:
                SVGFileView(url: tab.mediaURL, headUrl: tab.headMediaURL, diff: tab.diff, caption: mediaCaption)
                    .id(tab.path) // 页签级 @State 隔离（reloadNonce 自愈预算不串页签）
            case .pdf:
                PDFFileView(url: tab.mediaURL)
                    .background(JieboColor.paper)
            case .audio:
                AudioFileView(url: tab.mediaURL, caption: mediaCaption)
            case .video:
                VideoFileView(url: tab.mediaURL)
                    .background(JieboColor.paper)
            case .html:
                // html 统一走「拉文本 → rewriteHtml（CSP+资源票据重写）→ loadHTMLString」，
                // 不直接 load 票据 URL——避免文档获得 gateway origin（对齐网页 iframe 唯一源沙箱）
                if let text = tab.content {
                    HTMLFileView(content: text, path: tab.path, chatId: tab.chatId ?? store.activeId, media: tab.media)
                        .id(tab.path) // 页签级 @State 隔离（错误/源码态不串页签，对齐 canvas 分支）
                } else {
                    loadingView // 大 html 正在 hydratePreviewText 拉文本
                }
            case .canvas:
                // P5d：画布运行时（同域 /canvas-runtime）；本地 dev 无 web 路由 → 自动降级源码
                if let text = tab.content {
                    if tab.showSource || GatewayConfig.canvasRuntimeURL == nil {
                        CodeFileView(content: text)
                    } else {
                        CanvasFileView(
                            source: text,
                            path: tab.path,
                            chatId: tab.chatId ?? store.activeId,
                            onOpenFile: { store.openPreview($0) },
                            onFallback: { store.toggleCanvasSource(tab.path) }
                        )
                        // 页签级身份：切 canvas 页签重置宿主 @State（status/didReady/bootRetries），
                        // 否则 A 页的错误盖层/已就绪预算会串到 B 页
                        .id("\(tab.path)\u{0}\(tab.chatId ?? store.activeId)")
                    }
                } else {
                    loadingView
                }
            default:
                textContent
            }
        }
    }

    @ViewBuilder
    private var textContent: some View {
        if let text = tab.content {
            if tab.diff {
                DiffFileView(content: text)
            } else {
                switch tab.kind {
                case .markdown:
                    MarkdownFileView(content: text, path: tab.path, chatId: tab.chatId ?? store.activeId, media: tab.media)
                        .id(tab.path) // 页签级 @State 隔离（对齐 canvas 分支）
                default:
                    // text / canvas（P5d 前按源码）都走代码视图
                    CodeFileView(content: text)
                }
            }
        } else if tab.mediaURL != nil {
            loadingView // 大文本正在 hydratePreviewText 拉取，别误显「文件是空的」
        } else {
            Text("文件是空的")
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.dim)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// 媒体头部元信息（对齐网页 figcaption 的 mime · size）
    private var mediaCaption: String? {
        let parts = [tab.mime, tab.size.map(formatBytes)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var loadingView: some View {
        VStack(spacing: 10) {
            ProgressView().controlSize(.regular).tint(JieboColor.dim)
            Text("正在读取 \(tab.filename)…")
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.dim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// 代码视图：竖向滚动 + 长行折行。
/// 不做横向滚动——双向 ScrollView 会让 LazyVStack 为算最大宽度失去惰性（几千行全量实体化）；
/// 行号列因此始终可见。跨行复制用头部的「复制全部」。
struct CodeFileView: View {
    let lines: [String]

    init(content: String) {
        // 归一化 Windows 行尾，避免行尾残留不可见 \r
        let normalized = content.replacingOccurrences(of: "\r\n", with: "\n")
        self.lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text("\(index + 1)")
                            .font(JieboFont.monoText(.caption2))
                            .foregroundStyle(JieboColor.dim)
                            .frame(width: 44, alignment: .trailing)
                            .padding(.trailing, 10)
                        Text(line.isEmpty ? " " : line)
                            .font(JieboFont.monoText(.caption))
                            .foregroundStyle(JieboColor.ink)
                            .textSelection(.enabled) // P6：代码行可选中复制（行号列不选）
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, 1)
                }
            }
            .padding(10)
        }
        .background(JieboColor.paper)
    }
}

/// unified diff 视图：红绿行 + hunk 头。不显示行号（diff 行号与文件行号不一致，反而误导）。
struct DiffFileView: View {
    enum RowKind { case meta, hunk, add, del, ctx }
    struct Row: Identifiable {
        let id: Int
        let kind: RowKind
        let text: String
    }

    let rows: [Row]

    init(content: String) {
        let normalized = content.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var parsed: [Row] = []
        parsed.reserveCapacity(lines.count)
        // 简单状态机：diff --git 退出 hunk，@@ 进入 hunk。
        // hunk 外一律 meta（避免 hunk 内删除 markdown 的 "---" 被误标 meta）；
        // hunk 内只看首字符 + / - / 其余（"\ No newline at end of file" 落 ctx）
        var inHunk = false
        for (index, line) in lines.enumerated() {
            let kind: RowKind
            if line.hasPrefix("diff --git") {
                inHunk = false
                kind = .meta
            } else if line.hasPrefix("@@") {
                inHunk = true
                kind = .hunk
            } else if inHunk {
                if line.hasPrefix("+") { kind = .add }
                else if line.hasPrefix("-") { kind = .del }
                else { kind = .ctx }
            } else {
                kind = .meta
            }
            parsed.append(Row(id: index, kind: kind, text: line.isEmpty ? " " : line))
        }
        self.rows = parsed
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    HStack(spacing: 0) {
                        // 左侧色条：折行后仍能认出同一逻辑行的归属
                        Rectangle()
                            .fill(barColor(row.kind))
                            .frame(width: 3)
                        Text(row.text)
                            .font(JieboFont.monoText(.caption))
                            .foregroundStyle(foreground(row.kind))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.leading, 9)
                            .padding(.trailing, 12)
                            .padding(.vertical, 1)
                    }
                    .background(background(row.kind))
                }
            }
            .padding(.vertical, 10)
        }
        .background(JieboColor.paper)
    }

    private func barColor(_ kind: RowKind) -> Color {
        switch kind {
        case .hunk: return JieboColor.brass
        case .add: return JieboColor.ok
        case .del: return JieboColor.danger
        default: return .clear
        }
    }

    private func foreground(_ kind: RowKind) -> Color {
        switch kind {
        case .meta: return JieboColor.ink2 // meta 行用 ink2 保证可读（dim 历史上只有 ~2.4:1，P6 已抬到 ~4.7:1，这里沿用 ink2 不动）
        case .hunk: return JieboColor.brass
        case .add: return JieboColor.ok
        case .del: return JieboColor.danger
        case .ctx: return JieboColor.ink
        }
    }

    private func background(_ kind: RowKind) -> Color {
        switch kind {
        case .hunk: return JieboColor.brass.opacity(0.08)
        case .add: return JieboColor.ok.opacity(0.08)
        case .del: return JieboColor.danger.opacity(0.08)
        default: return .clear
        }
    }
}

/// Markdown 视图：Swift 转 HTML → rewriteHtml（CSP + 相对资源票据重写）→ 沙箱 WebView。
/// 对齐网页 MarkdownPreview：内联图片经 /media 票据加载（AttributedString 渲染不了图片，P5c 换掉）。
struct MarkdownFileView: View {
    let content: String
    let path: String
    let chatId: String
    let media: MediaTicket?
    @State private var renderedHtml: String?

    var body: some View {
        Group {
            if let renderedHtml {
                // P6：失败给错误占位 + 查看源码（P6 前 SandboxWebView 首屏被导航策略误杀，静默白屏）
                SandboxPreviewView(html: renderedHtml, source: content)
            } else {
                // 转换完成前先给加载态，避免大 md 闪一帧空白
                ProgressView().controlSize(.small).tint(JieboColor.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(JieboColor.paper)
        .task(id: content) {
            renderedHtml = markdownToHtmlDocument(content, fromFile: path) { resolved in
                // loadHTMLString 的 baseURL=nil，相对地址不可靠——补全成绝对地址
                mediaSrc(path: resolved, chatId: chatId, media: media)
                    .flatMap { GatewayConfig.resolveHTTP($0)?.absoluteString } ?? ""
            }
        }
    }
}

/// HTML 预览：rewriteHtml（CSP + 资源票据重写 + javascript: 剥离）→ 沙箱 WebView。
/// 转换放 .task(id:) 缓存，大 html 不在 body 里重复跑正则。
struct HTMLFileView: View {
    let content: String
    let path: String
    let chatId: String
    let media: MediaTicket?
    @State private var rewritten: String?

    var body: some View {
        Group {
            if let rewritten {
                // P6：失败给错误占位 + 查看源码（P6 前 SandboxWebView 首屏被导航策略误杀，静默白屏）
                SandboxPreviewView(html: rewritten, source: content)
            } else {
                ProgressView().controlSize(.small).tint(JieboColor.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(JieboColor.paper)
        .task(id: content) {
            rewritten = rewriteHtml(source: content, fromFile: path) { resolved in
                mediaSrc(path: resolved, chatId: chatId, media: media)
                    .flatMap { GatewayConfig.resolveHTTP($0)?.absoluteString } ?? ""
            }
        }
    }
}
