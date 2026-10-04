import SwiftUI
import UIKit

/// iPhone 助理页（docs/iphone-assistant-first.md §4.1）：根页，导航栏由 PhoneShell 的 NavigationStack 提供。
/// 整个 iPhone 上只有这里有 ComposerView（它由 ThreadView 内部创建），ActionDock 通过 ThreadView 的 dock 插槽放在输入框正上方。
struct AssistantHome: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// 页面宽度。小屏或大字号时，撤销按钮收进 ⋯ 菜单，不挤掉「今日」
    @State private var viewWidth: CGFloat = 0

    private var crowdedToolbar: Bool {
        dynamicTypeSize >= .xLarge || (viewWidth > 0 && viewWidth < 380)
    }

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
        .background {
            GeometryReader { geo in
                Color.clear
                    .onAppear { viewWidth = geo.size.width }
                    .onChange(of: geo.size.width) { _, width in viewWidth = width }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                menuButton
            }
            ToolbarItem(placement: .principal) {
                titleView
            }
            ToolbarItem(placement: .topBarTrailing) {
                trailingItems
            }
        }
        .task { store.requestAssistant() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.requestAssistant() }
        }
        .onChange(of: store.connected) { _, connected in
            if connected { store.requestAssistant() }
        }
        .onChange(of: router.focusActionDock) { _, on in
            // 行动区贴在输入框上方，一直在屏幕上；这里只消费标记并给一个触觉反馈
            guard on else { return }
            router.focusActionDock = false
            UISelectionFeedbackGenerator().selectionChanged()
        }
    }

    // MARK: 导航栏

    private var menuButton: some View {
        let badge = store.assistantBadgeCount
        return Button {
            router.openMenu()
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .frame(width: 32, height: 32)
                .hitTarget()
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        PendingBadge(count: badge)
                    }
                }
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(badge > 0 ? "菜单，\(badge) 项待处理" : "菜单")
    }

    private var titleView: some View {
        VStack(spacing: 1) {
            Text(store.assistantName)
                .font(JieboFont.display(17))
                .tracking(0.34)
                .foregroundStyle(JieboColor.ink)
                .lineLimit(1)
            Text(subtitleText)
                .font(JieboFont.ui(11, weight: .medium))
                .tracking(0.3)
                .foregroundStyle(subtitleColor)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    /// 优先级：未连接 > 没配 API Key > 助理在跑 > 后台状态
    private var subtitleText: String {
        if !store.connected { return "正在重连…" }
        if !store.hasApiKey { return "服务器还没配 API Key" }
        if store.assistantRunning { return "正在回复" }
        if let background = store.assistantState?.background, !background.ok {
            return background.reason?.nilIfEmpty ?? "后台模型未就绪"
        }
        return "就绪"
    }

    private var subtitleColor: Color {
        if store.connected, !store.hasApiKey { return JieboColor.danger }
        return JieboColor.dim
    }

    private var todayButton: some View {
        AssistantTodayButton(
            on: router.hubOpen,
            // 待处理的提示只在 ☰ 上；今日面板里没有待批 / 收件箱，这里再挂点会指向一个看不到东西的地方
            marked: false
        ) {
            router.openHub()
        }
    }

    @ViewBuilder
    private var trailingItems: some View {
        HStack(spacing: 4) {
            if store.canUndo {
                if crowdedToolbar {
                    Menu {
                        Button {
                            store.undoLast()
                        } label: {
                            Label("还原上一轮的改动", systemImage: "arrow.uturn.backward")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                            .frame(width: 32, height: 32)
                            .background(JieboColor.mist)
                            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                            .hitTarget()
                    }
                    .accessibilityLabel("更多")
                } else {
                    Button {
                        store.undoLast()
                    } label: {
                        Image(systemName: "arrow.uturn.backward")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                            .frame(width: 32, height: 32)
                            .background(JieboColor.mist)
                            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                            .hitTarget()
                    }
                    .buttonStyle(PressScaleButtonStyle())
                    .accessibilityLabel("还原上一轮的改动")
                }
            }
            todayButton
        }
    }

    // MARK: 降级（§4.1.6）

    private var unsupportedCard: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 40)
            JieboMark(size: 36)
            Text("这个服务器还没有助理功能，请先升级服务器")
                .font(JieboFont.ui(15))
                .foregroundStyle(JieboColor.ink)
                .multilineTextAlignment(.center)
            Spacer(minLength: 40)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
