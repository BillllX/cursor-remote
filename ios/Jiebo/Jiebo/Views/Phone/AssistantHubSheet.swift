import SwiftUI

/// 今日面板：只有「今日」，没有分段控件，没有记忆（规格 §4.1.5）。
/// 挂在 PhoneShell 的 ZStack 里，由 `router.hubOpen` 控制。不用系统 sheet：
/// iOS 26 弹出半屏时会在容器背景上断言崩溃。
/// 打开时 `router.hubAnchor`（"todos" / "schedules"）非空就滚到对应分区。
struct AssistantHubSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Binding private var drag: CGFloat
    private let panelHeight: CGFloat

    init(drag: Binding<CGFloat> = .constant(0), panelHeight: CGFloat = 0) {
        _drag = drag
        self.panelHeight = panelHeight
    }

    var body: some View {
        VStack(spacing: 0) {
            // 抓手和标题行：和系统半屏一样可以往下拉关
            VStack(spacing: 0) {
                Capsule()
                    .fill(JieboColor.line)
                    .frame(width: 36, height: 5)
                    .padding(.top, 8)
                    .accessibilityHidden(true)
                HStack {
                    Text("今日")
                        .font(JieboFont.display(17))
                        .foregroundStyle(JieboColor.ink)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("完成") { router.hubOpen = false }
                        .font(JieboFont.text(.callout, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
            }
            .contentShape(Rectangle())
            .gesture(pullDown)
            ScrollViewReader { proxy in
                ScrollView {
                    // 待批、委派在 iPhone 上不显示：它们在行动区和待处理里
                    AssistantTodayPane(showsApprovals: false, showsDelegations: false)
                        .padding(14)
                        .padding(.bottom, 24)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .refreshable { store.requestAssistant() }
                .onAppear {
                    store.requestAssistant()
                    scrollToAnchor(proxy)
                }
                .onChange(of: router.hubAnchor) { _, _ in scrollToAnchor(proxy) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(JieboColor.paper)
        .phoneNotice()
        .onDisappear { router.hubAnchor = nil }
    }

    /// 往下拉过面板高度的 1/4 或甩下去就关，否则弹回
    private var pullDown: some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .global)
            .onChanged { value in
                drag = max(0, value.translation.height)
            }
            .onEnded { value in
                let threshold = max(100, panelHeight * 0.25)
                if value.translation.height > threshold || value.predictedEndTranslation.height > threshold * 2 {
                    // 从手指位置接着滑出屏幕再收起，不在半空淡出
                    // 多滑出一截：面板底色还铺在 Home 指示条下面
                    withAnimation(JieboMotion.panel(reduceMotion)) {
                        drag = panelHeight + 120
                    } completion: {
                        // 已经滑出屏幕，不再走淡出（透明层会在淡出期间挡住点按）
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) { router.hubOpen = false }
                    }
                } else {
                    withAnimation(JieboMotion.snappy(reduceMotion)) { drag = 0 }
                }
            }
    }

    /// 等分区布局出来再滚，否则 id 还没挂上
    private func scrollToAnchor(_ proxy: ScrollViewProxy) {
        guard let anchor = router.hubAnchor else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            withAnimation(JieboMotion.panel(reduceMotion)) {
                proxy.scrollTo(anchor, anchor: .top)
            }
        }
    }
}
