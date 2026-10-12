import SwiftUI
import UIKit
import ImageIO

/// 对话页的外壳：pad = iPad 大标题；phoneLegacy = iPad 窄窗（PhoneWorkbench）的旧手机标题栏；
/// embedded = iPhone 助理页（PhoneShell）：头部为空、导航栏由宿主管理。
enum ThreadChrome { case pad, phoneLegacy, embedded }

struct ThreadView: View {
    @Environment(ChatStore.self) var store
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    var chrome: ThreadChrome = .pad
    var openDrawer: () -> Void = {}
    /// 仅 .embedded 使用：渲染在消息列表与输入框之间的插槽（ActionDock）。输入框仍然只有 ThreadView 里这一个。
    var dock: AnyView? = nil
    @State var composerFocusNonce = 0
    /// 和当前会话对齐之后，新消息才做进入动画。切会话那一帧两者还不一致，避免整列重播。
    @State var motionChatId = ""
    /// 长会话首屏只排版最近若干轮，往上翻再按批加载；按 chat id 记住已展开到多少轮
    static let initialRenderedTurns = 12
    static let renderedTurnStep = 12
    @State var renderedTurnLimitByChat: [String: Int] = [:]
    @State var loadingEarlierBatch = false
    @AppStorage(CalendarInvite.dismissedKey) var calendarInviteDismissed = false

    init(chrome: ThreadChrome = .pad, openDrawer: @escaping () -> Void = {}, dock: AnyView? = nil) {
        self.chrome = chrome
        self.openDrawer = openDrawer
        self.dock = dock
    }

    /// 旧写法：窄屏手机标题栏。保留给 PhoneWorkbench 等现有调用点。
    init(phoneChrome: Bool, openDrawer: @escaping () -> Void = {}) {
        self.init(chrome: phoneChrome ? .phoneLegacy : .pad, openDrawer: openDrawer)
    }

