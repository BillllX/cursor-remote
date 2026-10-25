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
        completion(Timeline(entries: [current], policy: .after(refreshAt)))
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
}

private struct JieboWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let entry: JieboWidgetEntry

    var body: some View {
        Group {
            switch family {
            case .systemMedium:
                medium
            default:
                small
                    .widgetURL(URL(string: "jiebo://assistant/today"))
            }
        }
        .containerBackground(for: .widget) {
            LinearGradient(
                colors: [
                    Color(red: 1.00, green: 0.93, blue: 0.96),
                    Color(red: 0.91, green: 0.88, blue: 1.00),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top) {
                MonsterAssistant(size: 42)
                Spacer(minLength: 4)
                if entry.snapshot.unreadCount > 0 {
                    countPill(entry.snapshot.unreadCount)
                }
            }
            Text(displayStatus)
                .font(.headline)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                Label("\(entry.snapshot.todoCount)", systemImage: "checklist")
                Label("\(entry.snapshot.unreadCount)", systemImage: "tray")
            }
            .font(.caption.weight(.semibold))
            updatedLabel
        }
        .foregroundStyle(.primary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("小驳，\(displayStatus)，待办 \(entry.snapshot.todoCount) 项，未读 \(entry.snapshot.unreadCount) 项")
    }

    private var medium: some View {
        HStack(spacing: dynamicTypeSize.isAccessibilitySize ? 8 : 14) {
            Link(destination: URL(string: "jiebo://assistant/today")!) {
                VStack(alignment: .leading, spacing: dynamicTypeSize.isAccessibilitySize ? 4 : 8) {
                    MonsterAssistant(size: dynamicTypeSize.isAccessibilitySize ? 36 : 48)
                    Text(displayStatus)
                        .font(.headline)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 1 : 2)
                        .minimumScaleFactor(0.75)
                    updatedLabel
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Divider()

            VStack(alignment: .leading, spacing: dynamicTypeSize.isAccessibilitySize ? 5 : 8) {
                HStack {
                    Label("\(entry.snapshot.todoCount) 项待办", systemImage: "checklist")
                    Spacer(minLength: 4)
                    if entry.snapshot.unreadCount > 0 {
                        countPill(entry.snapshot.unreadCount)
                    }
                }
                .font(.caption.weight(.semibold))

                Link(destination: highlightURL) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(highlightTitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(highlightSummary)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 1 : 2)
                            .minimumScaleFactor(0.75)
                            .redacted(reason: shouldHideSummary ? .placeholder : [])
                            .privacySensitive()
                    }
                    .frame(
                        maxWidth: .infinity,
                        minHeight: dynamicTypeSize.isAccessibilitySize ? 34 : 44,
                        alignment: .leading
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Link(destination: URL(string: "jiebo://assistant/inbox")!) {
                    Label("打开收件箱", systemImage: "tray")
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(.primary)
    }

    private var displayStatus: String {
        if entry.snapshot.loginState == .loggedOut { return "打开接驳登录" }
        if entry.snapshot.isStale { return "摘要可能已过期" }
        return entry.snapshot.statusText
    }

    private var shouldHideSummary: Bool {
        entry.snapshot.privacyMode || entry.snapshot.isStale
    }

    private var highlightTitle: String {
        switch entry.snapshot.highlight?.kind {
        case .todo: return "下一项"
        case .inbox: return "最近通知"
        case nil: return "今日"
        }
    }

    private var highlightSummary: String {
        guard entry.snapshot.loginState == .loggedIn else { return "登录后查看今日摘要" }
        return entry.snapshot.highlight?.summary ?? "目前没有待处理事项"
    }

    private var highlightURL: URL {
        guard let highlight = entry.snapshot.highlight else {
            return URL(string: "jiebo://assistant/today")!
        }
        if highlight.kind == .inbox {
            return URL(string: "jiebo://assistant/inbox")!
        }
        var components = URLComponents(string: "jiebo://assistant/todo")!
        components.queryItems = [URLQueryItem(name: "id", value: highlight.id)]
        return components.url ?? URL(string: "jiebo://assistant/today")!
    }

    private var updatedLabel: some View {
        Group {
            if entry.snapshot.isStale {
                Text("上次更新较早")
            } else {
                Text(entry.snapshot.updatedAt, style: .relative)
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    private func countPill(_ count: Int) -> some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.caption2.bold())
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(.pink, in: Capsule())
            .accessibilityLabel("\(count) 项未读")
    }
}

/// 纯 SwiftUI 静态形状，避免 Widget 载入主 App 大图资产，也不产生持续动画。
private struct MonsterAssistant: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.34, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [.pink.opacity(0.95), Color(red: 0.72, green: 0.27, blue: 0.70)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            Circle()
                .fill(.white)
                .frame(width: size * 0.18, height: size * 0.18)
                .offset(x: -size * 0.14, y: -size * 0.07)
            Circle()
                .fill(.white)
                .frame(width: size * 0.18, height: size * 0.18)
                .offset(x: size * 0.14, y: -size * 0.07)
            Capsule()
                .fill(Color.primary.opacity(0.78))
                .frame(width: size * 0.28, height: size * 0.08)
                .offset(y: size * 0.16)
        }
        .frame(width: size, height: size)
        .shadow(color: .pink.opacity(0.22), radius: 4, y: 2)
        .accessibilityHidden(true)
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
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

@main
struct JieboWidgetBundle: WidgetBundle {
    var body: some Widget {
        JieboAssistantWidget()
    }
}
