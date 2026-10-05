import AVFoundation
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// 上传上限与网关 MAX_UPLOAD_BYTES 对齐
let maxUploadBytes = 32 * 1024 * 1024

enum UploadError: LocalizedError {
    case tooLarge
    case empty
    case notConnected
    case timeout
    case http(Int, String?)
    case badResponse
    case unreadable

    var errorDescription: String? {
        switch self {
        case .tooLarge: return "文件超过 32MB，传不了。"
        case .empty: return "文件是空的。"
        case .notConnected: return "还没连上服务器，等连上再传。"
        case .timeout: return "上传超时，再试一次。"
        case .http(let code, let message):
            if let message, !message.isEmpty { return message }
            return "上传失败（\(code)）。"
        case .badResponse: return "服务器回的东西读不懂。"
        case .unreadable: return "读不到这个文件。"
        }
    }
}

struct UploadOutcome: Sendable {
    var path: String
    var size: Int
    var name: String
}

/// HTTP /upload 主通道：raw body + Bearer，URLSession 从临时文件流式上传。
enum Uploader {
    static func upload(chatId: String, name: String, file: URL, token: String) async throws -> UploadOutcome {
        var components = URLComponents(url: GatewayConfig.uploadURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "chatId", value: chatId),
            URLQueryItem(name: "name", value: name),
        ]
        guard let endpoint = components?.url else { throw UploadError.badResponse }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.upload(for: request, fromFile: file)
        } catch {
            throw UploadError.http(-1, error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw UploadError.badResponse }
        let object = (try? JSONValue.parse(data).object) ?? [:]
        guard (200 ..< 300).contains(http.statusCode) else {
            if http.statusCode == 413 || http.statusCode == 502 { throw UploadError.tooLarge }
            throw UploadError.http(http.statusCode, object["error"]?.string)
        }
        guard let path = object["path"]?.string, !path.isEmpty else { throw UploadError.badResponse }
        return UploadOutcome(
            path: path,
            size: object["size"]?.int ?? 0,
            name: object["name"]?.string ?? name
        )
    }
}

/// 草稿里的待发图片（随 prompt.images 内联发出，不走 /upload）
struct PendingImage: Identifiable, Hashable, Sendable {
    var id: UUID = UUID()
    var data: Data
    var mimeType: String
    /// base64 在 prepare（后台线程）预计算，避免 submit 在主线程编码 ~27MB
    var base64: String = ""

    var promptImage: PromptImage {
        PromptImage(data: base64, mimeType: mimeType)
    }
}

enum ImagePrep {
    /// 有意低于网页端 8MB 直通上限：手机侧省内存/流量；网关 sanitizeImages 上限 12e6 base64（~9MB），4MB 安全
    static let perImageLimit = 4 * 1024 * 1024
    static let maxCount = 5

    /// 网关 sanitizeImages 只收 png/jpeg/gif/webp；一律缩到 MediaShrink.imageMaxEdge 转 jpeg，
    /// 原图本来就更小且格式能直传时发原图
    static func prepare(_ data: Data, mimeType: String?) -> PendingImage? {
        let mime = mimeType?.lowercased() ?? ""
        let passthrough = ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mime)
        let original = { PendingImage(data: data, mimeType: mime, base64: data.base64EncodedString()) }
        // GIF 可能是动图，转 jpeg 只剩第一帧
        if mime == "image/gif", data.count <= perImageLimit { return original() }
        var edge = MediaShrink.imageMaxEdge
        var quality = MediaShrink.jpegQuality
        while edge >= 512, let out = MediaShrink.jpeg(from: data, maxEdge: edge, quality: quality, keepAlpha: false) {
            if out.count <= perImageLimit {
                if passthrough, data.count <= out.count { return original() }
                return PendingImage(data: out, mimeType: "image/jpeg", base64: out.base64EncodedString())
            }
            edge = edge * 3 / 4
            quality = max(0.5, quality - 0.1)
        }
        if passthrough, data.count <= perImageLimit { return original() }
        return nil
    }
}

