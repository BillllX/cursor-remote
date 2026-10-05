import SwiftUI
import UIKit

// 从 AssistantView 抽出的共享组件。iPad 助理面板和 iPhone 的行动区 / 待处理 / 今日面板共用。

struct AssistantSection<Content: View>: View {
    var title: String
    var content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(JieboFont.text(.caption, weight: .semibold))
                .tracking(0.4)
                .foregroundStyle(JieboColor.dim)
            content
        }
    }
}

/// 与侧栏会话行的「跑」标同一形状：小号字、浅底胶囊
struct StatusTag: View {
    var text: String
    var fg: Color
    var bg: Color

    var body: some View {
        Text(text)
            .font(JieboFont.text(.caption2, weight: .medium))
            .foregroundStyle(fg)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(bg)
            .clipShape(Capsule())
    }
}

/// 按钮沿用现有两套：主/次与输入框待批条的「允许 / 拒绝」一致，描边与工具层顶栏的「保留 / 还原」一致
struct ActionButton: View {
    enum Kind { case primary, secondary, outline, destructive }

    var title: String
    var kind: Kind
    /// 竖排时撑满整行
    var fullWidth = false
    var action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    init(title: String, kind: Kind = .outline, fullWidth: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.kind = kind
        self.fullWidth = fullWidth
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            // 视觉至少 32 高（随字号长高），命中区 44：底色画在内缩 6pt 的圆角矩形上
            Text(title)
                .font(JieboFont.text(.footnote, weight: kind == .primary ? .semibold : .medium))
                .foregroundStyle(foreground)
                .lineLimit(1)
                // 不折行：横排放不下时让 ViewThatFits 换成竖排
                .fixedSize(horizontal: !fullWidth, vertical: false)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .frame(minWidth: 44, maxWidth: fullWidth ? .infinity : nil, minHeight: 32)
                .background {
                    RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                        .fill(background)
                }
                .overlay {
                    if kind == .outline || kind == .destructive {
                        RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    }
                }
                .padding(.vertical, 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : 0.45)
    }

    private var foreground: Color {
        switch kind {
        case .primary: return JieboColor.fillFg
        case .secondary: return JieboColor.ink
        case .outline: return JieboColor.ink
        case .destructive: return JieboColor.danger
        }
    }

    private var background: Color {
        switch kind {
        case .primary: return JieboColor.pine
        case .secondary: return JieboColor.mist
        case .outline, .destructive: return Color.clear
        }
    }
}

extension View {
    func assistantCard(highlight: Bool = false) -> some View {
        padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(highlight ? JieboColor.userBubble : JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
    }
}

/// 面板里的灰色说明文字
struct AssistantMutedText: View {
    var text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(JieboFont.text(.footnote))
            .foregroundStyle(JieboColor.dim)
    }
}

// MARK: 时间 / 文案工具

/// 绝对时间（毫秒时间戳），与原 AssistantView 的写法一致
func assistantFormatMillis(_ millis: Double) -> String {
    guard millis > 0 else { return "" }
    return Date(timeIntervalSince1970: millis / 1000).formatted(date: .abbreviated, time: .shortened)
}

/// 相对时间（毫秒时间戳），例如「3分钟前」
func assistantRelativeTime(_ millis: Double) -> String {
    guard millis > 0 else { return "" }
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.unitsStyle = .short
    return formatter.localizedString(for: Date(timeIntervalSince1970: millis / 1000), relativeTo: Date())
}

/// 从 startMillis 到 now 过了几分钟（不为负）
func assistantElapsedMinutes(from startMillis: Double, to now: Date) -> Int {
    guard startMillis > 0 else { return 0 }
    let seconds = now.timeIntervalSince1970 - startMillis / 1000
    return max(0, Int(seconds / 60))
}

extension ChatStore {
    /// 日程开关：发 schedule_set（网关对已有 id 做部分更新，cron/prompt 沿用原值），并先本地翻转，避免开关弹回
    func assistantSetScheduleEnabled(_ id: String, enabled: Bool) {
        assistantOp("schedule_set", args: ["id": .string(id), "enabled": .bool(enabled)])
        if let index = assistantState?.schedules.firstIndex(where: { $0.id == id }) {
            assistantState?.schedules[index].enabled = enabled
        }
    }
}

// MARK: 待办日期

/// due 两种写法：YYYY-MM-DD（全天）或带时区的 ISO 时间（到点提醒）
enum TodoDue {
    struct Parsed {
        var date: Date
        var timed: Bool
    }

