import Foundation
import UIKit

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

    /// 网关 sanitizeImages 只收 png/jpeg/gif/webp；其余（HEIC 等）一律转 jpeg 并压到上限内
    static func prepare(_ data: Data, mimeType: String?) -> PendingImage? {
        let mime = mimeType?.lowercased() ?? ""
        let passthrough = ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mime)
        if passthrough, data.count <= perImageLimit {
            return PendingImage(data: data, mimeType: mime, base64: data.base64EncodedString())
        }
        guard let image = UIImage(data: data) else { return nil }
        let compressed = compress(image)
        return PendingImage(data: compressed, mimeType: "image/jpeg", base64: compressed.base64EncodedString())
    }

    private static func compress(_ image: UIImage) -> Data {
        var current = image
        var quality: CGFloat = 0.85
        var out = current.jpegData(compressionQuality: quality) ?? Data()
        while out.count > perImageLimit, quality > 0.25 {
            quality -= 0.15
            out = current.jpegData(compressionQuality: quality) ?? out
        }
        var dimension: CGFloat = 2048
        while out.count > perImageLimit, dimension >= 512 {
            dimension /= 2
            let size = CGSize(width: dimension, height: dimension * current.size.height / max(current.size.width, 1))
            let renderer = UIGraphicsImageRenderer(size: size)
            current = renderer.image { _ in
                current.draw(in: CGRect(origin: .zero, size: size))
            }
            out = current.jpegData(compressionQuality: 0.7) ?? out
        }
        return out
    }
}
