import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    func toolSelected(_ layer: ToolLayer) -> Bool {
        switch layer {
        case .files: return fileBrowserOpen && fileBrowserPane == .files
        case .search: return fileBrowserOpen && fileBrowserPane == .search
        case .git: return fileBrowserOpen && fileBrowserPane == .git
        default: return toolLayer == layer
        }
    }

    /// 工作台写着「回到小驳」时，点状态句切回小驳。审批卡在小驳输入框上方，不在工作台工具层。
    func requestReturnToAssistant() {
        returnToAssistantRequest += 1
    }

    /// 工作台写着「待批在待处理」时，点状态句打开待处理。今日只剩摘要，没有批准按钮。
    func requestOpenApprovals() {
        openApprovalsRequest += 1
    }

    func toggleTool(_ layer: ToolLayer) {
        if let pane = FileBrowserPane(layer) {
            toggleFileBrowser(pane)
            return
        }
        if contentDirty, !suppressContentDiscard {
            contentDiscardFollowup = toolLayer == layer ? .closeTool : .switchTool(layer)
            contentDiscardPrompt = true
            return
        }
        if toolLayer == .loop, layer != .loop { loopError = "" }
        if toolLayer == layer {
            toolLayer = nil
            closeContentLayer()
            if layer == .terminal {
                terminalFocusChatId = ""
                terminalFocusCallId = ""
            }
            if layer == .loop { loopError = "" }
            return
        }
        closeContentLayer()
        toolLayer = layer
        if layer == .terminal {
            terminalFocusChatId = ""
            terminalFocusCallId = ""
        }
    }

    /// 文件、搜索、改动都进同一张全屏浮层，左栏切换筛选。
    func toggleFileBrowser(_ pane: FileBrowserPane = .files) {
        if fileBrowserOpen, fileBrowserPane == pane {
            fileBrowserOpen = false
            return
        }
        let browserLayer = toolLayer == .files || toolLayer == .search || toolLayer == .git
        if browserLayer, contentDirty, !suppressContentDiscard {
            fileBrowserPane = pane
            contentDiscardFollowup = .openFileBrowser
            contentDiscardPrompt = true
            return
        }
        if browserLayer {
            let was = suppressContentDiscard
            suppressContentDiscard = true
            closeContentLayer()
            suppressContentDiscard = was
            toolLayer = nil
        }
        fileBrowserPane = pane
        fileBrowserOpen = true
        requestFileIndex(userInitiated: true)
    }

    /// 文件树在工作台。手机看到请求后切过去；浮层在切页之前就打开。
    func openFilesOnWorkbench() {
        workbenchFilesRequest += 1
        if !(fileBrowserOpen && fileBrowserPane == .files) {
            toggleFileBrowser(.files)
        }
    }

    /// 终端输出在工作台。先打开面板，再钉住会话；callId 为空就滚到最后一条。
    func openTerminalOnWorkbench(chatId: String, callId: String = "") {
        workbenchTerminalRequest += 1
        if toolLayer != .terminal {
            toggleTool(.terminal)
        }
        terminalFocusChatId = chatId
        terminalFocusCallId = callId
    }

    /// 文件名走本地索引，内容走 search_text。空查询不发请求。
    func scheduleSearch(chatId requestedId: String? = nil) {
        searchTask?.cancel()
        searchEpoch += 1
        let epoch = searchEpoch
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty {
            searchHits = []
            searchTruncated = false
            searchLoading = false
            searchContentNote = ""
            return
        }
        searchLoading = true
        searchHits = []
        searchTruncated = false
        searchContentNote = ""
        let chatId = requestedId ?? activeId
        searchTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, searchEpoch == epoch else { return }
            guard unlocked else {
                searchLoading = false
                searchContentNote = "还没登录。内容这次不会搜，登录后再搜。"
                return
            }
            guard client.isOpen else {
                searchLoading = false
                searchContentNote = linkState == .offline
                    ? "已断开。内容这次不会搜，点按重连后再搜。"
                    : "正在连接。内容这次不会搜，连上后再搜。"
                return
            }
            searchRequestChatId = chatId
            send(.searchText(query: query, chatId: chatId))
        }
    }

    /// 文件树点开：文本和 Markdown 可编辑，图片 / HTML / Canvas 等只读，二进制走 Quick Look。
    /// 换文件替换内容层，不另开右侧预览。
    func openContentFile(_ rawPath: String) {
        let path = relToCwd(rawPath.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !path.isEmpty, !path.hasSuffix("/"), path.lowercased() != "diff" else { return }
        let kind = previewKind(of: path)
        if !kind.panelRenderable {
            openMention(path)
            return
        }
        if contentPath == path, contentError == nil, !contentDiff { return }
        if contentDirty, !suppressContentDiscard {
            contentDiscardFollowup = .openFile(path)
            contentDiscardPrompt = true
            return
        }
        if contentPath == nil {
            contentRestorePreview = previewPanelOpen ? previewActivePath : nil
        }
        if contentPath != path { contentSaves.removeAll() }
        contentLoadEpoch += 1
        let epoch = contentLoadEpoch
        contentChatId = activeId
        contentPath = path
        contentDiff = false
        contentKind = kind
        contentError = nil
        contentOversized = false
        contentOriginal = ""
        contentDraft = ""
        if kind == .text || kind == .markdown {
            if let blocked = contentReadBlockedTitle() {
                contentLoading = false
                contentError = blocked
                return
            }
            contentLoading = true
            send(.readFile(path: path, chatId: contentChatId, diff: false))
            armContentWatchdog(path: path, epoch: epoch)
        } else {
            contentLoading = false
            openPreviewTab(path: path, kind: kind, diff: false)
            previewActivePath = contentRestorePreview
        }
    }

    /// Git 列表点开：diff 叠在工具层上。图片走预览页签，其余把 diff 文本放进内容层。
    func openContentDiff(_ rawPath: String) {
        let path = relToCwd(rawPath.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !path.isEmpty, !path.hasSuffix("/") else { return }
        if contentPath == path, contentDiff, contentError == nil { return }
        if contentDirty, !suppressContentDiscard {
            contentDiscardFollowup = .openDiff(path)
            contentDiscardPrompt = true
            return
        }
        if contentPath == nil {
            contentRestorePreview = previewPanelOpen ? previewActivePath : nil
        }
        if contentPath != path { contentSaves.removeAll() }
        contentLoadEpoch += 1
        let epoch = contentLoadEpoch
        let kind = previewKind(of: path)
        contentChatId = activeId
        contentPath = path
        contentDiff = true
        contentKind = kind
        contentError = nil
        contentOversized = false
        contentOriginal = ""
        contentDraft = ""
        if kind == .image || kind == .svg {
            contentLoading = false
            openPreviewTab(path: path, kind: kind, diff: true)
            previewActivePath = contentRestorePreview
        } else {
            if let blocked = contentReadBlockedTitle() {
                contentLoading = false
                contentError = blocked
                return
            }
            contentLoading = true
            send(.readFile(path: path, chatId: contentChatId, diff: true))
            armContentWatchdog(path: path, epoch: epoch)
        }
    }

    /// 正文和改动都靠 read_file。还没登录或没连上时不发，免得八秒后写成读取超时。
    func contentReadBlockedTitle() -> String? {
        guard unlocked else { return "还没登录。这次不会读，登录后再打开。" }
        guard client.isOpen else {
            return linkState == .offline
                ? "已断开。这次不会读，点按重连后再打开。"
                : "正在连接。这次不会读，连上后再打开。"
        }
        return nil
    }

    /// 预览里的图片下不来。已经连上时才是加载失败。
    var previewImageFailedTitle: String {
        guard unlocked else { return "还没登录。登录后再看这张图。" }
        guard connected else {
            return linkState == .offline
                ? "已断开。点按重连后再看这张图。"
                : "正在连接。连上后再看这张图。"
        }
        return "图片加载失败"
    }

    /// 预览里的 SVG 下不来。已经连上时才是加载失败。
    var previewSvgFailedTitle: String {
        guard unlocked else { return "还没登录。登录后再看这个 SVG。" }
        guard connected else {
            return linkState == .offline
                ? "已断开。点按重连后再看这个 SVG。"
                : "正在连接。连上后再看这个 SVG。"
        }
        return "SVG 加载失败"
    }

    /// 预览里的 PDF 下不来。已经连上时才是加载失败或文件过大。
    var previewPdfFailedTitle: String {
        guard unlocked else { return "还没登录。登录后再看这个 PDF。" }
        guard connected else {
            return linkState == .offline
                ? "已断开。点按重连后再看这个 PDF。"
                : "正在连接。连上后再看这个 PDF。"
        }
        return "PDF 加载失败或文件过大"
    }

    /// 预览里的音视频下不来。已经连上时才是加载失败。
    var previewMediaFailedTitle: String {
        guard unlocked else { return "还没登录。登录后再看这段音视频。" }
        guard connected else {
            return linkState == .offline
                ? "已断开。点按重连后再看这段音视频。"
                : "正在连接。连上后再看这段音视频。"
        }
        return "媒体加载失败"
    }

    func keepContentDiff() {
        guard let path = contentPath, contentDiff else { return }
        contentDiff = false
        contentPath = nil
        openContentFile(path)
    }

    func revertContentFile() {
        guard let path = contentPath else { return }
        let chatId = contentChatId ?? activeId
        guard chats.contains(where: { $0.id == chatId }) else {
            flash("这个会话已经不在了，没法还原")
            return
        }
        if !client.isOpen {
            flash(linkState == .offline
                ? "已断开。还原会在连上后发出。"
                : "正在连接。还原会在连上后发出。")
        }
        send(.revertFile(chatId: chatId, path: path))
    }

    func closeContentLayer() {
        if contentDirty, !suppressContentDiscard {
            contentDiscardFollowup = .closeContent
            contentDiscardPrompt = true
            return
        }
        contentLoadEpoch += 1
        contentSaves.removeAll()
        contentChatId = nil
        contentPath = nil
        contentOriginal = ""
        contentDraft = ""
        contentLoading = false
        contentError = nil
        contentOversized = false
        contentDiff = false
    }

    func confirmContentDiscard() {
        let followup = contentDiscardFollowup
        contentDiscardPrompt = false
        contentDiscardFollowup = nil
        suppressContentDiscard = true
        switch followup {
        case .closeContent, nil:
            closeContentLayer()
        case .closeTool:
            toolLayer = nil
            loopError = ""
            closeContentLayer()
        case .switchTool(let layer):
            if let pane = FileBrowserPane(layer) {
                toolLayer = nil
                closeContentLayer()
                fileBrowserPane = pane
                fileBrowserOpen = true
                requestFileIndex(userInitiated: true)
                break
            }
            if toolLayer == .loop, layer != .loop { loopError = "" }
            closeContentLayer()
            toolLayer = layer
        case .openFileBrowser:
            toolLayer = nil
            closeContentLayer()
            fileBrowserOpen = true
            requestFileIndex(userInitiated: true)
        case .openFile(let path):
            openContentFile(path)
        case .openDiff(let path):
            openContentDiff(path)
        case .selectChat(let id):
            select(id)
        case .deleteChat(let id):
            deleteChat(id)
        }
        suppressContentDiscard = false
    }

    func cancelContentDiscard() {
        contentDiscardPrompt = false
        contentDiscardFollowup = nil
    }

    func saveContentLayer() {
        guard let path = contentPath, contentDirty, !contentOversized,
              (contentKind == .text || contentKind == .markdown) else { return }
        guard let chatId = contentChatId, chats.contains(where: { $0.id == chatId }) else {
            flash("这个会话已经不在了，没法保存")
            return
        }
        let snapshot = contentDraft
        if snapshot.utf16.count > Self.contentSaveLimit {
            flash("内容超过 500KB，不在这里保存")
            return
        }
        contentSaves.append((path: path, snapshot: snapshot))
        send(.writeFile(path: path, content: snapshot, chatId: chatId))
        if !client.isOpen {
            flash(linkState == .offline
                ? "已断开。改动会在连上后写入。"
                : "正在连接。改动会在连上后写入。")
        }
    }

    func acceptContentText(_ text: String) {
        contentLoading = false
        contentError = nil
        let edited = contentDraft != contentOriginal
        if !edited, text.utf16.count > Self.contentSaveLimit {
            contentOversized = true
            contentOriginal = text
            contentDraft = text
            return
        }
        contentOversized = false
        contentOriginal = text
        if !edited { contentDraft = text }
    }

    func hydrateContentText(path: String, urlString: String, epoch: Int) {
        guard let url = GatewayConfig.resolveHTTP(urlString) else {
            contentLoading = false
            contentError = "读不到这个文件"
            return
        }
        if let blocked = contentReadBlockedTitle() {
            contentLoading = false
            contentError = blocked
            return
        }
        let tenantAtStart = tenantId
        Task { @MainActor [weak self] in
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 60
                let (data, response) = try await AppTrafficHTTP.data(for: request, category: "工具文件下载")
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200 ..< 300).contains(code), let text = String(data: data, encoding: .utf8) else {
                    throw PreviewError.http(code)
                }
                guard let self, self.tenantId == tenantAtStart, self.contentLoadEpoch == epoch, self.contentPath == path else { return }
                self.acceptContentText(text)
            } catch {
                guard let self, self.tenantId == tenantAtStart, self.contentLoadEpoch == epoch, self.contentPath == path else { return }
                self.contentLoading = false
                self.contentError = self.contentReadBlockedTitle() ?? self.hydrateFailureTitle(error)
            }
        }
    }

    /// 大文件正文下载失败。还没登录或没连上时由调用方先用连接句。链路还在时不接系统原文。
    func hydrateFailureTitle(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut:
                return "这次读取超时了，点重试再试一次。"
            case .cancelled:
                return "这次读取取消了。"
            case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
                 .cannotFindHost, .dnsLookupFailed, .dataNotAllowed, .internationalRoamingOff:
                return "网络中断了，点重试再试一次。"
            default:
                return "读不到这个文件，点重试再试一次。"
            }
        }
        if let text = (error as? LocalizedError)?.errorDescription, !text.isEmpty {
            return text
        }
        return "读不到这个文件，点重试再试一次。"
    }

    func armContentWatchdog(path: String, epoch: Int) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self, self.contentLoadEpoch == epoch, self.contentPath == path, self.contentLoading else { return }
            self.contentLoading = false
            self.contentError = self.contentReadBlockedTitle() ?? "读取超时。点重试再试一次。"
        }
    }

    func startActiveLoop(goal: String, intervalSec: Int, maxTicks: Int?) {
        let trimmed = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            loopError = "Loop 需要一段目标"
            return
        }
        if trimmed.count > 4000 {
            loopError = "Loop 目标超过 4000 字"
            return
        }
        if !(30...86_400).contains(intervalSec) {
            loopError = "间隔要在 30 秒到 24 小时之间"
            return
        }
        if let maxTicks, !(1...100).contains(maxTicks) {
            loopError = "最多 1 到 100 拍"
            return
        }
        guard unlocked else {
            loopError = "还没登录。这次不会开始，登录后再试。"
            return
        }
        guard client.isOpen else {
            loopError = linkState == .offline
                ? "已断开。这次不会开始，点按重连后再试。"
                : "正在连接。这次不会开始，连上后再试。"
            return
        }
        loopError = ""
        send(.loopStart(
            chatId: activeId,
            goal: trimmed,
            intervalSec: intervalSec,
            maxTicks: maxTicks,
            model: model,
            mode: mode
        ))
    }

    func stopActiveLoop() {
        guard unlocked else {
            loopError = "还没登录。这次不会停止，登录后再试。"
            return
        }
        guard client.isOpen else {
            loopError = linkState == .offline
                ? "已断开。这次不会停止，点按重连后再试。"
                : "正在连接。这次不会停止，连上后再试。"
            return
        }
        send(.loopStop(chatId: activeId))
    }

    /// 缩略图旁路读取：带 reqId，回包不进页签/内容层
    func sendThumbnailRead(path: String, chatId: String, sha: String?, reqId: String) {
        send(.readFile(path: path, chatId: chatId, diff: false, sha: sha, reqId: reqId))
    }
}