    static func parse(_ due: String?) -> Parsed? {
        guard let due = due?.trimmingCharacters(in: .whitespaces), !due.isEmpty else { return nil }
        if due.contains("T") {
            let iso = ISO8601DateFormatter()
            if let date = iso.date(from: due) { return Parsed(date: date, timed: true) }
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return iso.date(from: due).map { Parsed(date: $0, timed: true) }
        }
        return dayFormatter.date(from: String(due.prefix(10))).map { Parsed(date: $0, timed: false) }
    }

    /// 「今天 15:00」「明天」「周三」「10月12日」；认不出就原样显示
    static func label(_ due: String?) -> String? {
        guard let due = due?.nilIfEmpty else { return nil }
        guard let parsed = parse(due) else { return due }
        let calendar = Calendar.current
        let day = calendar.startOfDay(for: parsed.date)
        let today = calendar.startOfDay(for: Date())
        let offset = calendar.dateComponents([.day], from: today, to: day).day ?? 0
        var text: String
        switch offset {
        case 0: text = "今天"
        case 1: text = "明天"
        case 2: text = "后天"
        case 3 ... 6: text = zhFormat("EEE", parsed.date)
        default:
            let sameYear = calendar.component(.year, from: day) == calendar.component(.year, from: today)
            text = zhFormat(sameYear ? "M月d日" : "yyyy年M月d日", parsed.date)
        }
        if parsed.timed { text += " " + zhFormat("HH:mm", parsed.date) }
        return text
    }

    private static func zhFormat(_ pattern: String, _ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = .current
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }

    static func overdue(_ due: String?) -> Bool {
        guard let parsed = parse(due) else { return false }
        if parsed.timed { return parsed.date < Date() }
        return Calendar.current.startOfDay(for: parsed.date) < Calendar.current.startOfDay(for: Date())
    }

    /// 网关要求带时间的必须带时区，按本机时区写
    static func encode(_ date: Date, timed: Bool) -> String {
        guard timed else { return dayFormatter.string(from: date) }
        let iso = ISO8601DateFormatter()
        iso.timeZone = .current
        return iso.string(from: date)
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

// MARK: 改待办

/// 今日列表点一条、对话回执点「改」都弹这个。助理记下时的原话放在下面，方便判断记得对不对
struct TodoEditSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var todo: AssistantTodo
    @State private var text: String
    @State private var hasDate: Bool
    @State private var timed: Bool
    @State private var date: Date

    init(todo: AssistantTodo) {
        self.todo = todo
        let parsed = TodoDue.parse(todo.due)
        _text = State(initialValue: todo.text)
        _hasDate = State(initialValue: parsed != nil)
        _timed = State(initialValue: parsed?.timed ?? false)
        _date = State(initialValue: parsed?.date ?? Self.nextHour())
    }

    private static func nextHour() -> Date {
        let calendar = Calendar.current
        let now = Date()
        let hour = calendar.dateInterval(of: .hour, for: now)?.start ?? now
        return calendar.date(byAdding: .hour, value: 1, to: hour) ?? now
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var newDue: String { hasDate ? TodoDue.encode(date, timed: timed) : "" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("待办内容", text: $text, axis: .vertical)
                        .font(JieboFont.text(.body))
                        .listRowBackground(JieboColor.white)
                }
                Section {
                    Toggle("日期", isOn: $hasDate.animation())
                        .tint(JieboColor.pine)
                        .listRowBackground(JieboColor.white)
                    if hasDate {
                        DatePicker("哪天", selection: $date, displayedComponents: .date)
                            .listRowBackground(JieboColor.white)
                        Toggle("具体时间", isOn: $timed.animation())
                            .tint(JieboColor.pine)
                            .listRowBackground(JieboColor.white)
                        if timed {
                            DatePicker("几点", selection: $date, displayedComponents: .hourAndMinute)
                                .listRowBackground(JieboColor.white)
                        }
                    }
                } footer: {
                    if hasDate {
                        Text(timed ? "到点会提醒；订阅了苹果日历的话，日历里也会出现。" : "订阅了苹果日历的话，会作为全天事件出现。")
                    }
                }
                if let quote = todo.quote {
                    Section("记下时的原话") {
                        Text(quote)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                            .textSelection(.enabled)
                            .listRowBackground(JieboColor.white)
                    }
                }
                Section {
                    Button("删除这条", role: .destructive) {
                        store.assistantOp("todo_remove", args: ["id": .string(todo.id)])
                        dismiss()
                    }
                    .listRowBackground(JieboColor.white)
                }
            }
            .scrollContentBackground(.hidden)
            .background(JieboColor.paper)
            .navigationTitle("改待办")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存", action: save)
                        .disabled(trimmed.isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() {
        var args: [String: JSONValue] = ["id": .string(todo.id)]
        if trimmed != todo.text { args["text"] = .string(trimmed) }
        if newDue != (todo.due ?? "") { args["due"] = .string(newDue) }
        if args.count > 1 { store.assistantOp("todo_update", args: args) }
        dismiss()
    }
}

// MARK: 苹果日历订阅

/// 订阅引导只出一次：点过「以后再说」或订阅过，回执和今日页都不再提
enum CalendarInvite {
    static let dismissedKey = "jiebo.calendarInviteDismissed"
    /// 记下用户对哪一次「好久没同步」说了不用；日历再来拉过、又断了才再提
    static let staleDismissedKey = "jiebo.calendarStaleDismissed"

    /// 开着、还没被日历拉过、用户也没说不要
    static func pending(_ calendar: AssistantCalendar?, dismissed: Bool) -> Bool {
        guard let calendar, calendar.enabled else { return false }
        return !calendar.subscribed && !dismissed
    }

    static func staleNotice(_ calendar: AssistantCalendar?, dismissedAt: Double) -> Bool {
        guard let calendar, calendar.enabled, calendar.stale else { return false }
        return calendar.lastFetchAt != dismissedAt
    }
}

/// 今日页顶部和对话回执下面的「同步到苹果日历？」。stale=true 时改成「好几天没同步了」
struct CalendarInviteCard: View {
    @Environment(\.openURL) private var openURL
    @AppStorage(CalendarInvite.dismissedKey) private var dismissed = false
    @AppStorage(CalendarInvite.staleDismissedKey) private var staleDismissedAt: Double = 0
    var calendar: AssistantCalendar
    var stale = false
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "calendar.badge.plus")
                    .font(JieboFont.text(.subheadline, weight: .medium))
                    .foregroundStyle(JieboColor.pine)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(stale ? "苹果日历好几天没来同步了" : "同步到苹果日历？")
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                    if !compact {
                        Text(stale ? "可能在日历里取消了订阅，重新添加一下就好。" : "带日期的待办会自动出现在日历里。日历里只读，要改还是在这儿改。")
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            HStack(spacing: 8) {
                ActionButton(title: stale ? "重新添加" : "添加到日历", kind: .primary) {
                    if let url = calendar.webcalURL { openURL(url) }
                }
                ActionButton(title: stale ? "不用了" : "以后再说", kind: .secondary) {
                    if stale { staleDismissedAt = calendar.lastFetchAt ?? 0 } else { dismissed = true }
                }
            }
        }
        .assistantCard(highlight: true)
    }
}

