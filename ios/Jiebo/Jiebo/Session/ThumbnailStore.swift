import AVFoundation
import CryptoKit
import Foundation
import ImageIO
import Observation
import PDFKit
import SwiftUI
import UIKit
import WebKit

/// 文件大卡的缩略图状态。none/failed 都显示原来的图标占位
enum ThumbState: Equatable {
    case none
    case loading
    case image(UIImage)
    /// markdown：前几行非空文本
    case text(String)
    case failed
}

/// 文件卡片缩略图：read_file 带 reqId 走旁路（不进页签/内容层），按类型渲染成图或几行文字。
/// 键 tenant|chatId|path|sha；没有 sha 的是当前版本，会变，只放内存。
/// 每个键每次启动只试一次，失败显示图标，不重试。
/// 限流：在途 read_file 最多 3 个、下载/解码最多 3 个、离屏 WebView 最多 2 个；
/// 排队最多 40 个，超出丢最旧的（退回未请求，卡片再出现时重排）；卡片消失时撤掉还没发出的。
@Observable
@MainActor
final class ThumbnailStore {
    static let shared = ThumbnailStore()

    private(set) var states: [String: ThumbState] = [:]

    private struct Pending {
        var key: String
        var kind: PreviewKind
        var path: String
        var chatId: String
        var tenant: String
        var sha: String?
        /// 有 sha 的快照内容不变，才落盘
        var persist: Bool { sha != nil }
    }

    /// 准备阶段的产物：直接出结果，或交给离屏 WebView
    private enum Prepared {
        case done(ThumbState?)
        case web(ThumbWebJob.Source)
    }

    /// reqId → 已发出、等回包的请求
    @ObservationIgnored private var pending: [String: Pending] = [:]
    /// 还没发出的请求（FIFO）
    @ObservationIgnored private var waiting: [Pending] = []
    /// 回包已到、在等下载/解码名额的个数（也占在途名额，免得回包堆积）
    @ObservationIgnored private var awaitingRender = 0
    /// 正在查盘缓存的键 → 本次请求的 token
    @ObservationIgnored private var diskLoading: [String: UUID] = [:]
    @ObservationIgnored private var attempted: Set<String> = []
    /// 成功结果的写入顺序，超过上限从旧的丢（只丢内存，盘上还在）
    @ObservationIgnored private var order: [String] = []
    /// 换租户/登出 +1，在途结果作废
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private weak var chatStore: ChatStore?
    private let renderGate = ThumbGate(limit: 3)
    private let webGate = ThumbGate(limit: 2)

    private static let memoryLimit = 200
    private static let maxInFlight = 3
    private static let maxWaiting = 40

    static func renderable(_ kind: PreviewKind) -> Bool {
        switch kind {
        case .image, .svg, .pdf, .video, .html, .canvas, .markdown: return true
        case .text, .binary, .audio: return false
        }
    }

    func thumbnail(for file: TurnFile, chatId: String, store: ChatStore) -> ThumbState {
        guard Self.renderable(file.kind) else { return ThumbState.none }
        return states[cacheKey(for: file, chatId: chatId, store: store).key] ?? ThumbState.none
    }

    func request(file: TurnFile, chatId: String, store: ChatStore) {
        guard Self.renderable(file.kind),
              store.connected,
              store.gatewayFeatures.contains("read_req_id"),
              !store.tenantId.isEmpty,
              !chatId.isEmpty, chatId != "boot"
        else { return }
        let (key, sha) = cacheKey(for: file, chatId: chatId, store: store)
        guard !attempted.contains(key) else { return }
        attempted.insert(key)
        states[key] = .loading
        chatStore = store
        let job = Pending(key: key, kind: file.kind, path: file.path, chatId: chatId, tenant: store.tenantId, sha: sha)
        guard job.persist else {
            enqueue(job)
            return
        }
        let epochAtStart = epoch
        let token = UUID()
        diskLoading[key] = token
        Task {
            let cached = await ThumbDisk.load(tenant: job.tenant, key: job.key)
            // 读盘期间卡片消失被撤、又重新请求（新 token）或换了租户：这一趟作废
            guard self.epoch == epochAtStart, self.diskLoading[job.key] == token else { return }
            self.diskLoading[job.key] = nil
            if let cached {
                self.commit(cached, for: job.key)
            } else {
                self.enqueue(job)
            }
        }
    }

