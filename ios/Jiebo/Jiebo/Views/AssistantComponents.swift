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