// MARK: 待批确认卡

/// 待批卡。行动区、待处理页、iPad 助理面板共用。按 approval.tool 区分文案：
/// create_workspace →「新建工作区」+ 名字与原因（拒绝 / 同意）；workspace_memory / work_preferences →「记进…」+ 目标与条目（拒绝 / 记下）；
/// shell →「想跑命令」；其它 →「想改文件」（拒绝 / 批准）。
struct ApprovalCard: View {
    enum Style {
        /// iPhone 行动区 / 待处理：warnBg 底 + warnFg 标题
        case warning
        /// iPad 助理面板：沿用原来的白底卡片
        case plain
    }

    @Environment(ChatStore.self) private var store
    let approval: AssistantApproval
    let style: Style
    /// 非 nil 且是委派审批时，左侧多一个「看委派」
    let onOpenDelegation: (() -> Void)?

    init(approval: AssistantApproval, style: Style = .warning, onOpenDelegation: (() -> Void)? = nil) {
        self.approval = approval
        self.style = style
        self.onOpenDelegation = onOpenDelegation
    }

    private var isCreateWorkspace: Bool { approval.tool == "create_workspace" }

    /// 工作区记忆提议 / 记忆升级整理出的工作偏好：summary 也是「目标 · 内容」
    private var isMemoryCard: Bool { approval.tool == "workspace_memory" || approval.tool == "work_preferences" }

    private var isShell: Bool {
        !isCreateWorkspace && !isMemoryCard && ToolKind.from(name: approval.tool, args: nil) == .shell
    }

    private var titleText: String {
        if isCreateWorkspace { return "新建工作区" }
        if approval.tool == "workspace_memory" { return "记进工作区记忆" }
        if approval.tool == "work_preferences" { return "记进工作偏好" }
        let owner = store.approvalDelegationTitle(approval)
        return isShell ? "\(owner) 想跑命令" : "\(owner) 想改文件"
    }

    private var allowTitle: String {
        if isCreateWorkspace { return "同意" }
        return isMemoryCard ? "记下" : "批准"
    }

