import SwiftUI

/// iPad 窄窗，以及 iPhone 的「工作区」页：打开就是当前工作区对话。
/// 抽屉只放工作区：当前工作区（切换、工具、对话）→ 底部设置菜单。
/// iPhone 的预览由外层 PhoneTabShell 盖住，这里不再叠一层。
struct PhoneWorkbench: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.sceneSessionState) private var sceneSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var embedsPreview = true
    @State private var drawerOpen = false
    @State private var preferredRunning = false
    @State private var settingsOpen = false
    @State private var chatActions = ChatActionTargets()

    private var activePreviewTab: PreviewTab? {
        if let sceneSession { return sceneSession.previewTab(in: store) }
        return store.activePreviewTab
    }

    private var previewPanelOpen: Bool {
        sceneSession != nil ? activePreviewTab != nil : store.previewPanelOpen
    }

    private func closePreview() {
        if let sceneSession { sceneSession.dismissPreview() }
        else { store.collapsePreview() }
    }

    var body: some View {
        @Bindable var store = store
        ZStack(alignment: .leading) {
            ThreadView(
                chrome: .phoneLegacy,
                chatId: sceneSession?.workbenchChatId,
                openDrawer: {
                withAnimation(JieboMotion.panel(reduceMotion)) { drawerOpen = true }
            })
            .background { WorkbenchShortcuts() }
            .accessibilityHidden(previewPanelOpen || drawerOpen)
            if let layer = store.toolLayer {
                ToolLayerOverlay(layer: layer)
                    .id(layer)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                    .accessibilityHidden(previewPanelOpen || drawerOpen)
            }
            if drawerOpen {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { closeDrawer() }
                    .accessibilityLabel("关闭菜单")
                    .accessibilityAddTraits(.isButton)
                    .transition(.opacity)
                PhoneDrawer(
                    close: closeDrawer,
                    openWorkspaces: { closeDrawer(then: store.openWorkspaceSwitcher) },
                    newChat: { closeDrawer(then: {
                        store.openNewChat(in: store.workspacePath(anchoredTo: sceneSession?.workbenchChatId))
                        sceneSession?.workbenchChatId = store.activeId
                    }) },
                    openSettings: { closeDrawer { settingsOpen = true } },
                    renameChat: { chat in closeDrawer { chatActions.beginRename(chat) } },
                    deleteChat: { chat in closeDrawer { chatActions.delete = chat } }
                )
                .transition(.jieboPanel(from: .leading, reduceMotion: reduceMotion))
                .accessibilityHidden(previewPanelOpen)
                .accessibilityAddTraits(.isModal)
                .accessibilityAction(.escape) { closeDrawer() }
            }
            if embedsPreview, previewPanelOpen, let tab = activePreviewTab {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { closePreview() }
                    .transition(.opacity)
                    .accessibilityHidden(true)
                PreviewPanelView(tab: tab)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(JieboColor.white)
                    .transition(.jieboPanel(from: .trailing, reduceMotion: reduceMotion))
                    .zIndex(3)
            }
        }
        .animation(JieboMotion.panel(reduceMotion), value: store.toolLayer)
        .animation(JieboMotion.panel(reduceMotion), value: drawerOpen)
        .animation(JieboMotion.panel(reduceMotion), value: previewPanelOpen)
        .sheet(isPresented: $store.workspaceSheetOpen) {
            WorkspacePickerSheet()
        }
        .sheet(isPresented: $settingsOpen) {
            NavigationStack {
                PhoneSettingsScreen()
                    .navigationDestination(for: PhoneRoute.self) { route in
                        PhoneSettingsDestination(route: route)
                    }
            }
        }
        .chatActionAlerts($chatActions)
        .task { preferRunningChat() }
        .onChange(of: store.activeId) { _, _ in adoptWorkbenchChatIfNeeded() }
        .onChange(of: store.chats.count) { _, _ in adoptWorkbenchChatIfNeeded() }
    }

    private func closeDrawer() {
        withAnimation(JieboMotion.panel(reduceMotion)) { drawerOpen = false }
    }

    /// 先收抽屉再弹表单：两段动画叠在一起时 sheet 会从半透明遮罩上冒出来，看着像卡顿
    private func closeDrawer(then action: @escaping () -> Void) {
        withAnimation(JieboMotion.panel(reduceMotion)) {
            drawerOpen = false
        } completion: {
            action()
        }
    }

    /// 这个工作区里如果有正在跑的会话，打开时优先它。只做一次，不抢后来的手动切换。
    private func preferRunningChat() {
        guard !preferredRunning else { return }
        preferredRunning = true
        adoptWorkbenchChatIfNeeded()
        let anchor = sceneSession?.workbenchChatId
        let running = store.workspaceChats(anchoredTo: anchor).first {
            store.chatShowsRunning($0)
        }
        guard let running else { return }
        if running.id != anchor {
            sceneSession?.workbenchChatId = running.id
        }
        if running.id != store.activeId {
            store.select(running.id)
        }
    }

    /// 工作台还停在助理会话或空占位时，换成上次打开的子工作区。已经在子工作区里就不抢。
    /// 窗口记下的会话还要成为活动会话，文件列表才会落在这个工作区，而不是用户根目录。
    private func adoptWorkbenchChatIfNeeded() {
        guard let sceneSession else { return }
        if let current = sceneSession.workbenchChatId, store.isWorkspaceChat(current) {
            store.activateWorkspaceChat(current)
            return
        }
        guard let id = store.preferredWorkspaceChatId() else { return }
        sceneSession.workbenchChatId = id
        store.activateWorkspaceChat(id)
    }
}
private struct PhoneDrawer: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(\.switchPhoneSpace) private var switchPhoneSpace
    @Environment(\.sceneSessionState) private var sceneSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var close: () -> Void
    var openWorkspaces: () -> Void
    var newChat: () -> Void
    var openSettings: () -> Void
    var renameChat: (ChatSession) -> Void
    var deleteChat: (ChatSession) -> Void

    private var workspaceAnchor: String? { sceneSession?.workbenchChatId }
    private var workspaceChats: [ChatSession] { store.workspaceChats(anchoredTo: workspaceAnchor) }
    private var workspaceTitle: String { store.workspaceTitle(anchoredTo: workspaceAnchor) }
    private var selectedChatId: String { sceneSession?.workbenchChatId ?? store.activeId }

    private var loopLive: Bool {
        guard let row = store.loops[selectedChatId] else { return false }
        return row.status == "armed" || row.status == "running"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            brandBar
            if switchPhoneSpace != nil {
                spaceSwitch
            }

            workspaceCard
                .padding(.horizontal, 12)

            toolStrip
                .padding(.horizontal, 8)
                .padding(.top, 6)

            chatsHeader
                .padding(.top, 14)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if workspaceChats.isEmpty {
                        Text("这里还没有对话")
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.dim)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 10)
                    } else {
                        ForEach(workspaceChats) { chat in
                            chatRow(chat)
                        }
                    }
                }
                .padding(.bottom, 12)
            }

            footer
        }
        .frame(width: 300)
        .frame(maxHeight: .infinity)
        .background(JieboColor.sidebar.ignoresSafeArea())
        .overlay(alignment: .trailing) {
            Rectangle().fill(JieboColor.line).frame(width: 1).ignoresSafeArea()
        }
        .gesture(
            DragGesture(minimumDistance: 20)
                .onEnded { value in
                    if value.translation.width < -60 { close() }
                }
        )
    }

    // MARK: 品牌行（只是标识，不可点）

    private var brandBar: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    brandIdentity
                    linkStatus
                }
            } else {
                HStack(spacing: 10) {
                    brandIdentity
                    Spacer(minLength: 8)
                    linkStatus
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .accessibilityElement(children: .combine)
    }

    private var brandIdentity: some View {
        HStack(spacing: 10) {
            JieboMark(size: 22)
            Text("接驳")
                .font(JieboFont.display(17))
                .tracking(0.34)
                .foregroundStyle(JieboColor.ink)
        }
    }

    @ViewBuilder
    private var linkStatus: some View {
        let label = HStack(spacing: 6) {
            LinkStatusDot(state: store.linkState, size: 8)
                .accessibilityHidden(true)
            Text(store.linkState.title)
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
        }
        if store.linkState == .offline {
            Button {
                store.retryConnection()
            } label: {
                label.frame(minHeight: 44, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("连接状态，\(store.linkState.title)")
            .accessibilityHint("重新连接")
        } else {
            label.accessibilityLabel("连接状态，\(store.linkState.title)")
        }
    }

    /// 只有 iPhone 注入了模块切换。从工作台回到小驳，或去即时消息。
    private var spaceSwitch: some View {
        VStack(alignment: .leading, spacing: 0) {
            spaceRow(NavigationIconId.assistant.symbol, "切换到小驳") {
                switchPhoneSpace?(.assistant)
            }
            spaceRow("bubble.left.and.bubble.right", "切换到即时消息", badge: im.totalUnread) {
                switchPhoneSpace?(.messages)
            }
        }
        .padding(.bottom, 8)
    }

    private func spaceRow(_ symbol: String, _ title: String, badge: Int = 0, action: @escaping () -> Void) -> some View {
        Button {
            close()
            action()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(JieboFont.text(.callout, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(width: 24)
                Text(title)
                    .font(JieboFont.text(.callout, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                Spacer(minLength: 8)
                if badge > 0 {
                    ImUnreadBadge(count: badge)
                }
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(badge > 0 ? "\(title)，\(badge)" : title)
    }

    // MARK: 当前工作区

    private var workspaceCard: some View {
        Button(action: openWorkspaces) {
            HStack(spacing: 10) {
                Image(systemName: NavigationIconId.workspace.symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(JieboColor.brass)
                    .frame(width: 30, height: 30)
                    .background(JieboColor.brass.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text("当前文件夹")
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                    Text(workspaceTitle)
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.up.chevron.down")
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .fill(JieboColor.white.opacity(0.4))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("当前文件夹，\(workspaceTitle)")
        .accessibilityHint("换一个文件夹")
    }

    private var toolStrip: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                LazyVGrid(columns: [
                    GridItem(.flexible(), spacing: 0),
                    GridItem(.flexible(), spacing: 0),
                    GridItem(.flexible(), spacing: 0)
                ], spacing: 0) {
                    ForEach(ToolLayer.workTools) { layer in
                        toolButton(layer)
                    }
                }
            } else {
                HStack(spacing: 0) {
                    ForEach(ToolLayer.workTools) { layer in
                        toolButton(layer)
                    }
                }
            }
        }
    }

    private func toolButton(_ layer: ToolLayer) -> some View {
        let on = store.toolSelected(layer)
        let marked = layer == .loop && loopLive
        return Button {
            store.toggleTool(layer)
            close()
        } label: {
            VStack(spacing: 4) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: layer.symbol)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(on ? JieboColor.pine : JieboColor.ink2)
                        .frame(width: 32, height: 32)
                        .background(on ? JieboColor.pine.opacity(0.12) : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .stroke(on ? JieboColor.pine.opacity(0.28) : JieboColor.line, lineWidth: 1)
                        )
                    Circle()
                        .fill(JieboColor.ok)
                        .frame(width: 7, height: 7)
                        .offset(x: 2, y: -2)
                        .opacity(marked ? 1 : 0)
                }
                Text(layer.title)
                    .font(JieboFont.text(.caption2, weight: on ? .semibold : .regular))
                    .foregroundStyle(on ? JieboColor.ink : JieboColor.dim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .animation(JieboMotion.fade(reduceMotion), value: on)
        .accessibilityLabel(marked ? "\(layer.title)，\(StatusLegendId.running.label)" : layer.title)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // MARK: 对话

    private var chatsHeader: some View {
        HStack(spacing: 8) {
            Text("对话")
                .font(JieboFont.text(.caption, weight: .medium))
                .tracking(0.6)
                .foregroundStyle(JieboColor.dim)
            Spacer(minLength: 8)
            Button(action: newChat) {
                Label("新对话", systemImage: "square.and.pencil")
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.pine)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 20)
        .padding(.trailing, 16)
    }

    private func chatRow(_ chat: ChatSession) -> some View {
        let selected = chat.id == selectedChatId
        let live = store.chatShowsRunning(chat)
        return Button {
            sceneSession?.workbenchChatId = chat.id
            store.rememberWorkspaceChat(chat.id)
            if chat.id != store.activeId { store.select(chat.id) }
            close()
        } label: {
            HStack(spacing: 8) {
                Capsule()
                    .fill(selected ? JieboColor.pine : Color.clear)
                    .frame(width: 3, height: 22)
                    .accessibilityHidden(true)
                Text(chat.title)
                    .font(JieboFont.text(.subheadline, weight: chat.unread ? .semibold : .regular))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if selected {
                    Text("当前")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(JieboColor.pine.opacity(0.12))
                        .clipShape(Capsule())
                        .accessibilityHidden(true)
                } else if !live, let touched = chat.touchedAt {
                    AgoLabel(epochMs: touched, font: JieboFont.text(.caption2))
                }
                if live {
                    Text("跑")
                        .font(JieboFont.text(.caption2, weight: .medium))
                        .foregroundStyle(JieboColor.run)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(JieboColor.runBg)
                        .clipShape(Capsule())
                } else if chat.unread {
                    Circle().fill(JieboColor.pine).frame(width: 6, height: 6)
                }
            }
            .foregroundStyle(JieboColor.ink)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(selected ? JieboColor.pine.opacity(0.1) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .stroke(selected ? JieboColor.pine.opacity(0.42) : Color.clear, lineWidth: 1)
            )
            .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .hoverEffect(.highlight)
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel([
            chat.title,
            selected ? "当前对话" : nil,
            live ? StatusLegendId.running.label : nil
        ].compactMap { $0 }.joined(separator: "，"))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .chatRowMenu(chat, rename: renameChat, delete: deleteChat)
    }

    // MARK: 底部设置（低频账号操作收进系统菜单）

    private var footer: some View {
        HStack {
            Button(action: openSettings) {
                HStack(spacing: 6) {
                    Label("设置", systemImage: NavigationIconId.account.symbol)
                        .font(JieboFont.text(.subheadline, weight: .medium))
                        .foregroundStyle(JieboColor.ink2)
                    if im.totalUnread > 0 {
                        ImUnreadBadge(count: im.totalUnread)
                    }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(im.totalUnread > 0 ? "设置，聊天有 \(im.totalUnread) 条未读" : "设置")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .overlay(alignment: .top) {
            Rectangle().fill(JieboColor.line).frame(height: 1)
        }
    }
}

/// 外接键盘快捷键由 PadAppCommands 集中注册；保留挂载点以兼容旧视图结构。
struct WorkbenchShortcuts: View {
    var body: some View {
        EmptyView()
    }
}
