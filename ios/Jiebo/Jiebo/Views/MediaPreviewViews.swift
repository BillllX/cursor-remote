import AVKit
import PDFKit
import SwiftUI
import WebKit

// P5c 富媒体预览：图片（含 diff 双图对照）/ SVG / HTML 沙箱 / PDF / 音频 / 视频。
// 全部经 /media 票据 URL 加载（file_content 的 url 字段已带 exp/sig 查询）。

// MARK: - 图片（单图 / diff 双图对照）

struct ImageFileView: View {
    let url: URL?
    /// diff 模式的「改前」图（rev=HEAD）；nil 表示新文件只有改后
    let headUrl: URL?
    let diff: Bool
    /// 头部元信息（mime · size，对齐网页 figcaption）
    var caption: String? = nil

    var body: some View {
        if diff, let headUrl {
            // 对齐网页 MediaPreview 的双图对照；面板宽度有限，上下排布比左右并排更能看清
            ScrollView {
                VStack(spacing: 14) {
                    labeledImage("改前", url: headUrl, tint: JieboColor.danger)
                    labeledImage("改后", url: url, tint: JieboColor.ok)
                    captionView
                }
                .padding(14)
            }
            .background(JieboColor.paper)
        } else {
            singleImage(url: url, label: diff ? "改后（新文件）" : nil)
        }
    }

    @ViewBuilder
    private var captionView: some View {
        if let caption {
            Text(caption)
                .font(JieboFont.ui(11))
                .foregroundStyle(JieboColor.dim)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private func singleImage(url: URL?, label: String?) -> some View {
        // 默认按面板宽 contain（对齐网页 max-width:100%）；点一下切 1:1 双向滚动看细节
        SingleImageView(url: url, label: label, caption: caption)
    }

    private func labeledImage(_ label: String, url: URL?, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(JieboFont.ui(11, weight: .semibold))
                .foregroundStyle(tint)
            RemoteImage(url: url)
                .frame(maxWidth: .infinity)
                .background(JieboColor.white)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                )
        }
    }
}

/// 单图：默认 contain，点击切 1:1（双向滚动）；再点切回。P6：双指捏合连续缩放。
/// 注意 scaleEffect 不改布局——zoomed 模式必须用「原始尺寸 × 倍率」的显式 frame 撑开
/// ScrollView 的 contentSize，否则放大后边缘滚不到、超出布局框的部分不响应手势。
private struct SingleImageView: View {
    let url: URL?
    let label: String?
    let caption: String?
    @State private var zoomed = false
    /// 捏合缩放倍率（仅 zoomed 模式生效；1 = 原始像素尺寸）
    @State private var scale: CGFloat = 1
    @GestureState private var liveScale: CGFloat = 1
    /// 原始像素尺寸（zoomed 布局框要用；contain 模式量不到，单独预取）
    @State private var natural: CGSize?
    /// 预取失败标记（zoomed 死局兜底：失败态给出口，不永久转圈）
    @State private var naturalFailed = false

