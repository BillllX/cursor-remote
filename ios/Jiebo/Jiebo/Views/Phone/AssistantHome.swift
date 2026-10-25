import SwiftUI
import UIKit

/// iPhone 助理页（docs/iphone-assistant-first.md §4.1）：根页，导航栏由 PhoneShell 的 NavigationStack 提供。
/// 整个 iPhone 上只有这里有 ComposerView（它由 ThreadView 内部创建），ActionDock 通过 ThreadView 的 dock 插槽放在输入框正上方。
struct AssistantHome: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router

    var body: some View {
        VStack(spacing: 0) {
            if store.assistantChatId == nil, router.bootstrapped {
                unsupportedCard
            } else {
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
                LinkStatusDot(state: store.linkState, syncing: store.threadSyncBusy)
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
            if !store.hasApiKey { return "服务器还没配 API Key" }
            switch store.assistantAvatarPhase {
            case .approval: return "等待你的确认"
            case .executing: return "正在执行"
            case .thinking: return "正在思考"
            case .listening: return "正在接收输入"
            case .failure: return "执行没有完成"
            case .idle, .success, .offline: break
            }
            if let background = store.assistantState?.background, !background.ok {
                return background.reason?.nilIfEmpty ?? "后台模型未就绪"
            }
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

    private var unsupportedCard: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 40)
            JieboMark(size: 36)
            Text("这个服务器还没有助理功能，请先升级服务器")
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                ActionButton(title: "重试", kind: .primary) { store.requestAssistant() }
                ActionButton(title: "设置") { router.go(.settings) }
            }
            .padding(.top, 4)
            Spacer(minLength: 40)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
