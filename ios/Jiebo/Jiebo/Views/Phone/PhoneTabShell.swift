import SwiftUI

/// iPhone 的三个一级空间。TabView 直接使用 iOS 26 系统栏与 Liquid Glass。
struct PhoneTabShell: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var router = PhoneRouter()

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.selectedTab) {
            Tab("小驳", systemImage: NavigationIconId.assistant.symbol, value: PhoneTab.assistant) {
                PhoneShell()
            }

            Tab("待处理", systemImage: "tray", value: PhoneTab.inbox) {
                NavigationStack(path: $router.inboxPath) {
                    InboxHome()
                        .navigationDestination(for: InboxRoute.self) { route in
                            switch route {
                            case .item(let id):
                                InboxDetailView(itemId: id)
                            }
                        }
                }
            }
            .badge(store.assistantBadgeCount)

            Tab("消息", systemImage: "bubble.left.and.bubble.right", value: PhoneTab.messages) {
                ChatHome()
            }
            .badge(im.totalUnread)
        }
        .environment(router)
        .environment(\.openDelegation, { [router = self.router] id in
            router.delegationDetail = DelegationRef(id: id)
        })
        .accessibilityHidden(store.previewPanelOpen)
        .sheet(item: $router.delegationDetail) { ref in
            DelegationDetailSheet(delegationId: ref.id)
        }
        .overlay {
            if store.previewPanelOpen, let tab = store.activePreviewTab {
                ZStack {
                    Color.black.opacity(0.28)
                        .ignoresSafeArea()
                        .onTapGesture { store.collapsePreview() }
                        .accessibilityHidden(true)
                    PreviewPanelView(tab: tab)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(JieboColor.white)
                        .transition(.move(edge: .trailing))
                }
                .zIndex(3)
            }
        }
        .animation(JieboMotion.panel(reduceMotion), value: store.previewPanelOpen)
        .onAppear {
            synchronizeSelectedTab()
            dispatchPush()
        }
        .onChange(of: router.selectedTab) { _, _ in
            synchronizeSelectedTab()
        }
        .onChange(of: router.bootstrapped) { _, ready in
            if ready { dispatchPush() }
        }
        .onChange(of: PushRouting.shared.pending) { _, _ in
            dispatchPush()
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantCaptureOpenRequested)) { _ in
            router.popToRoot()
            store.openAssistantChat()
        }
    }

    private func synchronizeSelectedTab() {
        let messages = router.selectedTab == .messages
        store.assistantOnly = !messages
        im.setHomeVisible(messages)
        if !messages, router.bootstrapped {
            store.openAssistantChat()
        }
    }

    /// iPhone 推送只在这里消费，避免主页层与小驳空间重复取走 pending。
    private func dispatchPush() {
        guard let target = PushRouting.shared.pending else { return }
        if target.isIm, let convId = target.convId {
            _ = PushRouting.shared.consume()
            router.selectedTab = .messages
            openConversation(convId)
            return
        }
        if target.isWorkspace, let chatId = target.chatId {
            _ = PushRouting.shared.consume()
            router.selectedTab = .messages
            openWorkspace(chatId)
            return
        }

        guard router.bootstrapped else { return }
        router.selectedTab = target.kind == "approval" ? .inbox : .assistant
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
        Task { @MainActor in
            store.requestWorkspaceAgents()
            while store.workspaceAgent(chatId: chatId) == nil, !store.workspaceAgentsLoaded {
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled else { return }
            }
            guard let item = store.workspaceAgent(chatId: chatId) else { return }
            store.chatHomeDestination = .workspace(item.path)
            store.enterWorkspaceThread(path: item.path, chatId: chatId)
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
