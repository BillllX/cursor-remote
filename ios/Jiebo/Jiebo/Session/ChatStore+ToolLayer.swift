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
        if toolLayer == .loop, layer != .loop { loopError = "" }
        if toolLayer == layer {
            toolLayer = nil
            if layer == .terminal {
                terminalFocusChatId = ""
                terminalFocusCallId = ""
            }
            if layer == .loop { loopError = "" }
            return
        }
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
        if browserLayer {
            toolLayer = nil
        }
        fileBrowserPane = pane
        fileBrowserOpen = true
        requestFileIndex(userInitiated: true)
    }

    /// 文件树在工作台。先把活动会话对准正在看的子工作区，再打开浮层。
    /// 否则列表会跟着助理会话，而助理会话的目录是用户根目录。
    func openFilesOnWorkbench(chatId: String? = nil) {
        let explicit = chatId.flatMap { isWorkspaceChat($0) ? $0 : nil }
        if let target = explicit ?? preferredWorkspaceChatId() {
            activateWorkspaceChat(target)
        }
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

    func previewTextEditable(_ tab: PreviewTab) -> Bool {
        guard !tab.diff,
              tab.readSha == nil,
              !tab.loading,
              tab.error == nil,
              tab.kind == .text || tab.kind == .markdown,
              let content = tab.content
        else { return false }
        return content.utf16.count <= Self.contentSaveLimit
    }

    func previewDiffRevertable(_ tab: PreviewTab) -> Bool {
        guard tab.diff, tab.readSha == nil else { return false }
        let key = relToCwd(tab.path, chatId: tab.chatId ?? activeId)
        return gitStatus[tab.path] != nil || (!key.isEmpty && gitStatus[key] != nil)
    }

    func savePreviewText(_ tab: PreviewTab, content: String) {
        guard content.utf16.count <= Self.contentSaveLimit else {
            flash("内容超过 500KB，不在这里保存")
            return
        }
        let chatId = tab.chatId ?? activeId
        guard chats.contains(where: { $0.id == chatId }) else {
            flash("这个会话已经不在了，没法保存")
            return
        }
        let previous = tab.content ?? ""
        previewSaves.append(PreviewSave(path: tab.path, chatId: chatId, previous: previous, snapshot: content))
        send(.writeFile(path: tab.path, content: content, chatId: chatId))
        if let index = previewTabs.firstIndex(where: { $0.path == tab.path && $0.diff == tab.diff }) {
            previewTabs[index].content = content
        }
        if !client.isOpen {
            flash(linkState == .offline
                ? "已断开。改动会在连上后写入。"
                : "正在连接。改动会在连上后写入。")
        }
    }

    func revertPreviewFile(_ tab: PreviewTab) {
        let chatId = tab.chatId ?? activeId
        guard chats.contains(where: { $0.id == chatId }) else {
            flash("这个会话已经不在了，没法还原")
            return
        }
        if !client.isOpen {
            flash(linkState == .offline
                ? "已断开。还原会在连上后发出。"
                : "正在连接。还原会在连上后发出。")
        }
        send(.revertFile(chatId: chatId, path: tab.path))
        if let index = previewTabs.firstIndex(where: { $0.path == tab.path && $0.diff == tab.diff }) {
            previewTabs[index].loading = true
        }
    }

    /// 缩略图旁路读取：带 reqId，回包不进页签/内容层
    func sendThumbnailRead(path: String, chatId: String, sha: String?, reqId: String) {
        send(.readFile(path: path, chatId: chatId, diff: false, sha: sha, reqId: reqId))
    }
}
