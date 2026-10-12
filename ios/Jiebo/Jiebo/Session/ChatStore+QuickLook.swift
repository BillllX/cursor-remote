import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    // MARK: Quick Look 预览

    /// 点 @文件 芯片：从 /media 下载到临时文件后用 QLPreviewController 打开
    /// chatId 给定时按那个会话的工作区下载（卡片里委派子会话的文件），不切换 activeId。
    /// sha 给定且网关认 read_sha 时下载那一轮的快照（rev=sha:<sha>），否则下载当前文件
    func openMention(_ path: String, chatId fileChatId: String? = nil, sha: String? = nil) {
        let trimmed = path.trimmingCharacters(in: .whitespaces)
        // 对齐网页 isOpenableMention：只挡精确 "diff" 与目录
        guard !trimmed.isEmpty, !trimmed.hasSuffix("/"), trimmed.lowercased() != "diff" else {
            if !trimmed.isEmpty { flash("这类内容暂不支持预览") }
            return
        }
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        previewTask?.cancel() // 连续点两个 mention：取消在途的，避免覆盖泄漏
        previewLoading = true
        let chatId = fileChatId ?? activeId
        let rev = supportsReadSha ? sha?.nilIfEmpty.map { "sha:\($0)" } : nil
        let activeAtStart = activeId
        let tenantAtStart = tenantId
        previewTask = Task {
            do {
                let temp = try await downloadToTemp(path: trimmed, chatId: chatId, token: token, rev: rev)
                // 下载途中切了会话/租户：删掉 temp 静默退出，不在新上下文弹预览
                guard !Task.isCancelled, tenantId == tenantAtStart, activeId == activeAtStart else {
                    removeTempFile(temp)
                    return
                }
                previewLoading = false
                setPreviewFile(PreviewFile(url: temp, name: (trimmed as NSString).lastPathComponent))
            } catch {
                guard !Task.isCancelled else { return }
                previewLoading = false
                guard tenantId == tenantAtStart else { return }
                bannerError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// /media 下载的公共段（openMention / exportPreview / saveImageToPhotos 共用）；
    /// 纯 IO，不含租户/会话守卫——调用方按自己的语义决定下载完成后是否还该呈现
    func downloadData(path: String, chatId: String, token: String, rev: String? = nil) async throws -> Data {
        var request = URLRequest(url: GatewayConfig.mediaURL(path: path, chatId: chatId, rev: rev))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 60
        let (data, response) = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(code) else { throw PreviewError.http(code) }
        guard data.count <= 32 * 1024 * 1024 else { throw PreviewError.tooLarge }
        return data
    }

    /// temp 用 uuid 目录隔离、文件名保持干净——分享 sheet/隔空投送给接收方的是
    /// lastPathComponent，带 uuid 前缀会泄漏丑名字（Kimi R1 M5）
    func downloadToTemp(path: String, chatId: String, token: String, prefix: String = "jiebo-preview", rev: String? = nil) async throws -> URL {
        let data = try await downloadData(path: path, chatId: chatId, token: token, rev: rev)
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let temp = dir.appendingPathComponent((path as NSString).lastPathComponent)
        try data.write(to: temp)
        return temp
    }

    /// 删 temp 文件并顺手收掉空的 uuid 隔离目录（非空目录不递归删——里面可能还有别的文件）
    func removeTempFile(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
        let dir = url.deletingLastPathComponent()
        let name = dir.lastPathComponent
        guard name.hasPrefix("jiebo-preview-") || name.hasPrefix("jiebo-export-") else { return }
        if (try? FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty) == true {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    /// 写 previewFile 的唯一入口：先删旧 temp 再换新的（防覆盖泄漏）；
    /// 删除依据 lastPreviewURL 而非 previewFile——sheet 交互关闭时 SwiftUI 先置 nil 再调 onDismiss
    func setPreviewFile(_ file: PreviewFile?) {
        if let old = lastPreviewURL, old != file?.url {
            removeTempFile(old)
        }
        lastPreviewURL = file?.url
        previewFile = file
    }

    /// sheet onDismiss 入口：SwiftUI 已先把 previewFile 置 nil。
    /// 若此时 previewFile 非 nil，说明 dismiss 的是旧 sheet、期间又点了新预览——新 temp 不能删。
    func closePreview() {
        guard previewFile == nil else { return }
        setPreviewFile(nil)
    }

    /// Quick Look「完成」按钮入口：主动关 sheet（temp 清理由 setPreviewFile/onDismiss 链负责）
    func dismissPreviewFile() {
        setPreviewFile(nil)
    }

    /// 分享任意预览文件：文本类直接用已内联的 content 写 temp（省一次下载），
    /// 媒体/大文件走 /media 下载。temp 文件名保留原扩展名，分享 sheet 才能识别 UTType。
    /// chatId 用页签快照（票据/路径都绑签发时的会话）——页签全局存活，activeId 可能已切走（GLM R1 M1）
    func exportPreview(path rawPath: String, content: String?, isDiff: Bool = false, chatId: String? = nil) {
        let path = rawPath.trimmingCharacters(in: .whitespaces)
        // 与 openMention 同一套入口守卫（对齐：空串/目录/精确 "diff"）
        guard !path.isEmpty, !path.hasSuffix("/"), path.lowercased() != "diff" else { return }
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        exportTask?.cancel()
        exportLoading = true
        bannerError = "" // 清旧错误：cover 顶条红优先于绿，不清的话成功 flash 被旧错误挡住（Grok R2 M1）
        let chatId = chatId ?? activeId
        let tenantAtStart = tenantId
        let filename = (path as NSString).lastPathComponent
        exportTask = Task {
            do {
                let temp: URL
                if let content {
                    // diff 页签的 content 是 unified diff 文本，加 .diff 后缀让接收方按纯文本打开；
                    // uuid 目录隔离保持文件名干净（同 downloadToTemp，Kimi R1 M5）
                    let name = isDiff ? "\(filename).diff" : filename
                    let dir = FileManager.default.temporaryDirectory
                        .appendingPathComponent("jiebo-export-\(UUID().uuidString)", isDirectory: true)
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    temp = dir.appendingPathComponent(name)
                    try Data(content.utf8).write(to: temp)
                } else {
                    temp = try await downloadToTemp(path: path, chatId: chatId, token: token, prefix: "jiebo-export")
                }
                guard !Task.isCancelled, tenantId == tenantAtStart else {
                    removeTempFile(temp)
                    return
                }
                exportLoading = false
                setExportFile(PreviewFile(url: temp, name: filename))
            } catch {
                guard !Task.isCancelled else { return }
                exportLoading = false
                guard tenantId == tenantAtStart else { return }
                bannerError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// 图片一键存相册（原始字节直存，PNG/JPEG/GIF 都不重编码；权限由系统在写入时弹）
    /// chatId 同 exportPreview——页签快照，防切会话后跨 cwd 404
    func saveImageToPhotos(path rawPath: String, chatId: String? = nil) {
        let path = rawPath.trimmingCharacters(in: .whitespaces)
        guard !path.isEmpty, !path.hasSuffix("/"), path.lowercased() != "diff" else { return }
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        exportTask?.cancel()
        exportLoading = true
        bannerError = "" // 同 exportPreview（Grok R2 M1）
        let chatId = chatId ?? activeId
        let tenantAtStart = tenantId
        exportTask = Task {
            do {
                let data = try await downloadData(path: path, chatId: chatId, token: token)
                guard !Task.isCancelled, tenantId == tenantAtStart else { return }
                // 仅校验可解码（不用于写入——写入走 addResource(data:) 保原字节）；
                // 损坏图/ico 等 Photos 不收的格式在这里给中文文案，不露 PHPhotosErrorDomain 原文（Grok R2 N1）
                guard UIImage(data: data) != nil else {
                    exportLoading = false
                    bannerError = "图片数据读不出来，没法存相册"
                    return
                }
                // Photos 框架：权限明确、错误可抛（UIImageWriteToSavedPhotosAlbum 的
                // selector 回调有 delegate 存活坑，且权限拒绝时静默）。
                // addOnly 只回 authorized/denied/restricted，无 .limited（GLM R1 N4）
                let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
                // await 期间可能已被新导出/切会话取消——写状态前必须重检，
                // 否则旧任务醒来会抹掉新任务的 exportLoading（Grok R1 M2）
                guard !Task.isCancelled, tenantId == tenantAtStart else { return }
                guard status == .authorized else {
                    exportLoading = false
                    bannerError = "没有相册写入权限——去系统设置 → 接驳 → 照片 里打开"
                    return
                }
                // addResource(data:) 保原始字节（creationRequestForAsset(from: UIImage)
                // 会重编码，JPEG 二次压缩、GIF 掉帧——GLM R1 N5）
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
                }
                // 图已存是事实，但取消后不 flash、不动 loading（归新任务/取消源管）
                guard !Task.isCancelled, tenantId == tenantAtStart else { return }
                exportLoading = false
                flash("已存到相册")
            } catch {
                guard !Task.isCancelled else { return }
                exportLoading = false
                guard tenantId == tenantAtStart else { return }
                bannerError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// 写 exportFile 的唯一入口：先删旧 temp 再换新的（同 setPreviewFile 的防泄漏链）
    func setExportFile(_ file: PreviewFile?) {
        if let old = lastExportURL, old != file?.url {
            removeTempFile(old)
        }
        lastExportURL = file?.url
        exportFile = file
    }

    /// 分享 sheet onDismiss 入口（SwiftUI 已先置 nil；同 closePreview 的旧 sheet 守卫）
    func closeExport() {
        guard exportFile == nil else { return }
        setExportFile(nil)
    }
}
