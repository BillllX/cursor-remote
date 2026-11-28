import SwiftUI

/// 小驳和窄屏工作台共用侧栏：遮罩淡化，内容从左侧滑入，始终留出可点击的关闭区域。
struct JieboDrawer<Content: View>: View {
    let isPresented: Bool
    let close: () -> Void
    @ViewBuilder var content: () -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                if isPresented {
                    Button(action: close) {
                        Color.black.opacity(0.28).ignoresSafeArea()
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("关闭侧边栏")
                    .transition(.opacity)
                    content()
                        .frame(width: min(dynamicTypeSize.isAccessibilitySize ? 380 : 320,
                                          max(0, geometry.size.width - 44)))
                        .frame(maxHeight: .infinity)
                        .background(JieboColor.paper)
                        .transition(.jieboPanel(from: .leading, reduceMotion: reduceMotion))
                        .accessibilityAddTraits(.isModal)
                        .accessibilityAction(.escape, close)
                        .gesture(DragGesture(minimumDistance: 24).onEnded { value in
                            guard value.translation.width < -60,
                                  abs(value.translation.width) > abs(value.translation.height) * 1.5 else { return }
                            close()
                        })
                        .zIndex(1)
                }
            }
            .animation(JieboMotion.panel(reduceMotion), value: isPresented)
        }
        .allowsHitTesting(isPresented)
        .accessibilityHidden(!isPresented)
    }
}

/// 首次数据尚未返回时单独呈现加载/离线状态，已有内容刷新时继续保留列表。
/// 延迟出现转圈，慢请求提供重试；恢复连接或离开页面时取消原来的计时。
struct AssistantLoadingView: View {
    let title: String
    @Environment(ChatStore.self) private var store
    @Environment(\.homeActive) private var homeActive
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showProgress = false
    @State private var slow = false
    @State private var retry = 0

    private struct LoadingTaskKey: Equatable {
        let unlocked: Bool
        let connected: Bool
        let gatewayReady: Bool
        let active: Bool
        let retry: Int
    }

    private var offline: Bool { store.linkState == .offline }
    private var waiting: Bool { store.unlocked && !offline }
    private var active: Bool { homeActive && scenePhase == .active }
    private var taskKey: LoadingTaskKey {
        LoadingTaskKey(
            unlocked: store.unlocked,
            connected: store.connected,
            gatewayReady: store.gatewayReady,
            active: active,
            retry: retry
        )
    }
    private var headline: String {
        if !store.unlocked { return "登录后查看" }
        if offline { return "连接已断开" }
        if slow { return "加载需要一点时间" }
        return store.connected ? title : "正在连接…"
    }

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                if waiting && !slow {
                    if reduceMotion {
                        Image(systemName: "hourglass")
                    } else if showProgress && active {
                        ProgressView().controlSize(.regular).tint(JieboColor.dim)
                    }
                } else {
                    Image(systemName: offline ? "wifi.slash" : "arrow.clockwise")
                }
            }
            .font(.system(size: 28, weight: .regular))
            .foregroundStyle(JieboColor.dim)
            .frame(width: 44, height: 44)
            .accessibilityHidden(true)
            VStack(spacing: 8) {
                Text(headline)
                    .font(JieboFont.text(.headline))
                    .foregroundStyle(JieboColor.ink)
                Text(!store.unlocked ? "登录后，这里的内容会自动更新。"
                     : offline ? "重新连接后会自动更新。"
                     : slow ? "可以重新加载，或返回小驳继续使用。"
                     : "内容准备好后会自动显示。")
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(JieboColor.dim)
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            if store.unlocked && (offline || slow) {
                ActionButton(title: offline ? "重新连接" : "重新加载", kind: .primary) {
                    slow = false
                    retry += 1
                    if offline { store.retryConnection() }
                    else { store.requestAssistant(force: true) }
                }
            }
        }
        .frame(maxWidth: 420)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(JieboColor.paper)
        .task(id: taskKey) {
            showProgress = false
            slow = false
            guard waiting, active else { return }
            do {
                try await Task.sleep(for: .milliseconds(200))
                showProgress = true
                try await Task.sleep(for: .seconds(8))
                slow = store.connected
            } catch { /* Leaving the page cancels its loading presentation. */ }
        }
    }
}
