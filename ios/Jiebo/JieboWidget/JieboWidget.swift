import SwiftUI
import WidgetKit

private struct JieboWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

private struct JieboWidgetProvider: TimelineProvider {
    private let appGroup = "group.ai.jiebo.ipad"

    func placeholder(in context: Context) -> JieboWidgetEntry {
        JieboWidgetEntry(
            date: Date(),
            snapshot: WidgetSnapshot(
                loginState: .loggedIn,
                assistantStatus: .available,
                statusText: "小驳随时在",
                unreadCount: 2,
                todoCount: 3,
                highlight: .init(kind: .todo, id: "preview", summary: "整理今天最重要的一件事"),
                updatedAt: Date(),
                staleAfter: Date().addingTimeInterval(WidgetSnapshot.staleInterval),
                privacyMode: false
            )
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (JieboWidgetEntry) -> Void) {
        completion(entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<JieboWidgetEntry>) -> Void) {
        let current = entry()
        let refreshAt = max(
            current.snapshot.staleAfter,
            Date().addingTimeInterval(WidgetSnapshot.staleInterval)
        )
        completion(Timeline(entries: scheduledEntries(from: current, until: refreshAt), policy: .after(refreshAt)))
    }

    private func entry() -> JieboWidgetEntry {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup
        ) else {
            return JieboWidgetEntry(date: Date(), snapshot: .loggedOut())
        }
        return JieboWidgetEntry(
            date: Date(),
            snapshot: WidgetSnapshotStore.load(from: container) ?? .loggedOut()
        )
    }

    /// 只在相对时间单位变化的时刻插一帧，避免「4分钟7秒」这种双单位。
    private func scheduledEntries(from current: JieboWidgetEntry, until end: Date) -> [JieboWidgetEntry] {
        var entries = [current]
        var cursor = current.date
        while entries.count < 48 {
            guard let next = nextStamp(updatedAt: current.snapshot.updatedAt, after: cursor),
                  next > cursor,
                  next < end else { break }
            entries.append(JieboWidgetEntry(date: next, snapshot: current.snapshot))
            cursor = next
        }
        return entries
    }

    private func nextStamp(updatedAt: Date, after now: Date) -> Date? {
        let elapsed = now.timeIntervalSince(updatedAt)
        let next: Date
        if elapsed < 60 {
            next = updatedAt.addingTimeInterval(60)
        } else if elapsed < 3_600 {
            next = updatedAt.addingTimeInterval(TimeInterval(Int(elapsed / 60) + 1) * 60)
        } else if elapsed < 86_400 {
            next = updatedAt.addingTimeInterval(TimeInterval(Int(elapsed / 3_600) + 1) * 3_600)
        } else if elapsed < 7 * 86_400 {
            next = updatedAt.addingTimeInterval(TimeInterval(Int(elapsed / 86_400) + 1) * 86_400)
        } else {
            return nil
        }
        return next > now ? next : nil
    }
}

private struct JieboWidgetEntryView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let entry: JieboWidgetEntry

    var body: some View {
        JieboWidgetFamilyLayout(entry: entry, dynamicTypeSize: dynamicTypeSize)
    }
}

private struct JieboWidgetFamilyLayout: View {
    @Environment(\.widgetFamily) private var family
    let entry: JieboWidgetEntry
    /// 根上捕获的真实档位。各尺寸的 dynamicTypeSize 钳制包在内容外，改不到这个值。
    let dynamicTypeSize: DynamicTypeSize

    private var todayURL: URL { URL(string: "jiebo://assistant/today")! }
    private var inboxURL: URL { URL(string: "jiebo://assistant/inbox")! }

    var body: some View {
        Group {
            switch family {
            case .systemMedium:
                medium
            case .systemLarge:
                large
            case .systemExtraLarge:
                extraLarge
            default:
                small
                    .widgetURL(URL(string: "jiebo://assistant/today"))
            }
        }
        .containerBackground(for: .widget) {
            CyberBackdrop()
        }
    }

