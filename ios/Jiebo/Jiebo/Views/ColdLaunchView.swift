import SwiftUI
import Observation
import UIKit

@Observable
@MainActor
final class ColdLaunchController {
    private var gate = ColdLaunchGate()
    private(set) var finished = false
    private(set) var startedAt: TimeInterval?
    private(set) var reduced = false
    @ObservationIgnored private var deadline: Task<Void, Never>?
    @ObservationIgnored private let sound = StickerLaunchSound()

    func isVisible(in scene: String) -> Bool {
        !finished && (gate.owner == nil || gate.owner == scene)
    }

    func begin(in scene: String, reducedMotion: Bool) {
        guard gate.claim(scene) else { return }
        reduced = reducedMotion || UIAccessibility.isVoiceOverRunning
        startedAt = ProcessInfo.processInfo.systemUptime
        AppLaunchMetrics.event("StickerIntroStarted")
        #if DEBUG
        if Self.previewTime != nil { return }
        #endif
        if !reduced, let startedAt { sound.play(startedAt: startedAt) }
        let duration = reduced ? StickerLaunchTimeline.reducedDuration : StickerLaunchTimeline.duration
        let deadlineAt = (startedAt ?? ProcessInfo.processInfo.systemUptime) + duration
        deadline = Task { @MainActor [weak self] in
            // Scheduling the task may wait behind first-frame work. Keep the deadline
            // anchored to the visual/audio timeline instead of adding that delay.
            let remaining = max(0, deadlineAt - ProcessInfo.processInfo.systemUptime)
            try? await Task.sleep(for: .seconds(remaining))
            guard !Task.isCancelled else { return }
            self?.finish()
        }
    }

    func phaseChanged(_ phase: ScenePhase, in scene: String, reducedMotion: Bool) {
        if phase == .active { begin(in: scene, reducedMotion: reducedMotion) }
        guard gate.owner == scene else { return }
        if phase == .background { finish() }
        else if phase == .inactive { sound.stop() }
    }

    func finish() {
        guard !finished else { return }
        finished = true
        deadline?.cancel()
        deadline = nil
        sound.stop()
        AppLaunchMetrics.event("StickerIntroFinished")
        PushRegistrar.shared.launchPresentationEnded()
    }

    var elapsed: TimeInterval {
        #if DEBUG
        if let preview = Self.previewTime { return preview }
        #endif
        guard let startedAt else { return 0 }
        return max(0, ProcessInfo.processInfo.systemUptime - startedAt)
    }

    #if DEBUG
    /// Simulator-only frame inspection; production always uses the bounded monotonic timeline.
    private static var previewTime: Double? {
        guard let arg = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--launch-frame=") }),
              let value = Double(arg.dropFirst("--launch-frame=".count)) else { return nil }
        return min(StickerLaunchTimeline.duration, max(0, value))
    }
    #endif
}

private struct ColdLaunchVisibleKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var coldLaunchVisible: Bool {
        get { self[ColdLaunchVisibleKey.self] }
        set { self[ColdLaunchVisibleKey.self] = newValue }
    }
}

#if DEBUG
/// 保留定格检查入口，日常启动直接呈现可操作页面。
struct LaunchFramePreview: ViewModifier {
    let sceneToken: String
    @ViewBuilder func body(content: Content) -> some View {
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--launch-frame=") }) {
            content.modifier(ColdLaunchPresentation(sceneToken: sceneToken))
        } else {
            content
        }
    }
}
#endif

struct ColdLaunchPresentation: ViewModifier {
    @Environment(ColdLaunchController.self) private var launch
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let sceneToken: String

