import SwiftUI

extension ChatStore {
    var assistantAvatarPhase: AssistantAvatarPhase {
        let chatId = assistantChatId ?? ""
        let now = Date().timeIntervalSince1970 * 1000
        return AssistantAvatarState.resolve(
            connected: connected,
            turnSnapshot: assistantAvatarTurnSnapshot,
            chatBusy: runningChatIds.contains(chatId) || queuedChatIds.contains(chatId)
                || assistantState?.delegations.contains { $0.status == "queued" } == true,
            hasApproval: assistantState?.approvals.contains { $0.expiresAt <= 0 || $0.expiresAt > now } == true
                || assistantState?.draftCards?.contains { $0.status == "waiting_user" && ($0.expiresAt <= 0 || $0.expiresAt > now) } == true,
            hasDelegation: !runningDelegations.isEmpty,
            hasDraft: !draft(for: chatId).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
    }
}

/// 贴纸机器人沿用八态与前后台、减少动态效果的生命周期。
struct AssistantAvatarView: View {
    let phase: AssistantAvatarPhase
    var size: CGFloat
    var completionEvent: UInt64

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.homeActive) private var homeActive
    @State private var displayedPhase: AssistantAvatarPhase
    @State private var motionActive = false

    init(phase: AssistantAvatarPhase, size: CGFloat, completionEvent: UInt64 = 0) {
        self.phase = phase
        self.size = size
        self.completionEvent = completionEvent
        _displayedPhase = State(initialValue: phase)
    }

