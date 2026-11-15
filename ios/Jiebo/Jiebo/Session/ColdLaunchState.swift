import Foundation

/// Process-local gate: windows and foreground transitions never replay a consumed intro.
struct ColdLaunchGate {
    private(set) var owner: String?
    private(set) var consumed = false

    mutating func claim(_ scene: String) -> Bool {
        guard !consumed else { return false }
        consumed = true
        owner = scene
        return true
    }
}

/// One monotonic timeline drives the contour, blink, reveal, and matching sound asset.
enum StickerLaunchTimeline {
    static let duration: TimeInterval = 3.65
    static let reducedDuration: TimeInterval = 0.45
    static let cornerStarts: [TimeInterval] = [0.30, 0.79, 1.28, 1.77]
    static let pullDuration: TimeInterval = 0.58
    static let revealStart: TimeInterval = 2.82
    static let revealDuration: TimeInterval = 0.76

    static func ease(_ value: Double) -> Double {
        let x = min(1, max(0, value))
        return x * x * x * (x * (x * 6 - 15) + 10)
    }

    static func cornerProgress(_ index: Int, at time: TimeInterval) -> Double {
        ease((time - cornerStarts[index]) / pullDuration)
    }

    static func reveal(at time: TimeInterval) -> Double {
        ease((time - revealStart) / revealDuration)
    }

    static func eyeScale(at time: TimeInterval) -> Double {
        let close = ease((time - 2.43) / 0.13)
        let open = ease((time - 2.60) / 0.16)
        return 1 - 0.92 * close * (1 - open)
    }

    /// Clockwise: top-left, top-right, bottom-right, bottom-left.
    static func corners(in size: CGSize, at time: TimeInterval) -> [CGPoint] {
        let side = min(size.width, size.height, 420)
        let w = side * 0.54
        let h = side * 0.46
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let angle = -7.0 * Double.pi / 180
        let offsets = [CGPoint(x: -w / 2, y: -h / 2), CGPoint(x: w / 2, y: -h / 2),
                       CGPoint(x: w / 2, y: h / 2), CGPoint(x: -w / 2, y: h / 2)]
        let inset: CGFloat = 5
        let targets = [CGPoint(x: inset, y: inset), CGPoint(x: size.width - inset, y: inset),
                       CGPoint(x: size.width - inset, y: size.height - inset), CGPoint(x: inset, y: size.height - inset)]
        return offsets.enumerated().map { index, point in
            let start = CGPoint(x: center.x + point.x * cos(angle) - point.y * sin(angle),
                                y: center.y + point.x * sin(angle) + point.y * cos(angle))
            let progress = cornerProgress(index, at: time)
            return CGPoint(x: start.x + (targets[index].x - start.x) * progress,
                           y: start.y + (targets[index].y - start.y) * progress)
        }
    }
}
