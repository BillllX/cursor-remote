import CoreTransferable
import Foundation
import ImageIO
import Photos
import UIKit
import UniformTypeIdentifiers

// 即时消息的图片：上传（POST /upload/im）、下载与内存/磁盘缓存、发送前压缩、头像裁剪、存相册。

enum ImMediaError: LocalizedError {
    case tooLarge(String)
    case http(Int, String?)
    case badResponse
    case unreadable

    var errorDescription: String? {
        switch self {
        case .tooLarge(let kind):
            switch kind {
            case "thumb": return "缩略图太大，发不了"
            case "avatar": return "头像图片超过 5MB"
            default: return "图片超过 20MB，发不了"
            }
        case .http(let code, let message):
            if let message, !message.isEmpty { return message }
            return "上传失败（\(code)）"
        case .badResponse: return "服务器回的东西读不懂"
        case .unreadable: return "读不到这张图"
        }
    }
}

/// raw body + Bearer，从本地文件流式上传，带进度
struct ImHTTPUploader: ImBlobUploader {
    /// 和网关 BLOB_LIMITS 对齐
    static let limits: [String: Int] = [
        "image": 20 * 1024 * 1024,
        "thumb": 1024 * 1024,
        "avatar": 5 * 1024 * 1024,
    ]

    func upload(file: URL, kind: String, mime: String, token: String, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0 else { throw ImMediaError.unreadable }
        if let limit = Self.limits[kind], size > limit { throw ImMediaError.tooLarge(kind) }
        guard let endpoint = GatewayConfig.imUploadURL(kind: kind, mime: mime) else { throw ImMediaError.badResponse }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(mime, forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.upload(for: request, fromFile: file, delegate: ImUploadProgress(progress))
        } catch {
            throw ImMediaError.http(-1, error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw ImMediaError.badResponse }
        let object = (try? JSONValue.parse(data).object) ?? [:]
        guard (200 ..< 300).contains(http.statusCode) else {
            if http.statusCode == 413 { throw ImMediaError.tooLarge(kind) }
            throw ImMediaError.http(http.statusCode, object["error"]?.string)
        }
        guard let blob = object["blob"]?.string, ImCache.isBlob(blob) else { throw ImMediaError.badResponse }
        progress(1)
        return blob
    }
}

private final class ImUploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let report: @Sendable (Double) -> Void

    init(_ report: @escaping @Sendable (Double) -> Void) {
        self.report = report
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        report(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}

// MARK: 下载与缓存

/// 内存（NSCache）+ 磁盘（ImCache.mediaDir，按 blob 存一份）。同一张图同时只下载一次
@MainActor
final class ImImageCache {
    static let shared = ImImageCache()

    private let memory: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 96 * 1024 * 1024
        return cache
    }()
    private var inflight: [String: Task<UIImage?, Never>] = [:]

    func cached(_ key: String, maxPixel: Int) -> UIImage? {
        memory.object(forKey: "\(key)@\(maxPixel)" as NSString)
    }

    /// 网关上的附件：先看内存，再看磁盘，最后用票据地址下载。remote 为 nil（票据过期在换）时只查本地
    func image(blob: String, tenant: String, remote: URL?, maxPixel: Int) async -> UIImage? {
        guard ImCache.isBlob(blob), let dir = ImCache.mediaDir(tenant: tenant) else { return nil }
        let file = dir.appendingPathComponent(blob)
        return await load(key: blob, maxPixel: maxPixel) {
            if FileManager.default.fileExists(atPath: file.path) {
                ImCache.noteUse(file)
            } else {
                guard let remote, await Self.download(remote, to: file) else { return nil }
            }
            return ImImageDecode.image(at: file, maxPixel: maxPixel)
        }
    }

    /// 本机还没发出去的图（outbox 里的文件）
    func local(file: URL, maxPixel: Int) async -> UIImage? {
        await load(key: file.lastPathComponent, maxPixel: maxPixel) {
            ImImageDecode.image(at: file, maxPixel: maxPixel)
        }
    }

    /// 存相册用的原图文件（没下载过就先下载到磁盘缓存）
    func originalFile(blob: String, tenant: String, remote: URL?) async -> URL? {
        guard ImCache.isBlob(blob), let dir = ImCache.mediaDir(tenant: tenant) else { return nil }
        let file = dir.appendingPathComponent(blob)
        return await Task.detached(priority: .userInitiated) { () -> URL? in
            if FileManager.default.fileExists(atPath: file.path) {
                ImCache.noteUse(file)
                return file
            }
            guard let remote, await Self.download(remote, to: file) else { return nil }
            return file
        }.value
    }

    func removeAll() {
        memory.removeAllObjects()
        for task in inflight.values { task.cancel() }
        inflight = [:]
    }

    private func load(key: String, maxPixel: Int, work: @escaping @Sendable () async -> UIImage?) async -> UIImage? {
        let cacheKey = "\(key)@\(maxPixel)"
        if let hit = memory.object(forKey: cacheKey as NSString) { return hit }
        if let running = inflight[cacheKey] { return await running.value }
        let task = Task.detached(priority: .userInitiated, operation: work)
        inflight[cacheKey] = task
        let image = await task.value
        inflight[cacheKey] = nil
        if let image {
            let cost = Int(image.size.width * image.scale * image.size.height * image.scale * 4)
            memory.setObject(image, forKey: cacheKey as NSString, cost: cost)
        }
        return image
    }

    private nonisolated static func download(_ remote: URL, to file: URL) async -> Bool {
        do {
            let (temp, response) = try await URLSession.shared.download(from: remote)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                try? FileManager.default.removeItem(at: temp)
                return false
            }
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: file.path) {
                try? FileManager.default.removeItem(at: temp)
                return true
            }
            try FileManager.default.moveItem(at: temp, to: file)
            ImCache.noteDownloaded(file)
            return true
        } catch {
            return FileManager.default.fileExists(atPath: file.path)
        }
    }
}