    private var tight: Bool { dynamicTypeSize.isAccessibilitySize }

    /// 中号内容区大约 120–130pt。xxLarge 起主句降一档，避免为了字号把句子裁出系统边距。
    private var prefersCompactType: Bool { dynamicTypeSize >= .xxLarge }

    private var small: some View {
        smallBody
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private var medium: some View {
        mediumBody
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private var large: some View {
        largeBody
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }

    private var extraLarge: some View {
        extraLargeBody
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    private var smallBody: some View {
        VStack(alignment: .leading, spacing: prefersCompactType ? 3 : 6) {
            brand(showsCode: !tight && !entry.snapshot.isStale, detail: nil)
                .layoutPriority(1)
            summaryText(font: smallHeadline, minLines: 2, maxLines: 2)
                .layoutPriority(2)
            if showsSmallStatus {
                Text(displayStatus)
                    .font(.caption)
                    .foregroundStyle(Cyber.dim)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
            Spacer(minLength: 0)
            smallFooter
                .layoutPriority(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(smallAccessibilityLabel)
    }

    private var mediumBody: some View {
        VStack(alignment: .leading, spacing: prefersCompactType ? 2 : 4) {
            mediumHeader
                .layoutPriority(2)
            highlightLink(font: mediumHeadline, minLines: 2, maxLines: 2, pad: prefersCompactType ? 3 : 6)
                .layoutPriority(1)
            mediumFooter
                .layoutPriority(2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var largeBody: some View {
        VStack(alignment: .leading, spacing: tight ? 6 : 10) {
            Link(destination: todayURL) {
                brand(showsCode: !tight, detail: nil)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(todayHeaderLabel)
            .layoutPriority(2)
            if !tight {
                Text(displayStatus)
                    .font(.subheadline)
                    .foregroundStyle(Cyber.dim)
                    .lineLimit(1)
                    .layoutPriority(2)
            }
            highlightLink(font: largeHeadline, minLines: 3, maxLines: tight ? 3 : 5, pad: 10, expands: false)
                .layoutPriority(1)
            HStack(spacing: 8) {
                countBlock(
                    title: "待办",
                    value: entry.snapshot.todoCount,
                    url: todayURL,
                    label: "打开今日，待办 \(entry.snapshot.todoCount) 项",
                    fillsHeight: false,
                    font: countFont,
                    minHeight: 44
                )
                countBlock(
                    title: "未读",
                    value: entry.snapshot.unreadCount,
                    url: inboxURL,
                    label: "打开收件箱，未读 \(entry.snapshot.unreadCount) 项",
                    fillsHeight: false,
                    font: countFont,
                    minHeight: 44
                )
            }
            .layoutPriority(2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var extraLargeBody: some View {
        GeometryReader { proxy in
            let spacing: CGFloat = 12
            let available = max(0, proxy.size.width - spacing)
            let leftWidth = available * 0.60
            let rightWidth = available - leftWidth
            HStack(alignment: .top, spacing: spacing) {
                VStack(alignment: .leading, spacing: 8) {
                    Link(destination: todayURL) {
                        brand(showsCode: !tight, detail: nil)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(todayHeaderLabel)
                    highlightLink(
                        font: extraLargeHeadline,
                        minLines: 3,
                        maxLines: tight ? 3 : 5,
                        pad: 10,
                        expands: false
                    )
                    if !tight {
                        Text(displayStatus)
                            .font(.subheadline)
                            .foregroundStyle(Cyber.dim)
                            .lineLimit(1)
                    }
                    updatedLabel
                }
                .frame(width: leftWidth, height: proxy.size.height, alignment: .topLeading)
                VStack(spacing: 10) {
                    countBlock(
                        title: "待办",
                        value: entry.snapshot.todoCount,
                        url: todayURL,
                        label: "打开今日，待办 \(entry.snapshot.todoCount) 项",
                        fillsHeight: true,
                        font: extraLargeCountFont,
                        minHeight: 60
                    )
                    countBlock(
                        title: "未读",
                        value: entry.snapshot.unreadCount,
                        url: inboxURL,
                        label: "打开收件箱，未读 \(entry.snapshot.unreadCount) 项",
                        fillsHeight: true,
                        font: extraLargeCountFont,
                        minHeight: 60
                    )
                }
                .frame(width: rightWidth, height: proxy.size.height, alignment: .top)
            }
        }
    }

    private var mediumHeader: some View {
        HStack(alignment: .center, spacing: 6) {
            Link(destination: todayURL) {
                brand(showsCode: false, detail: tight ? nil : displayStatus)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel(todayHeaderLabel)
            Link(destination: inboxURL) {
                Text("未读 \(countText(entry.snapshot.unreadCount))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(entry.snapshot.unreadCount > 0 ? Cyber.cyan : Cyber.text)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .layoutPriority(1)
            .accessibilityLabel("打开收件箱，未读 \(entry.snapshot.unreadCount) 项")
        }
    }

    private var mediumFooter: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Link(destination: todayURL) {
                Text("待办 \(countText(entry.snapshot.todoCount))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(entry.snapshot.todoCount > 0 ? Cyber.cyan : Cyber.text)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("打开今日，待办 \(entry.snapshot.todoCount) 项")
            Spacer(minLength: 6)
            if !tight {
                updatedLabel
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
    }

    private var smallFooter: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text("待办 \(countText(entry.snapshot.todoCount)) · 未读 \(countText(entry.snapshot.unreadCount))")
                .foregroundStyle(Cyber.text)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .layoutPriority(1)
            Spacer(minLength: 4)
            Text(shortUpdated(now: entry.date))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(Cyber.dim)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .font(.caption2.weight(.semibold))
    }

    private func brand(showsCode: Bool, detail: String?) -> some View {
        HStack(spacing: 5) {
            Text("JIEBO")
                .font(.system(.caption2, design: .monospaced, weight: .bold))
                .foregroundStyle(Cyber.cyan)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
            Circle()
                .fill(Cyber.pip(entry.snapshot.assistantStatus))
                .frame(width: 6, height: 6)
            if showsCode {
                Text("// \(statusCode)")
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(Cyber.dim)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            if entry.snapshot.isStale {
                Text("STALE 已过期")
                    .font(.system(.caption2, design: .monospaced, weight: .bold))
                    .foregroundStyle(Cyber.magenta)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            if let detail {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(Cyber.dim)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
        .accessibilityHidden(true)
    }

    private func summaryText(font: Font, minLines: Int, maxLines: Int) -> some View {
        let upper = max(minLines, maxLines)
        return ZStack(alignment: .topLeading) {
            Text(reservedSummary(lines: minLines))
                .font(font)
                .lineLimit(minLines, reservesSpace: true)
                .opacity(0)
                .accessibilityHidden(true)
            Text(highlightSummary)
                .font(font)
                .foregroundStyle(Cyber.text)
                .lineLimit(minLines...upper)
                .minimumScaleFactor(0.85)
                .redacted(reason: shouldHideSummary ? .placeholder : [])
                .privacySensitive()
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func reservedSummary(lines: Int) -> String {
        Array(repeating: "\u{00A0}", count: max(lines, 1)).joined(separator: "\n")
    }

    private func highlightLink(font: Font, minLines: Int, maxLines: Int, pad: CGFloat, expands: Bool = true) -> some View {
        Link(destination: highlightURL) {
            VStack(alignment: .leading, spacing: 2) {
                Text(highlightMark)
                    .font(.system(.caption2, design: .monospaced, weight: .bold))
                    .foregroundStyle(Cyber.magenta)
                    .lineLimit(1)
                summaryText(font: font, minLines: minLines, maxLines: maxLines)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, pad)
            .frame(maxWidth: .infinity, maxHeight: expands ? .infinity : nil, alignment: .topLeading)
            .background(Cyber.panel)
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(Cyber.line, lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(highlightAccessibility)
    }

    private func countBlock(
        title: String,
        value: Int,
        url: URL,
        label: String,
        fillsHeight: Bool,
        font: Font,
        minHeight: CGFloat
    ) -> some View {
        let blockMaxHeight: CGFloat? = fillsHeight ? .infinity : nil
        return Link(destination: url) {
            Text("\(title) \(countText(value))")
                .font(font)
                .foregroundStyle(value > 0 ? Cyber.cyan : Cyber.text)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(
                    maxWidth: .infinity,
                    minHeight: minHeight,
                    maxHeight: blockMaxHeight,
                    alignment: fillsHeight ? .center : .leading
                )
                .background(Cyber.panel)
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Cyber.line, lineWidth: 1)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var smallHeadline: Font {
        prefersCompactType ? .headline.weight(.semibold) : .title3.weight(.semibold)
    }

    private var mediumHeadline: Font {
        prefersCompactType ? .headline.weight(.semibold) : .title3.weight(.semibold)
    }

    private var largeHeadline: Font {
        prefersCompactType ? .title3.weight(.semibold) : .title2.weight(.semibold)
    }

    private var extraLargeHeadline: Font {
        prefersCompactType ? .title2.weight(.semibold) : .title.weight(.semibold)
    }

    private var countFont: Font {
        prefersCompactType ? .headline.weight(.semibold) : .title3.weight(.semibold)
    }

    private var extraLargeCountFont: Font {
        prefersCompactType ? .title3.weight(.semibold) : .title2.weight(.semibold)
    }

    private var showsSmallStatus: Bool {
        !tight || entry.snapshot.loginState == .loggedOut
    }

    private var displayStatus: String {
        if entry.snapshot.loginState == .loggedOut { return "打开接驳登录" }
        return entry.snapshot.statusText
    }

    private var shouldHideSummary: Bool {
        entry.snapshot.privacyMode || entry.snapshot.isStale
    }

    private var statusCode: String {
        switch entry.snapshot.assistantStatus {
        case .available: return "READY"
        case .working: return "RUN"
        case .syncing: return "SYNC"
        case .needsAttention: return "ATTN"
        case .offline: return "OFF"
        case .loggedOut: return "LOCK"
        }
    }

    private var highlightMark: String {
        entry.snapshot.highlight?.kind == .inbox ? "PING 最近通知" : "NEXT 下一条"
    }

    private var highlightSummary: String {
        guard entry.snapshot.loginState == .loggedIn else { return "登录后查看今日摘要" }
        return entry.snapshot.highlight?.summary ?? "目前没有待处理事项"
    }

    private var highlightURL: URL {
        guard let highlight = entry.snapshot.highlight else {
            return todayURL
        }
        if highlight.kind == .inbox {
            return inboxURL
        }
        var components = URLComponents(string: "jiebo://assistant/todo")!
        components.queryItems = [URLQueryItem(name: "id", value: highlight.id)]
        return components.url ?? todayURL
    }

    private var highlightAccessibility: String {
        shouldHideSummary ? "\(highlightMark)，摘要已隐藏" : "\(highlightMark)，\(highlightSummary)"
    }

    private var todayHeaderLabel: String {
        entry.snapshot.isStale ? "打开今日，已过期，\(displayStatus)" : "打开今日，\(displayStatus)"
    }

    private var smallAccessibilityLabel: String {
        let stale = entry.snapshot.isStale ? "已过期，" : ""
        let summary = shouldHideSummary ? "" : "\(highlightSummary)，"
        return "小驳，\(stale)\(summary)\(displayStatus)，待办 \(entry.snapshot.todoCount) 项，未读 \(entry.snapshot.unreadCount) 项"
    }

    private func countText(_ value: Int) -> String {
        value > 99 ? "99+" : String(value)
    }

    private var updatedLabel: some View {
        Text(shortUpdated(now: entry.date))
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(Cyber.dim)
            .lineLimit(1)
    }

    private func shortUpdated(now: Date) -> String {
        if entry.snapshot.isStale { return "上次更新较早" }
        let elapsed = now.timeIntervalSince(entry.snapshot.updatedAt)
        if elapsed < 60 { return "刚刚" }
        let minutes = Int(elapsed / 60)
        if minutes < 60 { return "\(minutes)分钟前" }
        let hours = Int(elapsed / 3_600)
        if hours < 24 { return "\(hours)小时前" }
        let days = Int(elapsed / 86_400)
        if days < 7 { return "\(days)天前" }
        let calendar = Calendar(identifier: .gregorian)
        let month = calendar.component(.month, from: entry.snapshot.updatedAt)
        let day = calendar.component(.day, from: entry.snapshot.updatedAt)
        return "\(month)月\(day)日"
    }
}

private enum Cyber {
    static let void = Color(red: 0.027, green: 0.031, blue: 0.055)
    static let panel = Color(red: 0.06, green: 0.08, blue: 0.12)
    static let text = Color(red: 0.90, green: 0.97, blue: 0.96)
    static let dim = Color(red: 0.60, green: 0.72, blue: 0.76)
    static let cyan = Color(red: 0.25, green: 0.96, blue: 0.91)
    static let magenta = Color(red: 1.0, green: 0.20, blue: 0.58)
    static let line = Color(red: 0.25, green: 0.96, blue: 0.91).opacity(0.38)

    static func pip(_ status: WidgetSnapshot.AssistantStatus) -> Color {
        switch status {
        case .available: return cyan
        case .working, .syncing: return Color(red: 0.45, green: 0.78, blue: 1)
        case .needsAttention: return magenta
        case .offline, .loggedOut: return dim
        }
    }
}

private struct CyberBackdrop: View {
    var body: some View {
        ZStack {
            Cyber.void
            CyberGrid()
            VStack {
                LinearGradient(colors: [Cyber.cyan, Cyber.magenta], startPoint: .leading, endPoint: .trailing)
                    .frame(height: 2)
                Spacer()
            }
            HudCorners()
        }
    }
}

private struct CyberGrid: View {
    var body: some View {
        Canvas { context, size in
            let step: CGFloat = 16
            var path = Path()
            var x: CGFloat = 0
            while x <= size.width {
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: size.height))
                x += step
            }
            var y: CGFloat = 0
            while y <= size.height {
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: size.width, y: y))
                y += step
            }
            context.stroke(path, with: .color(Cyber.cyan.opacity(0.07)), lineWidth: 0.5)
        }
        .allowsHitTesting(false)
    }
}

private struct HudCorners: View {
    var body: some View {
        GeometryReader { geo in
            let length: CGFloat = 10
            let inset: CGFloat = 8
            Path { path in
                let w = geo.size.width
                let h = geo.size.height
                path.move(to: CGPoint(x: inset, y: inset + length))
                path.addLine(to: CGPoint(x: inset, y: inset))
                path.addLine(to: CGPoint(x: inset + length, y: inset))
                path.move(to: CGPoint(x: w - inset - length, y: inset))
                path.addLine(to: CGPoint(x: w - inset, y: inset))
                path.addLine(to: CGPoint(x: w - inset, y: inset + length))
                path.move(to: CGPoint(x: inset, y: h - inset - length))
                path.addLine(to: CGPoint(x: inset, y: h - inset))
                path.addLine(to: CGPoint(x: inset + length, y: h - inset))
                path.move(to: CGPoint(x: w - inset - length, y: h - inset))
                path.addLine(to: CGPoint(x: w - inset, y: h - inset))
                path.addLine(to: CGPoint(x: w - inset, y: h - inset - length))
            }
            .stroke(Cyber.cyan.opacity(0.7), lineWidth: 1)
        }
        .allowsHitTesting(false)
    }
}

struct JieboAssistantWidget: Widget {
    let kind = "JieboAssistantWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: JieboWidgetProvider()) { entry in
            JieboWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("小驳助理")
        .description("快速查看助理状态、待办与收件箱摘要。")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
    }
}

@main
struct JieboWidgetBundle: WidgetBundle {
    var body: some Widget {
        JieboAssistantWidget()
    }
}
