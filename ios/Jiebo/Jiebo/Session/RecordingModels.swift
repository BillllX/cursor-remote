import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - 策略与设置模型（对齐 gateway/src/recordings/types.ts）

enum RecordingRouteKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case personal
    case workspace

    var id: String { rawValue }

    var title: String {
        switch self {
        case .personal: return "个人助理（可乐）"
        case .workspace: return "指定项目工作区"
        }
    }
}

enum RecordingNetworkPolicy: String, Codable, CaseIterable, Identifiable, Sendable {
    case wifiAndCellular = "wifi_and_cellular"
    case wifiOnly = "wifi_only"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .wifiAndCellular: return "Wi-Fi 与蜂窝网络"
        case .wifiOnly: return "仅 Wi-Fi"
        }
    }

    var shortLabel: String {
        switch self {
        case .wifiAndCellular: return "允许蜂窝"
        case .wifiOnly: return "仅 Wi-Fi"
        }
    }

    var allowsCellular: Bool { self == .wifiAndCellular }
}

enum RecordingAsrPolicy: String, Codable, CaseIterable, Identifiable, Sendable {
    case onDeviceOnly = "on_device_only"
    case onDevicePreferred = "on_device_preferred"
    case serverAllowed = "server_allowed"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .onDeviceOnly: return "仅本机转写（Apple 系统模型）"
        case .onDevicePreferred: return "优先本机转写"
        case .serverAllowed: return "允许服务端转写"
        }
    }

    var shortLabel: String {
        switch self {
        case .onDeviceOnly: return "本机转写"
        case .onDevicePreferred: return "优先本机"
        case .serverAllowed: return "可云端转写"
        }
    }

    var note: String {
        switch self {
        case .onDeviceOnly:
            return "完全在 iPhone 本地使用 Apple 系统语音模型转写，零云端转写费用，不触发服务端 ASR。"
        case .onDevicePreferred:
            return "优先用 iPhone 本地转写；未取得逐字稿前不会私自走云端转写。"
        case .serverAllowed:
            return "明确授权在缺少端侧逐字稿时由服务端 ASR 接管（需开启原音同步且服务端已配置供应商）。"
        }
    }
}

enum RecordingMemoryPolicy: String, Codable, CaseIterable, Identifiable, Sendable {
    case confirmOnly = "confirm_only"
    case disabled

    var id: String { rawValue }

    var title: String {
        switch self {
        case .confirmOnly: return "生成待确认建议（不自动写入）"
        case .disabled: return "不提取记忆建议"
        }
    }
}

/// 按租户隔离保存的个人长录音偏好配置
struct PersonalRecordingSettings: Codable, Equatable, Sendable {
    var configured: Bool = false
    var defaultRouteKind: RecordingRouteKind = .personal
    var defaultWorkspaceKey: String = ""
    var defaultWorkspaceDisplayName: String = ""
    var networkPolicy: RecordingNetworkPolicy = .wifiAndCellular
    var asrPolicy: RecordingAsrPolicy = .onDeviceOnly
    /// 默认仅同步带时间戳逐字稿，原音留在 iPhone；用户可显式开启同步原音到私有空间
    var syncAudio: Bool = false
    var rawRetentionDays: Int = 30
    var textRetentionDays: Int = 90
    var memoryPolicy: RecordingMemoryPolicy = .confirmOnly

    static func storageKey(tenant: String) -> String {
        "jiebo.personalRecording.settings.v1.\(tenant)"
    }

    static func load(tenant: String) -> PersonalRecordingSettings {
        guard !tenant.isEmpty,
              let data = UserDefaults.standard.data(forKey: storageKey(tenant: tenant)),
              let decoded = try? JSONDecoder().decode(PersonalRecordingSettings.self, from: data)
        else { return PersonalRecordingSettings() }
        return decoded
    }

    func save(tenant: String) {
        guard !tenant.isEmpty, let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey(tenant: tenant))
    }

    var effectiveRouteSummary: String {
        if defaultRouteKind == .workspace, !defaultWorkspaceKey.isEmpty {
            return defaultWorkspaceDisplayName.isEmpty ? defaultWorkspaceKey : defaultWorkspaceDisplayName
        }
        return "个人助理"
    }

    func policySnapshotDictionary() -> [String: Any] {
        [
            "version": 1,
            "network": networkPolicy.rawValue,
            "asr": asrPolicy.rawValue,
            "syncAudio": syncAudio,
            "uploadDuringRecording": false,
            "rawRetentionDays": rawRetentionDays,
            "textRetentionDays": textRetentionDays,
            "memory": memoryPolicy.rawValue,
            "reminders": "explicit_only",
        ]
    }
}