enum ImImageDecode {
    /// ImageIO 按目标尺寸解码，顺带按 EXIF 摆正（HEIC 也走这里）
    static func image(at file: URL, maxPixel: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil) else { return nil }
        return image(source, maxPixel: maxPixel)
    }

    private static func image(_ source: CGImageSource, maxPixel: Int) -> UIImage? {
        guard let image = cgImage(source, maxPixel: maxPixel) else { return nil }
        return UIImage(cgImage: image)
    }

    /// 长边不超过 maxPixel、按 EXIF 摆正的位图；ImageIO 直接按目标尺寸解码，不会先解出整张大图
    static func cgImage(_ source: CGImageSource, maxPixel: Int) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// JPEG 编码（CGImageDestination）。带透明的先铺白底，免得透明处变黑
    static func jpeg(_ image: CGImage, quality: CGFloat) -> Data? {
        let flat = opaque(image) ?? image
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
        CGImageDestinationAddImage(destination, flat, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    private static func opaque(_ image: CGImage) -> CGImage? {
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast:
            return image
        default:
            break
        }
        let width = image.width
        let height = image.height
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: space,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        let rect = CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height))
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(rect)
        context.draw(image, in: rect)
        return context.makeImage()
    }

    /// 摆正后的像素尺寸
    static func orientedSize(_ source: CGImageSource) -> (w: Int, h: Int) {
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        let width = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
        let height = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
        let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        return (5 ... 8).contains(orientation) ? (height, width) : (width, height)
    }
}

// MARK: 发送前准备

enum ImImagePrep {
    static let imageMaxEdge = 1280
    static let thumbMaxEdge = 400
    static let quality: CGFloat = 0.8
    /// 原图超过网关上限就退回压缩
    static let originalLimit = 20 * 1024 * 1024

    /// 把选中的图（磁盘上的文件）处理好写进 outbox：非原图长边 1280 JPEG 0.8；原图按文件原样复制（HEIC 也行）；
    /// 缩略图长边 400 JPEG。全程从文件按目标尺寸解码，不把原始字节或整张大图读进内存。很重，放后台线程调
    static func prepare(file: URL, original wantsOriginal: Bool, tenant: String) -> ImOutgoingImage? {
        guard let dir = ImCache.outboxDir(tenant: tenant),
              let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              let thumbImage = ImImageDecode.cgImage(source, maxPixel: thumbMaxEdge),
              let thumb = ImImageDecode.jpeg(thumbImage, quality: quality),
              thumb.count <= 1024 * 1024
        else { return nil }
        let manager = FileManager.default
        let stem = UUID().uuidString.lowercased()
        let thumbFile = "\(stem)-t.jpg"
        let thumbURL = dir.appendingPathComponent(thumbFile)
        do {
            try manager.createDirectory(at: dir, withIntermediateDirectories: true)
            try thumb.write(to: thumbURL, options: .atomic)
        } catch {
            return nil
        }
        let bytes = ImPickTemp.size(file)
        if wantsOriginal, bytes > 0, bytes <= Int64(originalLimit), let mime = sniffMime(source) {
            let name = "\(stem).\(fileExtension(mime))"
            do {
                try manager.copyItem(at: file, to: dir.appendingPathComponent(name))
            } catch {
                try? manager.removeItem(at: thumbURL)
                return nil
            }
            let size = ImImageDecode.orientedSize(source)
            return ImOutgoingImage(file: name, thumbFile: thumbFile, mime: mime, w: size.w, h: size.h, original: true, blob: nil, thumb: nil)
        }
        guard let main = ImImageDecode.cgImage(source, maxPixel: imageMaxEdge),
              let jpeg = ImImageDecode.jpeg(main, quality: quality)
        else {
            try? manager.removeItem(at: thumbURL)
            return nil
        }
        let name = "\(stem).jpg"
        do {
            try jpeg.write(to: dir.appendingPathComponent(name), options: .atomic)
        } catch {
            try? manager.removeItem(at: thumbURL)
            return nil
        }
        return ImOutgoingImage(file: name, thumbFile: thumbFile, mime: "image/jpeg", w: main.width, h: main.height, original: false, blob: nil, thumb: nil)
    }

