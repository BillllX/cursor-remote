import Foundation

/// 仅用于已有服务端 clientId 去重与 im_ack 回执的 IM 发送；普通 Prompt/assistant_op 不具备同等保证。
enum ImDurableOutboxStatus: String, Codable, Hashable {
    case pending
    case retrying
    case inFlight
    case succeeded
    case permanentFailure
}

struct ImDurableOutboxMetadata: Codable, Hashable {
    let stableID: String
    var attempts: Int
    var nextAttemptAt: Double
    var status: ImDurableOutboxStatus

    init(stableID: String, now: Double) {
        self.stableID = stableID
        attempts = 0
        nextAttemptAt = now
        status = .pending
    }

    init(stableID: String, attempts: Int, nextAttemptAt: Double, status: ImDurableOutboxStatus) {
        self.stableID = stableID
        self.attempts = attempts
        self.nextAttemptAt = nextAttemptAt
        self.status = status
    }
}

enum ImDurableOutboxPolicy {
    static let maximumAttempts = 5
    static let replayBatchLimit = 8
    static let maximumDelay: Double = 30_000
    static let rateLimitDelay: Double = 60_000
    static let minimumScheduleDelay: Double = 100
    static let maximumScheduleDelay: Double = 60_000

    static func nextDelay(attempts: Int) -> Double {
        min(pow(2, Double(max(0, attempts - 1))) * 1_000, maximumDelay)
    }

    static func mayReplay(_ metadata: ImDurableOutboxMetadata, now: Double) -> Bool {
        (metadata.status == .pending || metadata.status == .retrying)
            && metadata.attempts < maximumAttempts
            && metadata.nextAttemptAt.isFinite
            && metadata.nextAttemptAt <= now
    }

    static func beginAttempt(
        _ metadata: ImDurableOutboxMetadata,
        now: Double
    ) -> ImDurableOutboxMetadata {
        var next = metadata
        next.attempts += 1
        next.status = .inFlight
        next.nextAttemptAt = now
        return next
    }

    static func afterTransientFailure(
        _ metadata: ImDurableOutboxMetadata,
        now: Double
    ) -> ImDurableOutboxMetadata {
        var next = metadata
        if next.attempts >= maximumAttempts {
            next.status = .permanentFailure
            next.nextAttemptAt = 0
        } else {
            next.status = .retrying
            next.nextAttemptAt = now + nextDelay(attempts: next.attempts)
        }
        return next
    }

    /// 断线并不代表服务端拒绝；同一个 clientId 重连后可安全重放，不消耗失败预算。
    static func afterConnectionLoss(
        _ metadata: ImDurableOutboxMetadata,
        now: Double
    ) -> ImDurableOutboxMetadata {
        var next = metadata
        next.attempts = max(0, next.attempts - (next.status == .inFlight ? 1 : 0))
        next.status = .retrying
        next.nextAttemptAt = now
        return next
    }

    /// 网关每人每分钟限流；限流拒绝不消耗失败预算，至少等完整窗口再重放。
    static func afterRateLimited(
        _ metadata: ImDurableOutboxMetadata,
        now: Double
    ) -> ImDurableOutboxMetadata {
        var next = metadata
        next.attempts = max(0, next.attempts - (next.status == .inFlight ? 1 : 0))
        next.status = .retrying
        next.nextAttemptAt = now + rateLimitDelay
        return next
    }

    static func isPermanent(errorCode: String) -> Bool {
        ["bad_body", "forbidden", "not_found", "not_visible", "too_large", "unsupported"].contains(errorCode)
    }

    /// 只为可重放状态生成安全的毫秒等待值；在途、成功和永久失败永不进入整数转换。
    static func scheduledDelay(
        _ metadata: ImDurableOutboxMetadata,
        now: Double
    ) -> Int64? {
        guard metadata.status == .pending || metadata.status == .retrying,
              metadata.attempts < maximumAttempts,
              metadata.nextAttemptAt.isFinite
        else { return nil }
        let raw = metadata.nextAttemptAt - now
        guard raw.isFinite else { return nil }
        let bounded = min(max(minimumScheduleDelay, raw), maximumScheduleDelay)
        return Int64(bounded.rounded(.up))
    }

    /// 进程退出时若正在等 ack，同一个 clientId 可安全重放；不再用特殊浮点哨兵。
    static func restored(_ metadata: ImDurableOutboxMetadata, now: Double) -> ImDurableOutboxMetadata {
        var next = metadata
        if next.status == .inFlight {
            return afterConnectionLoss(next, now: now)
        }
        if next.attempts >= maximumAttempts, next.status != .succeeded {
            next.status = .permanentFailure
            next.nextAttemptAt = 0
            return next
        }
        // 兼容 P2 初版可能落盘的 greatestFiniteMagnitude 哨兵；新版本不会再写这种值。
        if next.status == .retrying,
           !next.nextAttemptAt.isFinite || next.nextAttemptAt > now + rateLimitDelay {
            next.nextAttemptAt = now + nextDelay(attempts: next.attempts)
        }
        return next
    }
}

enum ImUploadLeasePolicy {
    static func acceptsCompletion(
        expectedGeneration: Int,
        expectedTenant: String,
        currentGeneration: Int?,
        currentTenant: String
    ) -> Bool {
        currentGeneration == expectedGeneration && currentTenant == expectedTenant
    }
}