    func body(content: Content) -> some View {
        let visible = launch.isVisible(in: sceneToken)
        content
            .environment(\.coldLaunchVisible, visible)
            .disabled(visible)
            .allowsHitTesting(!visible)
            .accessibilityHidden(visible)
            .overlay {
                if visible {
                    TimelineView(.animation(minimumInterval: 1.0 / 60, paused: scenePhase != .active)) { _ in
                        StickerLaunchFrame(time: launch.elapsed, reducedMotion: launch.reduced)
                    }
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("正在打开小驳")
                    .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .statusBarHidden(visible)
            .persistentSystemOverlays(visible ? .hidden : .automatic)
            .onAppear {
                if scenePhase == .active { launch.begin(in: sceneToken, reducedMotion: reduceMotion) }
            }
            .onChange(of: scenePhase) { _, phase in
                launch.phaseChanged(phase, in: sceneToken, reducedMotion: reduceMotion)
            }
            .onChange(of: reduceMotion) { _, reduced in
                if reduced && visible { launch.finish() }
            }
    }
}

struct StickerLaunchFrame: View {
    let time: TimeInterval
    var reducedMotion = false
    @Environment(\.colorScheme) private var colorScheme

    private var ink: Color { colorScheme == .dark ? Color(red: 0.96, green: 0.95, blue: 0.93) : Color(red: 0.078, green: 0.078, blue: 0.086) }
    private var face: Color { colorScheme == .dark ? Color(red: 0.09, green: 0.09, blue: 0.10) : .white }

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let side = min(size.width, size.height, 420)
            let t = reducedMotion ? 0 : time
            let corners = StickerLaunchTimeline.corners(in: size, at: t)
            let settled = StickerLaunchTimeline.contourSettled(at: t)
            let radius = side * 0.20 * (1 - settled) + min(size.width * 0.115, 48) * settled
            let reveal = StickerLaunchTimeline.reveal(at: t)
            let contour = StickerContour(corners: corners, radius: radius,
                                         flex: (0..<4).map { StickerLaunchTimeline.edgeFlex($0, at: t) * side * 0.12 })
            let motion = StickerLaunchTimeline.faceMotion(at: t)
            let twinkle = StickerLaunchTimeline.ease((t - 0.05) / 0.28)
            ZStack {
                Color("LaunchBackground")
                contour.fill(face).overlay {
                    contour.stroke(ink, style: StrokeStyle(lineWidth: 4.5 - 1.5 * settled, lineJoin: .round))
                }
                eyes(side: side)
                    .scaleEffect(x: 1 + motion.squash, y: (1 - motion.squash) * StickerLaunchTimeline.eyeScale(at: t))
                    .rotationEffect(.degrees(motion.tilt))
                    .position(x: size.width / 2 + side * motion.x, y: size.height / 2 + side * motion.y)
                Image(systemName: "sparkle")
                    .font(.system(size: side * 0.12, weight: .bold))
                    .foregroundStyle(Color(red: 0.88, green: 0.31, blue: 0.20))
                    .scaleEffect(1 + 0.18 * twinkle)
                    .rotationEffect(.degrees(-10 + 22 * twinkle))
                    .position(x: size.width / 2 + side * (0.245 + 0.035 * twinkle),
                              y: size.height / 2 - side * (0.26 + 0.035 * twinkle))
                    .opacity(1 - StickerLaunchTimeline.ease((t - 0.32) / 0.4))
            }
            .mask {
                if reducedMotion {
                    Rectangle().opacity(1 - StickerLaunchTimeline.ease((time - 0.15) / 0.30))
                } else {
                    // Destination-out punches a genuinely transparent expanding hole through the entire intro.
                    ZStack {
                        Rectangle()
                        Circle()
                            .fill(.black)
                            .frame(width: hypot(size.width, size.height) * 1.04 * reveal,
                                   height: hypot(size.width, size.height) * 1.04 * reveal)
                            .blur(radius: 6 * (1 - reveal))
                            .blendMode(.destinationOut)
                    }.compositingGroup()
                }
            }
        }
        .allowsHitTesting(false)
    }

    private func eyes(side: CGFloat) -> some View {
        HStack(spacing: side * 0.09) {
            Capsule().fill(ink)
            Capsule().fill(ink)
        }
        .frame(width: side * 0.23, height: side * 0.15)
    }
}

/// 四个圆角分别受力，角与角之间用缓弧表现贴纸的拉伸。
private struct StickerContour: Shape {
    let corners: [CGPoint]
    let radius: CGFloat
    let flex: [CGFloat]

    func path(in rect: CGRect) -> Path {
        guard corners.count == 4 else { return Path() }
        func toward(_ origin: CGPoint, _ target: CGPoint) -> CGPoint {
            let length = hypot(target.x - origin.x, target.y - origin.y)
            let fraction = min(0.45, radius / max(1, length))
            return CGPoint(x: origin.x + (target.x - origin.x) * fraction,
                           y: origin.y + (target.y - origin.y) * fraction)
        }
        var path = Path()
        path.move(to: toward(corners[0], corners[3]))
        for index in 0..<4 {
            let corner = corners[index]
            let next = corners[(index + 1) % 4]
            let start = toward(corner, next)
            let end = toward(next, corner)
            path.addQuadCurve(to: start, control: corner)
            let dx = end.x - start.x
            let dy = end.y - start.y
            let length = max(1, hypot(dx, dy))
            // 两端保持原来的边方向，中间才鼓起，圆角接缝不会突然拐折。
            let bulge = min(length * 0.22, abs(flex[index])) * (flex[index] < 0 ? -1 : 1)
            let bow = CGPoint(x: dy / length * bulge, y: -dx / length * bulge)
            let mid = CGPoint(x: (start.x + end.x) / 2 + bow.x, y: (start.y + end.y) / 2 + bow.y)
            path.addCurve(to: mid,
                          control1: CGPoint(x: start.x + dx * 0.20, y: start.y + dy * 0.20),
                          control2: CGPoint(x: mid.x - dx * 0.16, y: mid.y - dy * 0.16))
            path.addCurve(to: end,
                          control1: CGPoint(x: mid.x + dx * 0.16, y: mid.y + dy * 0.16),
                          control2: CGPoint(x: end.x - dx * 0.20, y: end.y - dy * 0.20))
        }
        path.closeSubpath()
        return path
    }
}

#if DEBUG
#Preview("冷启动 · 贴纸弹开") {
    ZStack {
        Color.orange
        StickerLaunchFrame(time: 1.62)
    }.ignoresSafeArea()
}
#Preview("冷启动 · 中心揭幕") {
    ZStack {
        Color.orange
        StickerLaunchFrame(time: 3.18)
    }.ignoresSafeArea()
}
#endif