    /// 头像：居中裁成正方形、缩到 512px、JPEG。返回 outbox 里的文件名
    static func avatar(file: URL, tenant: String) -> String? {
        guard let dir = ImCache.outboxDir(tenant: tenant),
              let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              let image = ImImageDecode.cgImage(source, maxPixel: 1536)
        else { return nil }
        let side = min(image.width, image.height)
        guard side > 0 else { return nil }
        let crop = CGRect(
            x: CGFloat((image.width - side) / 2),
            y: CGFloat((image.height - side) / 2),
            width: CGFloat(side),
            height: CGFloat(side)
        )
        guard let square = image.cropping(to: crop) else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let edge = CGFloat(min(512, side))
        let canvas = CGRect(x: 0, y: 0, width: edge, height: edge)
        let renderer = UIGraphicsImageRenderer(size: canvas.size, format: format)
        let jpeg = renderer.jpegData(withCompressionQuality: 0.85) { context in
            UIColor.white.setFill()
            context.fill(canvas)
            UIImage(cgImage: square).draw(in: canvas)
        }
        let name = "avatar-\(UUID().uuidString.lowercased()).jpg"
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try jpeg.write(to: dir.appendingPathComponent(name), options: .atomic)
        } catch {
            return nil
        }
        return name
    }

    private static func sniffMime(_ source: CGImageSource) -> String? {
        guard let identifier = CGImageSourceGetType(source) as String?,
              let type = UTType(identifier),
              let mime = type.preferredMIMEType,
              mime.hasPrefix("image/"), !mime.contains("svg")
        else { return nil }
        return mime
    }

    private static func fileExtension(_ mime: String) -> String {
        UTType(mimeType: mime)?.preferredFilenameExtension ?? "jpg"
    }
}

// MARK: 选图落盘

/// 相册里选中的一张图：系统交来的文件拷进自己的临时目录，原始字节不进内存
struct ImPickedFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            ImPickedFile(url: try ImPickTemp.adopt(received.file))
        }
    }
}

/// 选图、拍照到发出去之间的临时文件（tmp/im-pick）。发完或取消就删
enum ImPickTemp {
    static var dir: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("im-pick", isDirectory: true)
    }

    /// 系统给的文件在回调结束后就没了：拷一份
    static func adopt(_ source: URL) throws -> URL {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let ext = source.pathExtension.isEmpty ? "img" : source.pathExtension.lowercased()
        let target = dir.appendingPathComponent("\(UUID().uuidString.lowercased()).\(ext)")
        try FileManager.default.copyItem(at: source, to: target)
        return target
    }

    /// 只拿得到字节时（相册不给文件、拍照）：写成文件，调用方随即丢掉字节
    static func write(_ data: Data, ext: String) -> URL? {
        let target = dir.appendingPathComponent("\(UUID().uuidString.lowercased()).\(ext)")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: target, options: .atomic)
            return target
        } catch {
            return nil
        }
    }

    static func remove(_ files: [URL]) {
        for file in files { try? FileManager.default.removeItem(at: file) }
    }

    /// 启动时清掉上次没走完流程（闪退、被杀）留下的临时文件
    static func sweep() {
        let target = dir
        DispatchQueue.global(qos: .utility).async {
            try? FileManager.default.removeItem(at: target)
        }
    }

    static func size(_ file: URL) -> Int64 {
        Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
    }
}

// MARK: 存相册

enum ImPhotoSaver {
    /// 原图文件写进相册（不重编码、不整个读进内存）。返回给用户看的结果文案
    static func save(file: URL) async -> String {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil), CGImageSourceGetCount(source) > 0 else {
            return "图片数据读不出来，没法存相册"
        }
        // 缓存里的文件名是 blob、没有扩展名：类型按文件头告诉相册
        let type = CGImageSourceGetType(source) as String?
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized else { return "没有相册写入权限——去系统设置 → 接驳 → 照片 里打开" }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let options = PHAssetResourceCreationOptions()
                options.uniformTypeIdentifier = type
                PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: file, options: options)
            }
            return "已存到相册"
        } catch {
            return "没存进相册：\(error.localizedDescription)"
        }
    }
}
