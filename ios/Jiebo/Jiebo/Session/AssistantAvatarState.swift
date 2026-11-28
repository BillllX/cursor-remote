import Foundation

/// 助理形象只消费客户端已有状态，不改变网关协议。
enum AssistantAvatarPhase: String, CaseIterable {
    case idle
    case listening
    case thinking
    case executing
    case approval
    case success
    case failure
    case offline

    var assetName: String {
        switch self {
        case .idle: "AssistantPoseIdle"
        case .listening: "AssistantPoseListening"
        case .thinking: "AssistantPoseThinking"
        case .executing: "AssistantPoseExecuting"
        case .approval: "AssistantPoseApproval"
        case .success: "AssistantPoseSuccess"
        case .failure: "AssistantPoseFailure"
        case .offline: "AssistantPoseOffline"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .idle: "小驳空闲"
        case .listening: "小驳正在接收输入"
        case .thinking: "小驳正在思考"
        case .executing: "小驳正在执行"
        case .approval: "小驳正在等待确认"
        case .success: "小驳已完成"
        case .failure: "小驳执行失败"
        case .offline: "小驳已离线"
        }
    }

    static func isSuccessful(_ status: String?) -> Bool {
        guard let raw = status, !raw.isEmpty else { return false }
        switch raw.lowercased() {
        case "completed", "finished", "succeeded", "success", "done":
            return true
        default:
            return false
        }
    }
}

/// 助理头像只依赖末轮少量状态字段，抽成轻量值快照后，流式正文增量不再穿透广播到顶部头像。
struct AssistantTurnAvatarSnapshot: Equatable, Sendable {
    var status: String?
    var hasPendingTool: Bool
    var hasRunningTool: Bool
    var running: Bool
    var queued: Bool
    var hasError: Bool

    static let empty = AssistantTurnAvatarSnapshot(
        status: nil,
        hasPendingTool: false,
        hasRunningTool: false,
        running: false,
        queued: false,
        hasError: false
    )

    static func from(turns: [Turn]) -> AssistantTurnAvatarSnapshot {
        guard let last = turns.last else { return .empty }
        return AssistantTurnAvatarSnapshot(
            status: last.status,
            hasPendingTool: last.pendingTool != nil,
            hasRunningTool: last.tools.contains(where: { $0.status == "running" }),
            running: last.running,
            queued: last.queued,
            hasError: last.error?.nilIfEmpty != nil
        )
    }
}

/// 头像表达当前工作状态；回合终态高于工具中间结果，历史工具不参与忙碌判定。
struct AssistantAvatarState {
    static func resolve(connected: Bool, turns: [Turn], chatBusy: Bool = false,
                        hasApproval: Bool = false, hasDelegation: Bool = false,
                        hasDraft: Bool = false) -> AssistantAvatarPhase {
        resolve(
            connected: connected,
            turnSnapshot: .from(turns: turns),
            chatBusy: chatBusy,
            hasApproval: hasApproval,
            hasDelegation: hasDelegation,
            hasDraft: hasDraft
        )
    }

    static func resolve(connected: Bool, turnSnapshot: AssistantTurnAvatarSnapshot, chatBusy: Bool = false,
                        hasApproval: Bool = false, hasDelegation: Bool = false,
                        hasDraft: Bool = false) -> AssistantAvatarPhase {
        guard connected else { return .offline }
        let status = turnSnapshot.status?.lowercased() ?? ""
        let succeeded = AssistantAvatarPhase.isSuccessful(status)
        let failed: Bool
        let cancelled: Bool
        switch status {
        case "error", "failed", "failure":
            failed = true
            cancelled = false
        case "cancelled", "canceled", "stopped":
            failed = false
            cancelled = true
        default:
            failed = false
            cancelled = false
        }
        let terminal = succeeded || failed || cancelled
        if hasApproval || (!terminal && turnSnapshot.hasPendingTool) { return .approval }
        if hasDelegation || (!terminal && turnSnapshot.hasRunningTool) {
            return .executing
        }
        if chatBusy || (!terminal && (turnSnapshot.running || turnSnapshot.queued)) { return .thinking }
        // 重试成功的工具错误仍保留在历史里，不能据此推翻已完成的回合。
        if failed || (!terminal && turnSnapshot.hasError) { return .failure }
        return hasDraft ? .listening : .idle
    }
}
