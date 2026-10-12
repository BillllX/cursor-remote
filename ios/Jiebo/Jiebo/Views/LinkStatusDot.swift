import SwiftUI
import UIKit

/// 连接点，iPhone 和 iPad 各处共用：绿 = 已连接，黄 = 连接中，红 = 已断开。
/// 连接中和后台补齐聊天记录时，外圈扩散一圈淡色波纹；断开时圆点慢慢呼吸；已连接且空闲时静止。
struct LinkStatusDot: View {
    var state: ChatStore.LinkState
    var syncing = false
    var size: CGFloat = 6
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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

    var body: some View {
        Group {
            if reduceMotion || !(ripples || breathes) {
                dot(opacity: 1)
                    .background {
                        if ripples {
                            Circle()
                                .stroke(color.opacity(0.45), lineWidth: 1)
                                .frame(width: size * 1.8, height: size * 1.8)
                        }
                    }
            } else {
                // 6pt 的点 15 帧就够顺，标题栏常驻，不值得按 30 帧重绘
                TimelineView(.animation(minimumInterval: 1.0 / 15)) { context in
                    let t = context.date.timeIntervalSinceReferenceDate
                        .truncatingRemainder(dividingBy: period) / period
                    dot(opacity: breathes ? 0.65 + 0.35 * cos(t * 2 * .pi) : 1)
                        .background {
                            if ripples {
                                Circle()
                                    .stroke(color, lineWidth: 1)
                                    .frame(width: size, height: size)
                                    .scaleEffect(1 + t * 1.4)
                                    .opacity(0.55 * (1 - t))
                            }
                        }
                }
            }
        }
        .frame(width: size + 2, height: size + 2)
        .animation(JieboMotion.fade(reduceMotion), value: state)
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
