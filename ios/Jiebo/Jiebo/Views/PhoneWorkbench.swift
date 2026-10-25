import SwiftUI

/// iPad 窄窗（compact）：打开就是当前对话。iPhone 不再进入这里，改走 PhoneShell（纯个人助理）。
/// 抽屉分三层：助理（全局，不属于任何工作区）→ 当前工作区（切换、工具、对话）→ 底部设置菜单。
/// 切换工作区、主题、统计这些表单挂在这里而不是抽屉上——抽屉一关，挂在它身上的 sheet 会跟着消失。
struct PhoneWorkbench: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.sceneSessionState) private var sceneSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
                    newChat: { closeDrawer(then: store.openNewChat) },
                    openSettings: { closeDrawer { settingsOpen = true } },
                    renameChat: { chat in closeDrawer { chatActions.beginRename(chat) } },
                    deleteChat: { chat in closeDrawer { chatActions.delete = chat } }
                )
                .transition(.move(edge: .leading))
                .accessibilityHidden(previewPanelOpen)
                .accessibilityAddTraits(.isModal)
                .accessibilityAction(.escape) { closeDrawer() }
            }
            if previewPanelOpen, let tab = activePreviewTab {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { closePreview() }
                    .transition(.opacity)
                    .accessibilityHidden(true)
                PreviewPanelView(tab: tab)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(JieboColor.white)
                    .transition(.move(edge: .trailing))
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
                        switch route {
                        case .memory: AssistantMemoryScreen()
                        case .connections: DeviceConnectionsScreen()
                        default: EmptyView()
                        }
                    }
            }
        }
        .chatActionAlerts($chatActions)
        .task { preferRunningChat() }
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
        let running = store.currentWorkspaceChats.first {
            store.runningChatIds.contains($0.id) || $0.turns.contains(where: \.running)
        }
        if let running, running.id != store.activeId {
            store.select(running.id)
        }
    }
}
private struct PhoneDrawer: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var close: () -> Void
    var openWorkspaces: () -> Void
    var newChat: () -> Void
    var openSettings: () -> Void
    var renameChat: (ChatSession) -> Void
    var deleteChat: (ChatSession) -> Void

    private var loopLive: Bool {
        guard let row = store.loops[store.activeId] else { return false }
        return row.status == "armed" || row.status == "running"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            brandBar

            AssistantEntryRow {
                store.openAssistantEntry()
                close()
            }
            .padding(.horizontal, 12)

            Rectangle()
                .fill(JieboColor.line)
                .frame(height: 1)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

            workspaceCard
                .padding(.horizontal, 12)

            toolStrip
                .padding(.horizontal, 8)
                .padding(.top, 6)

            chatsHeader
                .padding(.top, 14)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if store.currentWorkspaceChats.isEmpty {
                        Text("这个工作区还没有对话")
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.dim)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 10)
                    } else {
                        ForEach(store.currentWorkspaceChats) { chat in
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

    private var linkStatus: some View {
        HStack(spacing: 6) {
            LinkStatusDot(state: store.linkState, size: 8)
                .accessibilityHidden(true)
            Text(store.linkState.title)
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
        }
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
                    Text("当前工作区")
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                    Text(store.currentWorkspaceName)
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
        .accessibilityLabel("当前工作区，\(store.currentWorkspaceName)")
        .accessibilityHint("切换到别的工作区")
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
            Text("工作区对话")
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
        let selected = chat.id == store.activeId
        let live = chat.turns.contains(where: \.running) || store.runningChatIds.contains(chat.id)
        return Button {
            store.select(chat.id)
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
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(selected ? JieboColor.pine.opacity(0.42) : Color.clear, lineWidth: 1)
            )
            .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 10, style: .continuous))
            .hoverEffect(.highlight)
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel([
            chat.title,
            selected ? "当前工作区会话" : nil,
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
                    Label("账户与设置", systemImage: NavigationIconId.account.symbol)
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
            .accessibilityLabel(im.totalUnread > 0 ? "账户与设置，聊天有 \(im.totalUnread) 条未读" : "账户与设置")
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
