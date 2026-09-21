import Foundation

// Mirrors web/lib/preview.ts — 保持 kind 判定与网页一致。

enum PreviewKind: String, Sendable, Hashable, CaseIterable {
    case text
    case canvas
    case markdown
    case html
    case image
    case svg
    case pdf
    case audio
    case video
    case binary

    /// 这类内容走 /media 票据下载，不内联 content（对齐网页 needsMediaUrl）
    var needsMediaURL: Bool {
        switch self {
        case .image, .svg, .pdf, .audio, .video: return true
        default: return false
        }
    }

    /// 面板能原生渲染的类型（P5c 起含富媒体）；只有 binary 走 QuickLook
    var panelRenderable: Bool {
        switch self {
        case .binary: return false
        default: return true // canvas 由 P5d 运行时渲染（可切源码）；binary 走 Quick Look
        }
    }
}

private let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]
private let audioExts: Set<String> = ["mp3", "wav", "ogg", "m4a", "aac", "flac"]
private let videoExts: Set<String> = ["mp4", "webm"]
private let markdownExts: Set<String> = ["md", "mdx", "markdown"]
private let htmlExts: Set<String> = ["html", "htm"]

/// 对齐网页 formatBytes
func formatBytes(_ size: Double) -> String {
    if size < 1024 { return "\(Int(size)) B" }
    if size < 1024 * 1024 { return String(format: "%.1f KB", size / 1024).replacingOccurrences(of: ".0 KB", with: " KB") }
    return String(format: "%.1f MB", size / (1024 * 1024)).replacingOccurrences(of: ".0 MB", with: " MB")
}

func previewKind(of path: String) -> PreviewKind {
    let normalized = path.replacingOccurrences(of: "\\", with: "/")
    if normalized.lowercased().hasSuffix(".canvas.tsx") { return .canvas }
    let base = normalized.split(separator: "/").last.map(String.init) ?? ""
    guard let dot = base.lastIndex(of: "."), dot < base.endIndex else { return .text }
    let ext = base[base.index(after: dot)...].lowercased()
    if imageExts.contains(ext) { return .image }
    if ext == "svg" { return .svg }
    if markdownExts.contains(ext) { return .markdown }
    if htmlExts.contains(ext) { return .html }
    if ext == "pdf" { return .pdf }
    if audioExts.contains(ext) { return .audio }
    if videoExts.contains(ext) { return .video }
    return .text
}

/// 一个预览页签：path 是唯一键；diff=true 时 content 是 unified diff 文本
struct PreviewTab: Identifiable, Hashable {
    var path: String
    var kind: PreviewKind
    var diff: Bool
    var content: String?
    var error: String?
    var loading: Bool
    /// 媒体类（或 preferHttpText 的大文本）的 /media 相对地址与票据
    var url: String?
    /// 图片/svg diff 的「改前」对照地址（rev=HEAD，P5c 图片 diff 用）
    var headUrl: String?
    var media: MediaTicket?
    /// 服务端给的 MIME 与字节数（媒体视图头部展示，对齐网页 figcaption）
    var mime: String?
    var size: Double?
    /// 签发 media 票据的会话 id（票据签名绑 chatId；切到同 cwd 的别的会话后不能用新 activeId 配旧票据）
    var chatId: String?
    /// canvas 页签的「源码/画布」切换（P5d；true=看源码）
    var showSource: Bool = false

    var id: String { path }
    var filename: String { (path as NSString).lastPathComponent }

    /// file_content 的 url 字段已带完整查询（path/chatId/exp/sig），只需补上 scheme+host
    var mediaURL: URL? {
        guard let url else { return nil }
        return GatewayConfig.resolveHTTP(url)
    }

    /// 图片/svg diff 的「改前」对照地址（同样带票据查询）
    var headMediaURL: URL? {
        guard let headUrl else { return nil }
        return GatewayConfig.resolveHTTP(headUrl)
    }
}
