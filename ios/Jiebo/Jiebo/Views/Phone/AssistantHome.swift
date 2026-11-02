import SwiftUI
import UIKit

/// iPhone 助理页（docs/iphone-assistant-first.md §4.1）：根页，导航栏由 PhoneShell 的 NavigationStack 提供。
/// 整个 iPhone 上只有这里有 ComposerView（它由 ThreadView 内部创建），ActionDock 通过 ThreadView 的 dock 插槽放在输入框正上方。
struct AssistantHome: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router

    var body: some View {
        VStack(spacing: 0) {
            if router.selectedTab == .workspace {
                Color.clear
            } else if store.assistantChatId == nil, router.bootstrapped {
                unsupportedCard
            } else {
                if let attentionLine {
                    Group {
                        if !store.connected {
                            Button {
                                store.retryConnection()
                            } label: {
                                Text(attentionLine)
                            }
                            .buttonStyle(.plain)
                            .disabled(store.linkState != .offline)
                            .accessibilityHint(store.linkState == .offline ? "重新连接" : "")
                        } else if store.isThreadSyncBusy(store.activeId) {
                            Button {
                                store.retryThreadSync(store.activeId)
                            } label: {
                                Text(attentionLine)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("再拉一次这条会话")
                        } else if store.backgroundAttentionTitle == attentionLine {
                            Button {
                                store.requestAssistant(force: true)
                            } label: {
                                Text(attentionLine)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("再向服务器确认后台模型")
                        } else if attentionLine == ChatStore.failedRetryTitle, let chatId = store.assistantChatId {
                            Button {
                                store.restoreFailedPromptIfDraftEmpty(chatId: chatId)
                            } label: {
                                Text(attentionLine)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("上一句回到输入框")
                        } else {
                            Text(attentionLine)
                        }
                    }
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(store.connected ? JieboColor.ink2 : JieboColor.danger)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .accessibilityAddTraits(.updatesFrequently)
                }
                destinationStrip
                TodayStrip()
                ThreadView(chrome: .embedded, dock: AnyView(ActionDock()))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(JieboColor.paper.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                menuButton
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .principal) {
                titleView
            }
            ToolbarItem(placement: .topBarTrailing) {
                todayButton
            }
            .sharedBackgroundVisibility(.hidden)
        }
    }

    /// 连接、同步或需要人处理时才出字。平常只留圆点，避免每句都占一行。
    private var attentionLine: String? {
        if !store.connected { return store.linkState.title }
        if store.isThreadSyncBusy(store.activeId) { return ChatStore.syncingThreadTitle }
        if !store.hasApiKey { return ChatStore.missingApiKeyTitle }
        if let hint = store.approvalHint(for: store.assistantChatId ?? "", surface: .phoneAssistant) {
            return hint.title
        }
        if let title = store.backgroundAttentionTitle {
            return title
        }
        switch store.assistantAvatarPhase {
        case .failure: return ChatStore.failedRetryTitle
        default: break
        }
        return nil
    }

    private var destinationStrip: some View {
        DestinationWrap(spacing: 8) {
            destination("sun.max", "今日") { router.openHub() }
            destination("checkmark.circle", "待办") { router.go(.worklist(.todo)) }
            destination("calendar", "计划") { router.go(.worklist(.plan)) }
            destination("person.2.wave.2", "委派") { router.go(.worklist(.delegation)) }
            destination("square.stack.3d.up", "产物") { router.go(.artifacts) }
            destination(NavigationIconId.memory.symbol, "记忆") { router.go(.memory) }
            destination(NavigationIconId.account.symbol, "设置") { router.go(.settings) }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .accessibilityLabel("小驳栏目")
    }

    private func destination(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(JieboFont.text(.subheadline, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .padding(.horizontal, 10)
                .frame(minHeight: 44)
                .background(JieboColor.white)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(JieboColor.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityHint("打开\(title)")
    }

    // MARK: 导航栏

    private var menuButton: some View {
        let badge = store.assistantBadgeCount
        return Button {
            router.openMenu()
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        PendingBadge(count: badge)
                            .offset(x: 10, y: -8)
                    }
                }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(
            badge > 0
                ? "菜单，\(StatusLegendId.attention.accessibilityLabel(count: badge))"
                : "菜单"
        )
    }

    private var titleView: some View {
        AssistantAvatarView(phase: store.assistantAvatarPhase, size: 56)
            .overlay(alignment: .bottomTrailing) {
                LinkStatusDot(state: store.linkState, syncing: store.isThreadSyncBusy(store.activeId))
                    .offset(x: 1, y: 7)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(titleAccessibility)
    }

    private var titleAccessibility: String {
        var parts = [store.assistantName, store.assistantAvatarPhase.accessibilityLabel]
        if let subtitleText { parts.append(subtitleText) }
        return parts.joined(separator: "，")
    }

    /// 连接状态由圆点表达；文字与形象使用同一客户端状态映射。
    private var subtitleText: String? {
        if store.connected {
            if !store.hasApiKey { return ChatStore.missingApiKeyTitle }
            if let hint = store.approvalHint(for: store.assistantChatId ?? "", surface: .phoneAssistant) {
                return hint.title
            }
            switch store.assistantAvatarPhase {
            case .approval: break
            case .executing: return "正在执行"
            case .thinking: return "正在思考"
            case .listening: return "正在接收输入"
            case .failure: return store.backgroundAttentionReason ?? "执行没有完成"
            case .idle, .success, .offline: break
            }
            if let reason = store.backgroundAttentionReason { return reason }
        }
        return store.linkState.title
    }

    private var todayButton: some View {
        Button {
            JieboHaptic.selection()
            router.openHub()
        } label: {
            Image(systemName: NavigationIconId.assistant.symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(router.hubOpen ? JieboColor.pine : JieboColor.ink)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("今日")
        .accessibilityAddTraits(router.hubOpen ? .isSelected : [])
    }

    // MARK: 降级（§4.1.6）

    /// 还没连上时不要写成服务器没有助理功能。连上且网关也没给出主会话，才是升级。
    private var unsupportedTitle: String {
        if !store.connected { return store.linkState.title }
        if !store.gatewayReady { return "正在打开小驳主会话…" }
        return "这个服务器还没有助理功能，请先升级服务器"
    }

    private var unsupportedCard: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 40)
            JieboMark(size: 36)
            Text(unsupportedTitle)
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                if store.linkState == .offline {
                    ActionButton(title: "重连", kind: .primary) { store.retryConnection() }
                } else if store.connected, store.gatewayReady {
                    ActionButton(title: "再试一次", kind: .primary) { store.requestAssistant(force: true) }
                }
                ActionButton(title: "设置") { router.go(.settings) }
            }
            .padding(.top, 4)
            Spacer(minLength: 40)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// 栏目胶囊按可用宽度换行，窄屏不用横滑才能看见后面的「设置」。
private struct DestinationWrap: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let limit = proposal.width ?? .greatestFiniteMagnitude
        let rows = rows(limit: limit, subviews: subviews)
        let height = rows.reduce(CGFloat(0)) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        let width = proposal.width ?? (rows.map(\.width).max() ?? 0)
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
    }

    private func rows(limit: CGFloat, subviews: Subviews) -> [(width: CGFloat, height: CGFloat)] {
        var rows: [(width: CGFloat, height: CGFloat)] = []
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            let next = rowWidth == 0 ? size.width : rowWidth + spacing + size.width
            if rowWidth > 0, next > limit {
                rows.append((rowWidth, rowHeight))
                rowWidth = size.width
                rowHeight = size.height
            } else {
                rowWidth = next
                rowHeight = max(rowHeight, size.height)
            }
        }
        if rowWidth > 0 || rows.isEmpty {
            rows.append((rowWidth, rowHeight))
        }
        return rows
    }
}
