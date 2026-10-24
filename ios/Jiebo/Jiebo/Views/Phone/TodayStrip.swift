import SwiftUI
import UIKit

/// Day Thread 顶部摘要（保留类型名，避免工程文件引用变更）。只取最多三条高价值事件，
/// 主对话仍由 ThreadView 展示，不在这里复制聊天 turn。
struct TodayStrip: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("jiebo.todayThreadExpanded") private var expanded = false

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
        if let projected = store.assistantState?.dayThread {
            summaryCard(events: selectedEvents(projected))
        } else {
            legacySummary
        }
    }

    private func summaryCard(events: [DayThreadEvent]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                JieboHaptic.selection()
                withAnimation(JieboMotion.snappy(reduceMotion)) { expanded.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(greeting)
                            .font(JieboFont.text(.headline, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                        Text(Self.dayFormatter.string(from: Date()))
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.dim)
                    }
                    Spacer(minLength: 8)
                    HStack(spacing: 4) {
                        Text(events.isEmpty ? "今日脉络" : "今日脉络 · \(events.count)")
                            .font(JieboFont.text(.caption2, weight: .semibold))
                            .tracking(0.7)
                        Image(systemName: "chevron.down")
                            .font(JieboFont.text(.caption2, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .foregroundStyle(JieboColor.dim)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("今日脉络")
            .accessibilityValue(expanded ? "已展开" : "已收起")
            .accessibilityHint(expanded ? "轻点两下收起" : "轻点两下展开")

            if expanded {
                if events.isEmpty {
                    Text("今天还没有需要关注的新动态")
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.dim)
                        .padding(.horizontal, 14)
                        .padding(.bottom, 12)
                } else {
                    ForEach(events) { event in
                        Divider().overlay(JieboColor.line)
                        eventRow(event)
                    }
                }
            }
        }
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func eventRow(_ event: DayThreadEvent) -> some View {
        let display = eventDisplay(event)
        return Button {
            open(event)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: display.icon)
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(display.color)
                    .frame(width: 22)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(display.title)
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .multilineTextAlignment(.leading)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 2)
                    if let body = event.body?.nilIfEmpty {
                        Text(body)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                            .multilineTextAlignment(.leading)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 2)
                    }
                    Text(Self.timeFormatter.string(from: Date(timeIntervalSince1970: event.at / 1000)))
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                    .padding(.top, 4)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel([display.title, event.body, Self.timeFormatter.string(from: Date(timeIntervalSince1970: event.at / 1000))]
            .compactMap { $0?.nilIfEmpty }
            .joined(separator: "，"))
        .accessibilityHint(display.hint)
    }

    private var legacySummary: some View {
        let state = store.assistantState
        let brief = state?.brief?.text.nilIfEmpty
        let todoCount = state?.todos.filter { !$0.done }.count ?? 0
        let nextLabel = nextScheduleLabel(state)
        return Group {
            if brief != nil || todoCount > 0 || nextLabel != nil {
                Button {
                    JieboHaptic.selection()
                    router.openHub()
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "sun.max")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(JieboColor.pine)
                            .frame(width: 32)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(todoCount > 0 ? "待办 \(todoCount)" : (brief != nil ? "今日简报" : "下一日程"))
                                .font(JieboFont.text(.headline, weight: .semibold))
                                .foregroundStyle(JieboColor.ink)
                            if let detail = nextLabel ?? brief {
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
                    .padding(14)
                    .frame(maxWidth: .infinity, minHeight: 70, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleButtonStyle())
                .accessibilityHint("打开今日面板")
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
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 0 ..< 6: return "夜深了"
        case 6 ..< 12: return "早上好"
        case 12 ..< 18: return "下午好"
        default: return "晚上好"
        }
    }

    /// 固定价值顺序，组内按新到旧；不会因低价值新消息挤掉待确认草稿。
    private func selectedEvents(_ events: [DayThreadEvent]) -> [DayThreadEvent] {
        events.sorted {
            let left = eventRank($0)
            let right = eventRank($1)
            return left == right ? $0.at > $1.at : left < right
        }
        .prefix(3)
        .map { $0 }
    }

    private func eventRank(_ event: DayThreadEvent) -> Int {
        if event.kind == "draft" { return 0 }
        if event.kind == "inbox" && event.priority == "high" { return 1 }
        if event.kind == "receipt" { return 2 }
        if event.kind == "brief" { return 3 }
        return 4
    }

    private func eventDisplay(_ event: DayThreadEvent) -> (icon: String, title: String, color: Color, hint: String) {
        if event.kind == "draft" {
            return ("checkmark.seal", event.title, JieboColor.warnFg, "前往待处理")
        }
        if event.kind == "brief" {
            return ("sun.max", event.title, JieboColor.pine, "打开今日面板")
        }
        if event.kind == "receipt" {
            let failed = ["failed", "interrupted"].contains(event.receipt?.status ?? "")
            let done = event.receipt?.status == "done"
            let state = failed ? "失败" : (done ? "已完成" : "已记录")
            let cleanTitle = event.title
                .replacingOccurrences(of: "已完成：", with: "")
                .replacingOccurrences(of: "失败：", with: "")
            return (
                failed ? "xmark.circle.fill" : (done ? "checkmark.circle.fill" : "tray.and.arrow.down.fill"),
                "\(state) · \(cleanTitle)",
                failed ? JieboColor.danger : JieboColor.ok,
                event.sources.contains(where: { $0.kind == "delegation" }) ? "打开委派详情" : "打开对应任务"
            )
        }
        return ("bell.fill", event.title, event.priority == "high" ? JieboColor.warnFg : JieboColor.pine, "打开对应事项")
    }

    private func open(_ event: DayThreadEvent) {
        JieboHaptic.selection()
        if event.kind == "draft" {
            router.go(.inbox)
            return
        }
        if let inboxId = event.sources.first(where: { $0.kind == "inbox" })?.id,
           let item = store.assistantState?.inbox.first(where: { $0.id == inboxId })
        {
            if item.kind == "approval" {
                router.go(.inbox)
            } else if let delegationId = item.delegationId {
                router.delegationDetail = DelegationRef(id: delegationId)
            } else if item.scheduleId != nil || item.kind == "brief" || item.kind == "reminder" {
                router.openHub(anchor: item.scheduleId == nil ? nil : "schedules")
            } else {
                router.openInboxItem(item.id)
            }
            return
        }
        if let delegationId = event.sources.first(where: { $0.kind == "delegation" })?.id
            ?? event.taskId.flatMap({ $0.hasPrefix("delegation:") ? String($0.dropFirst("delegation:".count)) : nil })
        {
            router.delegationDetail = DelegationRef(id: delegationId)
        } else if event.kind == "brief" {
            router.openHub()
        } else if event.sources.contains(where: { $0.kind == "todo" }) {
            router.openHub(anchor: "todos")
        } else if event.sources.contains(where: { $0.kind == "schedule" }) {
            router.openHub(anchor: "schedules")
        } else {
            // 普通回执和后台运行统一进入「任务与计划」。
            router.go(.delegations)
        }
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