// MARK: - 本机录音目录元数据（meta.json）

struct LocalRecordingEvent: Codable, Equatable, Sendable {
    var eventId: String
    var type: String // pause | resume | interruption | route_change | recovery_gap
    var startWallTime: String
    var endWallTime: String?
    var canonicalFrame: Int
    var reason: String?
}

struct LocalRecordingMissingRange: Codable, Equatable, Sendable {
    var startFrame: Int
    var endFrame: Int
    var reason: String
}

struct LocalRecordingMeta: Codable, Equatable, Sendable {
    var sessionId: String
    var title: String
    var startedAt: String
    var stoppedAt: String?
    var routeKind: RecordingRouteKind
    var workspaceKey: String?
    var workspaceDisplayName: String?
    var networkPolicy: RecordingNetworkPolicy
    var asrPolicy: RecordingAsrPolicy
    var syncAudio: Bool
    var rawRetentionDays: Int
    var textRetentionDays: Int
    var memoryPolicy: RecordingMemoryPolicy
    var partial: Bool
    var events: [LocalRecordingEvent]
    var missingRanges: [LocalRecordingMissingRange]

    var routeDisplayName: String {
        if routeKind == .workspace, let key = workspaceKey, !key.isEmpty {
            return (workspaceDisplayName?.isEmpty == false ? workspaceDisplayName! : key)
        }
        return "个人助理"
    }

    func routeDictionary() -> [String: Any] {
        if routeKind == .workspace, let key = workspaceKey, !key.isEmpty {
            return ["kind": "workspace", "workspaceId": key]
        }
        return ["kind": "personal", "workspaceId": NSNull()]
    }

    func policySnapshotDictionary() -> [String: Any] {
        [
            "version": 1,
            "network": networkPolicy.rawValue,
            "asr": asrPolicy.rawValue,
            "syncAudio": syncAudio,
            "uploadDuringRecording": false,
            "rawRetentionDays": rawRetentionDays,
            "textRetentionDays": textRetentionDays,
            "memory": memoryPolicy.rawValue,
            "reminders": "explicit_only",
        ]
    }
}

enum LocalTransferPhase: String, Sendable {
    case recording
    case paused
    case preparing
    case uploading
    case accepted
    case failed
}

struct LocalRecordingSummary: Identifiable, Equatable, Sendable {
    var id: String { sessionId }
    var sessionId: String
    var folder: URL
    var title: String
    var startedAt: String
    var routeDisplayName: String
    var routeKind: RecordingRouteKind
    var workspaceKey: String?
    var syncAudio: Bool
    var partial: Bool
    var pieceCount: Int
    var totalBytes: Int64
    var estimatedSeconds: Double
    var phase: LocalTransferPhase
    var transferError: String?
}

// MARK: - 服务端契约 DTO（与 gateway/src/recordings/types.ts 字段精确一致）

struct RecordingRouteDTO: Codable, Equatable, Sendable {
    var kind: String // "personal" | "workspace"
    var workspaceId: String?

    var isWorkspace: Bool { kind == "workspace" && !(workspaceId?.isEmpty ?? true) }
}

struct RecordingPolicySnapshotDTO: Codable, Equatable, Sendable {
    var version: Int?
    var network: String?
    var asr: String?
    var syncAudio: Bool?
    var uploadDuringRecording: Bool?
    var rawRetentionDays: Int?
    var textRetentionDays: Int?
    var memory: String?
    var reminders: String?
}

struct RecordingMissingRangeDTO: Codable, Equatable, Identifiable, Sendable {
    var startFrame: Int
    var endFrame: Int
    var reason: String

    var id: String { "\(startFrame)-\(endFrame)-\(reason)" }
}

struct RecordingLastErrorDTO: Codable, Equatable, Sendable {
    var code: String
    var message: String
    var retryable: Bool
    var at: String
}

