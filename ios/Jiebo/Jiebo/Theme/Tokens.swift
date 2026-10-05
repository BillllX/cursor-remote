import Observation
import SwiftUI
import UIKit

/// 一套配色的表面色。与 web/app/themes.css 对齐。成功 / 失败 / 运行中不在这里，它们只跟明暗走。
struct JieboSurfaces {
    var bg: UInt32
    var sidebar: UInt32
    var panel: UInt32
    var text: UInt32
    var muted: UInt32
    var border: UInt32
    var accent: UInt32
    var user: UInt32
}

/// 只留两套：接驳（暖白 + 松绿，深色是暖炭 + 雾绿）和素墨（冷白 + 墨黑，深色是近黑 + 赭金）。
/// rawValue 与网页 web/lib/theme.ts 的配色 id 一致，画布按 id 去网页端取表面色，不能另起新 id。
enum JieboPalette: String, CaseIterable, Identifiable {
    case jiebo, night

    var id: String { rawValue }

    var title: String {
        switch self {
        case .jiebo: "接驳"
        case .night: "素墨"
        }
    }

    var subtitle: String {
        switch self {
        case .jiebo: "暖白纸色 · 松绿强调"
        case .night: "冷白近黑 · 墨黑与赭金强调"
        }
    }

    /// 旧版的九套配色按观感归到两套里：暖色系归接驳，中性、冷色系归素墨。
    static func migrated(_ raw: String) -> JieboPalette? {
        switch raw {
        case "jiebo", "paper", "pine", "sand", "ink", "clay": .jiebo
        case "night", "neutral", "cool": .night
        default: nil
        }
    }

    /// 网页把输入底、次级字色、粗边从主表面里拆开。多数配色三者分别等于面板、弱字、细边。
    func extras(dark: Bool) -> (composer: UInt32, dim: UInt32, borderStrong: UInt32) {
        let ink = dark ? self.dark : self.light
        switch self {
        case .jiebo:
            return dark
                ? (0x1F211E, 0x8A8478, 0x3A3E38)
                : (0xFFFDFA, 0x746D62, 0xCDC4B4)
        case .night:
            return (ink.panel, ink.muted, ink.border)
        }
    }

    var light: JieboSurfaces {
        switch self {
        case .jiebo:
            JieboSurfaces(bg: 0xF3EEE4, sidebar: 0xEBE5D9, panel: 0xFFFCF8, text: 0x1C1916, muted: 0x5C574F, border: 0xDDD5C7, accent: 0x1A4F41, user: 0xE2EBE4)
        case .night:
            JieboSurfaces(bg: 0xF7F7F8, sidebar: 0xF1F1F3, panel: 0xFFFFFF, text: 0x161618, muted: 0x5E5E66, border: 0xE4E4E8, accent: 0x161618, user: 0xECECEF)
        }
    }

    var dark: JieboSurfaces {
        switch self {
        case .jiebo:
            JieboSurfaces(bg: 0x141512, sidebar: 0x101210, panel: 0x1B1D1A, text: 0xEDE8DE, muted: 0xB6B0A4, border: 0x2C2F2B, accent: 0x8FBFB0, user: 0x22322C)
        case .night:
            JieboSurfaces(bg: 0x0C0D10, sidebar: 0x090A0C, panel: 0x131418, text: 0xE8E8EA, muted: 0x9A9AA0, border: 0x23242A, accent: 0xC4A36A, user: 0x1A1C22)
        }
    }
}

enum JieboAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "跟随系统"
        case .light: "浅色"
        case .dark: "深色"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

@Observable
final class JieboTheme {
    static let shared = JieboTheme()

    var palette: JieboPalette {
        didSet { UserDefaults.standard.set(palette.rawValue, forKey: Self.paletteKey) }
    }

    var appearance: JieboAppearance {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: Self.appearanceKey) }
    }

    static let paletteKey = "jiebo.theme"
    static let appearanceKey = "jiebo.appearance"
    /// 旧版默认写过「中性」。对齐网页品牌默认时，只迁这一次。
    static let brandDefaultKey = "jiebo.theme.brandDefault"

    private init() {
        let storedPalette = UserDefaults.standard.string(forKey: Self.paletteKey) ?? ""
        let storedAppearance = UserDefaults.standard.string(forKey: Self.appearanceKey) ?? ""
        let branded = UserDefaults.standard.bool(forKey: Self.brandDefaultKey)
        let resolved: JieboPalette
        if !branded && (storedPalette.isEmpty || storedPalette == "neutral") {
            resolved = .jiebo
        } else {
            resolved = JieboPalette.migrated(storedPalette) ?? .jiebo
        }
        palette = resolved
        appearance = JieboAppearance(rawValue: storedAppearance) ?? .system
        if !branded {
            UserDefaults.standard.set(true, forKey: Self.brandDefaultKey)
        }
        if storedPalette != resolved.rawValue {
            UserDefaults.standard.set(resolved.rawValue, forKey: Self.paletteKey)
        }
    }
}

