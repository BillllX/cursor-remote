import SwiftUI

/// 与 App 图标和 Web 品牌位使用同一份视觉资产。
struct JieboMark: View {
    var size: CGFloat = 64

    var body: some View {
        Image("BrandMark")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
