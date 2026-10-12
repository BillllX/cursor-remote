import SwiftUI
import UIKit

/// 「5 分钟前」这类相对时间，每分钟自己刷新一次，界面静止时不会冻在旧值上
struct AgoLabel: View {
    let epochMs: Double?
    var font: Font
    var long = false

    var body: some View {
        TimelineView(.everyMinute) { _ in
            Text(agoText(epochMs, long: long))
                .font(font)
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
        }
    }
}
