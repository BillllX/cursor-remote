import SwiftUI

struct JieboMark: View {
    var size: CGFloat = 64

    var body: some View {
        Canvas { context, canvasSize in
            let scale = min(canvasSize.width, canvasSize.height) / 32
            func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ radius: CGFloat) -> Path {
                Path(roundedRect: CGRect(x: x * scale, y: y * scale, width: w * scale, height: h * scale), cornerRadius: radius * scale)
            }
            context.fill(r(0, 0, 32, 32, 8), with: .color(JieboColor.pine))
            context.fill(r(6, 6, 13, 15, 3.2), with: .color(JieboColor.paper))
            context.fill(r(13, 11, 13, 15, 3.2), with: .color(JieboColor.brass))
            let pin = Path(ellipseIn: CGRect(
                x: (16 - 1.85) * scale,
                y: (16 - 1.85) * scale,
                width: 3.7 * scale,
                height: 3.7 * scale
            ))
            context.fill(pin, with: .color(JieboColor.pine))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