    /// 卡片消失：还没发出的请求撤掉，退回未请求
    func cancel(file: TurnFile, chatId: String, store: ChatStore) {
        let key = cacheKey(for: file, chatId: chatId, store: store).key
        if diskLoading.removeValue(forKey: key) != nil {
            forget(key)
        } else if let index = waiting.firstIndex(where: { $0.key == key }) {
            waiting.remove(at: index)
            forget(key)
        }
    }

    /// ChatStore 收到 reqId 以 thumb: 开头的 file_content 时转交
    func handleReply(reqId: String, path: String, kind: String?, content: String?, url: String?, media: MediaTicket?, error: String?) {
        guard let job = pending.removeValue(forKey: reqId) else { return }
        if error != nil {
            fail(job.key)
            pump()
            return
        }
        let resolved = url.flatMap { GatewayConfig.resolveHTTP($0) }
        let epochAtStart = epoch
        awaitingRender += 1
        Task {
            await self.renderGate.acquire()
            self.awaitingRender -= 1
            self.pump()
            guard self.epoch == epochAtStart else {
                self.renderGate.release()
                return
            }
            let prepared = await self.prepare(job, content: content, url: resolved, media: media)
            self.renderGate.release()
            var result: ThumbState?
            switch prepared {
            case .done(let state):
                result = state
            case .web(let source):
                await self.webGate.acquire()
                var image: UIImage?
                if self.epoch == epochAtStart {
                    image = await ThumbWebJob(source: source).run()
                }
                self.webGate.release()
                result = image.map { ThumbState.image($0) }
            }
            guard self.epoch == epochAtStart else { return }
            guard let result else {
                self.fail(job.key)
                return
            }
            self.commit(result, for: job.key)
            if job.persist { ThumbDisk.save(result, tenant: job.tenant, key: job.key, epoch: epochAtStart) }
        }
    }

    /// 换账号/登出：内存全清；盘上按同一条串行队列删（tenant 空 = 登出，删所有租户的 thumbs）
    func reset(tenant: String) {
        epoch += 1
        states = [:]
        pending = [:]
        waiting = []
        diskLoading = [:]
        attempted = []
        order = []
        ThumbDisk.clear(tenant: tenant, epoch: epoch)
    }

    // MARK: 内部

    func cacheKey(for file: TurnFile, chatId: String, store: ChatStore) -> (key: String, sha: String?) {
        let sha = store.gatewayFeatures.contains("read_sha") ? file.sha : nil
        if let sha { return ("\(store.tenantId)|\(chatId)|\(file.path)|\(sha)", sha) }
        let size = file.size.map { String(Int($0)) } ?? "-"
        return ("\(store.tenantId)|\(chatId)|\(file.path)|size:\(size)", nil)
    }

    private func enqueue(_ job: Pending) {
        waiting.append(job)
        while waiting.count > Self.maxWaiting {
            forget(waiting.removeFirst().key)
        }
        pump()
    }

    private func pump() {
        while pending.count + awaitingRender < Self.maxInFlight, !waiting.isEmpty {
            let job = waiting.removeFirst()
            // 发之前断线/换了租户：退回未请求，等卡片下次出现
            guard let store = chatStore, store.connected, store.tenantId == job.tenant else {
                forget(job.key)
                continue
            }
            sendRead(job, store: store)
        }
    }

    private func sendRead(_ job: Pending, store: ChatStore) {
        let reqId = "thumb:" + UUID().uuidString
        pending[reqId] = job
        store.sendThumbnailRead(path: job.path, chatId: job.chatId, sha: job.sha, reqId: reqId)
        let epochAtStart = epoch
        Task {
            try? await Task.sleep(for: .seconds(20))
            guard self.epoch == epochAtStart, self.pending.removeValue(forKey: reqId) != nil else { return }
            self.fail(job.key)
            self.pump()
        }
    }

