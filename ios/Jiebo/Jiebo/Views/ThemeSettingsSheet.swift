import SwiftUI
import UIKit

struct ThemeSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var theme: JieboTheme { JieboTheme.shared }

    var body: some View {
        NavigationStack {
            List {
                Section("外观") {
                    Picker("外观", selection: Bindable(theme).appearance) {
                        ForEach(JieboAppearance.allCases) { item in
                            Text(item.title).tag(item)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .listRowBackground(JieboColor.white)
                }

                Section("配色") {
                    ForEach(JieboPalette.allCases) { palette in
                        ThemePaletteCard(
                            palette: palette,
                            selected: theme.palette == palette,
                            appearance: theme.appearance
                        ) {
                            withAnimation(JieboMotion.fade(reduceMotion)) { theme.palette = palette }
                        }
                        .listRowInsets(EdgeInsets(top: 7, leading: 0, bottom: 7, trailing: 0))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(JieboColor.paper)
            .navigationTitle("主题")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }
}

/// 一套配色一张卡：左右两块迷你对话界面分别是这套配色的浅色、深色。外观锁定在某一边时，另一边压暗。
private struct ThemePaletteCard: View {
    let palette: JieboPalette
    let selected: Bool
    let appearance: JieboAppearance
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    ThemeMiniThread(ink: palette.light, dark: false, idle: appearance == .dark)
                    ThemeMiniThread(ink: palette.dark, dark: true, idle: appearance == .light)
                }
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(palette.title)
                            .font(JieboFont.text(.body, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                        Text(palette.subtitle)
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.dim)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(selected ? JieboColor.pine : JieboColor.borderStrong)
                }
                .padding(.horizontal, 4)
            }
            .padding(12)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous)
                    .stroke(selected ? JieboColor.pine : JieboColor.line, lineWidth: selected ? 2 : 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous))
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(palette.title)，\(palette.subtitle)")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// 迷你对话界面：标题、助理正文、用户气泡、输入胶囊和发送键，颜色直接取这套配色的色值，不跟当前明暗走。
private struct ThemeMiniThread: View {
    let ink: JieboSurfaces
    let dark: Bool
    let idle: Bool

    var body: some View {
        VStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Spacer()
                    VStack(spacing: 3) {
                        bar(ink.text, width: 34, height: 5)
                        Circle().fill(Color(hex: dark ? 0x7DCE98 : 0x2F7D4A)).frame(width: 4, height: 4)
                    }
                    Spacer()
                }
                .padding(.bottom, 4)
                bar(ink.text, width: nil, height: 4).opacity(0.85)
                bar(ink.text, width: 70, height: 4).opacity(0.85)
                bar(ink.muted, width: 52, height: 4).opacity(0.6)
                HStack {
                    Spacer(minLength: 24)
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(Color(hex: ink.user))
                        .frame(height: 20)
                        .overlay(alignment: .leading) {
                            bar(ink.text, width: 34, height: 3).opacity(0.7).padding(.leading, 7)
                        }
                }
                bar(ink.text, width: nil, height: 4).opacity(0.85)
                bar(ink.muted, width: 60, height: 4).opacity(0.6)
                Spacer(minLength: 0)
                HStack(spacing: 0) {
                    bar(ink.muted, width: 40, height: 3).opacity(0.45)
                    Spacer(minLength: 0)
                    Circle()
                        .fill(Color(hex: ink.accent))
                        .frame(width: 14, height: 14)
                        .overlay(
                            Image(systemName: "arrow.up")
                                .font(.system(size: 7, weight: .bold))
                                .foregroundStyle(Color(hex: ink.bg))
                        )
                }
                .padding(.leading, 9)
                .padding(.trailing, 3)
                .frame(height: 20)
                .background(Color(hex: ink.panel), in: Capsule())
                .overlay(Capsule().stroke(Color(hex: ink.border), lineWidth: 1))
            }
            .padding(10)
            .frame(maxWidth: .infinity)
            .frame(height: 170)
            .background(Color(hex: ink.bg))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color(hex: ink.border), lineWidth: 1)
            )
            Text(dark ? "深色" : "浅色")
                .font(JieboFont.text(.caption2))
                .foregroundStyle(JieboColor.dim)
        }
        .opacity(idle ? 0.4 : 1)
    }

    private func bar(_ hex: UInt32, width: CGFloat?, height: CGFloat) -> some View {
        Capsule()
            .fill(Color(hex: hex))
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }
}
