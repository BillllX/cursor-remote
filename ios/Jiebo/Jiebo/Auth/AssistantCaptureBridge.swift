import Foundation
import Darwin

@_silgen_name("flock")
private func assistantPosixFlock(_ fd: Int32, _ operation: Int32) -> Int32

// 主 App、分享扩展与 App Intents 共用的轻量捕获队列。只保存用户输入和路由资料，绝不保存令牌。
enum AssistantCaptureBridge {
    static let appGroup = "group.ai.jiebo.ipad"
    private static let fileName = "assistant-captures.json"
    private static let lockName = "assistant-captures.lock"
    private static let maximumItems = 40
    private static let maximumAge: TimeInterval = 7 * 24 * 60 * 60
    private static let maximumTextLength = 32 * 1024

    enum Kind: String, Codable {
        case text, link, location, file, action
    }

    enum Action: String, Codable, CaseIterable {
        case ask
        case summarize
        case remember
        case createTask
        case readLater
        case custom
        case voice

        var title: String {
            switch self {
            case .ask: return "问小驳"
            case .summarize: return "总结"
            case .remember: return "记住"
            case .createTask: return "建任务"
            case .readLater: return "稍后读"
            case .custom: return "自定义"
            case .voice: return "语音输入"
            }
        }
    }

    struct Capture: Codable, Identifiable, Hashable {
        var id: String
        var tenant: String
        var createdAt: Double
        var kind: Kind
        var text: String?
        var url: String?
        var latitude: Double?
        var longitude: Double?
        var name: String?
        var mime: String?
        var size: Int?
        var action: Action
        var note: String?
    }

    private struct File: Codable {
        var items: [Capture]
    }

    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    @discardableResult
    static func enqueue(
        tenant: String,
        kind: Kind,
        text: String? = nil,
        url: String? = nil,
        latitude: Double? = nil,
        longitude: Double? = nil,
        name: String? = nil,
        mime: String? = nil,
        size: Int? = nil,
        action: Action = .ask,
        note: String? = nil
    ) -> Capture? {
        let tenant = clean(tenant, limit: 128)
        guard !tenant.isEmpty else { return nil }
        let capture = Capture(
            id: UUID().uuidString.lowercased(),
            tenant: tenant,
            createdAt: Date().timeIntervalSince1970,
            kind: kind,
            text: optional(text, limit: maximumTextLength),
            url: optional(url, limit: 4096),
            latitude: latitude,
            longitude: longitude,
            name: optional(name, limit: 255),
            mime: optional(mime, limit: 128),
            size: size,
            action: action,
            note: optional(note, limit: 4000)
        )
        do {
            try withLock {
                var items = try readLocked()
                items.append(capture)
                try writeLocked(pruned(items, now: Date().timeIntervalSince1970))
            }
            return capture
        } catch {
            return nil
        }
    }

    static func pending(tenant: String) -> [Capture] {
        (try? withLock {
            let now = Date().timeIntervalSince1970
            let all = try readLocked()
            let cleaned = pruned(all, now: now)
            if cleaned != all { try writeLocked(cleaned) }
            return cleaned.filter { $0.tenant == tenant }
        }) ?? []
    }

    static func remove(id: String, tenant: String) {
        try? withLock {
            var items = try readLocked()
            items.removeAll { $0.id == id && $0.tenant == tenant }
            try writeLocked(pruned(items, now: Date().timeIntervalSince1970))
        }
    }

    static func removeAll(tenant: String) {
        try? withLock {
            var items = try readLocked()
            items.removeAll { $0.tenant == tenant }
            try writeLocked(pruned(items, now: Date().timeIntervalSince1970))
        }
    }

    static func prompt(for capture: Capture) -> String {
        if capture.action == .voice { return "" }
        var parts = ["意图：\(capture.action.title)"]
        if let note = capture.note { parts.append("备注：\(note)") }
        switch capture.kind {
        case .text, .action:
            if let text = capture.text { parts.append(text) }
        case .link:
            if let name = capture.name { parts.append("标题：\(name)") }
            if let url = capture.url { parts.append("链接：\(url)") }
        case .location:
            if let name = capture.name { parts.append("位置：\(name)") }
            if let latitude = capture.latitude, let longitude = capture.longitude {
                parts.append("坐标：\(latitude), \(longitude)")
            }
        case .file:
            if let name = capture.name { parts.append("文件：\(name)") }
            if let mime = capture.mime { parts.append("类型：\(mime)") }
            if let size = capture.size { parts.append("大小：\(size) 字节") }
        }
        return parts.joined(separator: "\n")
    }

    private static func clean(_ value: String, limit: Int) -> String {
        String(value.trimmingCharacters(in: .whitespacesAndNewlines).prefix(limit))
    }

    private static func optional(_ value: String?, limit: Int) -> String? {
        guard let value else { return nil }
        let cleaned = clean(value, limit: limit)
        return cleaned.isEmpty ? nil : cleaned
    }

    private static func pruned(_ items: [Capture], now: Double) -> [Capture] {
        Array(items.filter { now - $0.createdAt <= maximumAge }.suffix(maximumItems))
    }

    private static func readLocked() throws -> [Capture] {
        guard let file = container?.appendingPathComponent(fileName),
              FileManager.default.fileExists(atPath: file.path)
        else { return [] }
        return (try? JSONDecoder().decode(File.self, from: Data(contentsOf: file)))?.items ?? []
    }

    private static func writeLocked(_ items: [Capture]) throws {
        guard let file = container?.appendingPathComponent(fileName) else { throw CocoaError(.fileNoSuchFile) }
        let data = try JSONEncoder().encode(File(items: items))
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static func withLock<T>(_ body: () throws -> T) throws -> T {
        guard let container else { throw CocoaError(.fileNoSuchFile) }
        let lock = container.appendingPathComponent(lockName)
        let descriptor = lock.path.withCString { Darwin.open($0, O_CREAT | O_RDWR, mode_t(0o600)) }
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(descriptor) }
        guard assistantPosixFlock(descriptor, LOCK_EX) == 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { _ = assistantPosixFlock(descriptor, LOCK_UN) }
        return try body()
    }
}

extension Notification.Name {
    static let assistantCaptureOpenRequested = Notification.Name("AssistantCaptureOpenRequested")
    static let assistantVoiceRequested = Notification.Name("AssistantVoiceRequested")
}
