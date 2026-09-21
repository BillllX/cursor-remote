import SwiftUI
import UIKit

/// P5 预览面板本体（页签条 + 头部 + 内容）。
/// 遮罩与滑入动画由 ThreadView 的 overlay 持有——transition 必须挂在被插入/删除的那一层上。
struct PreviewPanelView: View {
    @Environment(ChatStore.self) private var store
    let tab: PreviewTab

    var body: some View {
        VStack(spacing: 0) {
            tabStrip
            Divider().overlay(JieboColor.line)
            header
            Divider().overlay(JieboColor.line)
            content
        }
        .frame(maxHeight: .infinity)
        .background(JieboColor.white)
        .overlay(alignment: .leading) {
            Rectangle().fill(JieboColor.line).frame(width: 1)
        }
        .shadow(color: .black.opacity(0.12), radius: 18, x: -6, y: 0)
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
            .padding(.vertical, 8)
        }
        .background(JieboColor.mist)
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
                        .font(JieboFont.ui(12, weight: .medium))
                        .foregroundStyle(isActive ? JieboColor.ink : JieboColor.ink2)
                        .lineLimit(1)
                }
                .padding(.leading, 10)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("切换到 \(item.filename)")
            Button {
                store.closePreviewTab(item.path)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(JieboColor.dim)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭 \(item.filename)")
        }
        .padding(.trailing, 4)
        .background(isActive ? JieboColor.white : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
    }

    // MARK: 头部

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(tab.filename)
                        .font(JieboFont.ui(14, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                    if tab.diff {
                        Text("DIFF")
                            .font(JieboFont.ui(10, weight: .bold))
                            .foregroundStyle(JieboColor.brass)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(JieboColor.brass.opacity(0.12))
                            .clipShape(Capsule())
                    }
                }
                Text(tab.path)
                    .font(JieboFont.mono(11))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(1)
                    .truncationMode(.middle)
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
                        .foregroundStyle(tab.diff ? JieboColor.brass : JieboColor.ink2)
                        .frame(width: 30, height: 30)
                        .background(tab.diff ? JieboColor.brass.opacity(0.12) : JieboColor.mist)
                        .clipShape(Circle())
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
                        .foregroundStyle(tab.showSource ? JieboColor.brass : JieboColor.ink2)
                        .frame(width: 30, height: 30)
                        .background(tab.showSource ? JieboColor.brass.opacity(0.12) : JieboColor.mist)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.showSource ? "查看画布" : "查看源码")
            }
            // 媒体类的系统逃生门（对齐网页的「下载」pill）：Quick Look 里可分享/导出/存相册
            if tab.kind.needsMediaURL {
                Button {
                    store.openMention(tab.path)
                } label: {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(width: 30, height: 30)
                        .background(JieboColor.mist)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("用系统打开 \(tab.filename)")
            }
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
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.diff ? "复制 diff" : "复制全部内容")
            }
            Button {
                store.dismissPreviewPanel()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(width: 30, height: 30)
                    .background(JieboColor.mist)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭预览面板")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: 内容区

    @ViewBuilder
    private var content: some View {
        if tab.loading, tab.content == nil, tab.mediaURL == nil {
            VStack(spacing: 10) {
                ProgressView().controlSize(.regular).tint(JieboColor.dim)
                Text("正在读取 \(tab.filename)…")
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.dim)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = tab.error {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 22))
                    .foregroundStyle(JieboColor.danger)
                Text(error)
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.ink2)
                    .multilineTextAlignment(.center)
                Button("重试") { store.retryPreviewTab(tab.path) }
                    .font(JieboFont.ui(13, weight: .medium))
                    .foregroundStyle(JieboColor.pine)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            switch tab.kind {
            // P5c 富媒体：票据 URL 直接渲染，不需要 content
            case .image:
                ImageFileView(url: tab.mediaURL, headUrl: tab.headMediaURL, diff: tab.diff, caption: mediaCaption)
            case .svg:
                SVGFileView(url: tab.mediaURL, headUrl: tab.headMediaURL, diff: tab.diff, caption: mediaCaption)
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
                default:
                    // text / canvas（P5d 前按源码）都走代码视图
                    CodeFileView(content: text)
                }
            }
        } else if tab.mediaURL != nil {
            loadingView // 大文本正在 hydratePreviewText 拉取，别误显「文件是空的」
        } else {
            Text("文件是空的")
                .font(JieboFont.ui(13))
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
                .font(JieboFont.ui(13))
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
                            .font(JieboFont.mono(11))
                            .foregroundStyle(JieboColor.dim)
                            .frame(width: 44, alignment: .trailing)
                            .padding(.trailing, 10)
                        Text(line.isEmpty ? " " : line)
                            .font(JieboFont.mono(12))
                            .foregroundStyle(JieboColor.ink)
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
                            .font(JieboFont.mono(12))
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
        case .meta: return JieboColor.ink2 // dim 在 paper 上对比度只有 ~2.4:1，太糊
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
                SandboxWebView(html: renderedHtml)
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
                SandboxWebView(html: rewritten)
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
