import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    /// 切工作区后重拉所有打开的页签（对齐网页 per-chat tabs 的意图：内容不能跨工作区复用）
    func reloadPreviewTabs() {
        for index in previewTabs.indices {
            // 卡片页签钉在自己的会话：只有它就是当前会话时才重拉（检查点还原），chatId/cwd 不换
            if previewTabs[index].fromCard {
                guard previewTabs[index].chatId == activeId else { continue }
                previewTabs[index].content = nil
                previewTabs[index].error = nil
                previewTabs[index].url = nil
                previewTabs[index].headUrl = nil
                previewTabs[index].media = nil
                previewTabs[index].loading = true
                sendTabRead(previewTabs[index])
                continue
            }
            previewTabs[index].content = nil
            previewTabs[index].error = nil
            // 媒体字段也是旧工作区的票据，一并清掉（否则切工作区后还加载旧文件）
            previewTabs[index].url = nil
            previewTabs[index].headUrl = nil
            previewTabs[index].media = nil
            previewTabs[index].mime = nil
            previewTabs[index].size = nil
            // cwd 快照同步刷新：内容来自新工作区，副标题不能还拼旧 cwd。
            // 注意用 active?.cwd——swapActive 先切 activeId 再调本函数，store.cwd 此刻可能还是旧值
            previewTabs[index].cwd = active?.cwd ?? cwd
            previewTabs[index].chatId = activeId // 票据将绑新会话（Kimi R2 N1：导出按旧会话 cwd 会拿错文件）
            previewTabs[index].loading = true
            sendTabRead(previewTabs[index])
        }
    }

    /// 网关是否认 read_file.sha。旧网关不认，发了也只会读到当前版本，干脆不发
    var supportsReadSha: Bool { gatewayFeatures.contains("read_sha") }

    /// 页签读文件用的会话：卡片页签按它自己的会话（委派子会话的工作区不同），其余跟 activeId
    func readChatId(_ tab: PreviewTab) -> String {
        tab.fromCard ? (tab.chatId ?? activeId) : activeId
    }

    /// 按页签当前的 diff/sha 发 read_file 并挂看门狗
    func sendTabRead(_ tab: PreviewTab) {
        send(.readFile(path: tab.path, chatId: readChatId(tab), diff: tab.diff, sha: supportsReadSha ? tab.readSha : nil))
        armPreviewWatchdog(path: tab.path)
    }

    /// loading 看门狗：outbox 挤掉/服务端丢包时给页签一个出口（网页 2.5s×4 重试的简化版）
    func armPreviewWatchdog(path: String) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self, let index = self.previewTabs.firstIndex(where: { $0.path == path }) else { return }
            let tab = self.previewTabs[index]
            if tab.loading, tab.content == nil, tab.error == nil {
                self.previewTabs[index].loading = false
                self.previewTabs[index].error = "读取超时。点重试再试一次。"
            }
        }
    }

    /// 工具卡「看改动」入口：归一路径后按类型路由——skipDiff 类型走 openPreview
    /// （markdown/html/canvas 开原文页签，pdf/audio 面板播放，binary 转 Quick Look），
    /// image/svg 开 diff 页签做双图对照（P5c），其余文本开 diff 页签
    func openToolFile(_ rawPath: String, chatId: String? = nil) {
        let path = chatId.map { relToCwd(rawPath, chatId: $0) } ?? relToCwd(rawPath)
        guard !path.isEmpty else { return }
        switch previewKind(of: path) {
        case .canvas, .markdown, .html, .pdf, .audio, .video:
            openPreview(path, chatId: chatId)
        default:
            openPreview(path, diff: true, chatId: chatId)
        }
    }

    /// canvas 页签的 源码/画布 切换（P5d）
    func toggleCanvasSource(_ path: String) {
        guard let index = previewTabs.firstIndex(where: { $0.path == path }) else { return }
        previewTabs[index].showSource.toggle()
    }

    /// 头部 diff/原文 切换
    func togglePreviewDiff(_ path: String) {
        guard let index = previewTabs.firstIndex(where: { $0.path == path }) else { return }
        let next = !previewTabs[index].diff
        previewTabs[index].diff = next
        previewTabs[index].content = nil
        previewTabs[index].error = nil
        previewTabs[index].url = nil // 清掉旧媒体地址，避免切换期间闪旧图
        previewTabs[index].headUrl = nil
        previewTabs[index].loading = true
        sendTabRead(previewTabs[index])
    }

    /// 工具参数/结果里提取文件路径（对齐网页 toolPath 的字段集）。
    /// string(in:) 无命中返回 ""，必须 nilIfEmpty 才能回退到 result
    static func toolPath(args: JSONValue?, result: JSONValue?) -> String? {
        args?.string(in: "path", "file", "target", "file_path", "uri", "filename", "image_path", "imagePath", "output_path", "outputPath").nilIfEmpty
            ?? result?.string(in: "path", "file", "file_path", "filename", "image_path", "imagePath", "output_path", "outputPath").nilIfEmpty
    }

    /// 绝对路径转工作区相对（对齐网页 relToCwd：反斜杠归一、去尾斜杠、去前导 ./）；
    /// 不在工作区里的返回归一化后的原路径；path == cwd 返回空串
    func relToCwd(_ path: String) -> String {
        relToCwd(path, root: active?.cwd?.nilIfEmpty ?? workspaceRoot.nilIfEmpty)
    }

    /// 按指定会话的工作区归一（卡片文件可能属于委派子会话，不能拿活跃会话的 cwd）
    func relToCwd(_ path: String, chatId: String) -> String {
        relToCwd(path, root: chats.first { $0.id == chatId }?.cwd?.nilIfEmpty ?? workspaceRoot.nilIfEmpty)
    }

    func relToCwd(_ path: String, root cwdRoot: String?) -> String {
        var p = path.replacingOccurrences(of: "\\", with: "/")
        while p.hasSuffix("/") { p.removeLast() }
        if p.hasPrefix("./") { p.removeFirst(2) }
        guard let cwdRaw = cwdRoot else { return p }
        var root = cwdRaw.replacingOccurrences(of: "\\", with: "/")
        while root.hasSuffix("/") { root.removeLast() }
        if p == root { return "" }
        if !root.isEmpty, p.hasPrefix(root + "/") {
            return String(p.dropFirst(root.count + 1))
        }
        return p
    }

    // MARK: P5 - 预览面板

    /// 从对话点文件：停在对话旁边，不把人带进文件浏览器。浏览器已经开着就在里面读。
    func openPreview(_ path: String, diff: Bool = false, chatId: String? = nil) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasSuffix("/"), trimmed.lowercased() != "diff" else {
            if !trimmed.isEmpty { flash("这类内容暂不支持预览") }
            return
        }
        if !fileBrowserOpen { previewExpanded = true }
        loadPreview(trimmed, diff: diff, chatId: chatId)
    }

    func expandPreview() {
        if previewActivePath == nil || !previewTabs.contains(where: { $0.path == previewActivePath }) {
            previewActivePath = previewTabs.last?.path
        }
        previewExpanded = previewActivePath != nil
    }

    func collapsePreview() {
        previewExpanded = false
    }

    /// 浮层已经在屏幕上时读文件。binary 仍走 Quick Look。
    func loadPreview(_ path: String, diff: Bool, chatId: String? = nil) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasSuffix("/"), trimmed.lowercased() != "diff" else { return }
        let kind = previewKind(of: trimmed)
        if kind.panelRenderable {
            openPreviewTab(path: trimmed, kind: kind, diff: diff, chatId: chatId)
        } else {
            openMention(trimmed, chatId: chatId)
        }
    }

    /// 打开/激活预览页签并发起 read_file；页签上限 8，超出挤掉最旧的（对齐网页 slice(-8)）。
    /// 绝对路径先归一到工作区相对（工具卡传来的可能是绝对路径；相对路径原样通过）
    /// chatId 给定 = 从文件卡片打开：页签钉在那个会话上读（委派子会话），sha/diffSha 指定某一轮的快照。
    /// chatId 为 nil 时保持原行为（跟随 activeId、读当前版本）
    func openPreviewTab(path rawPath: String, kind: PreviewKind? = nil, diff: Bool, chatId pinnedChatId: String? = nil, sha: String? = nil, diffSha: String? = nil) {
        let path = pinnedChatId.map { relToCwd(rawPath, chatId: $0) } ?? relToCwd(rawPath)
        let resolved = kind ?? previewKind(of: path)
        let wantSha = pinnedChatId != nil && supportsReadSha ? sha : nil
        let wantDiffSha = pinnedChatId != nil && supportsReadSha ? diffSha : nil
        if let index = previewTabs.firstIndex(where: { $0.path == path }) {
            var tab = previewTabs[index]
            previewActivePath = path
            previewExpanded = true
            let pinChanged = pinnedChatId.map { !tab.fromCard || tab.chatId != $0 || tab.sha != wantSha || tab.diffSha != wantDiffSha || tab.diff != diff } ?? tab.fromCard
            if pinChanged {
                // 换了会话或版本（或从卡片页签回到普通入口）：内容含义变了，整页重载
                tab.fromCard = pinnedChatId != nil
                tab.chatId = pinnedChatId
                tab.cwd = pinnedChatId.flatMap { id in chats.first { $0.id == id }?.cwd } ?? cwd
                tab.sha = wantSha
                tab.diffSha = wantDiffSha
                tab.diff = diff
                tab.kind = resolved
                tab.content = nil
                tab.error = nil
                tab.url = nil
                tab.headUrl = nil
                tab.media = nil
                tab.loading = true
                previewTabs[index] = tab
                sendTabRead(tab)
            } else if diff && !tab.diff {
                // diff 状态升级：内容含义变了，必须重拉；清掉旧媒体地址避免误标「新文件」/闪旧图
                tab.diff = true
                tab.content = nil
                tab.error = nil
                tab.url = nil
                tab.headUrl = nil
                tab.loading = true
                previewTabs[index] = tab
                sendTabRead(tab)
            } else if !diff && tab.diff {
                // 从对照回到文件本身：清掉 diff 媒体，否则图片/svg 会继续显示对照
                tab.diff = false
                tab.content = nil
                tab.error = nil
                tab.url = nil
                tab.headUrl = nil
                tab.loading = true
                previewTabs[index] = tab
                sendTabRead(tab)
            } else if tab.content == nil && tab.error == nil && !tab.loading && tab.mediaURL == nil {
                // 媒体页签已有 url 就不重发（content 恒 nil，重发只会白拉一趟）
                previewTabs[index].loading = true
                sendTabRead(previewTabs[index])
            }
            return
        }
        let tabCwd = pinnedChatId.flatMap { id in chats.first { $0.id == id }?.cwd } ?? cwd
        let tab = PreviewTab(path: path, kind: resolved, diff: diff, content: nil, error: nil, loading: true, url: nil, media: nil, chatId: pinnedChatId, cwd: tabCwd, sha: wantSha, diffSha: wantDiffSha, fromCard: pinnedChatId != nil)
        previewTabs.append(tab)
        if previewTabs.count > 8 { previewTabs.removeFirst(previewTabs.count - 8) }
        previewActivePath = path
        previewExpanded = true
        sendTabRead(tab)
    }

    /// 从文件卡片打开。代码/纯文本看这一轮的对照，其余可预览类型看文件本身，binary 走 Quick Look。
    /// 一律按卡片所属会话读，绝不 select 过去（iPhone 上 activeId 只能是助理会话）
    func openTurnFile(_ file: TurnFile, chatId: String) {
        let path = relToCwd(file.path, chatId: chatId)
        guard !path.isEmpty, !path.hasSuffix("/") else { return }
        switch file.kind {
        case .binary:
            openMention(path, chatId: chatId, sha: file.sha)
        case .text:
            // 有 diffSha 读这一轮的对照；没有就退回实时 diff（file.sha 留给切到原文时用）
            openPreviewTab(path: path, kind: .text, diff: true, chatId: chatId, sha: file.sha, diffSha: file.diffSha)
        default:
            openPreviewTab(path: path, kind: file.kind, diff: false, chatId: chatId, sha: file.sha)
        }
    }

    /// 预览头部「看当前版本」：去掉 sha 重读，页签仍钉在原会话
    func showCurrentVersion(_ path: String) {
        guard let index = previewTabs.firstIndex(where: { $0.path == path }) else { return }
        previewTabs[index].sha = nil
        previewTabs[index].diffSha = nil
        previewTabs[index].content = nil
        previewTabs[index].error = nil
        previewTabs[index].url = nil
        previewTabs[index].headUrl = nil
        previewTabs[index].media = nil
        previewTabs[index].loading = true
        sendTabRead(previewTabs[index])
    }

    func selectPreviewTab(_ path: String) {
        if previewTabs.contains(where: { $0.path == path }) {
            previewActivePath = path
        }
    }

    /// 关掉正在看的页签就收起面板，不自动换成别的页签
    func closePreviewTab(_ path: String) {
        previewTabs.removeAll { $0.path == path }
        if previewActivePath == path {
            previewActivePath = nil
            previewExpanded = false
        }
        if previewTabs.isEmpty { previewExpanded = false }
    }

    func dismissPreviewPanel() {
        previewActivePath = nil
    }

    /// 错误页重试
    func retryPreviewTab(_ path: String) {
        guard let index = previewTabs.firstIndex(where: { $0.path == path }) else { return }
        previewTabs[index].error = nil
        previewTabs[index].loading = true
        sendTabRead(previewTabs[index])
    }

    /// 大文本的 HTTP 水合（对齐网页 fetchPreviewText）：file_content 只给 url 时经票据拉正文
    func hydratePreviewText(path: String) {
        guard let tab = previewTabs.first(where: { $0.path == path }),
              let url = tab.mediaURL
        else { return }
        let tenantAtStart = tenantId
        let shaAtStart = tab.readSha
        Task {
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 60
                let (data, response) = try await URLSession.shared.data(for: request)
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200 ..< 300).contains(code), let text = String(data: data, encoding: .utf8) else {
                    throw PreviewError.http(code)
                }
                guard tenantId == tenantAtStart,
                      let index = previewTabs.firstIndex(where: { $0.path == path }),
                      previewTabs[index].readSha == shaAtStart, // 期间换了版本的不写旧版本正文
                      previewTabs[index].content == nil // 期间 WS 已补上 content 的不覆盖
                else { return }
                previewTabs[index].content = text
                previewTabs[index].error = nil // 清掉可能的陈旧错误（双 Task 竞态）
                previewTabs[index].loading = false
            } catch {
                guard tenantId == tenantAtStart,
                      let index = previewTabs.firstIndex(where: { $0.path == path }),
                      previewTabs[index].readSha == shaAtStart,
                      previewTabs[index].content == nil // 已有内容时不盖错误
                else { return }
                previewTabs[index].loading = false
                previewTabs[index].error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}