    private func forget(_ key: String) {
        states[key] = nil
        attempted.remove(key)
    }

    private func commit(_ state: ThumbState, for key: String) {
        states[key] = state
        order.append(key)
        while order.count > Self.memoryLimit {
            forget(order.removeFirst())
        }
    }

    private func fail(_ key: String) {
        states[key] = .failed
    }

    /// 下载与解码（占 renderGate）；网页类只拉文本，截图在 webGate 里做
    private func prepare(_ job: Pending, content: String?, url: URL?, media: MediaTicket?) async -> Prepared {
        switch job.kind {
        case .image:
            guard let url, let data = await ThumbRender.fetch(url) else { return .done(nil) }
            let image = await Task.detached(priority: .utility) { ThumbRender.downsample(data, maxPixel: 640) }.value
            return .done(image.map { ThumbState.image($0) })
        case .pdf:
            guard let url, let data = await ThumbRender.fetch(url) else { return .done(nil) }
            let image = await Task.detached(priority: .utility) { ThumbRender.pdfThumbnail(data) }.value
            return .done(image.map { ThumbState.image($0) })
        case .video:
            guard let url, let image = await ThumbRender.videoFrame(url) else { return .done(nil) }
            return .done(.image(image))
        case .markdown:
            guard let text = await ThumbRender.text(content: content, url: url),
                  let preview = ThumbRender.markdownPreview(text)
            else { return .done(nil) }
            return .done(.text(preview))
        case .html:
            guard let text = await ThumbRender.text(content: content, url: url) else { return .done(nil) }
            let chatId = job.chatId
            // 与 HTMLFileView 相同：rewriteHtml（CSP + 资源票据）→ loadHTMLString，不直接 load 票据地址
            let html = rewriteHtml(source: text, fromFile: job.path) { resolved in
                mediaSrc(path: resolved, chatId: chatId, media: media)
                    .flatMap { GatewayConfig.resolveHTTP($0)?.absoluteString } ?? ""
            }
            return .web(.html(html))
        case .svg:
            guard let url else { return .done(nil) }
            return .web(.html(ThumbRender.imgDocument(url)))
        case .canvas:
            guard GatewayConfig.canvasRuntimeURL != nil,
                  let text = await ThumbRender.text(content: content, url: url),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return .done(nil) }
            return .web(.canvas(source: text, path: job.path, chatId: job.chatId))
        case .text, .binary, .audio:
            return .done(nil)
        }
    }
}

/// 计数信号量：名额满了按先来后到排队，释放时直接把名额交给下一个
@MainActor
private final class ThumbGate {
    private let limit: Int
    private var active = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(limit: Int) {
        self.limit = limit
    }

    func acquire() async {
        if active < limit {
            active += 1
            return
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiters.append(continuation)
        }
    }

    func release() {
        if waiters.isEmpty {
            active -= 1
        } else {
            waiters.removeFirst().resume()
        }
    }
}

// MARK: - 离屏 WebView 截图