/// 表面色跟当前配色和系统明暗走。视图继续写 JieboColor.paper，读取时会订上 JieboTheme。
enum JieboColor {
    private static func surface(_ key: KeyPath<JieboSurfaces, UInt32>) -> Color {
        let palette = JieboTheme.shared.palette
        return Color(uiColor: UIColor { traits in
            let ink = traits.userInterfaceStyle == .dark ? palette.dark : palette.light
            return UIColor(hex: ink[keyPath: key])
        })
    }

    static var paper: Color { surface(\.bg) }
    static var mist: Color { surface(\.user) }
    static var white: Color { surface(\.panel) }
    static var composer: Color { extra(\.composer) }
    static var sidebar: Color { surface(\.sidebar) }
    static var userBubble: Color { surface(\.user) }
    static var ink: Color { surface(\.text) }
    static var ink2: Color { surface(\.muted) }
    static var dim: Color { extra(\.dim) }
    static var line: Color { surface(\.border) }
    static var borderStrong: Color { extra(\.borderStrong) }
    /// 实心按钮上的字。浅色用面板色，深色用页面底。
    static var fillFg: Color {
        let palette = JieboTheme.shared.palette
        return Color(uiColor: UIColor { traits in
            let dark = traits.userInterfaceStyle == .dark
            let ink = dark ? palette.dark : palette.light
            return UIColor(hex: dark ? ink.bg : ink.panel)
        })
    }

    private static func extra(_ key: KeyPath<(composer: UInt32, dim: UInt32, borderStrong: UInt32), UInt32>) -> Color {
        let palette = JieboTheme.shared.palette
        return Color(uiColor: UIColor { traits in
            let dark = traits.userInterfaceStyle == .dark
            return UIColor(hex: palette.extras(dark: dark)[keyPath: key])
        })
    }
    /// 缩略图占位、浅胶囊的底：卡片色往细边色靠 45%。浅色比卡片略深，深色比卡片略亮——两种主题下都不会比卡片更黑
    static var well: Color {
        let palette = JieboTheme.shared.palette
        return Color(uiColor: UIColor { traits in
            let ink = traits.userInterfaceStyle == .dark ? palette.dark : palette.light
            return UIColor(hex: blend(ink.panel, ink.border, 0.45))
        })
    }

    /// 骨架扫光：任何主题下都比底色亮一点（深色里只是一层很淡的白）
    static let shimmer = Color(uiColor: UIColor { traits in
        UIColor.white.withAlphaComponent(traits.userInterfaceStyle == .dark ? 0.12 : 0.55)
    })

    private static func blend(_ a: UInt32, _ b: UInt32, _ t: Double) -> UInt32 {
        func channel(_ shift: UInt32) -> UInt32 {
            let x = Double((a >> shift) & 0xFF)
            let y = Double((b >> shift) & 0xFF)
            return UInt32((x + (y - x) * t).rounded()) << shift
        }
        return channel(16) | channel(8) | channel(0)
    }

    static var hoverStrong: Color { surface(\.border) }
    static var pine: Color { surface(\.accent) }
    static var pineDeep: Color { surface(\.accent) }
    static let pineSoft = Color(light: 0x8FBFB0, dark: 0x8FBFB0)

    static let brass = Color(light: 0xC4A36A, dark: 0xC4A36A)
    static let ok = Color(light: 0x2F7D4A, dark: 0x7DCE98)
    /// 工具卡「完成」次级绿：比 ok 降饱和，避免和终稿抢权
    static let okSoft = Color(light: 0x3D8F5A, dark: 0x6A9E7A)
    static let danger = Color(light: 0xB42318, dark: 0xE07068)
    static let clay = Color(light: 0xA35C3C, dark: 0xE09478)
    static let okBg = Color(light: 0xE1EEE3, dark: 0x16301F)
    static let okBgSoft = Color(light: 0xE5EFE5, dark: 0x14241A)
    /// 进行中用赭金，不用蓝色。与网页 --run 一致。
    static let run = Color(light: 0x8A6526, dark: 0xD4B47A)
    static let runBg = Color(light: 0xF2E8D2, dark: 0x2C2617)
    static let dangerBg = Color(light: 0xF8E5E0, dark: 0x3A1D1B)
    /// 待批、暂停这类“要你处理”的提醒色。与网页 --warn-fg / --warn-bg 一致。
    static let warnFg = Color(light: 0x7A581B, dark: 0xE0B570)
    static let warnBg = Color(light: 0xF7EEDB, dark: 0x2A2118)
}

