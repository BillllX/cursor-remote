import SwiftUI
import UIKit

/// 助理页顶部的横滑「今日条」（docs/iphone-assistant-first.md §4.1.2）。
/// 芯片为空就不显示；全部为空或 assistantState 还没到时整条隐藏，不占位。
struct TodayStrip: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router

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
        let hasBrief = state?.brief?.text.nilIfEmpty != nil
        let todoCount = state?.todos.filter { !$0.done }.count ?? 0
        let nextLabel = nextScheduleLabel(state)
        let running = store.runningDelegations
        if hasBrief || todoCount > 0 || nextLabel != nil || !running.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    if hasBrief {
                        chip(symbol: "doc.text", text: "今日简报", label: "今日简报") {
                            router.openHub()
                        }
                    }
                    if todoCount > 0 {
                        chip(symbol: nil, text: "待办 \(todoCount)", label: "待办 \(todoCount) 项") {
                            router.openHub(anchor: "todos")
                        }
                    }
                    if let nextLabel {
                        chip(symbol: "clock", text: nextLabel, label: "下一个日程，\(nextLabel)") {
                            router.openHub(anchor: "schedules")
                        }
                    }
                    if !running.isEmpty {
                        chip(
                            symbol: nil,
                            text: "进行中 \(running.count)",
                            label: "进行中的委派 \(running.count) 项",
                            fg: JieboColor.run,
                            bg: JieboColor.runBg
                        ) {
                            if running.count == 1, let only = running.first {
                                router.delegationDetail = DelegationRef(id: only.id)
                            } else {
                                router.focusActionDock = true
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
            .frame(height: 44)
        }
    }

    private func chip(
        symbol: String?,
        text: String,
        label: String,
        fg: Color = JieboColor.ink,
        bg: Color = JieboColor.white,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 12, weight: .semibold))
                }
                Text(text)
                    .font(JieboFont.ui(13, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(fg)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(bg)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
            .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(label)
    }

    /// 启用的日程里 nextAt 最近的一条；今天「HH:mm 标题」，明天「明天 HH:mm 标题」，更远「M月d日 标题」
    private func nextScheduleLabel(_ state: AssistantState?) -> String? {
        guard let state else { return nil }
        let upcoming = state.schedules.filter { $0.enabled && ($0.nextAt ?? 0) > 0 }
        guard let next = upcoming.min(by: { ($0.nextAt ?? 0) < ($1.nextAt ?? 0) }),
              let millis = next.nextAt
        else { return nil }
        let date = Date(timeIntervalSince1970: millis / 1000)
        // 芯片不限宽，标题太长就把整条条撑出屏幕：截到 12 个字
        let rawTitle = next.title.nilIfEmpty ?? "日程"
        let title = rawTitle.count > 12 ? String(rawTitle.prefix(12)) + "…" : rawTitle
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
