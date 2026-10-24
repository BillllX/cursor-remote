import Foundation

enum PadLayoutMode: String, Codable, CaseIterable {
    case compact
    case regular
    case expanded

    static func resolve(width: Double, compactSizeClass: Bool) -> Self {
        if compactSizeClass || width < 700 { return .compact }
        if width < 1_100 { return .regular }
        return .expanded
    }

    var sidebarWidth: (minimum: CGFloat, ideal: CGFloat, maximum: CGFloat) {
        switch self {
        case .compact: return (180, 210, 250)
        case .regular: return (190, 220, 280)
        case .expanded: return (210, 250, 320)
        }
    }

    var inspectorWidth: (minimum: CGFloat, ideal: CGFloat, maximum: CGFloat) {
        switch self {
        case .compact: return (300, 340, 400)
        case .regular: return (320, 400, 500)
        case .expanded: return (360, 460, 580)
        }
    }
}