struct RecordingSessionStatusDTO: Codable, Equatable, Identifiable, Sendable {
    var sessionId: String
    var deviceId: String
    var generation: Int
    var revision: Int
    var title: String?
    var createdAt: String
    var startedAt: String
    var stoppedAt: String?
    var route: RecordingRouteDTO
    var policySnapshot: RecordingPolicySnapshotDTO?
    var policyHash: String
    var captureState: String
    var transferState: String
    var processingState: String
    var coverage: String // complete | partial | none
    var expectedChunks: Int
    var verifiedChunks: Int
    var missingSeqs: [Int]?
    var missingRanges: [RecordingMissingRangeDTO]?
    var expectedTotalFrames: Int
    var expectedTotalBytes: Int
    var hasTranscript: Bool
    var audioUploaded: Bool
    var audioExpired: Bool
    var rawExpiresAt: String?
    var textExpiresAt: String?
    var resultRevision: Int?
    var lastError: RecordingLastErrorDTO?
    var nextAttemptAt: String?

    var id: String { sessionId }

    var displayTitle: String {
        if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
            return t
        }
        return "录音 \(RecordingFormatting.shortDateTime(startedAt))"
    }

    var isPartial: Bool { coverage == "partial" }

    var isReadyToViewResult: Bool {
        resultRevision != nil || processingState == "delivered"
    }

    var isInProgress: Bool {
        ["queued", "transcribing", "summarizing", "delivering"].contains(processingState)
    }

    var needsUserAction: Bool {
        ["partial_pending", "needs_attention"].contains(processingState) || transferState == "failed"
    }
}

struct RecordingSessionsPageDTO: Codable, Equatable, Sendable {
    var items: [RecordingSessionStatusDTO]
    var nextCursor: String?
}

struct RecordingCapabilitiesDTO: Codable, Equatable, Sendable {
    struct Quota: Codable, Equatable, Sendable {
        var totalBytes: Int64
        var usedBytes: Int64
        var remainingBytes: Int64
    }
    struct AsrInfo: Codable, Equatable, Sendable {
        var onDeviceSupported: Bool
        var serverAdapterAvailable: Bool
        var serverProvider: String?
    }
    var schemaVersion: Int
    var enabled: Bool
    var canonicalSampleRate: Int
    var quota: Quota?
    var asr: AsrInfo?
}

struct RecordingCitationDTO: Codable, Equatable, Identifiable, Sendable {
    var segmentId: String
    var startFrame: Int
    var endFrame: Int
    var transcriptRevision: Int

    var id: String { "\(segmentId)-\(startFrame)-\(transcriptRevision)" }
}

struct RecordingClaimDTO: Codable, Equatable, Identifiable, Sendable {
    var claimId: String
    var text: String
    var kind: String // fact | proposal | uncertain
    var citations: [RecordingCitationDTO]

    var id: String { claimId }
}

struct RecordingSectionSummaryDTO: Codable, Equatable, Identifiable, Sendable {
    var sectionId: String
    var title: String
    var startFrame: Int
    var endFrame: Int
    var summary: String
    var citations: [RecordingCitationDTO]

    var id: String { sectionId }
}

struct RecordingTranscriptSegmentDTO: Codable, Equatable, Identifiable, Sendable {
    var segmentId: String
    var startFrame: Int
    var endFrame: Int
    var text: String
    var speakerLocalId: String?
    var identityStatus: String?
    var confidence: Double?
    var uncertain: Bool?

    var id: String { segmentId }
}

struct RecordingMemoryCandidateDTO: Codable, Equatable, Identifiable, Sendable {
    var candidateId: String
    var text: String
    var topic: String?
    var subject: String // user | third_party | unknown
    var evidenceRefs: [RecordingCitationDTO]
    var confirmation: String // pending | confirmed | dismissed
    var proposedScope: String // personal | workspace
    var sourceSessionId: String
    var memoryId: String?

    var id: String { candidateId }
}

struct RecordingReminderCandidateDTO: Codable, Equatable, Identifiable, Sendable {
    var candidateId: String
    var text: String
    var suggestedTimeText: String?
    var evidenceRefs: [RecordingCitationDTO]
    var status: String // suggested | dismissed

    var id: String { candidateId }
}