/// 上传前在本机压缩：图片缩到模型看得清的尺寸，音频转成听得清人声的单声道低码率 AAC
enum MediaShrink {
    /// 长边 1600：手机截图缩完字仍清楚，照片里的文档也读得出；再大各家模型侧也会再缩
    static let imageMaxEdge = 1600
    static let jpegQuality: CGFloat = 0.72
    /// 能压的图片/音频先压再判 32MB 上限；1 小时无损语音备忘录原件约 300MB
    static let maxSourceBytes = 1024 * 1024 * 1024
    /// 太小的图不值得重编码
    private static let minImageBytes = 300 * 1024
    /// 压完至少省 20% 才换掉原件
    private static let keepRatio = 0.8

    struct Outcome: Sendable {
        var url: URL
        var name: String
        var size: Int
    }

    private enum Kind { case image, audio }

    private static func kind(of name: String) -> Kind? {
        let ext = (name as NSString).pathExtension
        guard !ext.isEmpty, let type = UTType(filenameExtension: ext) else { return nil }
        if type.conforms(to: .audio) { return .audio }
        if type.conforms(to: .image), !type.conforms(to: .gif), !type.conforms(to: .svg) { return .image }
        return nil
    }

    static func canShrink(name: String) -> Bool {
        kind(of: name) != nil
    }

    /// 压不了、压完不划算或出错都返回 nil，调用方照传原件
    static func shrinkUpload(_ file: URL, name: String, size: Int) async -> Outcome? {
        let base = (name as NSString).deletingPathExtension
        let output = FileManager.default.temporaryDirectory
            .appendingPathComponent("jiebo-shrink-\(UUID().uuidString.lowercased())")
        switch kind(of: name) {
        case .image:
            guard size >= minImageBytes,
                  let source = CGImageSourceCreateWithURL(file as CFURL, nil),
                  // 带透明的图多半是素材/图标，转 jpeg 会坏，保留原件
                  let data = jpeg(from: source, maxEdge: imageMaxEdge, quality: jpegQuality, keepAlpha: true),
                  Double(data.count) < Double(size) * keepRatio else { return nil }
            let url = output.appendingPathExtension("jpg")
            guard (try? data.write(to: url)) != nil else { return nil }
            return Outcome(url: url, name: "\(base).jpg", size: data.count)
        case .audio:
            let url = output.appendingPathExtension("m4a")
            guard let written = await speechM4A(from: file, to: url, sourceBytes: size),
                  Double(written) < Double(size) * keepRatio else {
                try? FileManager.default.removeItem(at: url)
                return nil
            }
            return Outcome(url: url, name: "\(base).m4a", size: written)
        case nil:
            return nil
        }
    }

