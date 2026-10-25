import SwiftUI
import UIKit

/// 旧版 iPad 双主页存储值。保留它只为平滑迁移和兼容旧设置入口。
enum HomeMode: String, CaseIterable, Identifiable {
    case workbench
    case chat

    static let storageKey = "jiebo.homeMode"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .workbench: return "工作台"
        case .chat: return "聊天"
        }
    }

    var symbol: String {
        switch self {
        case .workbench: return "rectangle.3.group"
        case .chat: return "bubble.left.and.bubble.right"
        }
    }
}

private struct HomeActiveKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    /// 这一层主页现在在前面。藏起来的那层别弹全屏盖子
    var homeActive: Bool {
        get { self[HomeActiveKey.self] }
        set { self[HomeActiveKey.self] = newValue }
    }
}

/// iPhone 继续走原三 Tab；iPad 使用 scene-local PadRouter 驱动三个正式业务域。
struct HomeShell: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(DeviceBridgeCoordinator.self) private var deviceBridge
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.sceneSessionState) private var sceneSession
    @State private var padRouter = PadRouter()
    @State private var fallbackSceneToken = UUID().uuidString

    private var sceneToken: String { sceneSession?.token ?? fallbackSceneToken }

    var body: some View {
        Group {
            if UIDevice.current.userInterfaceIdiom == .phone {
                PhoneTabShell()
            } else {
                padHomes
            }
        }
        // iPhone、iPad 共用唯一确认承载点；只要主页在线就能安全声明 device_bridge。
        .sheet(item: confirmationBinding) { draft in
            DeviceWriteConfirmationSheet(draft: draft)
        }
        .sheet(isPresented: mailDraftPresented) {
            if let draft = deviceBridge.mailDraft {
                MailDraftComposer(draft: draft) {
                    deviceBridge.dismissMailDraft()
                }
            }
        }
        .onAppear {
            deviceBridge.setConfirmationPresenter(token: sceneToken, active: scenePhase == .active)
        }
        .onDisappear {
            deviceBridge.removeConfirmationPresenter(token: sceneToken)
        }
        .onChange(of: scenePhase) { _, phase in
            deviceBridge.setConfirmationPresenter(token: sceneToken, active: phase == .active)
        }
    }

    private var confirmationBinding: Binding<DeviceWriteConfirmation?> {
        Binding(
            get: {
                deviceBridge.isConfirmationPresenter(token: sceneToken)
                    ? deviceBridge.confirmation
                    : nil
            },
            set: { value in
                if value == nil, deviceBridge.confirmation != nil {
                    deviceBridge.resolveConfirmation(allowed: false)
                }
            }
        )
    }

    private var mailDraftPresented: Binding<Bool> {
        Binding(
            get: {
                deviceBridge.isConfirmationPresenter(token: sceneToken) &&
                    deviceBridge.mailDraft != nil
            },
            set: { shown in
                if !shown { deviceBridge.dismissMailDraft() }
            }
        )
    }

    private var padHomes: some View {
        @Bindable var router = padRouter
        return Group {
            switch router.domain {
            case .assistant:
                PadAssistantShell()
            case .workbench:
                WorkbenchView()
                    .environment(\.homeActive, true)
            case .messages:
                ChatHome()
                    .environment(\.homeActive, true)
            }
        }
        // 当前域才挂载：工作台、聊天和小驳不会同时留下多个可编辑 Composer。
        .safeAreaInset(edge: .bottom, spacing: 0) {
            PadDomainSwitcher()
        }
        .environment(router)
        .environment(\.openDelegation, { padRouter.openDelegation($0) })
        .environment(\.openPadDomain, { padRouter.openDomain($0) })
        .environment(\.assistantSceneToken, sceneToken)
        .focusedSceneValue(\.padCommandActions, padCommandActions)
        .onAppear {
            AssistantScenePresenter.shared.register(token: sceneToken, active: scenePhase == .active)
            bootstrapPadRouter()
            dispatchPush()
        }
        .onDisappear {
            AssistantScenePresenter.shared.unregister(token: sceneToken)
        }
        .onChange(of: router.domain) { _, next in
            // Preview 属于当前业务域；切域时关闭，避免工作台、小驳、消息互相带入旧页签。
            sceneSession?.dismissPreview()
            padRouter.restoreAfterPreview()
            // 只保存以后新场景的默认值；现有场景不观察它，因此不会被其它窗口带着切域。
            UserDefaults.standard.set(next.rawValue, forKey: PadDomain.storageKey)
            im.setHomeVisible(next == .messages)
        }
        .onChange(of: scenePhase) { _, phase in
            AssistantScenePresenter.shared.update(token: sceneToken, active: phase == .active)
            if phase == .active { dispatchPush() }
        }
        .onChange(of: PushRouting.shared.pending) { _, _ in
            dispatchPush()
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantCaptureOpenRequested)) { _ in
            guard AssistantScenePresenter.shared.isPresenter(token: sceneToken) else { return }
            router.openAssistant()
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantVoiceRequested)) { notification in
            guard AssistantScenePresenter.shared.isPresenter(token: sceneToken) else { return }
            guard let capture = notification.object as? AssistantCaptureBridge.Capture else { return }
            router.queueVoice(capture)
        }
    }

    private var padCommandActions: PadCommandActions {
        PadCommandActions(
            openDomain: { padRouter.openDomain($0) },
            openSection: { section in
                padRouter.openAssistant(
                    section: section,
                    selection: section == .today ? .assistantChat : nil
                )
            },
            search: {
                switch padRouter.domain {
                case .assistant:
                    if padRouter.assistantSection == .memory {
                        postSceneCommand(.padSceneSearchRequested)
                    } else {
                        padRouter.presentSearch()
                    }
                case .workbench:
                    store.openWorkspaceSwitcher()
                case .messages:
                    postSceneCommand(.padSceneSearchRequested)
                }
            },
            create: {
                switch padRouter.domain {
                case .assistant:
                    padRouter.openAssistant()
                    Task { @MainActor in
                        await Task.yield()
                        postSceneCommand(.assistantComposerFocusRequested)
                    }
                case .workbench:
                    store.openNewChat()
                    sceneSession?.workbenchChatId = store.activeId
                case .messages:
                    if let sceneSession {
                        sceneSession.chatDestination = nil
                    } else {
                        store.chatHomeDestination = nil
                    }
                    postSceneCommand(.padSceneSearchRequested)
                }
            },
            openFile: {
                guard padRouter.domain == .workbench else {
                    store.flash("请先切到工作台再打开文件")
                    return
                }
                store.toggleFileBrowser()
            },
            refresh: {
                switch padRouter.domain {
                case .assistant: store.requestAssistant(memory: padRouter.assistantSection == .memory)
                case .workbench: store.requestStateReload()
                case .messages: im.refreshList()
                }
            },
            closeOverlay: {
                if sceneSession?.previewKey != nil {
                    sceneSession?.dismissPreview()
                } else if padRouter.inspectorPresented {
                    padRouter.dismissInspector()
                } else {
                    padRouter.searchPresented = false
                }
            },
            previous: { padRouter.navigateSectionHistory(by: -1) },
            next: { padRouter.navigateSectionHistory(by: 1) },
            toggleSidebar: { postSceneCommand(.padSceneSidebarToggleRequested) }
        )
    }

    private func postSceneCommand(_ name: Notification.Name) {
        NotificationCenter.default.post(
            name: name,
            object: PadSceneCommandDelivery(sceneToken: sceneToken)
        )
    }

    private func bootstrapPadRouter() {
        guard !padRouter.bootstrapped else { return }
        let saved = UserDefaults.standard.string(forKey: PadDomain.storageKey)?.nilIfEmpty
        let legacy = UserDefaults.standard.string(forKey: HomeMode.storageKey)
        let migrated = PadRouter.migratedDomain(padRawValue: saved, legacyRawValue: legacy)
        padRouter.domain = migrated
        UserDefaults.standard.set(migrated.rawValue, forKey: PadDomain.storageKey)
        padRouter.bootstrapped = true
        if sceneSession?.workbenchChatId == nil {
            sceneSession?.workbenchChatId = store.activeId
        }
        // iPad 不启用 iPhone 的 activeId 限制；小驳始终显式绑定 assistantChatId。
        store.assistantOnly = false
        im.setHomeVisible(migrated == .messages)
    }

    /// iPad 点通知：先映射业务域，再在助理状态刷新后定位实体；不再消费后丢弃。
    private func dispatchPush() {
        guard padRouter.bootstrapped,
              AssistantScenePresenter.shared.isPresenter(token: sceneToken),
              let target = PushRouting.shared.consume()
        else { return }
        if target.isIm, let convId = target.convId {
            padRouter.route(target)
            openConversation(convId)
            return
        }
        if target.isWorkspace, let chatId = target.chatId {
            padRouter.route(target)
            openWorkspace(chatId)
            return
        }
        let needsResolution = target.delegationId != nil || target.itemId != nil
        if needsResolution,
           let resolution = PadRouter.resolveAssistantTarget(target, state: store.assistantState) {
            padRouter.route(target, presentSelection: false)
            applyAssistantPushResolution(resolution)
            return
        }
        // 冷启动先只进入业务域/列表；明确找到实体后才呈现 Inspector，避免闪出“内容已失效”。
        padRouter.route(target, presentSelection: !needsResolution)
        Task { @MainActor in
            await resolveAssistantPush(target)
        }
    }

    @MainActor
    private func resolveAssistantPush(_ target: PushTarget) async {
        guard target.delegationId != nil || target.itemId != nil else {
            store.requestAssistant(force: true)
            return
        }

        let baselineRevision = store.assistantStateRevision
        let maximumAttempts = 16
        store.requestAssistant(force: true)
        for _ in 0..<maximumAttempts {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }

            if let resolution = PadRouter.resolveAssistantTarget(target, state: store.assistantState) {
                applyAssistantPushResolution(resolution)
                return
            }

            // 收到明确的新 assistant_state 且目标仍不存在，可以安全降级；否则继续有界重试。
            if store.assistantStateRevision > baselineRevision { break }
        }

        padRouter.select(nil)
        if target.delegationId != nil {
            store.flash("这项委派已失效，已打开任务列表")
        } else {
            store.flash("这条通知对应的内容已失效，已打开相关列表")
        }
    }

    private func applyAssistantPushResolution(_ resolution: PadAssistantTargetResolution) {
        switch resolution {
        case .delegation(let id):
            padRouter.openDelegation(id)
        case .inboxItem(let id):
            if let item = store.assistantState?.inbox.first(where: { $0.id == id }) {
                store.markInboxRead(item)
            }
            padRouter.openAssistant(section: .inbox, selection: .inboxItem(id))
        case .task(let id):
            padRouter.openAssistant(section: .tasks, selection: .task(id))
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
            if let sceneSession {
                sceneSession.chatDestination = .workspace(item.path)
            } else {
                store.chatHomeDestination = .workspace(item.path)
            }
            store.prepareWorkspaceThread(item, chatId: chatId)
        }
    }

    /// 冷启动时自己的 id 可能还没读出来：等一会儿再算对方是谁
    private func openConversation(_ convId: String) {
        Task { @MainActor in
            var waited = 0
            while ImConv.peer(of: convId, me: im.meId) == nil, waited < 80 {
                try? await Task.sleep(for: .milliseconds(100))
                waited += 1
            }
            guard let peer = ImConv.peer(of: convId, me: im.meId) else { return }
            if let sceneSession {
                sceneSession.chatDestination = .person(peer)
            } else {
                store.chatHomeDestination = .person(peer)
            }
        }
    }
}

