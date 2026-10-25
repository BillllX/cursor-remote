import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// 主 App 与 Widget 之间唯一允许共享的数据模型。
/// 这里只保留首页展示所需的计数和短摘要，不得加入令牌、完整消息或记忆。
struct WidgetSnapshot: Codable, Equatable, Sendable {
    static let currentSchema = 1
    static let fileName = "widget-snapshot.json"
    static let staleInterval: TimeInterval = 30 * 60

    enum LoginState: String, Codable, Equatable, Sendable {
        case loggedOut
        case loggedIn
    }

    enum AssistantStatus: String, Codable, Equatable, Sendable {
        case loggedOut
        case syncing
        case available
        case working
        case needsAttention
        case offline
    }

    struct Highlight: Codable, Equatable, Sendable {
        enum Kind: String, Codable, Equatable, Sendable {
            case todo
            case inbox
        }

        var kind: Kind
        var id: String
        var summary: String
    }

    var schema: Int
    var loginState: LoginState
    var assistantStatus: AssistantStatus
    var statusText: String
    var unreadCount: Int
    var todoCount: Int
    var highlight: Highlight?
    var updatedAt: Date
    var staleAfter: Date
    var privacyMode: Bool

    init(
        schema: Int = currentSchema,
        loginState: LoginState,
        assistantStatus: AssistantStatus,
        statusText: String,
        unreadCount: Int,
        todoCount: Int,
        highlight: Highlight?,
        updatedAt: Date,
        staleAfter: Date,
        privacyMode: Bool
    ) {
        self.schema = schema
        self.loginState = loginState
        self.assistantStatus = assistantStatus
        self.statusText = Self.sanitized(statusText, limit: 28)
        self.unreadCount = max(0, unreadCount)
        self.todoCount = max(0, todoCount)
        self.highlight = highlight.map {
            Highlight(kind: $0.kind, id: Self.safeID($0.id), summary: Self.sanitized($0.summary))
        }
        self.updatedAt = updatedAt
        self.staleAfter = staleAfter
        self.privacyMode = privacyMode
    }

    static func loggedOut(now: Date = Date()) -> WidgetSnapshot {
        WidgetSnapshot(
            loginState: .loggedOut,
            assistantStatus: .loggedOut,
            statusText: "打开接驳登录",
            unreadCount: 0,
            todoCount: 0,
            highlight: nil,
            updatedAt: now,
            staleAfter: now.addingTimeInterval(staleInterval),
            privacyMode: true
        )
    }

    var isStale: Bool {
        Date() >= staleAfter
    }

    /// 内容指纹故意忽略时间，防止 scene 切换导致无意义刷新。
    var contentFingerprint: String {
        [
            String(schema), loginState.rawValue, assistantStatus.rawValue, statusText,
            String(unreadCount), String(todoCount), highlight?.kind.rawValue ?? "",
            highlight?.id ?? "", highlight?.summary ?? "", String(privacyMode),
        ].joined(separator: "\u{1f}")
    }

    static func sanitized(_ source: String, limit: Int = 72) -> String {
        var text = source.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sensitivePatterns = [
            #"(?i)\bhttps?://\S+"#,
            #"(?i)\b[\w.%+-]+@[\w.-]+\.[A-Z]{2,}\b"#,
            #"\b\d{6,}\b"#,
            #"(?i)\b(?:token|bearer|secret|password|密钥|令牌)\s*[:=：]?\s*\S+"#,
        ]
        for pattern in sensitivePatterns {
            text = text.replacingOccurrences(of: pattern, with: "•••", options: .regularExpression)
        }
        if text.count > limit {
            text = String(text.prefix(max(1, limit - 1))) + "…"
        }
        return text
    }

    private static func safeID(_ source: String) -> String {
        String(source.filter { $0.isLetter || $0.isNumber || "-_:".contains($0) }.prefix(80))
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let decodedSchema = try values.decodeIfPresent(Int.self, forKey: .schema) ?? 1
        guard decodedSchema > 0, decodedSchema <= Self.currentSchema else {
            throw DecodingError.dataCorruptedError(
                forKey: .schema,
                in: values,
                debugDescription: "不支持的 Widget 快照版本"
            )
        }
        schema = decodedSchema
        loginState = try values.decodeIfPresent(LoginState.self, forKey: .loginState) ?? .loggedOut
        assistantStatus = try values.decodeIfPresent(AssistantStatus.self, forKey: .assistantStatus) ?? .syncing
        statusText = Self.sanitized(try values.decodeIfPresent(String.self, forKey: .statusText) ?? "正在同步")
        unreadCount = max(0, try values.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0)
        todoCount = max(0, try values.decodeIfPresent(Int.self, forKey: .todoCount) ?? 0)
        highlight = try values.decodeIfPresent(Highlight.self, forKey: .highlight).map {
            Highlight(kind: $0.kind, id: Self.safeID($0.id), summary: Self.sanitized($0.summary))
        }
        updatedAt = try values.decodeIfPresent(Date.self, forKey: .updatedAt) ?? .distantPast
        staleAfter = try values.decodeIfPresent(Date.self, forKey: .staleAfter)
            ?? updatedAt.addingTimeInterval(Self.staleInterval)
        privacyMode = try values.decodeIfPresent(Bool.self, forKey: .privacyMode) ?? true
    }
}

enum WidgetSnapshotStore {
    static func fileURL(in container: URL) -> URL {
        container.appendingPathComponent(WidgetSnapshot.fileName, isDirectory: false)
    }

    static func load(from container: URL) -> WidgetSnapshot? {
        do {
            let data = try Data(contentsOf: fileURL(in: container))
            return try JSONDecoder.widgetSnapshot.decode(WidgetSnapshot.self, from: data)
        } catch {
            return nil
        }
    }

    /// 同目录临时文件写完后再 replace/move，Widget 永远不会读到半份 JSON。
    static func save(_ snapshot: WidgetSnapshot, to container: URL) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: container, withIntermediateDirectories: true)
        let destination = fileURL(in: container)
        let temporary = container.appendingPathComponent(".widget-snapshot-\(UUID().uuidString).tmp")
        let data = try JSONEncoder.widgetSnapshot.encode(snapshot)
        do {
            try data.write(to: temporary, options: .atomic)
            let errorCode = temporary.withUnsafeFileSystemRepresentation { sourcePath in
                destination.withUnsafeFileSystemRepresentation { destinationPath in
                    guard let sourcePath, let destinationPath else { return Int32(EINVAL) }
                    return rename(sourcePath, destinationPath) == 0 ? 0 : errno
                }
            }
            guard errorCode == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .EIO)
            }
        } catch {
            try? manager.removeItem(at: temporary)
            throw error
        }
    }
}

private extension JSONEncoder {
    static var widgetSnapshot: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

private extension JSONDecoder {
    static var widgetSnapshot: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
