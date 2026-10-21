import SwiftUI
import UIKit

/// 助理会话的置顶入口（iPad 侧栏与手机抽屉共用）。不进工作区分组，不能删
struct AssistantEntryRow: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var action: () -> Void

    var body: some View {
        let chat = store.assistantChat
        let selected = store.assistantChatActive
        let live = chat.map { row in
            row.turns.contains(where: \.running) || store.runningChatIds.contains(row.id)
        } ?? false
        let unread = !selected && (chat?.unread ?? false)
        let badge = store.assistantBadgeCount
        let preview = store.assistantPreview
        Button(action: action) {
            HStack(spacing: 10) {
                Capsule()
                    .fill(selected ? JieboColor.pine : Color.clear)
                    .frame(width: 3, height: 26)
                    .accessibilityHidden(true)
                ZStack(alignment: .topTrailing) {
                    Image(systemName: NavigationIconId.assistant.symbol)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .frame(width: 30, height: 30)
                        .background(JieboColor.pine.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                    if badge > 0 {
                        PendingBadge(count: badge)
                            .offset(x: 7, y: -6)
                            .animation(JieboMotion.fade(reduceMotion), value: badge)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.assistantName)
                        .font(JieboFont.ui(14, weight: unread ? .semibold : .medium))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    Text(preview.isEmpty ? "今日 · 收件箱 · 记忆" : preview)
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
                if selected {
                    Text("当前")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(JieboColor.pine.opacity(0.12))
                        .clipShape(Capsule())
                        .accessibilityHidden(true)
                }
                if live {
                    Circle()
                        .fill(JieboColor.run)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .fill(selected ? JieboColor.pine.opacity(0.1) : JieboColor.white.opacity(0.4))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                            .stroke(selected ? JieboColor.pine.opacity(0.42) : JieboColor.line, lineWidth: 1)
                    )
            )
            .contentShape(Rectangle())
            .animation(JieboMotion.fade(reduceMotion), value: selected)
            .animation(JieboMotion.fade(reduceMotion), value: live)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel(name: store.assistantName, badge: badge, running: live, unread: unread))
        .accessibilityValue(selected ? "当前助理会话，\(preview)" : preview)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func accessibilityLabel(name: String, badge: Int, running: Bool, unread: Bool) -> String {
        var parts = [name]
        if badge > 0 { parts.append(StatusLegendId.attention.accessibilityLabel(count: badge)) }
        if unread { parts.append("助理会话\(StatusLegendId.unread.label)") }
        if running { parts.append(StatusLegendId.running.label) }
        return parts.joined(separator: "，")
    }
}