private struct PadDomainSwitcher: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(PadRouter.self) private var router

    var body: some View {
        HStack(spacing: 4) {
            domainButton(.assistant, badge: store.assistantBadgeCount, shortcut: "1")
            domainButton(.workbench, badge: store.workspaceUnreadCount, shortcut: "2")
            domainButton(.messages, badge: im.totalUnread, shortcut: "3")
        }
        .padding(4)
        .jieboGlass(in: Capsule(), interactive: true)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(JieboColor.paper.opacity(0.94))
    }

    private func domainButton(_ domain: PadDomain, badge: Int, shortcut: Character) -> some View {
        Button {
            router.openDomain(domain)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: domain.symbol)
                    .accessibilityHidden(true)
                Text(domain.title)
                    .lineLimit(1)
                if badge > 0 {
                    ImUnreadBadge(count: badge)
                }
            }
            .font(JieboFont.text(.subheadline, weight: .semibold))
            .foregroundStyle(router.domain == domain ? JieboColor.pine : JieboColor.ink2)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 40)
            .background {
                if router.domain == domain {
                    Capsule().fill(JieboColor.white.opacity(0.72))
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(badge > 0 ? "\(domain.title)，\(badge) 项未读或待处理" : domain.title)
        .accessibilityHint(Text(verbatim: "切换到\(domain.title)，快捷键 Command \(shortcut)"))
        .accessibilityAddTraits(router.domain == domain ? .isSelected : [])
    }
}

