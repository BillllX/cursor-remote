import SwiftUI
import UIKit

/// ☰ 等助理入口使用的数字角标（> 99 显示 99+）
struct PendingBadge: View {
    var count: Int

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(JieboFont.text(.caption2, weight: .semibold))
            .foregroundStyle(JieboColor.fillFg)
            .padding(.horizontal, 5)
            .frame(minWidth: 16, minHeight: 16)
            .background(JieboColor.danger)
            .clipShape(Capsule())
            .accessibilityHidden(true)
    }
}

/// 小驳空间的左侧菜单抽屉（docs/iphone-assistant-first.md §4.0.1 / §4.3）。
/// 一直挂在 PhoneShell 的 ZStack 里：关着的时候不拦触摸，只在「路由栈为空且没有键盘」时留一条 16pt 的左缘热区，
/// 从左缘向右拖就打开；push 页上这条热区撤掉，左缘右滑归系统的返回手势。
struct MenuDrawer: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// VoiceOver 焦点：0 是首项「今日」。nil 时没有行被选中
    @AccessibilityFocusState private var focusedRow: Int?
    @State private var keyboardUp = false
    private var edgeOpenEnabled: Bool {
        router.path.isEmpty && !keyboardUp
    }

    var body: some View {
        ZStack(alignment: .leading) {
            openLayer
            if !router.menuOpen, edgeOpenEnabled {
                edgeStrip
            }
        }
        .animation(JieboMotion.panel(reduceMotion), value: router.menuOpen)
        .onChange(of: router.menuOpen) { _, open in
            if open { JieboHaptic.selection() }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardUp = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardUp = false
        }
    }

    // MARK: 打开后的遮罩 + 面板

    private var openLayer: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                if router.menuOpen {
                    Color.black.opacity(0.28)
                        .ignoresSafeArea()
                        .onTapGesture { router.closeMenu() }
                        .accessibilityLabel("关闭菜单")
                        .accessibilityAddTraits(.isButton)
                        .transition(.opacity)
                    panel
                        .frame(width: min(300, geo.size.width * 0.82))
                        .frame(maxHeight: .infinity)
                        .background(JieboColor.sidebar.ignoresSafeArea())
                        .overlay(alignment: .trailing) {
                            Rectangle().fill(JieboColor.line).frame(width: 1).ignoresSafeArea()
                        }
                        .gesture(
                            DragGesture(minimumDistance: 20)
                                .onEnded { value in
                                    if value.translation.width < -60 || value.predictedEndTranslation.width < -140 {
                                        router.closeMenu()
                                    }
                                }
                        )
                        .transition(.move(edge: .leading))
                        .accessibilityAddTraits(.isModal)
                        .accessibilityAction(.escape) { router.closeMenu() }
                        .task {
                            // 打开后把 VoiceOver 焦点放到首项；等滑入动画走完再设，否则会被动画吞掉
                            try? await Task.sleep(for: .milliseconds(450))
                            focusedRow = 0
                        }
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .leading)
        }
        .allowsHitTesting(router.menuOpen)
    }

    // MARK: 左缘热区

    private var edgeStrip: some View {
        Color.clear
            .frame(width: 16)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in
                        guard !router.menuOpen,
                              value.translation.width > 24,
                              abs(value.translation.height) < value.translation.width
                        else { return }
                        router.openMenu()
                    }
            )
            .accessibilityHidden(true)
    }

    // MARK: 面板内容

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            divider
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    sectionTitle("助理")
                    // 和导航栏「今日」是同一个面板，不再另开一个全屏页
                    menuRow("sun.max", "今日", tag: 0) {
                        router.openHub()
                    }
                    menuRow("checklist", "任务与计划", tag: 1) {
                        router.go(.delegations)
                    }
                    menuRow("square.stack.3d.up", "产物中心", tag: 2) {
                        router.go(.artifacts)
                    }
                    divider
                        .padding(.vertical, 8)
                    menuRow(NavigationIconId.account.symbol, "设置", tag: 3) {
                        router.go(.settings)
                    }
                }
                .padding(.bottom, 12)
            }
            aboutFooter
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            JieboMark(size: 36)
            VStack(alignment: .leading, spacing: 3) {
                Text(store.tenantName.nilIfEmpty ?? "接驳")
                    .font(JieboFont.display(17))
                    .tracking(0.34)
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    LinkStatusDot(state: store.linkState, size: 8)
                        .accessibilityHidden(true)
                    Text(store.linkState.title)
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 14)
        .accessibilityElement(children: .combine)
    }

    private var divider: some View {
        Rectangle()
            .fill(JieboColor.line)
            .frame(height: 1)
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(JieboFont.text(.caption, weight: .medium))
            .tracking(0.6)
            .foregroundStyle(JieboColor.dim)
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }

    private func menuRow(
        _ symbol: String,
        _ title: String,
        tag: Int,
        action: @escaping () -> Void
    ) -> some View {
        return Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: symbol)
                    .font(JieboFont.text(.callout, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(width: 24)
                Text(title)
                    .font(JieboFont.text(.callout, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .contentShape(Rectangle())
            .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(title)
        .accessibilityFocused($focusedRow, equals: tag)
    }

    private var aboutFooter: some View {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? ""
        let build = info?["CFBundleVersion"] as? String ?? ""
        let text = build.isEmpty ? "接驳 \(version)" : "接驳 \(version) (\(build))"
        return Text(text)
            .font(JieboFont.text(.caption2))
            .foregroundStyle(JieboColor.dim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .overlay(alignment: .top) {
                Rectangle().fill(JieboColor.line).frame(height: 1)
            }
    }
}
