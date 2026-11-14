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

/// 贴纸机器人沿用八态与前后台、减少动态效果的生命周期。
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
            if JieboTheme.shared.palette == .sticker {
                StickerRobotFace(phase: displayedPhase)
                    .id(displayedPhase)
                    .transition(.opacity)
            } else {
                Image(displayedPhase.assetName)
                    .resizable()
                    .scaledToFit()
                    .id(displayedPhase)
                    .transition(.opacity)
            }
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

    /// 位移、缩放和倾斜在原幅度上再放大 75%，小尺寸导航栏里才看得出在动
    private let motionGain: CGFloat = 1.75

    private var motionScale: CGSize {
        guard motionActive else { return CGSize(width: 1, height: 1) }
        let raw: CGSize
        switch displayedPhase {
        case .idle: raw = CGSize(width: 1.008, height: 1.014)
        case .listening: raw = CGSize(width: 1.012, height: 1.018)
        case .thinking: raw = CGSize(width: 1.005, height: 1.008)
        case .executing: raw = CGSize(width: 1.016, height: 0.992)
        case .success: raw = CGSize(width: 1.025, height: 1.025)
        case .failure: raw = CGSize(width: 1, height: 0.99)
        case .offline: raw = CGSize(width: 1.006, height: 0.988)
        case .approval: raw = CGSize(width: 1, height: 1)
        }
        return CGSize(
            width: 1 + (raw.width - 1) * motionGain,
            height: 1 + (raw.height - 1) * motionGain
        )
    }

    private var motionOffset: CGSize {
        guard motionActive else { return .zero }
        let distance = max(1, size * 0.035) * motionGain
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
        case .listening: return .degrees(-1.2 * Double(motionGain))
        case .thinking: return .degrees(Double(motionGain))
        case .approval: return .degrees(-0.8 * Double(motionGain))
        case .failure: return .degrees(-0.5 * Double(motionGain))
        default: return .zero
        }
    }
}

/// 圆团轮廓、微倾双胶囊眼与右上星点，延续接驳自己的图标造型。
/// 导航栏省略外围细节，完整尺寸才显示声波、思考星芒与执行轨迹。
struct StickerRobotFace: View {
    var phase: AssistantAvatarPhase = .idle

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            let compact = side <= 36
            ZStack {
                RoundedRectangle(cornerRadius: side * 0.32, style: .continuous)
                    .fill(JieboColor.white)
                    .overlay {
                        RoundedRectangle(cornerRadius: side * 0.32, style: .continuous)
                            .stroke(JieboColor.ink, lineWidth: max(1.8, side * 0.026))
                    }
                    .frame(width: side * 0.77, height: side * 0.66)
                    .rotationEffect(.degrees(-7))
                HStack(spacing: side * 0.13) {
                    eye(side: side)
                    eye(side: side)
                }
                .rotationEffect(.degrees(-7))
                .offset(x: phase == .thinking ? side * 0.025 : 0,
                        y: phase == .failure ? side * 0.04 : 0)
                if phase != .offline {
                    Image(systemName: badgeSymbol)
                        .font(.system(size: side * (compact ? 0.23 : 0.22), weight: .bold))
                        .foregroundStyle(phase == .failure ? JieboColor.danger : JieboColor.spark)
                        .background(JieboColor.paper, in: Circle())
                        .offset(x: side * 0.33, y: -side * 0.32)
                }
                if !compact && (phase == .listening || phase == .executing) {
                    Image(systemName: phase == .listening ? "wave.3.right" : "arrow.triangle.2.circlepath")
                        .font(.system(size: side * 0.15, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                        .offset(x: -side * 0.43, y: -side * 0.23)
                }
                if !compact && phase == .thinking {
                    Image(systemName: "sparkle")
                        .font(.system(size: side * 0.12, weight: .bold))
                        .foregroundStyle(JieboColor.spark)
                        .offset(x: side * 0.12, y: -side * 0.43)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func eye(side: CGFloat) -> some View {
        if phase == .success {
            Image(systemName: "chevron.up")
                .font(.system(size: side * 0.16, weight: .heavy))
                .foregroundStyle(JieboColor.ink)
        } else {
            Capsule()
                .fill(phase == .executing ? JieboColor.sparkText : JieboColor.ink)
                .frame(width: side * (phase == .offline ? 0.16 : 0.09),
                       height: side * (phase == .offline ? 0.045 : phase == .failure ? 0.13 : phase == .listening ? 0.25 : 0.21))
        }
    }

    private var badgeSymbol: String {
        switch phase {
        case .idle, .thinking: "sparkle"
        case .listening, .executing: "circle.fill"
        case .approval: "exclamationmark.circle.fill"
        case .success: "heart.fill"
        case .failure: "exclamationmark.triangle.fill"
        case .offline: "minus"
        }
    }
}