    var body: some View {
        ZStack {
            if JieboTheme.shared.palette == .sticker {
                StickerRobotFace(phase: displayedPhase)
            } else {
                Image(displayedPhase.assetName)
                    .resizable()
                    .scaledToFit()
                    .id(displayedPhase)
                    .transition(.opacity)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(displayedPhase.accessibilityLabel)
        .scaleEffect(x: motionScale.width, y: motionScale.height, anchor: .bottom)
        .rotationEffect(motionRotation, anchor: .bottom)
        .offset(x: motionOffset.width, y: motionOffset.height)
        .animation(JieboMotion.fade(reduceMotion), value: displayedPhase)
        .onChange(of: phase) { _, newPhase in
            displayedPhase = newPhase
        }
        .onChange(of: completionEvent) { _, _ in
            guard scenePhase == .active, homeActive, phase == .idle else { return }
            displayedPhase = .success
        }
        .task(id: completionKey) {
            guard displayedPhase == .success, phase == .idle else { return }
            try? await Task.sleep(for: .milliseconds(1_350))
            guard !Task.isCancelled, phase == .idle else { return }
            displayedPhase = .idle
        }
        .task(id: motionKey) {
            // 显式用短时有限动画归位，覆盖并彻底终止上一阶段的 repeatForever
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                motionActive = false
            }
            // 非贴纸主题在静止/离线/失败态不再跑 repeatForever，减少常驻 Core Animation / GPU 帧占用
            guard !reduceMotion, homeActive, scenePhase == .active,
                  JieboTheme.shared.palette != .sticker,
                  shouldAnimateMotion
            else { return }
            await Task.yield()
            guard !Task.isCancelled else { return }
            withAnimation(motionAnimation.repeatForever(autoreverses: true)) {
                motionActive = true
            }
        }
        .accessibilityHidden(true)
    }

    private var shouldAnimateMotion: Bool {
        switch displayedPhase {
        case .listening, .thinking, .executing, .approval, .success:
            return true
        case .idle, .failure, .offline:
            return false
        }
    }

    private var completionKey: String {
        "\(phase.rawValue):\(displayedPhase.rawValue):\(completionEvent)"
    }

    private var motionKey: String {
        "\(displayedPhase.rawValue):\(reduceMotion):\(homeActive):\(scenePhase == .active):\(JieboTheme.shared.palette.rawValue)"
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
        guard motionActive, shouldAnimateMotion else { return CGSize(width: 1, height: 1) }
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
        guard motionActive, shouldAnimateMotion else { return .zero }
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
        guard motionActive, shouldAnimateMotion else { return .zero }
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

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.homeActive) private var homeActive
    @State private var appeared = false
    @State private var startedAt = Date()
    @State private var idleBlinking = false

    private var activeMotionAllowed: Bool {
        appeared && homeActive && !reduceMotion && scenePhase == .active
    }

    /// 仅在思考/听写/执行/成功等活跃态启用逐帧 TimelineView；idle/approval/failure/offline 零空转。
    private var needsContinuousTimeline: Bool {
        guard activeMotionAllowed else { return false }
        switch phase {
        case .thinking, .listening, .executing, .success:
            return true
        case .idle, .approval, .failure, .offline:
            return false
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            let compact = side <= 36
            // 单一稳定 TimelineView 结构，idle/approval/failure/offline 通过 paused 彻底停帧且避免切换态闪烁。
            TimelineView(.animation(minimumInterval: compact ? 1.0 / 12 : 1.0 / 24, paused: !needsContinuousTimeline)) { context in
                let active = needsContinuousTimeline
                let time = active ? max(0, context.date.timeIntervalSince(startedAt)) : 0
                let beat = active ? sin(time * .pi * 2 / 2.8) : 0
                let blinkCycle = time.truncatingRemainder(dividingBy: 4.7)
                let blink = active ? (blinkCycle > 3.9 && blinkCycle < 4.06) : idleBlinking
                faceBody(side: side, compact: compact, time: time, beat: beat, blink: blink)
                    .frame(width: proxy.size.width, height: proxy.size.height)
            }
        }
        .onAppear { startedAt = Date(); appeared = true }
        .onDisappear { appeared = false; idleBlinking = false }
        .onChange(of: phase) { _, _ in
            startedAt = Date()
            idleBlinking = false
        }
        .onChange(of: scenePhase) { _, next in
            if next == .active { startedAt = Date() } else { idleBlinking = false }
        }
        .onChange(of: homeActive) { _, active in
            if active { startedAt = Date() } else { idleBlinking = false }
        }
        .task(id: "\(phase == .idle):\(activeMotionAllowed)") {
            idleBlinking = false
            guard phase == .idle, activeMotionAllowed else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(4_500))
                guard !Task.isCancelled else { return }
                withAnimation(.easeInOut(duration: 0.07)) { idleBlinking = true }
                try? await Task.sleep(for: .milliseconds(130))
                guard !Task.isCancelled else { return }
                withAnimation(.easeInOut(duration: 0.08)) { idleBlinking = false }
            }
        }
    }

    private func faceBody(side: CGFloat, compact: Bool, time: Double, beat: Double, blink: Bool) -> some View {
        let gaze = phase == .thinking ? sin(time * 1.5) * side * 0.035 : 0
        return ZStack {
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
                    .scaleEffect(x: 1, y: blink ? 0.12 : 1)
                eye(side: side)
                    .scaleEffect(x: 1, y: blink ? 0.12 : 1)
            }
            .rotationEffect(.degrees(-7))
            .offset(x: gaze + (phase == .listening ? side * 0.02 : 0),
                    y: phase == .failure ? side * 0.04 : 0)
            if phase != .offline {
                Image(systemName: badgeSymbol)
                    .font(.system(size: side * (compact ? 0.23 : 0.22), weight: .bold))
                    .foregroundStyle(phase == .failure ? JieboColor.danger : JieboColor.spark)
                    .background(JieboColor.paper, in: Circle())
                    .scaleEffect(badgeScale(time: time, beat: beat))
                    .rotationEffect(.degrees(phase == .thinking ? beat * 18 : 0))
                    .offset(x: side * 0.33, y: -side * 0.32)
            }
            if !compact && (phase == .listening || phase == .executing) {
                Image(systemName: phase == .listening ? "wave.3.right" : "arrow.triangle.2.circlepath")
                    .font(.system(size: side * 0.15, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .rotationEffect(.degrees(phase == .executing ? time * 180 : 0))
                    .opacity(phase == .listening ? 0.6 + 0.4 * sin(time * 6) : 1)
                    .offset(x: -side * 0.43, y: -side * 0.23)
            }
            if !compact && phase == .thinking {
                Image(systemName: "sparkle")
                    .font(.system(size: side * 0.12, weight: .bold))
                    .foregroundStyle(JieboColor.spark)
                    .scaleEffect(1 + beat * 0.22)
                    .offset(x: side * 0.12, y: -side * 0.43)
            }
        }
        .scaleEffect(x: 1 - beat * 0.008, y: 1 + beat * 0.018, anchor: .bottom)
        .rotationEffect(.degrees(phase == .listening ? -2 + beat * 2 : phase == .approval ? -3 : 0))
        .offset(y: phase == .success ? -side * 0.08 * abs(sin(min(time, 0.8) / 0.8 * .pi)) : -side * 0.018 * beat)
    }

    private func badgeScale(time: Double, beat: Double) -> Double {
        switch phase {
        case .success: return 1 + 0.35 * sin(min(time, 1) * .pi)
        case .listening, .executing: return 1 + 0.2 * sin(time * 6)
        case .thinking, .idle: return 1 + 0.12 * beat
        default: return 1
        }
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

#if DEBUG
#Preview("贴纸形象八态") {
    ScrollView {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 28) {
            ForEach(AssistantAvatarPhase.allCases, id: \.self) { phase in
                VStack(spacing: 12) {
                    StickerRobotFace(phase: phase).frame(width: 112, height: 112)
                    HStack {
                        StickerRobotFace(phase: phase).frame(width: 32, height: 32)
                        Text(phase.accessibilityLabel).font(.caption)
                    }
                }
            }
        }
        .padding(24)
    }
    .background(JieboColor.paper)
}
#endif


/// 只有用户主动点按时才俏皮地偏一下头，仍使用真实工作状态的表情。
struct AssistantPlayfulAvatar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var greeting = false
    let phase: AssistantAvatarPhase
    let size: CGFloat
    var completionEvent: UInt64 = 0

    var body: some View {
        Button {
            guard !greeting else { return }
            JieboHaptic.selection()
            guard !reduceMotion else { return }
            withAnimation(.spring(response: 0.25, dampingFraction: 0.5)) { greeting = true }
        } label: {
            AssistantAvatarView(phase: phase, size: size, completionEvent: completionEvent)
                .rotationEffect(.degrees(greeting ? -12 : 0), anchor: .bottom)
                .scaleEffect(x: greeting ? 1.08 : 1, y: greeting ? 0.94 : 1, anchor: .bottom)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("和小驳打个招呼")
        .accessibilityValue(phase.accessibilityLabel)
        .task(id: greeting) {
            guard greeting else { return }
            try? await Task.sleep(for: .milliseconds(260))
            guard !Task.isCancelled else { return }
            withAnimation(.spring(response: 0.45, dampingFraction: 0.6)) { greeting = false }
        }
        .onChange(of: scenePhase) { _, state in
            if state != .active { greeting = false }
        }
        .onChange(of: reduceMotion) { _, value in
            if value { greeting = false }
        }
    }
}