/// 挂在 key window 最底层（alpha 0.01、不接触摸）才会真正渲染；截完即移除。
/// html/svg 沙箱对齐 SandboxWebView：loadHTMLString(baseURL: nil)、无 JS bridge、只放行首屏 about:blank。
/// canvas 对齐 CanvasWebView：加载 /canvas-runtime，canvas:ready 后推 canvas:load，canvas:loaded 后截图。
@MainActor
private final class ThumbWebJob: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    enum Source {
        case html(String)
        case canvas(source: String, path: String, chatId: String)
    }

    private let source: Source
    private var webView: WKWebView?
    private var continuation: CheckedContinuation<UIImage?, Never>?
    private var committed = false
    private var capturing = false
    private var loaded = false
    private var seq = 0
    private var timers: [Task<Void, Never>] = []

    private static let size = CGSize(width: 640, height: 400)

    init(source: Source) {
        self.source = source
    }

    private var isCanvas: Bool {
        if case .canvas = source { return true }
        return false
    }

    func run() async -> UIImage? {
        await withCheckedContinuation { (continuation: CheckedContinuation<UIImage?, Never>) in
            self.continuation = continuation
            self.start()
        }
    }

    private func start() {
        guard let window = Self.hostWindow else {
            finish(nil)
            return
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        var runtimeURL: URL?
        if isCanvas {
            guard let url = GatewayConfig.canvasRuntimeURL else {
                finish(nil)
                return
            }
            runtimeURL = url
            config.userContentController.addUserScript(WKUserScript(
                source: Self.canvasBridge,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
            config.userContentController.add(self, name: "canvas")
        } else {
            // html/svg 只截静态渲染：文件里的脚本一律不跑（只有 canvas 运行时需要 JS）
            config.defaultWebpagePreferences.allowsContentJavaScript = false
        }
        let webView = WKWebView(frame: CGRect(origin: .zero, size: Self.size), configuration: config)
        webView.navigationDelegate = self
        webView.alpha = 0.01
        webView.isUserInteractionEnabled = false
        webView.accessibilityElementsHidden = true
        webView.isOpaque = true
        webView.backgroundColor = UIColor(JieboColor.paper)
        webView.scrollView.backgroundColor = UIColor(JieboColor.paper)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        window.insertSubview(webView, at: 0)
        self.webView = webView

        switch source {
        case .html(let html):
            webView.loadHTMLString(Self.lockDown(html), baseURL: nil)
            schedule(after: 3) { [weak self] in self?.finish(nil) }
        case .canvas:
            if let runtimeURL { webView.load(URLRequest(url: runtimeURL)) }
            schedule(after: 15) { [weak self] in self?.finish(nil) }
        }
    }

    private func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) {
        timers.append(Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            action()
        })
    }

    /// 等布局/首帧稳定再截
    private func capture(after delay: Double) {
        guard !capturing else { return }
        capturing = true
        schedule(after: delay) { [weak self] in
            guard let self, let webView = self.webView else { return }
            let config = WKSnapshotConfiguration()
            config.snapshotWidth = NSNumber(value: 400)
            webView.takeSnapshot(with: config) { [weak self] image, _ in
                self?.finish(image)
            }
        }
    }

    private func finish(_ image: UIImage?) {
        for timer in timers { timer.cancel() }
        timers = []
        if let webView {
            webView.stopLoading()
            webView.navigationDelegate = nil
            if isCanvas {
                webView.configuration.userContentController.removeScriptMessageHandler(forName: "canvas")
            }
            webView.removeFromSuperview()
            self.webView = nil
        }
        continuation?.resume(returning: image)
        continuation = nil
    }

    // MARK: canvas 协议

    private func sendLoad() {
        guard !loaded, let webView, case .canvas(let text, let path, let chatId) = source,
              let window = webView.window
        else { return }
        seq += 1
        let payload: [String: Any] = [
            "type": "canvas:load",
            "seq": seq,
            "source": text,
            "path": path,
            "chatId": chatId,
            "palette": JieboTheme.shared.palette.rawValue,
            "theme": Self.themeKind(window),
        ]
        webView.callAsyncJavaScript(
            "window.postMessage(payload, '*')",
            arguments: ["payload": payload],
            in: nil,
            in: .page
        ) { _ in }
        // loaded 丢了就 250ms 后重发；运行时按 identity 去重，只回 loaded 不重编译
        schedule(after: 0.25) { [weak self] in self?.sendLoad() }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "canvas", let dict = message.body as? [String: Any],
              let type = dict["type"] as? String
        else { return }
        switch type {
        case "canvas:ready":
            sendLoad()
        case "canvas:loaded":
            // 同一个任务只推同一份源码，任何一次 loaded 都算数
            guard !loaded else { return }
            loaded = true
            capture(after: 0.3)
        case "canvas:error":
            // message 为 null 表示编译成功清错，只有真错误才放弃
            if dict["message"] is String { finish(nil) }
        default:
            break
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let mainFrame = navigationAction.targetFrame?.isMainFrame == true
        if isCanvas {
            // 运行时首屏（含重定向）放行，之后主框不许跳走
            return mainFrame && committed ? .cancel : .allow
        }
        guard mainFrame else { return .cancel }
        let url = navigationAction.request.url?.absoluteString ?? ""
        if !committed, url.hasPrefix("about:blank") { return .allow }
        return .cancel
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        committed = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !isCanvas else { return }
        capture(after: 0.15)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(nil)
    }

    private func report(_ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        guard !committed else { return }
        finish(nil)
    }

    /// 在 rewriteHtml 的 CSP 之外再叠一条：多条 CSP 同时生效取交集。
    /// 禁脚本、联网、子框架和插件；img/style/font 不限，静态渲染照常
    private static let lockDownMeta = "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">"

    private static func lockDown(_ html: String) -> String {
        var result = html
        if let range = result.range(of: #"<head(?:\s[^>]*)?>"#, options: [.regularExpression, .caseInsensitive]) {
            result.insert(contentsOf: lockDownMeta, at: range.upperBound)
            return result
        }
        if let range = result.range(of: #"<html[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            result.insert(contentsOf: "<head>\(lockDownMeta)</head>", at: range.upperBound)
            return result
        }
        return "<!doctype html><html><head><meta charset=\"utf-8\">\(lockDownMeta)</head><body>\(result)</body></html>"
    }

    private static var hostWindow: UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.first
    }

    private static func themeKind(_ window: UIWindow) -> String {
        switch JieboTheme.shared.appearance {
        case .light: return "light"
        case .dark: return "dark"
        case .system: return window.traitCollection.userInterfaceStyle == .dark ? "dark" : "light"
        }
    }

    private static let canvasBridge = """
    window.addEventListener('message', function(e) {
      var d = e.data;
      if (d && typeof d.type === 'string' && d.type.indexOf('canvas:') === 0 && d.type !== 'canvas:load') {
        window.webkit.messageHandlers.canvas.postMessage(d);
      }
    });
    """
}