    static func jpeg(from data: Data, maxEdge: Int, quality: CGFloat, keepAlpha: Bool) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return jpeg(from: source, maxEdge: maxEdge, quality: quality, keepAlpha: keepAlpha)
    }

    /// ImageIO 直接按目标尺寸解码（不先解全尺寸），顺带按 EXIF 摆正；重新编码不带原图元数据（含 GPS）
    private static func jpeg(from source: CGImageSource, maxEdge: Int, quality: CGFloat, keepAlpha: Bool) -> Data? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
        ]
        guard var image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let hasAlphaChannel = [.first, .last, .premultipliedFirst, .premultipliedLast].contains(image.alphaInfo)
        if hasAlphaChannel, hasTransparentPixels(image) {
            if keepAlpha { return nil }
            guard let flat = flattenOnWhite(image) else { return nil }
            image = flat
        }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    /// 很多 PNG 带 alpha 通道却全不透明（如截图），要看像素才知道是不是真有透明
    private static func hasTransparentPixels(_ image: CGImage) -> Bool {
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.clear(CGRect(x: 0, y: 0, width: width, height: height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return true }
        return stride(from: 3, to: pixels.count, by: 4).contains { pixels[$0] < 255 }
    }

    private static func flattenOnWhite(_ image: CGImage) -> CGImage? {
        guard let context = CGContext(
            data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(rect)
        context.draw(image, in: rect)
        return context.makeImage()
    }

    /// 人声用：16kHz 单声道 AAC-LC 24kbps，1 小时约 11MB；编码器不认就退到更高一档
    private static let speechProfiles: [(sampleRate: Double, bitRate: Int)] = [
        (16_000, 24_000),
        (22_050, 32_000),
        (44_100, 48_000),
    ]

    private static func speechM4A(from source: URL, to output: URL, sourceBytes: Int) async -> Int? {
        let asset = AVURLAsset(url: source)
        guard let tracks = try? await asset.loadTracks(withMediaType: .audio), !tracks.isEmpty,
              let duration = try? await asset.load(.duration).seconds,
              duration.isFinite, duration > 0 else { return nil }
        // 源文件本来就是低码率（已经压过）就不再转一遍
        let sourceBitRate = Double(sourceBytes) * 8 / duration
        if sourceBitRate <= Double(speechProfiles[0].bitRate) * 1.3 { return nil }
        for profile in speechProfiles {
            try? FileManager.default.removeItem(at: output)
            if await encode(asset: asset, tracks: tracks, to: output, sampleRate: profile.sampleRate, bitRate: profile.bitRate),
               let size = try? output.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0 {
                return size
            }
        }
        try? FileManager.default.removeItem(at: output)
        return nil
    }

    private static func encode(asset: AVAsset, tracks: [AVAssetTrack], to output: URL, sampleRate: Double, bitRate: Int) async -> Bool {
        var layout = AudioChannelLayout()
        layout.mChannelLayoutTag = kAudioChannelLayoutTag_Mono
        let layoutData = Data(bytes: &layout, count: MemoryLayout<AudioChannelLayout>.size)
        guard let reader = try? AVAssetReader(asset: asset),
              let writer = try? AVAssetWriter(outputURL: output, fileType: .m4a) else { return false }
        // 多轨混成一轨，重采样和降成单声道都在解码侧做完
        let readerOutput = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVChannelLayoutKey: layoutData,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        readerOutput.alwaysCopiesSampleData = false
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVChannelLayoutKey: layoutData,
            AVEncoderBitRateKey: bitRate,
        ]
        guard reader.canAdd(readerOutput),
              writer.canApply(outputSettings: settings, forMediaType: .audio) else { return false }
        reader.add(readerOutput)
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        guard writer.canAdd(input) else { return false }
        writer.add(input)
        writer.shouldOptimizeForNetworkUse = true
        guard reader.startReading(), writer.startWriting() else {
            reader.cancelReading()
            writer.cancelWriting()
            return false
        }
        guard let first = readerOutput.copyNextSampleBuffer() else {
            reader.cancelReading()
            writer.cancelWriting()
            return false
        }
        // 源轨首帧时间不一定是 0，从 0 起会多出前置空白
        writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(first))
        let pump = AudioPump(first: first)
        let queue = DispatchQueue(label: "jiebo.media-shrink.audio")
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            input.requestMediaDataWhenReady(on: queue) {
                while input.isReadyForMoreMediaData {
                    guard let buffer = pump.next(readerOutput), input.append(buffer) else {
                        if pump.finish() {
                            input.markAsFinished()
                            continuation.resume()
                        }
                        return
                    }
                }
            }
            // writer 中途失败后 input 不再 ready、回调也不再来，靠轮询状态收尾
            Task.detached {
                while !pump.isFinished {
                    try? await Task.sleep(for: .milliseconds(500))
                    if writer.status == .failed || reader.status == .failed, pump.finish() {
                        continuation.resume()
                    }
                }
            }
        }
        guard reader.status == .completed, writer.status == .writing else {
            reader.cancelReading()
            writer.cancelWriting()
            return false
        }
        await writer.finishWriting()
        return writer.status == .completed
    }
}

/// 音频转码的取帧与收尾状态：先吐预读的首帧，finish 只有第一次返回 true（continuation 只能 resume 一次）
private final class AudioPump: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: CMSampleBuffer?
    private var finished = false

    init(first: CMSampleBuffer) {
        pending = first
    }

    func next(_ output: AVAssetReaderOutput) -> CMSampleBuffer? {
        lock.lock()
        let buffer = pending
        pending = nil
        lock.unlock()
        return buffer ?? output.copyNextSampleBuffer()
    }

    var isFinished: Bool {
        lock.lock()
        defer { lock.unlock() }
        return finished
    }

    func finish() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if finished { return false }
        finished = true
        return true
    }
}
