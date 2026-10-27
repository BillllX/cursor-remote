import SwiftUI
import UIKit

/// 主屏幕图标。`alternateName` 为 nil 时用工程里的主图标。
/// 其余名字要和 Assets 里的 App Icon 集合同名。编译时 actool 会把它们写进
/// `CFBundleIcons` 和 `CFBundleIcons~ipad`，iPhone 和 iPad 才能换。
enum AppIconChoice: String, CaseIterable, Identifiable {
    case cyber
    case porcelain
    case plush
    case enamel
    case jelly
    case wood
    case ink
    case helmet

    var id: String { rawValue }

    /// 传给 `setAlternateIconName` 的键，和 App Icon 集合同名。赛博是主图标，传 nil。
    var alternateName: String? {
        self == .cyber ? nil : "AppIcon\(rawValue.capitalized)"
    }

    var title: String {
        switch self {
        case .cyber: "赛博"
        case .porcelain: "瓷"
        case .plush: "毛绒"
        case .enamel: "胸针"
        case .jelly: "果冻"
        case .wood: "木雕"
        case .ink: "水墨"
        case .helmet: "头盔"
        }
    }

    /// 设置页里的预览。主图标资源不能用 Image 读出来，所以每张另放一份。
    var previewAsset: String { "IconChoice\(rawValue.capitalized)" }

    static var current: AppIconChoice {
        let name = UIApplication.shared.alternateIconName
        return allCases.first { $0.alternateName == name } ?? .cyber
    }

    static var supported: Bool { UIApplication.shared.supportsAlternateIcons }
}

/// 设置里点「主屏幕图标」后推入的选择页。iPhone 和 iPad 的设置都进这里。
struct AppIconPickerScreen: View {
    @Binding var selection: AppIconChoice
    @ScaledMetric(relativeTo: .body) private var iconSide: CGFloat = 76
    @State private var pending: AppIconChoice?
    @State private var message: String?

    var body: some View {
        ScrollView {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: max(iconSide + 28, 108)), spacing: 16)],
                spacing: 20
            ) {
                ForEach(AppIconChoice.allCases) { choice in
                    iconButton(choice)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)

            VStack(alignment: .leading, spacing: 8) {
                if let message {
                    Text(message)
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(AppIconChoice.supported
                    ? "iPhone 和 iPad 都会换成这一张。点选之后，系统会再确认一次。"
                    : "这台设备不能更换主屏幕图标。")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .background(JieboColor.paper)
        .navigationTitle("主屏幕图标")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { selection = AppIconChoice.current }
    }

    private func iconButton(_ choice: AppIconChoice) -> some View {
        let selected = selection == choice
        let busy = pending == choice
        return Button {
            Task { await apply(choice) }
        } label: {
            VStack(spacing: 8) {
                Image(choice.previewAsset)
                    .resizable()
                    .scaledToFill()
                    .frame(width: iconSide, height: iconSide)
                    .clipShape(RoundedRectangle(cornerRadius: iconSide * 0.22, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: iconSide * 0.22, style: .continuous)
                            .strokeBorder(selected ? JieboColor.pine : JieboColor.line, lineWidth: selected ? 3 : 1)
                    }
                    .overlay {
                        if busy {
                            ProgressView()
                                .controlSize(.regular)
                        }
                    }
                    .accessibilityHidden(true)
                Text(choice.title)
                    .font(JieboFont.text(.caption, weight: selected ? .semibold : .regular))
                    .foregroundStyle(JieboColor.ink)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(selected ? JieboColor.pine : JieboColor.borderStrong)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(pending != nil || !AppIconChoice.supported)
        .accessibilityLabel(selected ? "\(choice.title)，当前图标" : choice.title)
        .accessibilityHint(selected ? "已经在用" : "换成这个主屏幕图标")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @MainActor
    private func apply(_ choice: AppIconChoice) async {
        guard choice != selection, pending == nil else { return }
        guard AppIconChoice.supported else {
            message = "这台设备不能更换主屏幕图标。"
            return
        }
        pending = choice
        message = nil
        let error = await withCheckedContinuation { (continuation: CheckedContinuation<Error?, Never>) in
            UIApplication.shared.setAlternateIconName(choice.alternateName) { error in
                continuation.resume(returning: error)
            }
        }
        pending = nil
        if error != nil {
            message = "没有换成「\(choice.title)」。"
            selection = AppIconChoice.current
        } else {
            selection = choice
            message = nil
        }
    }
}
