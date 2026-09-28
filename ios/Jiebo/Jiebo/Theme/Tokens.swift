import SwiftUI
import UIKit

/// 对齐 web/app/globals.css 与 brand/vi/tokens.css 的中性色语言。
/// 浅色是品牌默认，深色是工作模式（不是身份）。
enum JieboColor {
    // 中性骨架
    static let paper = Color(light: 0xFAFAFA, dark: 0x141512) // --bg
    static let mist = Color(light: 0xF4F4F5, dark: 0x1F211E) // 浅填充（chips / 行）
    static let white = Color(light: 0xFFFFFF, dark: 0x1B1D1A) // --bg-panel
    static let composer = Color(light: 0xFFFFFF, dark: 0x1F211E) // --bg-composer
    static let sidebar = Color(light: 0xFAFAFA, dark: 0x101210) // --bg-sidebar
    static let userBubble = Color(light: 0xF4F4F5, dark: 0x24332E) // --bg-user
    static let ink = Color(light: 0x171717, dark: 0xEDE8DE) // --text
    static let ink2 = Color(light: 0x737373, dark: 0xB6B0A4) // --muted
    // P6：浅色 0xA3A3A3 在 paper 上对比度仅 ~2.4:1（WCAG AA 小字要 4.5:1）；0x6E6E6E 在 paper 上 ≈ 4.7:1 留余量
    static let dim = Color(light: 0x6E6E6E, dark: 0x7D786E) // --dim
    static let line = Color(light: 0xECECEC, dark: 0x2C2F2B) // --border
    static let borderStrong = Color(light: 0xE4E4E7, dark: 0x3A3E38) // --border-strong
    static let hoverStrong = Color(light: 0xECECEE, dark: 0x2C2F2B) // mode thumb

    // 品牌余温
    static let pine = Color(light: 0x171717, dark: 0x8FBFB0) // --accent（浅近黑 / 深松绿）
    static let pineDeep = Color(light: 0x0A0A0A, dark: 0xA7D3C6)
    static let pineSoft = Color(light: 0xD4D4D4, dark: 0x3A3E38) // 禁用态
    static let brass = Color(light: 0xC4A36A, dark: 0xC4A36A) // --accent-2
    static let clay = danger // 旧名兼容（离线点）
    static let ok = Color(light: 0x16A34A, dark: 0x7DCE98)
    static let danger = Color(light: 0xDC2626, dark: 0xE07068)

    // 工具徽章
    static let okBg = Color(light: 0xDCFCE7, dark: 0x16301F)
    static let run = Color(light: 0x2563EB, dark: 0x7AA5F8)
    static let runBg = Color(light: 0xDBEAFE, dark: 0x1B2942)
    static let dangerBg = Color(light: 0xFEE2E2, dark: 0x3A1D1B)
}

enum JieboFont {
    /// 新语言是无衬线（Noto Sans SC / PingFang），display 不再用宋体
    static func display(_ size: CGFloat) -> Font {
        .system(size: size, weight: .semibold, design: .default)
    }

    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    static func mono(_ size: CGFloat) -> Font {
        .system(size: size, design: .monospaced)
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }

    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

enum JieboRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24 // composer dock（对齐网页 --radius: 24px）
}

/// 对话区在 iPad 上的阅读宽度。再宽就居中，避免一行拉满横屏。
enum JieboMeasure {
    static let thread: CGFloat = 820
    static let bubble: CGFloat = 520
}

enum JieboMotion {
    static func panel(_ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(duration: 0.42, bounce: 0.05)
    }

    static func snappy(_ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(duration: 0.32, bounce: 0.22)
    }

    static func fade(_ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .easeOut(duration: 0.22)
    }
}

struct PressScaleButtonStyle: ButtonStyle {
    var enabled: Bool = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(!reduceMotion && configuration.isPressed && enabled ? 0.9 : 1)
            .animation(reduceMotion ? nil : .spring(duration: 0.22, bounce: 0.2), value: configuration.isPressed)
    }
}

extension View {
    /// P6：HIG 最小触控热区 44×44。挂在「视觉 frame + background + clipShape」之后——
    /// 绘制的图形不变，但布局占用会扩到 44（相邻控件间距相应变大，这是 HIG 达标的预期取舍）。
    /// 页签条等高度受限处传更小的值。假设调用方用 .buttonStyle(.plain)（其他样式会覆盖 contentShape）。
    func hitTarget(_ size: CGFloat = 44) -> some View {
        frame(minWidth: size, minHeight: size).contentShape(Rectangle())
    }
}

/// 思考状态的流光文字（对齐 web 的 .text-shimmer：4s 线性循环，reduceMotion 降级为静态）
struct ShimmerText: View {
    let text: String
    var font: Font = JieboFont.ui(14)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            Text(text)
                .font(font)
                .foregroundStyle(JieboColor.ink2)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let t = CGFloat(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 4) / 4)
                let center = t * 1.6 - 0.3 // 高亮窗从 -0.3 扫到 1.3
                ZStack {
                    Text(text)
                        .font(font)
                        .foregroundStyle(JieboColor.dim)
                    Text(text)
                        .font(font)
                        .foregroundStyle(JieboColor.ink)
                        .mask(
                            LinearGradient(
                                stops: [
                                    .init(color: .clear, location: max(0, center - 0.3)),
                                    .init(color: .black, location: min(max(center, 0.01), 0.99)),
                                    .init(color: .clear, location: min(1, max(0.02, center + 0.3))),
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                }
            }
        }
    }
}

/// 助手头像（对齐 web 的 .bot-avatar：28px 圆、浅底、muted 小字）
struct BotAvatar: View {
    var body: some View {
        Text("接")
            .font(JieboFont.ui(11, weight: .semibold))
            .foregroundStyle(JieboColor.ink2)
            .frame(width: 28, height: 28)
            .background(JieboColor.mist)
            .clipShape(Circle())
            .padding(.top, 2)
            .accessibilityHidden(true)
    }
}