    /// iOS 26+ 把输入区做成浮在消息上的玻璃底栏（safeAreaBar）。iPhone、iPad 宽窗和窄窗同一套。
    var floatsComposer: Bool { JieboGlass.available }
    /// iOS 17–25 用 safeAreaInset，不和列表抢高度。不与 safeAreaBar 同时开。
    var insetsComposer: Bool { !JieboGlass.available }

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            header
            thread
                .overlay(alignment: .top) { floatingBanners }
                .modifier(FloatingBottomBar(enabled: floatsComposer) { bottomStack })
                .modifier(EmbeddedComposerInset(enabled: insetsComposer) { bottomStack })
            if !floatsComposer && !insetsComposer {
                bottomStack
            }
        }
        .frame(maxWidth: JieboMeasure.thread)
        .frame(maxWidth: .infinity)
        .background(JieboColor.paper.ignoresSafeArea())
        .toolbar(chrome == .embedded ? .automatic : .hidden, for: .navigationBar)
        .toolbar(removing: .sidebarToggle)
        // @文件 链接 → 预览面板（媒体类内部转 Quick Look）；其他链接走系统
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "jiebo-file",
                  let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let path = components.queryItems?.first(where: { $0.name == "path" })?.value
            else { return .systemAction }
            store.openPreview(path)
            return .handled
        })
        // P6：预览面板 overlay 上移到 WorkbenchView（RootView）——遮罩盖住侧栏 + detail，
        // 不再只压对话列导致标题被切断；宽度拖拽手柄也在那层
        .sheet(item: previewFileBinding, onDismiss: store.closePreview) { file in
            QuickLookView(file: file, onClose: { store.dismissPreviewFile() })
                .ignoresSafeArea()
        }
        // P10：分享 sheet（与 QL 同一套 cover 期间不抢守卫）
        .sheet(item: exportFileBinding, onDismiss: store.closeExport) { file in
            ActivityView(items: [file.url])
        }
    }

    /// 输入框上方的委派待批、ActionDock 和输入框本身。输入框只有这一个
    @ViewBuilder
    var bottomStack: some View {
        VStack(spacing: 0) {
            // .embedded：委派审批由 ActionDock 接管，这里不再出现同一张确认卡
            let delegated: [AssistantApproval] = chrome == .embedded ? [] : store.assistantApprovals(forParent: store.activeId)
            Group {
                if let approval = delegated.first {
                    delegatedApprovalBanner(approval, more: delegated.count - 1)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(JieboMotion.fade(reduceMotion), value: delegated.first?.id)
            if chrome == .embedded, let dock {
                dock
            }
            ComposerView(
                focusNonce: composerFocusNonce,
                style: store.assistantChatActive && chrome == .embedded ? .assistant : .full
            )
                // 上面的出现动画不要套到输入框上，否则打字时的高度变化会被当成动画。
                .transaction { $0.animation = nil }
        }
    }

    @ViewBuilder
    var floatingBanners: some View {
        VStack(spacing: 6) {
            if !store.notice.isEmpty {
                floatingBanner(store.notice, color: JieboColor.dim)
                    .allowsHitTesting(false)
            }
            if !store.bannerError.isEmpty {
                Button {
                    store.dismissBannerError()
                } label: {
                    floatingBanner(friendlyError(store.bannerError), color: JieboColor.danger, closable: true)
                }
                .buttonStyle(.plain)
                .accessibilityHint("轻点关闭")
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 16)
        .animation(JieboMotion.fade(reduceMotion), value: store.notice.isEmpty)
        .animation(JieboMotion.fade(reduceMotion), value: store.bannerError.isEmpty)
    }

    func floatingBanner(_ text: String, color: Color, closable: Bool = false) -> some View {
        HStack(spacing: 8) {
            Text(text)
                .multilineTextAlignment(.center)
            if closable {
                Image(systemName: "xmark")
                    .font(JieboFont.text(.caption2, weight: .bold))
                    .opacity(0.7)
                    .accessibilityHidden(true)
            }
        }
        .font(JieboFont.text(.footnote, weight: .medium))
        .foregroundStyle(color)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .jieboGlass(in: Capsule())
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(closable ? [] : .isStaticText)
    }

    /// 本会话派出去的委派子会话停在审批上：在输入框上方直接作答
    /// 样式与输入框里的待批条（ComposerView.approvalBar）一致，只是按钮用委派的「批准 / 拒绝」
    func delegatedApprovalBanner(_ approval: AssistantApproval, more: Int) -> some View {
        let tool = approval.tool.nilIfEmpty ?? "工具调用"
        return VStack(alignment: .leading, spacing: 8) {
            Text(more > 0 ? "委派要用 \(tool)（另有 \(more) 条待批）" : "委派要用 \(tool)")
                .font(JieboFont.text(.subheadline, weight: .medium))
                .foregroundStyle(JieboColor.ink)
                .lineLimit(2)
            if !approval.summary.isEmpty {
                Text(approval.summary)
                    .font(JieboFont.monoText(.caption))
                    .foregroundStyle(JieboColor.ink2)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            HStack(spacing: 8) {
                Button("拒绝", role: .destructive) { store.answerAssistantApproval(approval, allow: false) }
                    .buttonStyle(.bordered)
                Button("批准") { store.answerAssistantApproval(approval, allow: true) }
                    .buttonStyle(.borderedProminent)
                    .tint(JieboColor.pine)
            }
            .font(JieboFont.text(.subheadline, weight: .semibold))
            .controlSize(.large)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.warnBg)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    /// P7：文件浏览器 cover 打开期间本层不 present QL——cover 自己挂了同一 previewFile 的 sheet，
    /// 两层抢同一个 item 会 present 失败/连闪（Grok R2 MINOR）。cover 关闭后绑定自动恢复。
    var previewFileBinding: Binding<PreviewFile?> {
        Binding(
            get: { store.fileBrowserOpen ? nil : store.previewFile },
            set: { store.previewFile = $0 }
        )
    }

    /// P10：同上——cover 期间分享 sheet 由 FileBrowserCover 自己 present
    var exportFileBinding: Binding<PreviewFile?> {
        Binding(
            get: { store.fileBrowserOpen ? nil : store.exportFile },
            set: { store.exportFile = $0 }
        )
    }

    // MARK: 对话流（P8：滚动跟随改造）

    /// 停在底部时才跟随流式输出。松开只认手势，恢复只认「回到最新」和重新钉顶。
    @State var stickToBottom = true
    /// 钉顶时的可视高度，用来撑当前轮的最小高度。
    @State var viewportHeight: CGFloat = 0
    /// 程序滚动期间，相位和 minY 变化不算用户上滑。
    @State var scrollingProgrammatically = false
    /// 当前这一轮撑满一屏。新一轮钉上时清掉上一轮。iPhone 和 iPad 同一套。
    @State var pinnedTurnId: String?
    /// 钉住时的可视高度。键盘变矮不减小，变高可以增大。
    @State var pinnedMinHeight: CGFloat = 0
    /// 内容列高度一旦超过 pinnedMinHeight 就闩住，不再用底锚点的视口坐标判断。
    @State var pinExceeded = false
    @State var pinBaselineMinY: CGFloat?
    @State var pinBaselineReady = false
    @State var pinnedTurnMinY: CGFloat = 0
    /// 程序滚动结束后的短窗口内，相位和 minY 变化不算用户上滑。
    @State var pinScrollGuardUntil = Date.distantPast
    /// 贴底滚动之后，下一次 minY 只用来重记基线，不拿去和旧的钉顶位置比。
    @State var pinRecaptureBaseline = false
    @State var followTask: Task<Void, Never>?
    /// showThreadLoading 持续超过 350ms 才亮的加载遮罩
    @State var loadingVisible = false

    let assistantStarters = [
        "今天有什么安排？",
        "帮我记一下：",
        "明早 9 点提醒我",
        "让 acrabat 里的讲稿再顺一遍",
    ]

    let starters = [
        "打开工作区文件",
        "看一下这个项目的结构",
        "最近改了哪些文件？",
        "用 Canvas 概括这个仓库",
    ]
}

/// iOS 17–25：输入区放进底部 safe area，键盘只改这块留白。
/// 挂在包住 ScrollView 的 GeometryReader 外面，和 safeAreaBar 二选一。iPhone 与 iPad 都用。
private struct EmbeddedComposerInset<Bar: View>: ViewModifier {
    var enabled: Bool
    @ViewBuilder var bar: () -> Bar

    func body(content: Content) -> some View {
        if enabled {
            content.safeAreaInset(edge: .bottom, spacing: 0) { bar() }
        } else {
            content
        }
    }
}

/// iOS 26+：内容挂一条底部 safeAreaBar（系统给滚动边缘做柔化）；其它情况原样返回，由调用方把底栏排在 VStack 里
private struct FloatingBottomBar<Bar: View>: ViewModifier {
    var enabled: Bool
    @ViewBuilder var bar: () -> Bar

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if enabled {
                content.safeAreaBar(edge: .bottom) { bar() }
            } else {
                content
            }
        } else {
            content
        }
    }
}
