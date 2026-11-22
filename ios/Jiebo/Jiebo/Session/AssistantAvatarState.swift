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
        ["completed", "finished", "succeeded", "success", "done"].contains(status?.lowercased() ?? "")
    }
}

/// 头像表达当前工作状态；回合终态高于工具中间结果，历史工具不参与忙碌判定。
struct AssistantAvatarState {
    static func resolve(connected: Bool, turns: [Turn], chatBusy: Bool = false,
                        hasApproval: Bool = false, hasDelegation: Bool = false,
                        hasDraft: Bool = false) -> AssistantAvatarPhase {
        guard connected else { return .offline }
        let last = turns.last
        let status = last?.status?.lowercased() ?? ""
        let succeeded = AssistantAvatarPhase.isSuccessful(status)
        let failed = ["error", "failed", "failure"].contains(status)
        let terminal = succeeded || failed || ["cancelled", "canceled", "stopped"].contains(status)
        let live = terminal ? nil : last
        if hasApproval || live?.pendingTool != nil { return .approval }
        if hasDelegation || live?.tools.contains(where: { $0.status == "running" }) == true {
            return .executing
        }
        if chatBusy || live?.running == true || live?.queued == true { return .thinking }
        // 重试成功的工具错误仍保留在历史里，不能据此推翻已完成的回合。
        if failed || (!terminal && last?.error?.nilIfEmpty != nil) { return .failure }
        return hasDraft ? .listening : .idle
    }
}