struct RecordingDeliveryReceiptDTO: Codable, Equatable, Sendable {
    var status: String // pending | acknowledged | failed | revoked
    var deliveryKey: String
    var targetReceipt: String?
    var ackAt: String?
    var workspaceBatchId: String?
    var workspaceKey: String?
    var inboxItemId: String?
    var error: String?
}

struct RecordingResultDTO: Codable, Equatable, Sendable {
    var sessionId: String
    var generation: Int
    var resultRevision: Int
    var coverage: String
    var transcriptRevision: Int
    var transcriptSource: String
    var timestampGranularity: String
    var title: String
    var summary: String
    var sections: [RecordingSectionSummaryDTO]
    var segments: [RecordingTranscriptSegmentDTO]
    var claims: [RecordingClaimDTO]
    var memoryCandidates: [RecordingMemoryCandidateDTO]
    var reminderCandidates: [RecordingReminderCandidateDTO]
    var missingRanges: [RecordingMissingRangeDTO]
    var audioAvailable: Bool
    var audioExpired: Bool
    var usedFallbackSummary: Bool?
    var delivery: RecordingDeliveryReceiptDTO
}

struct RecordingDeletionStatusDTO: Codable, Equatable, Sendable {
    var sessionId: String
    var generation: Int
    var status: String
    var deletedAt: String
    var objectsPurged: Bool
    var indexPurged: Bool
    var deliveriesRevoked: Bool
    var localCleanupPending: Bool
    var backupPolicyNote: String
}

struct RecordingAPIErrorEnvelope: Codable, Sendable {
    struct Inner: Codable, Sendable {
        var code: String
        var message: String
        var retryable: Bool?
        var requestId: String?
    }
    var error: Inner
}

enum RecordingResultFetchOutcome: Sendable {
    case ready(RecordingResultDTO)
    case pending(RecordingSessionStatusDTO)
}

// MARK: - 格式化与中文状态标签

enum RecordingFormatting {
    static let canonicalSampleRate: Double = 24_000

    static func formatFrames(_ frames: Int) -> String {
        let total = max(0, Int((Double(frames) / canonicalSampleRate).rounded(.down)))
        return formatSeconds(Double(total))
    }

    static func formatSeconds(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        }
        return String(format: "%02d:%02d", m, s)
    }

    static func formatClock(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        return String(format: "%02d:%02d:%02d", h, m, s)
    }

    static func formatBytes(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: max(0, bytes))
    }

    static func shortDateTime(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        let df = DateFormatter()
        df.locale = Locale(identifier: "zh_CN")
        df.dateFormat = "MM月dd日 HH:mm"
        return df.string(from: date)
    }

    static func processingLabel(_ state: String, transferState: String? = nil) -> String {
        switch state {
        case "not_started":
            if transferState == "awaiting_chunks" { return "等待分片齐备" }
            if transferState == "failed" { return "传输失败" }
            return "等待处理"
        case "queued": return "排队整理中"
        case "transcribing": return "转写中"
        case "summarizing": return "生成摘要中"
        case "delivering": return "交付可乐中"
        case "delivered": return "已整理"
        case "partial_pending": return "待确认部分整理"
        case "needs_attention": return "需要处理"
        case "cancelling": return "取消中"
        case "cancelled": return "已取消"
        case "deleting": return "删除中"
        case "deleted": return "已删除"
        default: return state
        }
    }

    static func transferLabel(_ state: String) -> String {
        switch state {
        case "local_only": return "仅在本机"
        case "waiting_network": return "等待网络"
        case "waiting_auth": return "等待续期授权"
        case "uploading": return "同步中"
        case "awaiting_chunks": return "等待剩余片段"
        case "durable": return "已同步服务端"
        case "failed": return "同步失败"
        default: return state
        }
    }

    static func transcriptSourceLabel(_ source: String) -> String {
        switch source {
        case "on_device_speech_analyzer": return "Apple 本机转写"
        case "on_device_sf_speech": return "本机语音识别"
        case "server_asr": return "服务端转写"
        default: return source
        }
    }

    static func subjectLabel(_ subject: String) -> String {
        switch subject {
        case "user": return "疑似你本人陈述"
        case "third_party": return "他人陈述（慎入个人记忆）"
        default: return "说话人未确认"
        }
    }
}