// MARK: - 下载与解码（不在主线程）

private enum ThumbRender {
    static func fetch(_ url: URL, limit: Int = 32 * 1024 * 1024) async -> Data? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (200 ..< 300).contains((response as? HTTPURLResponse)?.statusCode ?? 0),
              data.count <= limit
        else { return nil }
        return data
    }

    /// 文本类：content 优先，没有再按 url 拉
    static func text(content: String?, url: URL?) async -> String? {
        if let content, !content.isEmpty { return content }
        guard let url, let data = await fetch(url, limit: 8 * 1024 * 1024) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func downsample(_ data: Data, maxPixel: Int) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: image)
    }

    static func pdfThumbnail(_ data: Data) -> UIImage? {
        guard let page = PDFDocument(data: data)?.page(at: 0) else { return nil }
        return page.thumbnail(of: CGSize(width: 640, height: 900), for: .mediaBox)
    }

    static func videoFrame(_ url: URL) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 640, height: 640)
        guard let (image, _) = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: image)
    }

    /// 前 6 行非空文本，去掉标题的 #、代码围栏和分隔线
    static func markdownPreview(_ text: String) -> String? {
        var lines: [String] = []
        for raw in text.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") || line == "---" || line == "***" { continue }
            while line.hasPrefix("#") { line.removeFirst() }
            line = line.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            lines.append(String(line.prefix(160)))
            if lines.count >= 6 { break }
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// 同 SVGFileView：<img> 包装页，不执行 SVG 内嵌脚本
    static func imgDocument(_ url: URL) -> String {
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
        <body><img src="\(src)"></body></html>
        """
    }
}

// MARK: - 磁盘缓存

/// Caches/JieboCache/<租户>/thumbs/：ChatCache.clear(tenant:) / clearAll() 删租户目录时一起清掉。
/// 只存有 sha 的快照缩略图；超过 50MB 按修改时间从旧删。
/// 读、写、修剪、清理全排在同一条串行队列上：reset 之前排的写先落盘再被 clear 删掉，
/// 之后才执行的旧 epoch 写入直接跳过，不会把已退出租户的目录写回来。
private enum ThumbDisk {
    static let maxBytes = 50 * 1024 * 1024
    private static let queue = DispatchQueue(label: "ai.jiebo.thumbs", qos: .utility)
    /// 以下只在 queue 上读写
    private static var writes = 0
    /// 最近一次 clear 时的 ThumbnailStore.epoch
    private static var currentEpoch = 0

    /// tenant 为空（登出）：删所有租户下的 thumbs
    static func clear(tenant: String, epoch: Int) {
        queue.async {
            currentEpoch = epoch
            let fm = FileManager.default
            let tenantDirs: [URL]
            if tenant.isEmpty {
                guard let root = rootDir,
                      let names = try? fm.contentsOfDirectory(atPath: root.path)
                else { return }
                tenantDirs = names.map { root.appendingPathComponent($0, isDirectory: true) }
            } else {
                guard let dir = thumbsDir(tenant)?.deletingLastPathComponent() else { return }
                tenantDirs = [dir]
            }
            for dir in tenantDirs {
                try? fm.removeItem(at: dir.appendingPathComponent("thumbs", isDirectory: true))
                // ChatCache 已先删掉租户目录时，别留下只剩空壳的目录
                if let rest = try? fm.contentsOfDirectory(atPath: dir.path), rest.isEmpty {
                    try? fm.removeItem(at: dir)
                }
            }
        }
    }

    static func load(tenant: String, key: String) async -> ThumbState? {
        await withCheckedContinuation { (continuation: CheckedContinuation<ThumbState?, Never>) in
            queue.async {
                continuation.resume(returning: read(tenant: tenant, key: key))
            }
        }
    }

    static func save(_ state: ThumbState, tenant: String, key: String, epoch: Int) {
        queue.async {
            guard epoch == currentEpoch, let dir = thumbsDir(tenant) else { return }
            let data: Data?
            let ext: String
            switch state {
            case .image(let image):
                data = image.jpegData(compressionQuality: 0.8)
                ext = "jpg"
            case .text(let text):
                data = Data(text.utf8)
                ext = "txt"
            default:
                return
            }
            guard let data else { return }
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try data.write(to: dir.appendingPathComponent(fileName(key)).appendingPathExtension(ext), options: .atomic)
            } catch {
                return
            }
            writes += 1
            if writes % 8 == 1 { prune(dir) }
        }
    }

    private static func read(tenant: String, key: String) -> ThumbState? {
        guard let dir = thumbsDir(tenant) else { return nil }
        let base = dir.appendingPathComponent(fileName(key))
        let jpg = base.appendingPathExtension("jpg")
        if let data = try? Data(contentsOf: jpg), let image = UIImage(data: data) {
            touch(jpg)
            return .image(image)
        }
        let txt = base.appendingPathExtension("txt")
        if let text = try? String(contentsOf: txt, encoding: .utf8), !text.isEmpty {
            touch(txt)
            return .text(text)
        }
        return nil
    }

    private static func touch(_ url: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
    }

    private static func prune(_ dir: URL) {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let urls = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
        var entries: [(url: URL, date: Date, bytes: Int)] = urls.compactMap { url in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url: url, date: values.contentModificationDate ?? .distantPast, bytes: values.fileSize ?? 0)
        }
        var total = entries.reduce(0) { $0 + $1.bytes }
        guard total > maxBytes else { return }
        entries.sort { $0.date < $1.date }
        for entry in entries where total > maxBytes {
            try? fm.removeItem(at: entry.url)
            total -= entry.bytes
        }
    }

    private static func fileName(_ key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// 目录名必须和 ChatCache.tenantDir 一致（同一套 safeName），清缓存才删得到
    private static var rootDir: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("JieboCache", isDirectory: true)
    }

    private static func thumbsDir(_ tenant: String) -> URL? {
        guard !tenant.isEmpty else { return nil }
        return rootDir?
            .appendingPathComponent(safeName(tenant), isDirectory: true)
            .appendingPathComponent("thumbs", isDirectory: true)
    }

    private static func safeName(_ raw: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        let kept = String(raw.map { allowed.contains($0) ? $0 : "_" }.prefix(80))
        if kept == raw { return raw }
        return kept + "-" + fnv1a(Data(raw.utf8))
    }

    private static func fnv1a(_ data: Data) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            for byte in buffer {
                hash ^= UInt64(byte)
                hash = hash &* 0x0000_0100_0000_01b3
            }
        }
        return String(hash, radix: 16)
    }
}
