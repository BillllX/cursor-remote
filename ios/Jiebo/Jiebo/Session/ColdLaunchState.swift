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
    static let pullDuration: TimeInterval = 0.72
    static let revealStart: TimeInterval = 2.82
    static let revealDuration: TimeInterval = 0.76

    static func ease(_ value: Double) -> Double {
        let x = min(1, max(0, value))
        return x * x * x * (x * (x * 6 - 15) + 10)
    }

    private static func blend(_ from: Double, _ to: Double, time: Double, start: Double, end: Double) -> Double {
        from + (to - from) * ease((time - start) / (end - start))
    }

    static func cornerProgress(_ index: Int, at time: TimeInterval) -> Double {
        let t = time - cornerStarts[index]
        // 先往里捏一下，快速拉到边缘，再回缩一点，最后轻轻归位。
        switch t {
        case ..<0.13: return blend(0, -0.075, time: t, start: 0, end: 0.13)
        case ..<0.47: return blend(-0.075, 1, time: t, start: 0.13, end: 0.47)
        case ..<0.59: return blend(1, 0.91, time: t, start: 0.47, end: 0.59)
        default: return blend(0.91, 1, time: t, start: 0.59, end: pullDuration)
        }
    }

    static func contourSettled(at time: TimeInterval) -> Double {
        ease((time - cornerStarts[3]) / pullDuration)
    }

    private static func bump(_ time: Double, start: Double, peak: Double, end: Double) -> Double {
        ease((time - start) / (peak - start)) * (1 - ease((time - peak) / (end - peak)))
    }

    /// 相邻两边跟着被拉的角鼓起来，归位后恢复为直边。
    static func edgeFlex(_ index: Int, at time: TimeInterval) -> Double {
        func flex(_ corner: Int) -> Double {
            let t = time - cornerStarts[corner]
            return bump(t, start: 0.10, peak: 0.36, end: 0.53)
                - 0.40 * bump(t, start: 0.48, peak: 0.59, end: pullDuration)
        }
        return 0.55 * (flex(index) + flex((index + 1) % 4))
    }

    /// 眼睛随贴纸的拉力轻轻偏头和挤压，眨眼仍走原来的节拍。
    static func faceMotion(at time: TimeInterval) -> (x: Double, y: Double, squash: Double, tilt: Double) {
        var x = 0.0, y = 0.0, squash = 0.0
        for index in cornerStarts.indices {
            let t = time - cornerStarts[index]
            let lift = bump(t, start: 0.10, peak: 0.36, end: 0.51)
            let recoil = bump(t, start: 0.43, peak: 0.51, end: pullDuration)
            x += (index == 0 || index == 3 ? -1 : 1) * lift
            y += (index < 2 ? -1 : 1) * lift
            squash += 0.095 * recoil - 0.055 * lift
        }
        let upright = ease((time - cornerStarts[0]) / 0.47)
        return (x * 0.024, y * 0.018, squash, -7 * (1 - upright) + x * 5)
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
            let dx = targets[index].x - start.x
            let dy = targets[index].y - start.y
            let length = max(1, hypot(dx, dy))
            // 拉出的路线带一点弧度，快到边缘时把侧向形变收回来。
            let t = time - cornerStarts[index]
            let curl = side * 0.085 * bump(t, start: 0.11, peak: 0.28, end: 0.44)
            return CGPoint(x: start.x + dx * progress - dy / length * curl,
                           y: start.y + dy * progress + dx / length * curl)
        }
    }
}