// MARK: - 服务端 REST API 客户端（控制面查询、结果、记忆确认与回放下载）

enum RecordingAPI {
    private static var uploadBase: URL { GatewayConfig.recordingsUploadBaseURL }
    private static var mediaBase: URL { GatewayConfig.recordingsMediaBaseURL }

    private static func makeRequest(
        method: String,
        url: URL,
        token: String,
        body: [String: Any]? = nil
    ) throws -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    static func parseServerError(data: Data, statusCode: Int) -> String {
        if let env = try? JSONDecoder().decode(RecordingAPIErrorEnvelope.self, from: data),
           !env.error.message.isEmpty {
            return env.error.message
        }
        if statusCode == 401 { return "登录凭证已失效，请重新连接网关" }
        if statusCode == 404 { return "未找到该录音记录" }
        if statusCode == 410 { return "该录音已被删除" }
        return "录音服务返回状态码 \(statusCode)"
    }

    private static func requestData(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await AppTrafficHTTP.data(for: req, category: "recordings")
        guard let http = response as? HTTPURLResponse else {
            throw RecordingProblem("录音服务响应无效")
        }
        return (data, http)
    }

    static func fetchCapabilities(token: String) async throws -> RecordingCapabilitiesDTO {
        let req = try makeRequest(method: "GET", url: uploadBase.appendingPathComponent("capabilities"), token: token)
        let (data, http) = try await requestData(req)
        guard 200..<300 ~= http.statusCode else {
            throw RecordingProblem(parseServerError(data: data, statusCode: http.statusCode))
        }
        return try JSONDecoder().decode(RecordingCapabilitiesDTO.self, from: data)
    }

