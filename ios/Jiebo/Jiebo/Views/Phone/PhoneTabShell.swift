import SwiftUI
import UIKit

/// iPhone 的三个大模块：小驳、工作台、即时消息。底部同一条空间栏切换。
struct PhoneTabShell: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.sceneSessionState) private var sceneSession
    @State private var router = PhoneRouter()
    @State private var fallbackSceneToken = UUID().uuidString
    @State private var keyboardUp = false

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
        VStack(spacing: 0) {
        ZStack {
            PhoneShell()
                .environment(\.assistantVoicePresenterActive, router.selectedTab == .assistant)
                .opacity(router.selectedTab == .assistant ? 1 : 0)
                .allowsHitTesting(router.selectedTab == .assistant)
                .accessibilityHidden(router.selectedTab != .assistant)
            if router.selectedTab == .workspace {
                PhoneWorkbench(embedsPreview: false)
            }
            if router.selectedTab == .messages {
                ChatHome()
            }
        }
        .environment(router)
        .environment(\.switchPhoneSpace, { [router] tab in
            router.openSpace(tab)
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
            if spaceBarVisible {
                PhoneSpaceBar(selection: router.selectedTab) { tab in
                    router.openSpace(tab)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(JieboMotion.panel(reduceMotion), value: spaceBarVisible)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardUp = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardUp = false
        }
        .fullScreenCover(isPresented: workspaceFilesPresented) {
            FileBrowserCover()
        }
        .onAppear {
            AssistantScenePresenter.shared.register(token: sceneToken, active: scenePhase == .active)
            synchronizeSelectedTab()
            dispatchPush()
            dispatchWidgetDeepLink()
        }
        .onDisappear {
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
            if router.selectedTab != .workspace {
                router.selectedTab = .workspace
            }
            if !(store.fileBrowserOpen && store.fileBrowserPane == .files) {
                store.toggleFileBrowser(.files)
            }
        }
        .onChange(of: store.workbenchTerminalRequest) { _, _ in
            if router.selectedTab != .workspace {
                router.selectedTab = .workspace
            }
        }
        .onChange(of: store.returnToAssistantRequest) { _, _ in
            router.popToRoot()
        }
        .onChange(of: router.selectedTab) { old, new in
            if old == .workspace, new != .workspace {
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
            store.openAssistantChat()
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantVoiceRequested)) { notification in
            guard AssistantScenePresenter.shared.isPresenter(token: sceneToken),
                  let capture = notification.object as? AssistantCaptureBridge.Capture
            else { return }
            router.queueVoice(capture)
            store.openAssistantChat()
        }
        .task(id: router.pendingVoiceCapture?.id) {
            guard let capture = router.takePendingVoice() else { return }
            await Task.yield()
            let delivery = AssistantVoiceDelivery(sceneToken: sceneToken, capture: capture)
            NotificationCenter.default.post(name: .assistantVoiceComposerRequested, object: delivery)
        }
    }

    private func synchronizeSelectedTab() {
        let messages = router.selectedTab == .messages
        store.assistantOnly = router.locksActiveChatToAssistant
        im.setHomeVisible(messages)
        if router.locksActiveChatToAssistant, router.bootstrapped {
            store.openAssistantChat()
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
        guard router.bootstrapped,
              let route = WidgetDeepLinkRouting.shared.consume(for: sceneToken)
        else { return }
        switch route {
        case .today:
            router.popToRoot()
            store.openAssistantChat()
        case .inbox:
            router.go(.inbox)
        case .todo:
            router.go(.worklist(.todo))
        }
    }

    /// iPhone 推送只在这里消费，避免主页层与小驳空间重复取走 pending。
    private func dispatchPush() {
        guard AssistantScenePresenter.shared.isPresenter(token: sceneToken),
              let target = PushRouting.shared.pending
        else { return }
        if target.isIm, let convId = target.convId {
            _ = PushRouting.shared.consume()
            router.selectedTab = .messages
            openConversation(convId)
            return
        }
        if target.isWorkspace, let chatId = target.chatId {
            _ = PushRouting.shared.consume()
            store.assistantOnly = false
            router.selectedTab = .workspace
            openWorkspace(chatId)
            return
        }

        guard router.bootstrapped else { return }
        if target.kind == "approval" {
            router.go(.inbox)
        } else {
            router.selectedTab = .assistant
        }
        Task { @MainActor in
            await consumeAssistantPush(target)
        }
    }

    @MainActor
    private func consumeAssistantPush(_ target: PushTarget) async {
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
        if let itemId = target.itemId,
           let item = store.assistantState?.inbox.first(where: { $0.id == itemId }) {
            store.markInboxRead(item)
        }
        if target.kind == "approval" {
            router.go(.inbox)
        } else if target.delegationId != nil || target.chatId != nil {
            router.open(chatId: target.chatId, delegationId: target.delegationId, store: store)
        } else {
            router.popToRoot()
        }
    }

    private func openWorkspace(_ chatId: String) {
        store.assistantOnly = false
        Task { @MainActor in
            var waited = 0
            var nudged = false
            while !store.isWorkspaceChat(chatId), waited < 40 {
                if !nudged, let item = store.workspaceAgent(chatId: chatId) {
                    store.switchWorkspace(to: item.path)
                    nudged = true
                }
                try? await Task.sleep(for: .milliseconds(100))
                waited += 1
                guard !Task.isCancelled else { return }
            }
            guard store.isWorkspaceChat(chatId) else { return }
            store.assistantOnly = false
            sceneSession?.workbenchChatId = chatId
            store.activateWorkspaceChat(chatId)
        }
    }

    /// 根页且键盘没收起时才占底部。二级页、预览和全屏文件都不挤输入框。
    private var spaceBarVisible: Bool {
        if keyboardUp || previewPanelOpen || store.fileBrowserOpen { return false }
        switch router.selectedTab {
        case .assistant:
            return router.path.isEmpty
        case .workspace:
            return !router.workbenchDrawerOpen && store.toolLayer == nil
        case .messages:
            let destination = sceneSession?.chatDestination ?? store.chatHomeDestination
            return destination == nil
        }
    }

    private func openConversation(_ convId: String) {
        Task { @MainActor in
            var waited = 0
            while ImConv.peer(of: convId, me: im.meId) == nil, waited < 80 {
                try? await Task.sleep(for: .milliseconds(100))
                waited += 1
            }
            guard let peer = ImConv.peer(of: convId, me: im.meId) else { return }
            im.selectedPeer = peer
            store.chatHomeDestination = .person(peer)
        }
    }
}

/// 三个空间共用的底部胶囊。角标各自只报本空间的事。
private struct PhoneSpaceBar: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    var selection: PhoneTab
    var select: (PhoneTab) -> Void

    var body: some View {
        HStack(spacing: 4) {
            spaceButton(.assistant, title: "小驳", symbol: NavigationIconId.assistant.symbol, badge: store.assistantBadgeCount, attention: true)
            spaceButton(.workspace, title: "工作台", symbol: "rectangle.3.group", badge: store.workspaceUnreadCount, attention: false)
            spaceButton(.messages, title: "消息", symbol: "bubble.left.and.bubble.right", badge: im.totalUnread, attention: false)
        }
        .padding(4)
        .jieboGlass(in: Capsule(), interactive: true)
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(JieboColor.paper)
        .overlay(alignment: .top) {
            Rectangle().fill(JieboColor.line).frame(height: 1)
        }
    }

    private func spaceButton(_ tab: PhoneTab, title: String, symbol: String, badge: Int, attention: Bool) -> some View {
        let selected = selection == tab
        return Button {
            select(tab)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .accessibilityHidden(true)
                Text(title)
                    .lineLimit(1)
                if badge > 0 {
                    ImUnreadBadge(count: badge)
                }
            }
            .font(JieboFont.text(.subheadline, weight: .semibold))
            .foregroundStyle(selected ? JieboColor.pine : JieboColor.ink2)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background {
                if selected {
                    Capsule().fill(JieboColor.white.opacity(0.72))
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(badgeLabel(title, badge: badge, attention: attention))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func badgeLabel(_ title: String, badge: Int, attention: Bool) -> String {
        guard badge > 0 else { return title }
        let status = attention
            ? StatusLegendId.attention.accessibilityLabel(count: badge)
            : StatusLegendId.unread.accessibilityLabel(count: badge)
        return "\(title)，\(status)"
    }
}
