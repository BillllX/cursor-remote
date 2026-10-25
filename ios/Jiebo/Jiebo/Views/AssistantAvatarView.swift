import SwiftUI

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
        case .idle: "助理空闲"
        case .listening: "助理正在接收输入"
        case .thinking: "助理正在思考"
        case .executing: "助理正在执行"
        case .approval: "助理正在等待确认"
        case .success: "助理已完成"
        case .failure: "助理执行失败"
        case .offline: "助理已离线"
        }
    }

    var canComplete: Bool {
        self == .thinking || self == .executing
    }
}

extension ChatStore {
    /// 优先级：离线 > 等待确认 > 失败 > 执行 > 思考 > 接收输入 > 空闲。
    var assistantAvatarPhase: AssistantAvatarPhase {
        guard connected else { return .offline }

        let turns = assistantChat?.turns ?? []
        let liveTurn = turns.last {
            $0.running
                || $0.queued
                || $0.pendingTool != nil
                || $0.tools.contains { $0.status == "running" }
        }
        let hasApproval = liveTurn?.pendingTool != nil
            || !(assistantState?.approvals.isEmpty ?? true)
            || !(assistantState?.draftCards?.isEmpty ?? true)
        if hasApproval { return .approval }

        if liveTurn == nil, let last = turns.last {
            let status = last.status?.lowercased() ?? ""
            let failed = last.error?.nilIfEmpty != nil
                || last.tools.contains { $0.status == "error" }
                || status.contains("error")
                || status.contains("fail")
            if failed { return .failure }
        }
        if liveTurn == nil, assistantState?.background.ok == false { return .failure }

        let toolRunning = liveTurn?.tools.contains { $0.status == "running" } == true
        if toolRunning || !runningDelegations.isEmpty { return .executing }
        if liveTurn?.running == true || liveTurn?.queued == true { return .thinking }
        if let chatId = assistantChatId,
           runningChatIds.contains(chatId) || queuedChatIds.contains(chatId) {
            return .thinking
        }

        if let chatId = assistantChatId,
           !draft(for: chatId).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .listening
        }
        return .idle
    }
}

/// 使用原设定图透明姿态，只做不会破坏造型的整体位移、缩放和倾斜。
struct AssistantAvatarView: View {
    let phase: AssistantAvatarPhase
    var size: CGFloat

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var displayedPhase: AssistantAvatarPhase
    @State private var motionActive = false

    init(phase: AssistantAvatarPhase, size: CGFloat) {
        self.phase = phase
        self.size = size
        _displayedPhase = State(initialValue: phase)
    }

    var body: some View {
        ZStack {
            Image(displayedPhase.assetName)
                .resizable()
                .scaledToFit()
                .id(displayedPhase)
                .transition(.opacity)
        }
        .frame(width: size, height: size)
        .scaleEffect(x: motionScale.width, y: motionScale.height, anchor: .bottom)
        .rotationEffect(motionRotation, anchor: .bottom)
        .offset(x: motionOffset.width, y: motionOffset.height)
        .animation(JieboMotion.fade(reduceMotion), value: displayedPhase)
        .onChange(of: phase) { oldPhase, newPhase in
            if oldPhase.canComplete, newPhase == .idle {
                displayedPhase = .success
            } else {
                displayedPhase = newPhase
            }
        }
        .task(id: completionKey) {
            guard displayedPhase == .success, phase == .idle else { return }
            try? await Task.sleep(for: .milliseconds(1_350))
            guard !Task.isCancelled, phase == .idle else { return }
            displayedPhase = .idle
        }
        .task(id: motionKey) {
            motionActive = false
            guard !reduceMotion, scenePhase == .active else { return }
            await Task.yield()
            withAnimation(motionAnimation.repeatForever(autoreverses: true)) {
                motionActive = true
            }
        }
        .accessibilityHidden(true)
    }

    private var completionKey: String {
        "\(phase.rawValue):\(displayedPhase.rawValue)"
    }

    private var motionKey: String {
        "\(displayedPhase.rawValue):\(reduceMotion):\(scenePhase == .active)"
    }

    private var motionAnimation: Animation {
        switch displayedPhase {
        case .idle: .easeInOut(duration: 1.4)
        case .listening: .easeInOut(duration: 0.62)
        case .thinking: .easeInOut(duration: 0.9)
        case .executing: .easeInOut(duration: 0.28)
        case .approval: .easeInOut(duration: 0.75)
        case .success: .spring(duration: 0.5, bounce: 0.22)
        case .failure: .easeInOut(duration: 1)
        case .offline: .easeInOut(duration: 1.7)
        }
    }

    private var motionScale: CGSize {
        guard motionActive else { return CGSize(width: 1, height: 1) }
        switch displayedPhase {
        case .idle: return CGSize(width: 1.008, height: 1.014)
        case .listening: return CGSize(width: 1.012, height: 1.018)
        case .thinking: return CGSize(width: 1.005, height: 1.008)
        case .executing: return CGSize(width: 1.016, height: 0.992)
        case .approval: return CGSize(width: 1, height: 1)
        case .success: return CGSize(width: 1.025, height: 1.025)
        case .failure: return CGSize(width: 1, height: 0.99)
        case .offline: return CGSize(width: 1.006, height: 0.988)
        }
    }

    private var motionOffset: CGSize {
        guard motionActive else { return .zero }
        let distance = max(1, size * 0.035)
        switch displayedPhase {
        case .idle: return CGSize(width: 0, height: -distance * 0.45)
        case .listening: return CGSize(width: 0, height: -distance)
        case .thinking: return CGSize(width: 0, height: -distance * 0.7)
        case .executing: return CGSize(width: 0, height: -distance * 0.5)
        case .approval: return CGSize(width: -distance * 0.55, height: 0)
        case .success: return CGSize(width: 0, height: -distance * 2.2)
        case .failure: return CGSize(width: 0, height: distance * 0.55)
        case .offline: return CGSize(width: 0, height: distance * 0.35)
        }
    }

    private var motionRotation: Angle {
        guard motionActive else { return .zero }
        switch displayedPhase {
        case .listening: return .degrees(-1.2)
        case .thinking: return .degrees(1)
        case .approval: return .degrees(-0.8)
        case .failure: return .degrees(-0.5)
        default: return .zero
        }
    }
}
