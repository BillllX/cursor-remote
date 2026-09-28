import SwiftUI
import WebKit

// P5d canvas：WKWebView 加载同域部署的 /canvas-runtime（网页 CanvasHost 的 iOS 版宿主）。
// 协议对齐 web/components/CanvasHost.tsx + CanvasRuntime.tsx：
//   宿主 → 运行时：window.postMessage({type:"canvas:load", seq, source, path, chatId})
//   运行时 → 宿主：canvas:ready / canvas:loaded(seq) / canvas:error(message) / canvas:action(action, path)
// 运行时页面在 WKWebView 里是顶层 frame，window.parent === window，
// 所以运行时的 postMessage 以 message 事件回环到自身——注入用户脚本把 canvas:* 转发给 Swift；
// Swift 侧用 callAsyncJavaScript 发 window.postMessage 反向送达。
// 本地 dev（127.0.0.1/localhost）网关不服务 web 路由 → 上层直接降级源码视图，不进本视图。

struct CanvasFileView: View {
    let source: String
    let path: String
    let chatId: String
    /// canvas 内 openFile 动作 → 开预览页签
    let onOpenFile: (String) -> Void
    /// 失败/超时 → 切源码视图
    let onFallback: () -> Void

    @State private var status: Status = .loading
    @State private var errorText: String?
    /// 运行时页面是否已就绪（决定超时阈值：就绪前 15s / 就绪后 8s，对齐网页）
    @State private var didReady = false
    @State private var boot = 0
    /// 未就绪超时的自动重建次数（对齐网页 retriesRef < 1：只自动再来一次）
    @State private var bootRetries = 0

    enum Status { case loading, ready, error }

    var body: some View {
        ZStack {
            CanvasWebView(
                source: source,
                path: path,
                chatId: chatId,
                onReady: { didReady = true },
                onLoaded: {
                    status = .ready
                    errorText = nil
                    bootRetries = 0 // 对齐网页 retriesRef=0：成功后恢复自动重建额度
                },
                onError: { message in
                    // 编译错误运行时已自渲染（CanvasError）；null 表示编译成功，清掉上一轮残留
                    errorText = message
                },
                onFail: { message in
                    status = .error
                    errorText = message
                },
                onAction: handleAction
            )
            // boot 重试 → 重建 WKWebView 与 Coordinator（页签隔离由外层 CanvasFileView 的 .id 负责）
            .id(boot)
            .background(JieboColor.paper)
            if status != .ready {
                VStack(spacing: 12) {
                    if status == .error {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 22))
                            .foregroundStyle(JieboColor.danger)
                        Text(errorText ?? "画布打开超时。点重试，或切到源码看看。")
                            .font(JieboFont.ui(13))
                            .foregroundStyle(JieboColor.ink2)
                            .multilineTextAlignment(.center)
                        HStack(spacing: 16) {
                            // P6：源码是可落地的出口，升为主按钮；重试降为次按钮
                            Button("查看源码", action: onFallback)
                                .padding(.horizontal, 14)
                                .frame(height: 32)
                                .background(JieboColor.pine)
                                .foregroundStyle(JieboColor.paper)
                                .clipShape(Capsule())
                                .hitTarget()
                            Button("重试") {
                                status = .loading
                                errorText = nil
                                didReady = false
                                boot += 1 // .id 变化 → 重建 WebView 重新加载运行时
                            }
                            .foregroundStyle(JieboColor.ink2)
                            .hitTarget()
                        }
                        .font(JieboFont.ui(13, weight: .medium))
                    } else {
                        ProgressView().controlSize(.regular).tint(JieboColor.dim)
                        Text("正在打开画布…")
                            .font(JieboFont.ui(13))
                            .foregroundStyle(JieboColor.dim)
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(JieboColor.paper)
            }
        }
        // source 变化（同页签内 agent 改写了画布）→ 回到 loading，对齐网页 setStatus(ready→loading)
        .onChange(of: source) { _, _ in
            if status == .ready { status = .loading }
            errorText = nil
        }
        // 超时：就绪前 15s / 就绪后 8s（对齐网页 readyRef ? 8000 : 15000）；payload/boot 变化重置计时。
        // 未就绪超时先自动重建一次（对齐网页 retriesRef），再不行才报错
        .task(id: "\(boot)\u{0}\(path)\u{0}\(chatId)\u{0}\(source)") {
            try? await Task.sleep(for: .seconds(didReady ? 8 : 15))
            guard !Task.isCancelled, status != .ready else { return }
            if !didReady, bootRetries < 1 {
                bootRetries += 1
                boot += 1
                return
            }
            status = .error
            errorText = "画布打开超时。点重试，或切到源码看看。"
        }
    }

    private func handleAction(_ action: JSONValue) {
        // CanvasAction：openAgent/newComposerChat 是桌面端能力，iOS 只接 openFile
        guard action.string(in: "type") == "openFile" else { return }
        let path = action.string(in: "path").nilIfEmpty ?? ""
        if !path.isEmpty { onOpenFile(path) }
    }
}