    static func listSessions(token: String, limit: Int = 40, cursor: String? = nil) async throws -> RecordingSessionsPageDTO {
        var comps = URLComponents(url: uploadBase.appendingPathComponent("sessions"), resolvingAgainstBaseURL: false)
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor, !cursor.isEmpty { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        comps?.queryItems = query
        guard let url = comps?.url else { throw RecordingProblem("无效的会话列表地址") }
        let req = try makeRequest(method: "GET", url: url, token: token)
        let (data, http) = try await requestData(req)
        guard 200..<300 ~= http.statusCode else {
            throw RecordingProblem(parseServerError(data: data, statusCode: http.statusCode))
        }
        return try JSONDecoder().decode(RecordingSessionsPageDTO.self, from: data)
    }

    static func fetchSession(token: String, sessionId: String) async throws -> RecordingSessionStatusDTO {
        let url = uploadBase.appendingPathComponent("sessions").appendingPathComponent(sessionId)
        let req = try makeRequest(method: "GET", url: url, token: token)
        let (data, http) = try await requestData(req)
        guard 200..<300 ~= http.statusCode else {
            throw RecordingProblem(parseServerError(data: data, statusCode: http.statusCode))
        }
        return try JSONDecoder().decode(RecordingSessionStatusDTO.self, from: data)
    }

    static func fetchResult(token: String, sessionId: String) async throws -> RecordingResultFetchOutcome {
        let url = uploadBase.appendingPathComponent("sessions").appendingPathComponent(sessionId).appendingPathComponent("result")
        let req = try makeRequest(method: "GET", url: url, token: token)
        let (data, http) = try await requestData(req)
        if http.statusCode == 202 {
            let status = try JSONDecoder().decode(RecordingSessionStatusDTO.self, from: data)
            return .pending(status)
        }
        guard 200..<300 ~= http.statusCode else {
            throw RecordingProblem(parseServerError(data: data, statusCode: http.statusCode))
        }
        let result = try JSONDecoder().decode(RecordingResultDTO.self, from: data)
        return .ready(result)
    }

    static func retrySession(token: String, sessionId: String, expectedRevision: Int?) async throws -> RecordingSessionStatusDTO {
        let url = uploadBase.appendingPathComponent("sessions").appendingPathComponent(sessionId).appendingPathComponent("retry")
        var body: [String: Any] = [:]
        if let expectedRevision { body["expectedRevision"] = expectedRevision }
        let req = try makeRequest(method: "POST", url: url, token: token, body: body)
        let (data, http) = try await requestData(req)
        guard 200..<300 ~= http.statusCode else {
            throw RecordingProblem(parseServerError(data: data, statusCode: http.statusCode))
        }
        return try JSONDecoder().decode(RecordingSessionStatusDTO.self, from: data)
    }

    static func cancelSession(token: String, sessionId: String, expectedRevision: Int?) async throws -> RecordingSessionStatusDTO {
        let url = uploadBase.appendingPathComponent("sessions").appendingPathComponent(sessionId).appendingPathComponent("cancel")
        var body: [String: Any] = [:]
        if let expectedRevision { body["expectedRevision"] = expectedRevision }
        let req = try makeRequest(method: "POST", url: url, token: token, body: body)
        let (data, http) = try await requestData(req)
        guard 200..<300 ~= http.statusCode else {
            throw RecordingProblem(parseServerError(data: data, statusCode: http.statusCode))
        }
        return try JSONDecoder().decode(RecordingSessionStatusDTO.self, from: data)
    }

    static func acceptPartial(token: String, sessionId: String, expectedRevision: Int?) async throws -> RecordingSessionStatusDTO {
        let url = uploadBase.appendingPathComponent("sessions").appendingPathComponent(sessionId).appendingPathComponent("accept-partial")
        var body: [String: Any] = [:]
        if let expectedRevision { body["expectedRevision"] = expectedRevision }
        let req = try makeRequest(method: "POST", url: url, token: token, body: body)
        let (data, http) = try await requestData(req)
        guard 200..<300 ~= http.statusCode else {
            throw RecordingProblem(parseServerError(data: data, statusCode: http.statusCode))
        }
        return try JSONDecoder().decode(RecordingSessionStatusDTO.self, from: data)
    }

    static func deleteSession(
        token: String,
        sessionId: String,
        expectedRevision: Int?,
        deleteLinkedMemories: Bool
    ) async throws -> RecordingDeletionStatusDTO {
        let url = uploadBase.appendingPathComponent("sessions").appendingPathComponent(sessionId)
        var body: [String: Any] = ["deleteLinkedMemories": deleteLinkedMemories]
        if let expectedRevision { body["expectedRevision"] = expectedRevision }
        let req = try makeRequest(method: "DELETE", url: url, token: token, body: body)
        let (data, http) = try await requestData(req)
        guard 200..<300 ~= http.statusCode else {
            throw RecordingProblem(parseServerError(data: data, statusCode: http.statusCode))
        }
        return try JSONDecoder().decode(RecordingDeletionStatusDTO.self, from: data)
    }

    static func updateMemoryCandidate(
        token: String,
        sessionId: String,
        candidateId: String,
        confirm: Bool
    ) async throws -> RecordingMemoryCandidateDTO {
        let action = confirm ? "confirm" : "dismiss"
        let url = uploadBase
            .appendingPathComponent("sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("memories")
            .appendingPathComponent(candidateId)
            .appendingPathComponent(action)
        let req = try makeRequest(method: "POST", url: url, token: token, body: [:])
        let (data, http) = try await requestData(req)
        guard 200..<300 ~= http.statusCode else {
            throw RecordingProblem(parseServerError(data: data, statusCode: http.statusCode))
        }
        return try JSONDecoder().decode(RecordingMemoryCandidateDTO.self, from: data)
    }

    /// 当本机原音副本已清理、但服务端留存原音时，经 Header Bearer 下载指定音频段到本地临时缓存供回听
    static func fetchRemoteChunk(token: String, sessionId: String, seq: Int) async throws -> URL {
        let cacheDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("JieboRecordingPlayback", isDirectory: true)
            .appendingPathComponent(sessionId, isDirectory: true)
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        let dst = cacheDir.appendingPathComponent(String(format: "%06d.m4a", seq))
        if FileManager.default.fileExists(atPath: dst.path) { return dst }

        let url = mediaBase
            .appendingPathComponent("sessions")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("chunks")
            .appendingPathComponent(String(seq))
        let req = try makeRequest(method: "GET", url: url, token: token)
        let (data, http) = try await requestData(req)
        guard 200..<300 ~= http.statusCode else {
            throw RecordingProblem(parseServerError(data: data, statusCode: http.statusCode))
        }
        try data.write(to: dst, options: .atomic)
        return dst
    }
}
