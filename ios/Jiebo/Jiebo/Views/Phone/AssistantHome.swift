import SwiftUI
import UIKit

/// iPhone 助理页（docs/iphone-assistant-first.md §4.1）：根页，导航栏由 PhoneShell 的 NavigationStack 提供。
/// 整个 iPhone 上只有这里有 ComposerView（它由 ThreadView 内部创建），ActionDock 通过 ThreadView 的 dock 插槽放在输入框正上方。
struct AssistantHome: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(PhoneRouter.self) private var router

    var body: some View {
        VStack(spacing: 0) {
            if router.selectedTab != .assistant {
                // 工作台和即时消息各自有对话。这里再留一块会跟着 activeId 把那边的输入租约占住或清掉。
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
            ToolbarItem(placement: .principal) {
                titleView
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                todayButton
                inboxButton
            }
        }
        .modifier(AssistantToolbarMinimize())
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

    // MARK: 导航栏

    private var menuButton: some View {
        let badge = store.workspaceUnreadCount + im.totalUnread
        return Button {
            router.openMenu()
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(JieboFont.text(.body, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        PendingBadge(count: badge)
                            .offset(x: 8, y: -6)
                    }
                }
        }
        .accessibilityLabel(
            badge > 0
                ? "菜单，\(StatusLegendId.attention.accessibilityLabel(count: badge))"
                : "菜单"
        )
    }

    private var titleView: some View {
        AssistantAvatarView(phase: store.assistantAvatarPhase, size: 32)
            .overlay(alignment: .bottomTrailing) {
                LinkStatusDot(state: store.linkState, syncing: store.isThreadSyncBusy(store.activeId))
                    .offset(x: 1, y: 2)
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

    private var inboxButton: some View {
        let badge = store.assistantBadgeCount
        return Button {
            router.go(.inbox)
        } label: {
            Image(systemName: "tray")
                .font(JieboFont.text(.body, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        PendingBadge(count: badge)
                            .offset(x: 10, y: -8)
                    }
                }
        }
        .accessibilityLabel(badge > 0 ? "待处理，\(badge)" : "待处理")
    }

    private var todayButton: some View {
        Button {
            JieboHaptic.selection()
            router.openHub()
        } label: {
            Image(systemName: NavigationIconId.assistant.symbol)
                .font(JieboFont.text(.body, weight: .semibold))
                .foregroundStyle(router.hubOpen ? JieboColor.pine : JieboColor.ink)
        }
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

/// iOS 27 可以在向下滚动时收起导航栏。冷启动时会话还是空的，这块玻璃会被铺成
/// 左上角一块灰矩形，盖住半屏；iPad 没有这层行为，也没有灰块。先保持栏不收起。
private struct AssistantToolbarMinimize: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 27, *) {
            content.toolbarMinimizationBehavior(.never, for: .navigationBar)
        } else {
            content
        }
    }
}
