import SwiftUI

/// 今日面板：只有「今日」，没有分段控件，没有记忆（规格 §4.1.5）。
/// 挂在 PhoneShell 的 ZStack 里，由 `router.hubOpen` 控制。不用系统 sheet：
/// iOS 26 弹出半屏时会在容器背景上断言崩溃。
/// 打开时 `router.hubAnchor`（"todos" / "schedules"）非空就滚到对应分区。
struct AssistantHubSheet: View {
    @Environment(PhoneRouter.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init() {}

    var body: some View {
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
                Spacer()
                Button("完成") { router.hubOpen = false }
                    .font(JieboFont.ui(16, weight: .semibold))
                    .foregroundStyle(JieboColor.pine)
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 4)
            ScrollViewReader { proxy in
                ScrollView {
                    // 待批、委派在 iPhone 上不显示：它们在行动区和待处理里
                    AssistantTodayPane(showsApprovals: false, showsDelegations: false)
                        .padding(14)
                        .padding(.bottom, 24)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onAppear { scrollToAnchor(proxy) }
                .onChange(of: router.hubAnchor) { _, _ in scrollToAnchor(proxy) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(JieboColor.paper)
        .phoneNotice()
        .onDisappear { router.hubAnchor = nil }
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
