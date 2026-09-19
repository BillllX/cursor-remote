import SwiftUI

enum JieboColor {
    static let pine = Color(hex: 0x1A4F41)
    static let pineDeep = Color(hex: 0x12362D)
    static let pineSoft = Color(hex: 0x8FBFB0)
    static let brass = Color(hex: 0xC4A36A)
    static let clay = Color(hex: 0xA35C3C)
    static let paper = Color(hex: 0xF3EEE4)
    static let mist = Color(hex: 0xE7E1D4)
    static let white = Color(hex: 0xFFFCFA)
    static let ink = Color(hex: 0x1C1916)
    static let ink2 = Color(hex: 0x5C574F)
    static let line = Color(hex: 0xD4CDBF)
    static let borderStrong = Color(hex: 0xC9C0AE)
    static let userBubble = Color(hex: 0xDCE8E3)
    static let ok = Color(hex: 0x2F7D4A)
    static let danger = Color(hex: 0xB42318)
    static let dim = Color(hex: 0x8A8478)
}

enum JieboFont {
    static func display(_ size: CGFloat) -> Font {
        .custom("Songti SC", size: size, relativeTo: .title)
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
}

enum JieboRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
}