enum JieboFont {
    /// 标题用宋体粗体，对应网页 --font-display（Noto Serif SC，系统回落 Songti SC）。
    /// 直接点名粗体字面。再套 .weight(.bold) 时，系统改不了宋体的字重，控制台会一直报错。
    /// relativeTo：跟 Dynamic Type 一起缩放
    static func display(_ size: CGFloat) -> Font {
        .custom("Songti SC Bold", size: size, relativeTo: .title2)
    }

    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }

    static func mono(_ size: CGFloat) -> Font {
        .system(size: size, design: .monospaced)
    }

    /// 语义字号：跟 Dynamic Type 走。对话区的标签、按钮、卡片用它，别再写死点数。
    static func text(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        .system(style, design: .default, weight: weight)
    }

    static func monoText(_ style: Font.TextStyle) -> Font {
        .system(style, design: .monospaced)
    }

    /// 跟系统字号档位缩放（Dynamic Type）。
    static func uiScaled(_ base: CGFloat, sizeCategory: ContentSizeCategory, weight: Font.Weight = .regular) -> Font {
        ui(scaledPoint(base, sizeCategory: sizeCategory), weight: weight)
    }

    static func monoScaled(_ base: CGFloat, sizeCategory: ContentSizeCategory) -> Font {
        mono(scaledPoint(base, sizeCategory: sizeCategory))
    }

    private static func scaledPoint(_ base: CGFloat, sizeCategory: ContentSizeCategory) -> CGFloat {
        let metrics = UIFontMetrics(forTextStyle: .body)
        let trait = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(sizeCategory))
        return metrics.scaledValue(for: base, compatibleWith: trait)
    }
}

private extension UIContentSizeCategory {
    init(_ category: ContentSizeCategory) {
        switch category {
        case .extraSmall: self = .extraSmall
        case .small: self = .small
        case .medium: self = .medium
        case .large: self = .large
        case .extraLarge: self = .extraLarge
        case .extraExtraLarge: self = .extraExtraLarge
        case .extraExtraExtraLarge: self = .extraExtraExtraLarge
        case .accessibilityMedium: self = .accessibilityMedium
        case .accessibilityLarge: self = .accessibilityLarge
        case .accessibilityExtraLarge: self = .accessibilityExtraLarge
        case .accessibilityExtraExtraLarge: self = .accessibilityExtraExtraLarge
        case .accessibilityExtraExtraExtraLarge: self = .accessibilityExtraExtraExtraLarge
        @unknown default: self = .large
        }
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
    static let xl: CGFloat = 12 // composer dock（对齐网页 --radius: 12px）
}

/// 对话区在 iPad 上的阅读宽度。再宽就居中，避免一行拉满横屏。
enum JieboMeasure {
    static let thread: CGFloat = 680
    static let bubble: CGFloat = 520
}

enum JieboMotion {
    static func panel(_ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(duration: 0.42, bounce: 0.05)
    }

    static func snappy(_ reduceMotion: Bool) -> Animation? {
        // 统一约 120ms 量级手感；chevron/模式滑块共用
        reduceMotion ? nil : .spring(duration: 0.24, bounce: 0.18)
    }

    static func fade(_ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .easeOut(duration: 0.16)
    }
}

enum JieboGlass {
    /// 系统有 Liquid Glass（iOS 26+）
    static let available: Bool = {
        if #available(iOS 26.0, *) { return true }
        return false
    }()
}

struct PressScaleButtonStyle: ButtonStyle {
    var enabled: Bool = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(!reduceMotion && configuration.isPressed && enabled ? 0.98 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.09), value: configuration.isPressed)
    }
}

extension View {
    /// P6：HIG 最小触控热区 44×44。挂在「视觉 frame + background + clipShape」之后——
    /// 绘制的图形不变，但布局占用会扩到 44（相邻控件间距相应变大，这是 HIG 达标的预期取舍）。
    /// 页签条等高度受限处传更小的值。假设调用方用 .buttonStyle(.plain)（其他样式会覆盖 contentShape）。
    func hitTarget(_ size: CGFloat = 44) -> some View {
        frame(minWidth: size, minHeight: size).contentShape(Rectangle())
    }

    /// 浮在内容上的控件层（输入胶囊、回到底部、浮动提示）：iOS 26+ 用 Liquid Glass，更早的系统退回材质。
    /// 内容层（消息、卡片）不要套它。
    @ViewBuilder
    func jieboGlass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            background(.regularMaterial, in: shape)
        }
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
            .foregroundStyle(JieboColor.pine)
            .frame(width: 28, height: 28)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .padding(.top, 2)
            .accessibilityHidden(true)
    }
}
