import SwiftUI
import UIKit

/// 连接点，iPhone 和 iPad 各处共用：绿 = 已连接，黄 = 连接中，红 = 已断开。
/// 连接中和后台补齐聊天记录时，外圈扩散一圈淡色波纹；断开时圆点慢慢呼吸；已连接且空闲时静止。
struct LinkStatusDot: View {
    var state: ChatStore.LinkState
    var syncing = false
    var size: CGFloat = 6
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.homeActive) private var homeActive

    private var color: Color {
        switch state {
        case .connected: JieboColor.ok
        case .connecting: JieboColor.brass
        case .offline: JieboColor.danger
        }
    }

    private var ripples: Bool { state == .connecting || (state == .connected && syncing) }
    private var breathes: Bool { state == .offline }

    private var period: TimeInterval {
        switch state {
        case .connecting: 1.2
        case .offline: 2.0
        case .connected: 1.6
        }
    }

    private var label: String {
        syncing && state == .connected ? "已连接，正在同步聊天记录" : state.title
    }

    private var isAnimating: Bool {
        !reduceMotion && homeActive && scenePhase == .active && (ripples || breathes)
    }

    var body: some View {
        Group {
            if !isAnimating {
                dot(opacity: 1)
                    .background {
                        if ripples {
                            Circle()
                                .stroke(color.opacity(0.45), lineWidth: 1)
                                .frame(width: size * 1.8, height: size * 1.8)
                        }
                    }
                    .animation(JieboMotion.fade(reduceMotion), value: state)
            } else {
                // 交由 Core Animation 合成循环动画，标题栏常驻时主线程 0 帧回调；按状态与同步态重置身份保证切态即干净重建动画
                AnimatedLinkStatusDot(
                    color: color,
                    size: size,
                    ripples: ripples,
                    breathes: breathes,
                    period: period
                )
                .id("\(state)-\(syncing)")
            }
        }
        .frame(width: size + 2, height: size + 2)
        .accessibilityElement()
        .accessibilityLabel(label)
    }

    private func dot(opacity: Double) -> some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .opacity(opacity)
    }
}

private struct AnimatedLinkStatusDot: View {
    let color: Color
    let size: CGFloat
    let ripples: Bool
    let breathes: Bool
    let period: TimeInterval
    @State private var ripplePhase = false
    @State private var breathePhase = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .opacity(breathes ? (breathePhase ? 0.35 : 1.0) : 1.0)
            .animation(
                breathes && breathePhase
                    ? .easeInOut(duration: period / 2).repeatForever(autoreverses: true)
                    : nil,
                value: breathePhase
            )
            .background {
                if ripples {
                    Circle()
                        .stroke(color, lineWidth: 1)
                        .frame(width: size, height: size)
                        .scaleEffect(ripplePhase ? 2.4 : 1.0)
                        .opacity(ripplePhase ? 0 : 0.55)
                        .animation(
                            ripplePhase
                                ? .linear(duration: period).repeatForever(autoreverses: false)
                                : nil,
                            value: ripplePhase
                        )
                }
            }
            .task {
                var reset = Transaction()
                reset.disablesAnimations = true
                withTransaction(reset) {
                    ripplePhase = false
                    breathePhase = false
                }
                await Task.yield()
                guard !Task.isCancelled else { return }
                if ripples { ripplePhase = true }
                if breathes { breathePhase = true }
            }
            .onDisappear {
                var reset = Transaction()
                reset.disablesAnimations = true
                withTransaction(reset) {
                    ripplePhase = false
                    breathePhase = false
                }
            }
    }
}
