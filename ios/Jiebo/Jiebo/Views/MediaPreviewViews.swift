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

/// 单图：默认 contain，点击切 1:1（双向滚动）；再点切回
private struct SingleImageView: View {
    let url: URL?
    let label: String?
    let caption: String?
    @State private var zoomed = false

    var body: some View {
        Group {
            if zoomed {
                // 双向 ScrollView 给无界提议 → scaledToFit 落到原始像素尺寸
                ScrollView([.vertical, .horizontal]) {
                    imageStack
                        .padding(14)
                }
            } else {
                // 竖向 ScrollView 宽度有界 → contain
                ScrollView(.vertical) {
                    imageStack
                        .padding(14)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .background(JieboColor.paper)
    }

    private var imageStack: some View {
        VStack(spacing: 8) {
            if let label {
                Text(label)
                    .font(JieboFont.ui(11, weight: .medium))
                    .foregroundStyle(JieboColor.ok)
            }
            RemoteImage(url: url)
                .onTapGesture { withAnimation(.easeOut(duration: 0.2)) { zoomed.toggle() } }
                .accessibilityLabel(zoomed ? "缩小为适应宽度" : "放大为原始尺寸")
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
                SandboxWebView(html: Self.imgDocument(url))
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
            SandboxWebView(html: Self.imgDocument(url))
        }
    }

    /// 居中自适应的 <img> 包装页（src 是绝对票据 URL，不执行 SVG 内嵌脚本）
    private static func imgDocument(_ url: URL?) -> String {
        guard let url else { return "<!doctype html><html><body></body></html>" }
        let src = url.absoluteString
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>html,body{margin:0;height:100%;background:#FAFAFA}
        body{display:flex;align-items:center;justify-content:center}
        img{max-width:100%;max-height:100%;object-fit:contain}</style></head>
        <body><img src="\(src)"></body></html>
        """
    }
}

// MARK: - HTML / Markdown：WKWebView 沙箱

/// 沙箱 WebView：只支持 loadHTMLString（baseURL=nil 的唯一源文档），无 JS bridge；
/// 主框导航一律拦截（loadHTMLString 首屏不走导航策略，window.location/meta refresh 出不去）——
/// 对齐网页 iframe sandbox（无 allow-same-origin）的隔离强度
struct SandboxWebView: UIViewRepresentable {
    let html: String?
    /// 不透明白底防加载闪黑（SVG 包装页自带 #FAFAFA 底，用默认 true 即可）
    var opaque: Bool = true

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.isTextInteractionEnabled = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = opaque
        webView.scrollView.backgroundColor = opaque ? .white : .clear
        load(into: webView, coordinator: context.coordinator)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // 内容随页签切换可能变化；Coordinator 记录已加载标识避免重复加载（html 用整串当 key，不赌 hash）
        let key = html.map { "html:\($0)" } ?? ""
        guard context.coordinator.loadedKey != key else { return }
        load(into: webView, coordinator: context.coordinator)
    }

    private func load(into webView: WKWebView, coordinator: Coordinator) {
        coordinator.loadedKey = html.map { "html:\($0)" } ?? ""
        if let html {
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedKey = ""

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            // 主框导航全拒：loadHTMLString 首屏不依赖策略放行，任何跳转（含 JS/meta refresh）都出不去
            .cancel
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            loadedKey = "" // 失败清 key，下次 updateUIView 可重试
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            loadedKey = ""
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
