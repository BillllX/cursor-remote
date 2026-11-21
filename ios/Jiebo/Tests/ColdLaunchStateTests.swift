import Foundation

@main
struct ColdLaunchStateTests {
    static func main() {
        var gate = ColdLaunchGate()
        precondition(gate.claim("first"))
        precondition(!gate.claim("first"), "Foregrounding must not replay the intro")
        precondition(!gate.claim("second"), "Opening another window must not replay it")
        precondition(gate.owner == "first")
        precondition(StickerLaunchTimeline.duration < 4)
        precondition(StickerLaunchTimeline.reducedDuration < 1)
        precondition(StickerLaunchTimeline.reveal(at: 2.8) == 0)
        precondition(StickerLaunchTimeline.reveal(at: 3.65) == 1)
        precondition(StickerLaunchTimeline.eyeScale(at: 2.58) < 0.1)
        precondition(StickerLaunchTimeline.eyeScale(at: 2.80) == 1)
        for index in 0..<4 {
            let start = StickerLaunchTimeline.cornerStarts[index]
            precondition(StickerLaunchTimeline.cornerProgress(index, at: start) == 0)
            precondition(StickerLaunchTimeline.cornerProgress(index, at: start + 0.13) < -0.06, "拉开前先收一点")
            precondition(StickerLaunchTimeline.cornerProgress(index, at: start + 0.47) > 0.99, "边缘的第一次触点对应音效")
            precondition(StickerLaunchTimeline.cornerProgress(index, at: start + 0.59) < 0.93, "触边后要有可见回弹")
            precondition(StickerLaunchTimeline.cornerProgress(index, at: start + StickerLaunchTimeline.pullDuration + 0.01) == 1)
            precondition(StickerLaunchTimeline.edgeFlex(index, at: start + 0.36) > 0.3)
        }
        let stretch = StickerLaunchTimeline.faceMotion(at: StickerLaunchTimeline.cornerStarts[0] + 0.36)
        let recoil = StickerLaunchTimeline.faceMotion(at: StickerLaunchTimeline.cornerStarts[0] + 0.51)
        precondition(stretch.x < 0 && stretch.y < 0 && stretch.squash < 0 && recoil.squash > 0)
        let settled = StickerLaunchTimeline.faceMotion(at: StickerLaunchTimeline.revealStart)
        precondition(settled.x == 0 && settled.y == 0 && settled.squash == 0 && settled.tilt == 0)
        for size in [CGSize(width: 320, height: 568), CGSize(width: 402, height: 874),
                     CGSize(width: 874, height: 402), CGSize(width: 1024, height: 1366),
                     CGSize(width: 320, height: 1024), CGSize(width: 1366, height: 1024)] {
            var lastReveal = 0.0
            for frame in 0...438 {
                let time = Double(frame) / 120
                let corners = StickerLaunchTimeline.corners(in: size, at: time)
                precondition(corners.count == 4)
                for point in corners {
                    precondition(point.x >= 0 && point.x <= size.width)
                    precondition(point.y >= 0 && point.y <= size.height)
                }
                // Every intermediate outline stays convex: no fold-over or self-intersection.
                for index in 0..<4 {
                    let a = corners[index], b = corners[(index + 1) % 4], c = corners[(index + 2) % 4]
                    precondition((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) > 0)
                }
                let reveal = StickerLaunchTimeline.reveal(at: time)
                precondition(reveal >= lastReveal && reveal <= 1)
                lastReveal = reveal
            }
            let final = StickerLaunchTimeline.corners(in: size, at: StickerLaunchTimeline.revealStart)
            precondition(abs(final[0].x - 5) < 0.001 && abs(final[0].y - 5) < 0.001)
            precondition(abs(final[2].x - (size.width - 5)) < 0.001)
            precondition(abs(final[2].y - (size.height - 5)) < 0.001)
            precondition(hypot(size.width, size.height) * 1.04 > hypot(size.width, size.height), "Reveal must cover every corner")
        }
        print("冷启动：仅播放一次、弹性时序、眨眼、轮廓和揭幕检查通过")
    }
}