/// 旧设置入口仍可切换工作台 / 消息；iPad 底部域切换是始终可见的主入口。
struct HomeModeSection: View {
    @AppStorage(HomeMode.storageKey) private var mode: HomeMode = .workbench
    @Environment(\.openPadDomain) private var openPadDomain
    var onPick: (HomeMode) -> Void = { _ in }

    var body: some View {
        Section {
            ForEach(HomeMode.allCases) { item in
                Button {
                    mode = item
                    openPadDomain?(item == .workbench ? .workbench : .messages)
                    onPick(item)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: item.symbol)
                            .font(JieboFont.text(.subheadline, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                            .frame(width: 24)
                        Text(item.title)
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                        Spacer(minLength: 8)
                        if mode == item {
                            Image(systemName: "checkmark")
                                .font(JieboFont.text(.subheadline, weight: .semibold))
                                .foregroundStyle(JieboColor.pine)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(JieboColor.white)
                .accessibilityAddTraits(mode == item ? .isSelected : [])
            }
        } header: {
            Text("iPad 默认空间（兼容设置）")
        } footer: {
            Text("iPad 可随时用底部的「小驳 / 工作台 / 消息」切换；这里保留旧版工作台与聊天偏好。")
        }
    }
}

/// 聊天未读的红色数字（≥1000 显示 999+）
struct ImUnreadBadge: View {
    var count: Int

    var body: some View {
        Text(ImFormat.badge(count))
            .font(JieboFont.text(.caption2, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .frame(minWidth: 16, minHeight: 16)
            .background(JieboColor.danger)
            .clipShape(Capsule())
            .accessibilityHidden(true)
    }
}
