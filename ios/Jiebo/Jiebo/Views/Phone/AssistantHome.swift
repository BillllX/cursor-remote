import SwiftUI
import UIKit

/// iPhone 助理页（docs/iphone-assistant-first.md §4.1）：根页，导航栏由 PhoneShell 的 NavigationStack 提供。
/// 整个 iPhone 上只有这里有 ComposerView（它由 ThreadView 内部创建），ActionDock 通过 ThreadView 的 dock 插槽放在输入框正上方。
struct AssistantHome: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase

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
            ToolbarItem(placement: .principal) {
                titleView
            }
            ToolbarItem(placement: .topBarTrailing) {
                todayButton
            }
        }
        .task { store.requestAssistant() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.requestAssistant() }
        }
        .onChange(of: store.connected) { _, connected in
            if connected { store.requestAssistant() }
        }
    }

    // MARK: 导航栏

    private var menuButton: some View {
        let badge = store.assistantBadgeCount
        return Button {
            router.openMenu()
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .frame(width: 36, height: 36)
                .background(JieboColor.mist)
                .clipShape(Circle())
                .hitTarget()
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        PendingBadge(count: badge)
                    }
                }
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(
            badge > 0
                ? "菜单，\(StatusLegendId.attention.accessibilityLabel(count: badge))"
                : "菜单"
        )
    }

    private var titleView: some View {
        VStack(spacing: 1) {
            Text(store.assistantName)
                .font(JieboFont.display(17))
                .tracking(0.34)
                .foregroundStyle(JieboColor.ink)
                .lineLimit(1)
            HStack(spacing: 5) {
                LinkStatusDot(state: store.linkState, syncing: store.threadSyncBusy)
                if let subtitleText {
                    Text(subtitleText)
                        .font(JieboFont.text(.caption2, weight: .medium))
                        .tracking(0.3)
                        .foregroundStyle(store.hasApiKey ? JieboColor.dim : JieboColor.danger)
                        .lineLimit(1)
                }
            }
            .frame(minHeight: 12)
        }
        .accessibilityElement(children: .combine)
    }

    /// 连接状态由圆点表达；只有连上之后还有话要说才出字。优先级：没配 API Key > 助理在跑 > 后台状态
    private var subtitleText: String? {
        if store.connected {
            if !store.hasApiKey { return "服务器还没配 API Key" }
            if store.assistantRunning { return "正在回复" }
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
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(router.hubOpen ? JieboColor.pine : JieboColor.ink)
                .frame(width: 36, height: 36)
                .background(router.hubOpen ? JieboColor.pine.opacity(0.12) : JieboColor.mist)
                .clipShape(Circle())
                .hitTarget()
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
