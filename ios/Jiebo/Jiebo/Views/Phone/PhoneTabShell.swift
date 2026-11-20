import SwiftUI
import UIKit

/// iPhone 默认聚焦小驳；工作台通过小驳侧边栏切换，消息暂时隐藏，继续复用各自的路由状态。
struct PhoneTabShell: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.sceneSessionState) private var sceneSession
    @Environment(\.coldLaunchVisible) private var coldLaunchVisible
    @State private var router = PhoneRouter()
    @State private var fallbackSceneToken = UUID().uuidString
    @State private var pushTask: Task<Void, Never>?
    @State private var workspaceTask: Task<Void, Never>?
    @State private var resolvingPush: PushTarget?
    #if DEBUG
    @State private var ranNavigationSmoke = false
    #endif

    private var sceneToken: String { sceneSession?.token ?? fallbackSceneToken }

    private var activePreviewTab: PreviewTab? {
        if let sceneSession { return sceneSession.previewTab(in: store) }
        return store.activePreviewTab
    }

    private var previewPanelOpen: Bool {
        sceneSession != nil ? activePreviewTab != nil : store.previewPanelOpen
    }

    var body: some View {
        @Bindable var router = router
        ZStack {
            PhoneShell()
                .modifier(PhoneSpaceVisibility(active: router.selectedTab == .assistant))
                .environment(\.assistantVoicePresenterActive,
                             router.selectedTab == .assistant && router.path.isEmpty && !coldLaunchVisible)
            if router.visitedWorkspace {
                PhoneWorkbench(embedsPreview: false)
                    .modifier(PhoneSpaceVisibility(active: router.selectedTab == .workspace))
            }
        }
        .environment(router)
        .environment(\.switchPhoneSpace, { tab in
            switchSpace(tab)
        })
        .environment(\.assistantSceneToken, sceneToken)
        .environment(\.openDelegation, { [router = self.router] id in
            router.delegationDetail = DelegationRef(id: id)
        })
        .accessibilityHidden(previewPanelOpen)
        .sheet(item: $router.delegationDetail) { ref in
            DelegationDetailSheet(delegationId: ref.id)
        }
        .overlay {
            if previewPanelOpen, let tab = activePreviewTab {
                ZStack {
                    Color.black.opacity(0.28)
                        .ignoresSafeArea()
                        .onTapGesture {
                            if let sceneSession { sceneSession.dismissPreview() }
                            else { store.collapsePreview() }
                        }
                        .accessibilityHidden(true)
                    PreviewPanelView(tab: tab)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(JieboColor.white)
                        .transition(.jieboPanel(from: .trailing, reduceMotion: reduceMotion))
                }
                .zIndex(3)
            }
        }
        .animation(JieboMotion.panel(reduceMotion), value: previewPanelOpen)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .fullScreenCover(isPresented: workspaceFilesPresented) {
            FileBrowserCover()
        }
        .task(id: "\(store.unlocked):\(store.assistantChatId ?? "")") { await bootstrap() }
        .onChange(of: coldLaunchVisible) { _, visible in
            if !visible {
                dispatchPush()
                dispatchWidgetDeepLink()
            }
        }
        #if DEBUG
        .task(id: !coldLaunchVisible && router.bootstrapped) {
            guard !coldLaunchVisible, router.bootstrapped, !ranNavigationSmoke,
                  ProcessInfo.processInfo.arguments.contains("--phone-navigation-smoke") else { return }
            ranNavigationSmoke = true
            await NavigationRegression.runPhone(store: store, router: router, sceneSession: sceneSession, sceneToken: sceneToken, switchSpace: switchSpace)
        }
        #endif
        .onAppear {
            AssistantScenePresenter.shared.register(token: sceneToken, active: scenePhase == .active)
            synchronizeSelectedTab()
            dispatchPush()
            dispatchWidgetDeepLink()
        }
        .onDisappear {
            pushTask?.cancel()
            workspaceTask?.cancel()
            AssistantScenePresenter.shared.unregister(token: sceneToken)
        }
        .onChange(of: scenePhase) { _, phase in
            AssistantScenePresenter.shared.update(token: sceneToken, active: phase == .active)
            syncWorkbenchViewing()
            if phase == .active {
                dispatchPush()
                dispatchWidgetDeepLink()
            }
        }
        .onChange(of: store.workbenchFilesRequest) { _, _ in
            router.invalidatePendingNavigation()
            if router.selectedTab != .workspace {
                router.selectedTab = .workspace
            }
            if !(store.fileBrowserOpen && store.fileBrowserPane == .files) {
                store.toggleFileBrowser(.files)
            }
        }
        .onChange(of: store.workbenchTerminalRequest) { _, _ in
            router.invalidatePendingNavigation()
            if router.selectedTab != .workspace {
                router.selectedTab = .workspace
            }
        }
        .onChange(of: store.returnToAssistantRequest) { _, _ in
            router.popToRoot()
        }
        .onChange(of: router.selectedTab) { old, new in
            AppLaunchMetrics.event("PhoneSpaceSelected")
            if old == .workspace, new != .workspace {
                workspaceTask?.cancel()
                if let sceneSession { sceneSession.dismissPreview() }
                else { store.collapsePreview() }
                store.fileBrowserOpen = false
            }
            synchronizeSelectedTab()
        }
        .onChange(of: router.bootstrapped) { _, ready in
            if ready {
                dispatchPush()
                dispatchWidgetDeepLink()
            }
        }
        .onChange(of: PushRouting.shared.pending) { _, _ in
            dispatchPush()
        }
        .onChange(of: WidgetDeepLinkRouting.shared.pending) { _, _ in
            dispatchWidgetDeepLink()
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantCaptureOpenRequested)) { _ in
            guard AssistantScenePresenter.shared.isPresenter(token: sceneToken) else { return }
            router.popToRoot()
            store.prepareAssistantThread()
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantVoiceRequested)) { notification in
            guard AssistantScenePresenter.shared.isPresenter(token: sceneToken),
                  let capture = notification.object as? AssistantCaptureBridge.Capture
            else { return }
            router.queueVoice(capture)
            store.prepareAssistantThread()
        }
        .task(id: "\(coldLaunchVisible):\(router.pendingVoiceCapture?.id ?? "")") {
            guard !coldLaunchVisible, let capture = router.pendingVoiceCapture else { return }
            await Task.yield()
            guard !Task.isCancelled, router.selectedTab == .assistant, router.path.isEmpty else { return }
            _ = router.takePendingVoice()
            let delivery = AssistantVoiceDelivery(sceneToken: sceneToken, capture: capture)
            NotificationCenter.default.post(name: .assistantVoiceComposerRequested, object: delivery)
        }
    }

    // MARK: 冷启动对齐（§3.2）

    /// 页面导航最多等 8 秒；助理数据晚到时仍补上推送注册，不再切换全局活动会话。
    @MainActor
    private func bootstrap() async {
        if store.unlocked, store.assistantChatId != nil {
            PushRegistrar.shared.start(store: store, im: im) // 数据晚到也执行；注册本身幂等。
        }
        guard !router.bootstrapped else { return }
        store.assistantOnly = router.locksActiveChatToAssistant
        guard store.unlocked else { return }
        if store.assistantChatId == nil {
            try? await Task.sleep(for: .seconds(8))
        }
        guard !Task.isCancelled else { return }
        store.assistantOnly = router.locksActiveChatToAssistant
        if router.locksActiveChatToAssistant {
            // 旧网关没有助理会话时显示降级说明，页面导航不等待网络。
            store.prepareAssistantThread()
        }
        router.bootstrapped = true
        #if DEBUG
        applyDebugArguments()
        #endif
    }

    // MARK: DEBUG 启动参数（§8 P5）

    #if DEBUG
    /// --phone-route=root|inbox|today|delegations|todos|plans|runs|artifacts|settings|memory
    /// runs 仍可用，打开的是委派。
    /// --phone-delegation=<id>
    @MainActor
    private func applyDebugArguments() {
        let arguments = ProcessInfo.processInfo.arguments
        func value(of prefix: String) -> String? {
            guard let found = arguments.first(where: { $0.hasPrefix(prefix) }) else { return nil }
            return String(found.dropFirst(prefix.count))
        }
        if let route = value(of: "--phone-route=") {
            switch route {
            case "workspace": switchSpace(.workspace)
            case "inbox": router.go(.inbox)
            case "today": router.popToRoot()
            case "delegations": router.go(.worklist(.delegation))
            case "todos": router.go(.worklist(.todo))
            case "plans": router.go(.worklist(.plan))
            case "runs": router.go(.worklist(.delegation))
            case "artifacts": router.go(.artifacts)
            case "settings": router.path = [.settings]
            case "memory": router.path = [.settings, .memory]
            default: router.path = []
            }
        }
        if let id = value(of: "--phone-delegation="), !id.isEmpty {
            router.delegationDetail = DelegationRef(id: id)
        }
    }
    #endif
    private func switchSpace(_ tab: PhoneTab) {
        guard tab != .messages else { return }
        // Set the legacy mutation guard before a newly visible workbench can act.
        store.assistantOnly = tab == .assistant
        router.openSpace(tab)
    }

    private func synchronizeSelectedTab() {
        let messages = router.selectedTab == .messages
        store.assistantOnly = router.locksActiveChatToAssistant
        im.setHomeVisible(messages)
        if router.locksActiveChatToAssistant, router.bootstrapped {
            store.prepareAssistantThread()
        }
        syncWorkbenchViewing()
    }

    private func syncWorkbenchViewing() {
        let viewing = router.selectedTab == .workspace && scenePhase == .active
        store.syncWorkbenchAgentViewing(
            chatId: viewing ? (sceneSession?.workbenchChatId ?? store.activeId) : nil,
            active: viewing
        )
    }

    private var workspaceFilesPresented: Binding<Bool> {
        Binding(
            get: { router.selectedTab == .workspace && store.fileBrowserOpen },
            set: { open in if !open { store.fileBrowserOpen = false } }
        )
    }

    private func dispatchWidgetDeepLink() {
        guard !coldLaunchVisible, scenePhase == .active, router.bootstrapped,
              let route = WidgetDeepLinkRouting.shared.consume(for: sceneToken)
        else { return }
        switch route {
        case .today:
            router.popToRoot()
            store.prepareAssistantThread()
        case .inbox:
            router.go(.inbox)
        case .todo(let id):
            let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                router.go(.worklist(.todo))
            } else {
                router.openWorkTask(trimmed.hasPrefix("todo:") ? trimmed : "todo:\(trimmed)", column: .todo)
            }
        }
    }

    /// iPhone 推送只在这里消费，避免主页层与小驳空间重复取走 pending。
    private func dispatchPush() {
        guard !coldLaunchVisible, scenePhase == .active,
              AssistantScenePresenter.shared.isPresenter(token: sceneToken),
              let target = PushRouting.shared.pending
        else { return }
        if target.isIm {
            _ = PushRouting.shared.consume()
            return
        }
        if target.isWorkspace, let chatId = target.chatId {
            _ = PushRouting.shared.consume()
            store.assistantOnly = false
            router.selectedTab = .workspace
            openWorkspace(chatId)
            return
        }

        guard router.bootstrapped, resolvingPush != target else { return }
        pushTask?.cancel()
        resolvingPush = target
        if target.kind == "approval" {
            router.go(.inbox)
        } else {
            router.selectedTab = .assistant
        }
        let revision = router.revision
        pushTask = Task { @MainActor in
            defer { if resolvingPush == target { resolvingPush = nil } }
            await consumeAssistantPush(target, revision: revision)
        }
    }

    @MainActor
    private func consumeAssistantPush(_ target: PushTarget, revision: UInt64) async {
        // 冷启动时助理状态可能还没到：多等几秒，免得委派或收件箱条目找不到。
        if store.assistantState == nil {
            store.requestAssistant()
            var waited = 0
            while store.assistantState == nil, waited < 30, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                waited += 1
            }
        }
        guard !Task.isCancelled, PushRouting.shared.pending == target else { return }
        _ = PushRouting.shared.consume()
        guard router.revision == revision else { return } // A later user navigation wins.
        if let itemId = target.itemId,
           let item = store.assistantState?.inbox.first(where: { $0.id == itemId }) {
            store.markInboxRead(item)
        }
        if target.kind == "approval" {
            router.go(.inbox)
        } else if target.kind == "reminder", let itemId = target.itemId?.nilIfEmpty {
            router.openWorkTask(itemId, column: AssistantWorkColumn.matching(itemId))
        } else if target.delegationId != nil || target.chatId != nil {
            router.open(chatId: target.chatId, delegationId: target.delegationId, store: store)
        } else if let itemId = target.itemId?.nilIfEmpty {
            if store.assistantState?.inbox.contains(where: { $0.id == itemId }) == true {
                router.openInboxItem(itemId)
            } else {
                router.openWorkTask(itemId, column: AssistantWorkColumn.matching(itemId))
            }
        } else {
            router.popToRoot()
        }
    }

    private func openWorkspace(_ chatId: String) {
        store.assistantOnly = false
        workspaceTask?.cancel()
        let revision = router.revision
        workspaceTask = Task { @MainActor in
            var waited = 0
            var nudged = false
            while !store.isWorkspaceChat(chatId), waited < 40 {
                if !nudged, let item = store.workspaceAgent(chatId: chatId) {
                    store.switchWorkspace(to: item.path)
                    nudged = true
                }
                try? await Task.sleep(for: .milliseconds(100))
                waited += 1
                guard !Task.isCancelled, router.revision == revision else { return }
            }
            guard !Task.isCancelled, router.revision == revision else { return }
            guard store.isWorkspaceChat(chatId) else {
                store.flash("这条工作区会话暂时无法打开，请连接后重试")
                return
            }
            store.assistantOnly = false
            sceneSession?.workbenchChatId = chatId
            store.activateWorkspaceChat(chatId)
        }
    }

}

/// Identity stays mounted; only the selected surface owns input, accessibility and presentation.
private struct PhoneSpaceVisibility: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content
            .environment(\.homeActive, active)
            .animation(JieboMotion.space(reduceMotion)) { surface in
                surface.opacity(active ? 1 : 0)
            }
            .allowsHitTesting(active)
            .accessibilityHidden(!active)
            .zIndex(active ? 1 : 0)
    }
}
