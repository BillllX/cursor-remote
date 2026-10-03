import SwiftUI

/// 今日面板（半屏 sheet）：只有「今日」，没有分段控件，没有记忆（规格 §4.1.5）。
/// 挂在 PhoneShell/AssistantHome 的 `.sheet(isPresented: $router.hubOpen)`；
/// 打开时 `router.hubAnchor`（"todos" / "schedules"）非空就滚到对应分区。
struct AssistantHubSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init() {}

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    // 待批、委派在 iPhone 上不显示：它们在行动区和待处理里
                    AssistantTodayPane(showsApprovals: false, showsDelegations: false)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onAppear { scrollToAnchor(proxy) }
                .onChange(of: router.hubAnchor) { _, _ in scrollToAnchor(proxy) }
            }
            .background(JieboColor.paper)
            .phoneNotice()
            .navigationTitle("今日")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(JieboColor.paper)
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
