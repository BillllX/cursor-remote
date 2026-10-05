import SwiftUI

/// 和网页 `favicon.svg` 同一稿：松绿底、象牙对话气泡压在黄铜终端上。
struct JieboMark: View {
    var size: CGFloat = 64

    private let pine = Color(red: 0x1A / 255, green: 0x4F / 255, blue: 0x41 / 255)
    private let paper = Color(red: 0xF3 / 255, green: 0xEE / 255, blue: 0xE4 / 255)
    private let brass = Color(red: 0xC4 / 255, green: 0xA3 / 255, blue: 0x6A / 255)

    var body: some View {
        Canvas { context, canvasSize in
            let scale = min(canvasSize.width, canvasSize.height) / 32
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: x * scale, y: y * scale)
            }
            func roundRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ radius: CGFloat) -> Path {
                Path(roundedRect: CGRect(x: x * scale, y: y * scale, width: w * scale, height: h * scale), cornerRadius: radius * scale)
            }

            context.fill(roundRect(0, 0, 32, 32, 7.5), with: .color(pine))
            context.fill(roundRect(13.4, 13.6, 13.6, 12.6, 3.1), with: .color(brass))

            var prompt = Path()
            prompt.move(to: p(17.4, 18.4))
            prompt.addLine(to: p(20, 20.3))
            prompt.addLine(to: p(17.4, 22.2))
            prompt.move(to: p(21.7, 22.6))
            prompt.addLine(to: p(24.7, 22.6))
            context.stroke(
                prompt,
                with: .color(pine),
                style: StrokeStyle(lineWidth: 1.55 * scale, lineCap: .round, lineJoin: .round)
            )

            var bubble = Path()
            bubble.move(to: p(12.6, 5.3))
            bubble.addCurve(to: p(19.9, 11.6), control1: p(16.7, 5.3), control2: p(19.9, 8.1))
            bubble.addCurve(to: p(12.6, 17.9), control1: p(19.9, 15.1), control2: p(16.7, 17.9))
            bubble.addCurve(to: p(10, 17.5), control1: p(11.7, 17.9), control2: p(10.8, 17.8))
            bubble.addLine(to: p(7.4, 19.2))
            bubble.addCurve(to: p(6.6, 18.7), control1: p(7, 19.4), control2: p(6.6, 19.2))
            bubble.addLine(to: p(6.6, 15.4))
            bubble.addCurve(to: p(5.3, 11.6), control1: p(5.6, 14.3), control2: p(5.3, 13))
            bubble.addCurve(to: p(12.6, 5.3), control1: p(5.3, 8.1), control2: p(8.5, 5.3))
            bubble.closeSubpath()
            context.stroke(
                bubble,
                with: .color(pine),
                style: StrokeStyle(lineWidth: 1.5 * scale, lineJoin: .round)
            )
            context.fill(bubble, with: .color(paper))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