    /// summary 的格式是「名字 · 原因」
    private var workspaceParts: (name: String, reason: String) {
        let text = approval.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = text.range(of: " · ") {
            let name = String(text[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            let reason = String(text[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            return (name, reason)
        }
        return (text, "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(titleText)
                .font(JieboFont.text(.subheadline, weight: .semibold))
                .foregroundStyle(style == .warning ? JieboColor.warnFg : JieboColor.ink)
                .fixedSize(horizontal: false, vertical: true)
            detail
            expiryLine
            buttons
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(style == .warning ? JieboColor.warnBg : JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                .stroke(style == .warning ? JieboColor.warnFg.opacity(0.22) : JieboColor.line, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var detail: some View {
        if isCreateWorkspace || isMemoryCard {
            let parts = workspaceParts
            VStack(alignment: .leading, spacing: 2) {
                if !parts.name.isEmpty {
                    Text(parts.name)
                        .font(JieboFont.monoText(.footnote))
                        .fontWeight(.semibold)
                        .foregroundStyle(JieboColor.ink)
                        .textSelection(.enabled)
                }
                if !parts.reason.isEmpty {
                    Text(parts.reason)
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.ink2)
                        .lineLimit(isMemoryCard && style == .warning ? 6 : nil)
                }
            }
        } else if !approval.summary.isEmpty {
            Text(approval.summary)
                .font(JieboFont.monoText(.caption))
                .foregroundStyle(JieboColor.ink2)
                .lineLimit(style == .warning ? 3 : 6)
        }
    }

    /// 「N 分钟后失效」，每分钟刷新一次（TimelineView，不自己开 Timer）
    @ViewBuilder
    private var expiryLine: some View {
        if approval.expiresAt > 0 {
            let expiresAt = approval.expiresAt
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(Self.expiryText(expiresAt: expiresAt, now: context.date))
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
            }
        }
    }

    private static func expiryText(expiresAt: Double, now: Date) -> String {
        let remaining = expiresAt / 1000 - now.timeIntervalSince1970
        if remaining <= 0 { return "即将失效" }
        let minutes = Int((remaining / 60).rounded(.up))
        if minutes <= 1 { return "不到 1 分钟后失效" }
        if minutes >= 48 * 60 { return "\(minutes / (24 * 60)) 天后失效" }
        if minutes >= 120 { return "\(minutes / 60) 小时后失效" }
        return "\(minutes) 分钟后失效"
    }

    /// 一行放不下（大字号、窄屏）就竖排，主操作在最上面
    private var buttons: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                if let onOpenDelegation, approval.delegationId != nil {
                    ActionButton(title: "看委派", kind: .outline, action: onOpenDelegation)
                }
                Spacer(minLength: 0)
                ActionButton(title: "拒绝", kind: .secondary) { answer(false) }
                ActionButton(title: allowTitle, kind: .primary) { answer(true) }
            }
            VStack(spacing: 0) {
                ActionButton(title: allowTitle, kind: .primary, fullWidth: true) { answer(true) }
                ActionButton(title: "拒绝", kind: .secondary, fullWidth: true) { answer(false) }
                if let onOpenDelegation, approval.delegationId != nil {
                    ActionButton(title: "看委派", kind: .outline, fullWidth: true, action: onOpenDelegation)
                }
            }
        }
    }

    private func answer(_ allow: Bool) {
        UINotificationFeedbackGenerator().notificationOccurred(allow ? .success : .warning)
        store.answerAssistantApproval(approval, allow: allow)
    }
}

// MARK: 提示条（push 页 / sheet 用）

/// `store.notice` / `store.bannerError` 的横幅画在 ThreadView（助理根页）里；push 页和 sheet 盖住了根页，
/// 用户看不到「这个会话在电脑或 iPad 上查看」「停止失败的原因」「已发送测试通知」之类的提示。
/// 在这些页面上自己画一条。根页不要加（ThreadView 已经画了，会重复）。
struct PhoneNoticeOverlay: ViewModifier {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var text: String {
        if !store.bannerError.isEmpty { return friendlyError(store.bannerError) }
        return store.notice
    }

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if !text.isEmpty {
                    Text(text)
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(store.bannerError.isEmpty ? JieboColor.ink : JieboColor.danger)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(JieboColor.white)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(JieboColor.line, lineWidth: 1)
                        )
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .allowsHitTesting(false)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .animation(JieboMotion.fade(reduceMotion), value: text)
    }
}

extension View {
    func phoneNotice() -> some View {
        modifier(PhoneNoticeOverlay())
    }
}
