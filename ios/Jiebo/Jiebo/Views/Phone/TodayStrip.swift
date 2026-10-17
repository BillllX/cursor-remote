import SwiftUI
import UIKit

/// 助理页顶部的「今日」摘要卡。没有任何摘要时隐藏，不占位。
struct TodayStrip: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "M月d日"
        return formatter
    }()

    var body: some View {
        let state = store.assistantState
        let brief = state?.brief?.text.nilIfEmpty
        let todoCount = state?.todos.filter { !$0.done }.count ?? 0
        let nextLabel = nextScheduleLabel(state)
        if brief != nil || todoCount > 0 || nextLabel != nil {
            Button(action: openPrimarySummary) {
                HStack(spacing: 12) {
                    VStack(spacing: 3) {
                        Image(systemName: "sun.max")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(JieboColor.pine)
                            .accessibilityHidden(true)
                        Text("今天")
                            .font(JieboFont.text(.caption2, weight: .medium))
                            .foregroundStyle(JieboColor.dim)
                    }
                    .frame(width: 42)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(primaryTitle(todoCount: todoCount, hasBrief: brief != nil, nextLabel: nextLabel))
                            .font(JieboFont.text(.headline, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                        if let detail = primaryDetail(brief: brief, todoCount: todoCount, nextLabel: nextLabel) {
                            Text(detail)
                                .font(JieboFont.text(.footnote))
                                .foregroundStyle(JieboColor.dim)
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                        }
                    }
                    .multilineTextAlignment(.leading)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(JieboColor.dim)
                        .accessibilityHidden(true)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleButtonStyle())
            .accessibilityLabel(primaryAccessibilityLabel(
                brief: brief,
                todoCount: todoCount,
                nextLabel: nextLabel
            ))
            .accessibilityHint("打开今日")
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    private func primaryTitle(todoCount: Int, hasBrief: Bool, nextLabel: String?) -> String {
        if todoCount > 0 { return "待办 \(todoCount)" }
        if hasBrief { return "今日简报" }
        if nextLabel != nil { return "下一日程" }
        return "今天"
    }

    private func primaryDetail(brief: String?, todoCount: Int, nextLabel: String?) -> String? {
        if todoCount > 0 { return nextLabel ?? (brief != nil ? "今日简报已准备好" : nil) }
        if let brief { return brief }
        return nextLabel
    }

    private func primaryAccessibilityLabel(brief: String?, todoCount: Int, nextLabel: String?) -> String {
        [
            todoCount > 0 ? "待办 \(todoCount) 项" : nil,
            brief != nil ? "今日简报已准备好" : nil,
            nextLabel.map { "下一日程，\($0)" }
        ]
        .compactMap { $0 }
        .joined(separator: "，")
    }

    private func openPrimarySummary() {
        JieboHaptic.selection()
        router.openHub()
    }

    /// 启用的日程里 nextAt 最近的一条；今天「HH:mm 标题」，明天「明天 HH:mm 标题」，更远「M月d日 标题」
    private func nextScheduleLabel(_ state: AssistantState?) -> String? {
        guard let state else { return nil }
        let upcoming = state.schedules.filter { $0.enabled && ($0.nextAt ?? 0) > 0 }
        guard let next = upcoming.min(by: { ($0.nextAt ?? 0) < ($1.nextAt ?? 0) }),
              let millis = next.nextAt
        else { return nil }
        let date = Date(timeIntervalSince1970: millis / 1000)
        let rawTitle = next.title.nilIfEmpty ?? "日程"
        let title = rawTitle.count > 18 ? String(rawTitle.prefix(18)) + "…" : rawTitle
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return "\(Self.timeFormatter.string(from: date)) \(title)"
        }
        if calendar.isDateInTomorrow(date) {
            return "明天 \(Self.timeFormatter.string(from: date)) \(title)"
        }
        return "\(Self.dayFormatter.string(from: date)) \(title)"
    }
}
