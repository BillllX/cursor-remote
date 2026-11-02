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
/// 一直挂在 PhoneShell 的 ZStack 里：关着的时候不拦触摸，只在「路由栈为空且没有键盘」时留一条 16pt 的左缘热区。
/// 手指拖到哪，面板跟到哪；松手再按速度停在开或关。push 页上这条热区撤掉，左缘右滑归系统的返回手势。
struct MenuDrawer: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// VoiceOver 焦点：0 是首项「今日」。nil 时没有行被选中
    @AccessibilityFocusState private var focusedRow: Int?
    @State private var keyboardUp = false
    /// 面板已经露出的宽度。拖动时直接写，点按开关时再做动画。
    @State private var reveal: CGFloat = 0
    @State private var panelWidth: CGFloat = 300
    @State private var dragging = false
    private var edgeOpenEnabled: Bool {
        router.path.isEmpty && !keyboardUp
    }

    var body: some View {
        ZStack(alignment: .leading) {
            drawerLayer
            if !router.menuOpen, edgeOpenEnabled {
                edgeStrip
            }
        }
        .onChange(of: router.menuOpen) { _, open in
            guard !dragging else { return }
            let target: CGFloat = open ? panelWidth : 0
            guard abs(reveal - target) > 1 else { return }
            withAnimation(JieboMotion.panel(reduceMotion)) {
                reveal = target
            }
            if open { focusFirstRow() }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardUp = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardUp = false
        }
    }

    // MARK: 跟手的遮罩 + 面板

    private var drawerLayer: some View {
        GeometryReader { geo in
            let width = min(300, geo.size.width * 0.82)
            ZStack(alignment: .leading) {
                if reveal > 0.5 {
                    Color.black.opacity(0.28 * min(reveal / max(width, 1), 1))
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { settle(open: false, velocity: 0, width: width) }
                        .accessibilityLabel("关闭菜单")
                        .accessibilityAddTraits(.isButton)
                }
                panel
                    .frame(width: width)
                    .frame(maxHeight: .infinity)
                    .background {
                        Color.clear
                            .jieboGlass(in: Rectangle())
                            .ignoresSafeArea()
                    }
                    .offset(x: reveal - width)
                    .simultaneousGesture(closeDrag(width: width))
                    .accessibilityHidden(!router.menuOpen)
                    .accessibilityAddTraits(router.menuOpen ? .isModal : [])
                    .accessibilityAction(.escape) { settle(open: false, velocity: 0, width: width) }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .leading)
            .onAppear { syncWidth(width) }
            .onChange(of: width) { _, newWidth in syncWidth(newWidth) }
        }
        .allowsHitTesting(reveal > 1 || dragging)
    }

    // MARK: 左缘热区

    private var edgeStrip: some View {
        Color.clear
            .frame(width: 16)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 8, coordinateSpace: .global)
                    .onChanged { value in
                        let width = panelWidth
                        guard !router.menuOpen else { return }
                        guard value.translation.width > 0,
                              abs(value.translation.width) > abs(value.translation.height)
                        else { return }
                        dragging = true
                        reveal = JieboMotion.rubberBand(value.translation.width, limit: width, dimension: width)
                    }
                    .onEnded { value in
                        let width = panelWidth
                        let horizontal = value.translation.width > 0
                            && abs(value.translation.width) > abs(value.translation.height)
                        guard dragging || horizontal else { return }
                        let current = dragging
                            ? reveal
                            : JieboMotion.rubberBand(value.translation.width, limit: width, dimension: width)
                        let projected = current + JieboMotion.project(value.velocity.width)
                        settle(open: projected > width * 0.4, velocity: value.velocity.width, width: width)
                    }
            )
            .accessibilityHidden(true)
    }

    private func closeDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 16, coordinateSpace: .global)
            .onChanged { value in
                guard router.menuOpen || reveal > 1 else { return }
                guard value.translation.width < 0,
                      abs(value.translation.width) > abs(value.translation.height)
                else { return }
                dragging = true
                reveal = JieboMotion.rubberBand(width + value.translation.width, limit: width, dimension: width)
            }
            .onEnded { value in
                guard dragging else { return }
                let projected = reveal + JieboMotion.project(value.velocity.width)
                settle(open: projected > width * 0.5, velocity: value.velocity.width, width: width)
            }
    }

    /// 点按开关走临界阻尼；手指松开走带速度的弹簧。
    private func settle(open: Bool, velocity: CGFloat, width: CGFloat) {
        let from = reveal
        let to: CGFloat = open ? width : 0
        let wasOpen = router.menuOpen
        dragging = false
        let animation = velocity == 0
            ? JieboMotion.panel(reduceMotion)
            : JieboMotion.release(reduceMotion, velocity: velocity, from: from, to: to)
        withAnimation(animation) {
            reveal = to
            if open {
                router.openMenu()
            } else {
                router.closeMenu()
            }
        }
        if open, !wasOpen { focusFirstRow() }
    }

    private func syncWidth(_ width: CGFloat) {
        guard abs(width - panelWidth) > 1 else { return }
        let previous = panelWidth
        panelWidth = width
        guard !dragging, router.menuOpen, abs(reveal - previous) < 1 else { return }
        reveal = width
    }

    private func focusFirstRow() {
        JieboHaptic.selection()
        Task { @MainActor in
            // 等滑入走完再把焦点放上，否则会被动画吞掉
            try? await Task.sleep(for: .milliseconds(450))
            guard router.menuOpen else { return }
            focusedRow = 0
        }
    }

    // MARK: 面板内容

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            divider
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    sectionTitle("小驳")
                    // 和导航栏「今日」是同一个面板，不再另开一个全屏页
                    menuRow("sun.max", "今日", tag: 0) {
                        router.openHub()
                    }
                    menuRow("checkmark.circle", "待办", tag: 1) {
                        router.go(.worklist(.todo))
                    }
                    menuRow("calendar", "计划", tag: 2) {
                        router.go(.worklist(.plan))
                    }
                    menuRow("person.2.wave.2", "委派", tag: 3) {
                        router.go(.worklist(.delegation))
                    }
                    menuRow("square.stack.3d.up", "产物中心", tag: 4) {
                        router.go(.artifacts)
                    }
                    menuRow(NavigationIconId.memory.symbol, "记忆", tag: 5) {
                        router.go(.memory)
                    }
                    divider
                        .padding(.vertical, 8)
                    menuRow(NavigationIconId.account.symbol, "设置", tag: 6) {
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
                .frame(minHeight: store.linkState == .offline ? 44 : 0, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture {
                    if store.linkState == .offline { store.retryConnection() }
                }
                .accessibilityAddTraits(store.linkState == .offline ? .isButton : [])
                .accessibilityHint(store.linkState == .offline ? "重新连接" : "")
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 14)
        .accessibilityElement(children: .contain)
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
