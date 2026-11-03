import SwiftUI

/// 今日面板：只有「今日」，没有分段控件，没有记忆（规格 §4.1.5）。
/// 挂在 PhoneShell 的 ZStack 里，由 `router.hubOpen` 控制。不用系统 sheet：
/// iOS 26 弹出半屏时会在容器背景上断言崩溃。
/// 打开时 `router.hubAnchor`（"todos" / "schedules"）非空就滚到对应分区。
struct AssistantHubSheet: View {
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
                        .font(JieboFont.text(.headline, weight: .semibold))
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
                    VStack(alignment: .leading, spacing: 12) {
                        Text("今日只看摘要。")
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                        HStack(spacing: 8) {
                            hubLink("待办") {
                                router.hubOpen = false
                                router.go(.worklist(.todo))
                            }
                            hubLink("计划") {
                                router.hubOpen = false
                                router.go(.worklist(.plan))
                            }
                        }
                        // 待批、委派、待办、计划都不在这份摘要里
                        AssistantTodayPane(showsApprovals: false, showsDelegations: false, showsWorklists: false)
                    }
                        .padding(14)
                        .padding(.bottom, 24)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onAppear { scrollToAnchor(proxy) }
                .onChange(of: router.hubAnchor) { _, _ in scrollToAnchor(proxy) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .phoneNotice()
        .onDisappear { router.hubAnchor = nil }
    }

    /// 往下拉过面板高度的 1/4 或甩下去就关，否则弹回
    private var pullDown: some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .global)
            .onChanged { value in
                let y = value.translation.height
                let span = max(panelHeight, 1)
                drag = y >= 0 ? y : JieboMotion.rubberBand(y, limit: span, dimension: span)
            }
            .onEnded { value in
                let threshold = max(100, panelHeight * 0.25)
                let projected = value.translation.height + JieboMotion.project(value.velocity.height)
                if projected > threshold {
                    let destination = panelHeight + 120
                    // 从手指位置接着滑出屏幕再收起，不在半空淡出
                    withAnimation(JieboMotion.release(
                        reduceMotion,
                        velocity: value.velocity.height,
                        from: drag,
                        to: destination
                    )) {
                        drag = destination
                    } completion: {
                        // 已经滑出屏幕，去掉时不再播一段
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) { router.hubOpen = false }
                    }
                } else {
                    withAnimation(JieboMotion.release(
                        reduceMotion,
                        velocity: value.velocity.height,
                        from: drag,
                        to: 0
                    )) {
                        drag = 0
                    }
                }
            }
    }

    private func hubLink(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(JieboFont.text(.subheadline, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(JieboColor.white)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(JieboColor.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityHint("打开\(title)")
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