private struct CanvasWebView: UIViewRepresentable {
    let source: String
    let path: String
    let chatId: String
    let onReady: () -> Void
    let onLoaded: () -> Void
    let onError: (String?) -> Void
    /// 页面加载失败/内容进程崩溃 → 错误态（可重试恢复）
    let onFail: (String) -> Void
    let onAction: (JSONValue) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let bridge = WKUserScript(
            source: """
            window.addEventListener('message', function(e) {
              var d = e.data;
              if (d && typeof d.type === 'string' && d.type.indexOf('canvas:') === 0 && d.type !== 'canvas:load') {
                window.webkit.messageHandlers.canvas.postMessage(d);
              }
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(bridge)
        config.userContentController.add(context.coordinator, name: "canvas")
        let webView = WKWebView(frame: .zero, configuration: config)
        // 运行时跟当前明暗（buildHostTheme），透明底 + 面板 paper 衬底，避免过滚时闪边
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.navigationDelegate = context.coordinator
        if let url = GatewayConfig.canvasRuntimeURL {
            webView.load(URLRequest(url: url))
        } else {
            // 防御性死路径（上层已拦截 nil）：走 onFail 进错误态，别只设 errorText 空转
            context.coordinator.reportFail("当前网关不提供画布运行时")
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // source 变化 → 运行时里重编译（对齐网页 payloadRef + sendRef 的推送路径）
        context.coordinator.parent = self
        context.coordinator.pushLoadIfReady(webView)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.invalidate()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "canvas")
        webView.stopLoading()
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: CanvasWebView
        private var ready = false
        /// 最近一次发出的 canvas:load 的 seq（对齐网页 expectRef：只认最新 load 的 loaded 回包）
        private var seq = 0
        /// 已收到 loaded 的 seq；seq > loadedSeq 时按 250ms 间隔重发（对齐网页 setInterval 250）
        private var loadedSeq = 0
        /// \0 分隔（对齐网页运行时 identity），避免 path 含空格时边界碰撞
        private var lastSentIdentity = ""
        private var resendWork: DispatchWorkItem?

        init(_ parent: CanvasWebView) { self.parent = parent }

        func invalidate() {
            resendWork?.cancel()
            resendWork = nil
        }

        func reportError(_ message: String) {
            DispatchQueue.main.async { self.parent.onError(message) }
        }

        func reportFail(_ message: String) {
            DispatchQueue.main.async { self.parent.onFail(message) }
        }

        // MARK: WKNavigationDelegate（内容进程崩溃/加载失败 → 错误态，重试可恢复）

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            invalidate()
            reportFail("画布进程崩溃了，点重试恢复")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            // dismantle 里的 stopLoading 会触发 cancelled，别误报
            if (error as NSError).code == NSURLErrorCancelled { return }
            invalidate()
            reportFail("画布运行时加载失败：\(error.localizedDescription)")
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "canvas", let dict = message.body as? [String: Any],
                  let type = dict["type"] as? String else { return }
            switch type {
            case "canvas:ready":
                ready = true
                parent.onReady()
                if let webView = message.webView { pushLoad(webView, force: true) }
            case "canvas:loaded":
                // 只认最新一次 load 的回包（对齐网页 expectRef 校验）；无 seq 的旧运行时放行
                if let echoed = dict["seq"] as? Int, echoed != seq { return }
                loadedSeq = seq
                resendWork?.cancel()
                parent.onLoaded()
            case "canvas:error":
                parent.onError(dict["message"] as? String)
            case "canvas:action":
                if let action = dict["action"] {
                    parent.onAction(JSONValue(action))
                }
            default:
                break
            }
        }

        /// source/path/chatId 变化时推送 canvas:load；运行时会按 identity 去重，这里也先本地去重
        func pushLoadIfReady(_ webView: WKWebView) {
            guard ready else { return }
            pushLoad(webView, force: false)
        }

        func pushLoad(_ webView: WKWebView, force: Bool) {
            let identity = "\(parent.path)\u{0}\(parent.chatId)\u{0}\(parent.source)"
            if !force, identity == lastSentIdentity { return }
            lastSentIdentity = identity
            sendLoad(webView)
        }

        private func sendLoad(_ webView: WKWebView) {
            let source = parent.source
            guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            seq += 1
            let payload: [String: Any] = [
                "type": "canvas:load",
                "seq": seq,
                "source": source,
                "path": parent.path,
                "chatId": parent.chatId,
            ]
            // arguments 传递，避免字符串插值拼 JS（payload 作为 JS 变量注入）
            webView.callAsyncJavaScript(
                "window.postMessage(payload, '*')",
                arguments: ["payload": payload],
                in: nil,
                in: .page
            ) { _ in }
            scheduleResend(from: webView)
        }

        /// 对齐网页 250ms 重发：loaded 丢失（回包未投递）时持续重发 canvas:load，
        /// 运行时 identity 相同会只回 loaded 不重编译，代价极低
        private func scheduleResend(from webView: WKWebView) {
            resendWork?.cancel()
            let work = DispatchWorkItem { [weak self, weak webView] in
                guard let self, let webView else { return }
                guard self.ready, self.seq > self.loadedSeq else { return }
                self.sendLoad(webView)
            }
            resendWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
        }
    }
}