    var body: some View {
        Group {
            if zoomed {
                if let natural {
                    let total = min(max(scale * liveScale, 0.5), 5)
                    // 双向 ScrollView 给无界提议；内层 frame 固定原始尺寸（布局基准），
                    // scaleEffect 视觉缩放，外层 frame 把布局框撑到缩放后尺寸 → 滚动范围正确
                    ScrollView([.vertical, .horizontal]) {
                        RemoteImage(url: url)
                            .frame(width: natural.width, height: natural.height)
                            .scaleEffect(total)
                            .frame(width: natural.width * total, height: natural.height * total)
                            .simultaneousGesture(pinch) // 与 ScrollView 的 pan 共存
                            .onTapGesture { exitZoom() }
                            .accessibilityLabel("缩小为适应宽度")
                            .padding(14)
                    }
                } else {
                    // 预取没完成/失败：给出口（点一下退回 contain），不永久转圈
                    VStack(spacing: 10) {
                        if naturalFailed {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.system(size: 22))
                                .foregroundStyle(JieboColor.danger)
                            Text("打不开原始尺寸，点任意处返回")
                                .font(JieboFont.ui(13))
                                .foregroundStyle(JieboColor.ink2)
                        } else {
                            ProgressView().controlSize(.regular).tint(JieboColor.dim)
                            Text("正在准备原始尺寸…")
                                .font(JieboFont.ui(13))
                                .foregroundStyle(JieboColor.dim)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .onTapGesture { exitZoom() }
                }
            } else {
                // 竖向 ScrollView 宽度有界 → contain
                ScrollView(.vertical) {
                    imageStack
                        .scaleEffect(max(liveScale, 1)) // 捏合实时反馈（只放大不缩小）
                        .simultaneousGesture(pinch)
                        .padding(14)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .background(JieboColor.paper)
        .task(id: url) {
            // 预取原始像素尺寸（AsyncImage 拿不到）；URLSession 缓存让二次请求走本地。
            // url 变了必须重取（不设 natural==nil 守卫），否则下一张图沿用旧尺寸基准
            natural = nil
            naturalFailed = false
            guard let url else { naturalFailed = true; return }
            if let (data, _) = try? await URLSession.shared.data(from: url),
               let image = UIImage(data: data)
            {
                guard !Task.isCancelled else { return }
                natural = image.size
            } else {
                // 取消（url 变了旧任务被撤）也会走 else——别用迟到失败覆盖新任务的加载态
                guard !Task.isCancelled else { return }
                naturalFailed = true
            }
        }
    }

    /// 捏合：contain 模式下放大超过阈值自动切入 1:1 浏览；1:1 下连续缩放，捏回 1x 以下退出
    private var pinch: some Gesture {
        MagnifyGesture()
            .updating($liveScale) { value, state, _ in state = value.magnification }
            .onEnded { value in
                if !zoomed {
                    guard value.magnification > 1.15 else { return }
                    scale = min(max(value.magnification, 1), 5)
                    withAnimation(.easeOut(duration: 0.2)) { zoomed = true }
                } else {
                    let next = min(max(scale * value.magnification, 0.5), 5)
                    if next < 1 { exitZoom() } else { scale = next }
                }
            }
    }

    private func exitZoom() {
        withAnimation(.easeOut(duration: 0.2)) {
            zoomed = false
            scale = 1
        }
    }

    private var imageStack: some View {
        VStack(spacing: 8) {
            if let label {
                Text(label)
                    .font(JieboFont.ui(11, weight: .medium))
                    .foregroundStyle(JieboColor.ok)
            }
            RemoteImage(url: url)
                .onTapGesture {
                    withAnimation(.easeOut(duration: 0.2)) { zoomed = true }
                }
                .accessibilityLabel("放大为原始尺寸")
            if let caption {
                Text(caption)
                    .font(JieboFont.ui(11))
                    .foregroundStyle(JieboColor.dim)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
        }
    }
}

/// 带加载/失败态的远程图（票据 URL 无需额外鉴权头）。
/// 容器有界宽 → scaledToFit 即 contain；双向 ScrollView 无界提议 → 原始像素尺寸。
struct RemoteImage: View {
    let url: URL?

    var body: some View {
        if let url {
            AsyncImage(url: url, transaction: Transaction(animation: .easeInOut(duration: 0.2))) { phase in
                switch phase {
                case .empty:
                    ProgressView().controlSize(.regular).tint(JieboColor.dim)
                        .frame(maxWidth: .infinity, minHeight: 120)
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFit()
                        .transition(.opacity)
                case .failure:
                    Label("图片加载失败", systemImage: "exclamationmark.triangle")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.danger)
                        .frame(maxWidth: .infinity, minHeight: 120)
                @unknown default:
                    EmptyView()
                }
            }
        } else {
            Text("缺少媒体地址")
                .font(JieboFont.ui(12))
                .foregroundStyle(JieboColor.dim)
        }
    }
}

// MARK: - SVG（WKWebView 渲染；diff 双图对照）

/// SwiftUI Image/AsyncImage 不支持 SVG；但 WKWebView 直接加载票据 URL 会让 SVG 内嵌 script
/// 以 gateway origin 执行（网页用 <img> 渲染就是为了不执行脚本）——所以包一层 <img> HTML：
/// <img> 语境下 SVG 脚本不运行，与网页对齐。diff 时上下双视图对照。
struct SVGFileView: View {
    let url: URL?
    let headUrl: URL?
    let diff: Bool
    /// 头部元信息（mime · size，对齐网页 figcaption）
    var caption: String? = nil
    /// 渲染进程崩溃/加载失败的自愈计数：换 key 触发重载（SVG 无错误占位，白屏不如重试）
    @State private var reloadNonce = 0

    var body: some View {
        if diff, let headUrl {
            VStack(spacing: 0) {
                labeledImage("改前", url: headUrl, tint: JieboColor.danger)
                Divider().overlay(JieboColor.line)
                labeledImage("改后", url: url, tint: JieboColor.ok)
                if let caption {
                    Text(caption)
                        .font(JieboFont.ui(11))
                        .foregroundStyle(JieboColor.dim)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 6)
                }
            }
            .background(JieboColor.paper)
        } else {
            VStack(spacing: 0) {
                SandboxWebView(html: Self.imgDocument(url, nonce: reloadNonce), onFail: { _ in
                    if reloadNonce < 3 { reloadNonce += 1 } // 持续失败（如网关断）不无限重试
                })
                if let caption {
                    Text(caption)
                        .font(JieboFont.ui(11))
                        .foregroundStyle(JieboColor.dim)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 6)
                }
            }
            .background(JieboColor.paper)
        }
    }

    private func labeledImage(_ label: String, url: URL?, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(JieboFont.ui(11, weight: .semibold))
                .foregroundStyle(tint)
                .padding(.leading, 14)
                .padding(.top, 10)
            SandboxWebView(html: Self.imgDocument(url, nonce: reloadNonce), onFail: { _ in
                if reloadNonce < 3 { reloadNonce += 1 }
            })
        }
    }

    /// 居中自适应的 <img> 包装页（src 是绝对票据 URL，不执行 SVG 内嵌脚本）
    private static func imgDocument(_ url: URL?, nonce: Int = 0) -> String {
        guard let url else { return "<!doctype html><html><body></body></html>" }
        let src = url.absoluteString
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>html{color-scheme:light dark}html,body{margin:0;height:100%;background:#FAFAFA}
        @media (prefers-color-scheme: dark){html,body{background:#141512}}
        body{display:flex;align-items:center;justify-content:center}
        img{max-width:100%;max-height:100%;object-fit:contain}</style></head>
        <body><img src="\(src)"></body><!-- \(nonce) --></html>
        """
    }
}

// MARK: - HTML / Markdown：WKWebView 沙箱

/// 沙箱 WebView：只支持 loadHTMLString（baseURL=nil 的唯一源文档），无 JS bridge；
/// 主框导航只放行 about:blank 首屏（loadHTMLString 的替代数据加载在现代 WebKit 会走导航策略，
/// 一律 .cancel 会把首屏也掐掉白屏），其余跳转（JS 跳转/meta refresh/链接/iframe）一律拦截——
/// 对齐网页 iframe sandbox（无 allow-same-origin）的隔离强度
struct SandboxWebView: UIViewRepresentable {
    let html: String?
    /// 不透明底防加载闪黑。颜色跟当前配色的明暗。
    var opaque: Bool = true

    private static var pageColor: UIColor {
        UIColor { traits in
            let palette = JieboTheme.shared.palette
            let ink = traits.userInterfaceStyle == .dark ? palette.dark : palette.light
            return UIColor(hex: ink.bg)
        }
    }
    /// P6：加载失败上抛（HTML/Markdown 预览据此显示错误占位 + 查看源码逃生门）
    var onFail: ((String) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.isTextInteractionEnabled = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = opaque
        webView.backgroundColor = opaque ? Self.pageColor : .clear
        webView.scrollView.backgroundColor = opaque ? Self.pageColor : .clear
        context.coordinator.onFail = onFail
        load(into: webView, coordinator: context.coordinator)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if opaque {
            webView.backgroundColor = Self.pageColor
            webView.scrollView.backgroundColor = Self.pageColor
        }
        context.coordinator.onFail = onFail
        // 内容随页签切换可能变化；Coordinator 记录已加载标识避免重复加载（html 用整串当 key，不赌 hash）
        let key = html.map { "html:\($0)" } ?? ""
        guard context.coordinator.loadedKey != key else { return }
        load(into: webView, coordinator: context.coordinator)
    }

    private func load(into webView: WKWebView, coordinator: Coordinator) {
        coordinator.loadedKey = html.map { "html:\($0)" } ?? ""
        coordinator.committed = false // 新文档：首屏导航策略重新放开一次
        if let html {
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedKey = ""
        var onFail: ((String) -> Void)?
        /// 首屏是否已 commit：commit 后 about:blank 也拒（JS 自白屏），失败上报只认首屏
        var committed = false

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            // 只放行「主框 + 首屏（commit 前）+ about:blank」的替代数据加载（loadHTMLString）；
            // 其余一切（JS 跳转 / meta refresh / 链接 / iframe / 二次 blank）一律拦截
            guard navigationAction.targetFrame?.isMainFrame == true else { return .cancel }
            let url = navigationAction.request.url?.absoluteString ?? ""
            // hasPrefix 兼容个别 WebKit 版本给 blank 补的尾缀
            if !committed, url.hasPrefix("about:blank") { return .allow }
            return .cancel
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            committed = true
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        /// WebContent 进程崩溃（重页面 OOM）不走 didFail——不上报就是静默白屏
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            loadedKey = ""
            onFail?("渲染进程崩溃了")
        }

        private func report(_ error: Error) {
            let ns = error as NSError
            // stopLoading 的 cancelled 与策略拦截（WebKitErrorDomain 102）都是沙箱在工作，不算渲染失败
            if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
            if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
            // 首屏已 commit 后的失败不清 key 不上报（被拒导航的伴随错误不打断已渲染页面）
            guard !committed else { return }
            loadedKey = "" // 真失败才清 key，下次 updateUIView 可重试
            onFail?(ns.localizedDescription)
        }
    }
}

/// P6：带失败回退的沙箱渲染宿主。SandboxWebView 加载失败时给错误占位 +
/// 「查看源码」逃生门（对齐 canvas 的 onFallback 路径），不再静默白屏。
struct SandboxPreviewView: View {
    /// rewriteHtml / markdownToHtmlDocument 的产物（唯一源文档）
    let html: String
    /// 原始源码（逃生门用）
    let source: String
    @State private var loadError: String?
    @State private var showSource = false
    /// 重试计数：变化迫使 SandboxWebView 的 loadedKey 失配重新加载
    @State private var retryCount = 0

    var body: some View {
        Group {
            if showSource {
                CodeFileView(content: source)
            } else if let loadError {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 22))
                        .foregroundStyle(JieboColor.danger)
                    Text("页面渲染失败：\(loadError)")
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.ink2)
                        .multilineTextAlignment(.center)
                    HStack(spacing: 16) {
                        Button("重试") {
                            self.loadError = nil
                            retryCount += 1
                        }
                        .foregroundStyle(JieboColor.ink2)
                        .hitTarget()
                        Button("查看源码") { showSource = true }
                            .foregroundStyle(JieboColor.pine)
                            .hitTarget()
                    }
                    .font(JieboFont.ui(13, weight: .medium))
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // 错误分支会销毁 WebView，重试走 makeUIView 全新加载；
                // retryCount 拼注释只是防御性换 key（防 loadedKey 残留竞态）
                SandboxWebView(html: retryCount == 0 ? html : html + "<!-- retry \(retryCount) -->") { message in
                    loadError = message
                }
            }
        }
        .background(JieboColor.paper)
        // 页签内容换了（agent 改写/切文件）→ 错误与源码态都重置，retry 计数归零（注释不再累积）。
        // 注意：正在读源码的用户会被拽回渲染态——内容变了，旧源码已过时，这是有意为之
        .onChange(of: html) { _, _ in
            loadError = nil
            showSource = false
            retryCount = 0
        }
        // 源码/渲染来回切的出口；返回渲染 = 清错误重载一次
        .overlay(alignment: .topTrailing) {
            if showSource {
                Button("返回渲染") {
                    showSource = false
                    loadError = nil
                    retryCount += 1
                }
                .font(JieboFont.ui(12, weight: .medium))
                .foregroundStyle(JieboColor.pine)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(JieboColor.mist)
                .clipShape(Capsule())
                .padding(10)
                .hitTarget()
            }
        }
    }
}

// MARK: - PDF

struct PDFFileView: View {
    let url: URL?

    var body: some View {
        PDFContent(url: url)
    }
}

/// 包一层 @State 宿主：.task(id:) 自带判重（同 url 不重跑，retryCount 强制重试），
/// URLSession 下载到临时文件（32MB 顶，对齐 Quick Look 路径），失败给错误态+重试而不是白屏；
/// .task(id:) 在页签切换/视图消失时自动取消旧下载
private struct PDFContent: View {
    let url: URL?
    @State private var document: PDFDocument?
    @State private var failed = false
    @State private var tempFile: URL?
    @State private var retryCount = 0

    var body: some View {
        Group {
            if let document {
                PDFKitView(document: document)
            } else if failed {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 22))
                        .foregroundStyle(JieboColor.danger)
                    Text("PDF 加载失败或文件过大")
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.ink2)
                    Button("重试") {
                        failed = false
                        retryCount += 1 // id 变化触发 .task 重跑
                    }
                    .font(JieboFont.ui(13, weight: .medium))
                    .foregroundStyle(JieboColor.pine)
                    .hitTarget()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView().controlSize(.regular).tint(JieboColor.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // .task(id:) 自带判重（同 url 不重跑）；retryCount 变化强制重试
        .task(id: "\(url?.absoluteString ?? "")#\(retryCount)") {
            guard let url else { return }
            document = nil
            failed = false
            let result = await Self.load(url: url)
            guard !Task.isCancelled else { return }
            // 换掉旧临时文件
            if let old = tempFile { try? FileManager.default.removeItem(at: old) }
            tempFile = result?.1
            document = result?.0
            failed = result == nil
        }
        .onDisappear {
            if let tempFile { try? FileManager.default.removeItem(at: tempFile) }
        }
    }

    /// 下载到 caches 再交给 PDFDocument（memory-map，不整包进内存）；超 32MB 拒载
    private static func load(url: URL) async -> (PDFDocument, URL)? {
        do {
            let (temp, _) = try await URLSession.shared.download(from: url)
            let size = (try? FileManager.default.attributesOfItem(atPath: temp.path)[.size] as? NSNumber)?.int64Value ?? 0
            guard size > 0, size <= 32 * 1024 * 1024 else {
                try? FileManager.default.removeItem(at: temp)
                return nil
            }
            let dest = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("jiebo-pdf-\(UUID().uuidString).pdf")
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: temp, to: dest)
            guard let doc = PDFDocument(url: dest) else {
                try? FileManager.default.removeItem(at: dest)
                return nil
            }
            return (doc, dest)
        } catch {
            return nil
        }
    }
}

private struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.document = document
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
    }
}

// MARK: - 音频（AVPlayerViewController：自带进度/时长/seek，对齐网页 <audio controls>）

struct AudioFileView: View {
    let url: URL?
    /// 头部元信息（mime · size，对齐网页 audio 的 name · size）
    var caption: String? = nil

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "waveform")
                .font(.system(size: 34))
                .foregroundStyle(JieboColor.dim)
            AudioPlayerRepresentable(url: url)
                .frame(height: 120)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)
            if let caption {
                Text(caption)
                    .font(JieboFont.ui(11))
                    .foregroundStyle(JieboColor.dim)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(JieboColor.paper)
    }
}

private struct AudioPlayerRepresentable: UIViewControllerRepresentable {
    let url: URL?

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.videoGravity = .resizeAspect
        if let url { controller.player = AVPlayer(url: url) }
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        guard let url else {
            controller.player?.pause()
            controller.player = nil
            return
        }
        if (controller.player?.currentItem?.asset as? AVURLAsset)?.url != url {
            controller.player = AVPlayer(url: url)
        }
    }

    static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: ()) {
        // 切页签/关面板时停播，不留后台声音
        controller.player?.pause()
        controller.player = nil
    }
}

// MARK: - 视频

struct VideoFileView: UIViewControllerRepresentable {
    let url: URL?

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        if let url { controller.player = AVPlayer(url: url) }
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        guard let url else {
            controller.player?.pause()
            controller.player = nil
            return
        }
        if (controller.player?.currentItem?.asset as? AVURLAsset)?.url != url {
            controller.player = AVPlayer(url: url)
        }
    }

    static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: ()) {
        controller.player?.pause()
        controller.player = nil
    }
}
