import SwiftUI

/// iPhone（以及 iPad 上窄到 compact 的窗口）：打开就是当前对话。
/// 会话和工具入口在左边抽屉里。工作区列表从抽屉顶进入，主题只在那一页的最底下。
struct PhoneWorkbench: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawerOpen = false
    @State private var workspacesOpen = false
    @State private var preferredRunning = false

    var body: some View {
        ZStack(alignment: .leading) {
            ThreadView(phoneChrome: true, openDrawer: {
                withAnimation(JieboMotion.panel(reduceMotion)) { drawerOpen = true }
            })
            if let layer = store.toolLayer {
                ToolLayerOverlay(layer: layer)
                    .id(layer)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
            if drawerOpen {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { closeDrawer() }
                    .transition(.opacity)
                PhoneDrawer(close: closeDrawer, openWorkspaces: {
                    closeDrawer()
                    withAnimation(JieboMotion.panel(reduceMotion)) { workspacesOpen = true }
                })
                .transition(.move(edge: .leading))
            }
            if workspacesOpen {
                PhoneWorkspaceList(close: {
                    withAnimation(JieboMotion.panel(reduceMotion)) { workspacesOpen = false }
                })
                .transition(.move(edge: .trailing))
                .zIndex(2)
            }
            if store.previewPanelOpen, let tab = store.activePreviewTab {
                Color.black.opacity(0.28)
                    .ignoresSafeArea()
                    .onTapGesture { store.collapsePreview() }
                    .transition(.opacity)
                PreviewPanelView(tab: tab)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(JieboColor.white)
                    .transition(.move(edge: .trailing))
                    .zIndex(3)
            }
        }
        .animation(JieboMotion.panel(reduceMotion), value: store.toolLayer)
        .animation(JieboMotion.panel(reduceMotion), value: drawerOpen)
        .animation(JieboMotion.panel(reduceMotion), value: workspacesOpen)
        .animation(JieboMotion.panel(reduceMotion), value: store.previewPanelOpen)
        .task { preferRunningChat() }
    }

    private func closeDrawer() {
        withAnimation(JieboMotion.panel(reduceMotion)) { drawerOpen = false }
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
    var close: () -> Void
    var openWorkspaces: () -> Void

    private var loopLive: Bool {
        guard let row = store.loops[store.activeId] else { return false }
        return row.status == "armed" || row.status == "running"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: openWorkspaces) {
                HStack(spacing: 10) {
                    JieboMark(size: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("接驳")
                            .font(JieboFont.display(17))
                            .tracking(0.34)
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                        Text(store.connected ? store.currentWorkspaceName : "正在重连…")
                            .font(JieboFont.ui(12))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(JieboColor.dim)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("工作区列表")

            drawerRow("plus", "新对话", boxed: true) {
                store.openNewChat()
                close()
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(store.currentWorkspaceChats) { chat in
                        chatRow(chat)
                    }
                    Text("这个工作区")
                        .font(JieboFont.ui(11, weight: .medium))
                        .tracking(0.6)
                        .foregroundStyle(JieboColor.dim)
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                        .padding(.bottom, 4)
                    ForEach(ToolLayer.allCases) { layer in
                        toolRow(layer)
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .frame(maxWidth: 320)
        .frame(maxHeight: .infinity)
        .frame(width: 300)
        .background(JieboColor.sidebar.ignoresSafeArea())
        .overlay(alignment: .trailing) {
            Rectangle().fill(JieboColor.line).frame(width: 1)
        }
        .gesture(
            DragGesture(minimumDistance: 20)
                .onEnded { value in
                    if value.translation.width < -60 { close() }
                }
        )
    }

    private func chatRow(_ chat: ChatSession) -> some View {
        let selected = chat.id == store.activeId
        let live = chat.turns.contains(where: \.running) || store.runningChatIds.contains(chat.id)
        return Button {
            store.select(chat.id)
            close()
        } label: {
            HStack(spacing: 8) {
                Text(chat.title)
                    .font(JieboFont.ui(14, weight: chat.unread ? .semibold : .medium))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if live {
                    Text("跑")
                        .font(JieboFont.ui(10, weight: .medium))
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
            .frame(minHeight: 36)
            .background(selected ? JieboColor.white : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(selected ? JieboColor.line : Color.clear, lineWidth: 1)
            )
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(chat.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func toolRow(_ layer: ToolLayer) -> some View {
        let marked = (layer == .loop && loopLive) || (layer == .assistant && store.assistantBadgeCount > 0)
        return drawerRow(layer.symbol, layer.title, marked: marked, iconBox: true) {
            store.toggleTool(layer)
            close()
        }
    }

    private func drawerRow(_ symbol: String, _ title: String, marked: Bool = false, boxed: Bool = false, iconBox: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: iconBox ? 28 : 22, height: iconBox ? 28 : nil)
                    .overlay {
                        if iconBox {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(JieboColor.line, lineWidth: 1)
                        }
                    }
                Text(title)
                    .font(JieboFont.ui(15))
                Spacer(minLength: 0)
                if marked {
                    Circle().fill(JieboColor.ok).frame(width: 6, height: 6)
                }
            }
            .foregroundStyle(JieboColor.ink)
            .padding(.horizontal, boxed ? 12 : 16)
            .frame(minHeight: boxed ? 36 : 40)
            .overlay {
                if boxed {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                }
            }
            .padding(.horizontal, boxed ? 16 : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct PhoneWorkspaceList: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var close: () -> Void
    @State private var themeOpen = false
    @State private var theme = JieboTheme.shared

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            HStack {
                Button(action: close) {
                    Label("对话", systemImage: "chevron.left")
                        .font(JieboFont.ui(15, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                }
                .buttonStyle(.plain)
                Spacer()
                Text("工作区")
                    .font(JieboFont.display(17))
                Spacer()
                Color.clear.frame(width: 52, height: 1)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            ScrollView {
                VStack(spacing: 0) {
                    let root = store.workspaceRoot.isEmpty ? store.cwd : store.workspaceRoot
                    let userItems = store.workspaces.filter { $0.user || sameCwd($0.path, root) }
                    let rest = store.workspaces.filter { item in !userItems.contains(where: { sameCwd($0.path, item.path) }) }
                    if userItems.isEmpty {
                        workspaceRow(name: store.assistantName, path: root, current: sameCwd(root, store.currentWorkspacePath), user: true)
                    }
                    ForEach(userItems) { item in
                        workspaceRow(name: store.assistantName, path: item.path, current: sameCwd(item.path, store.currentWorkspacePath), user: true)
                    }
                    ForEach(rest) { item in
                        workspaceRow(
                            name: item.name,
                            path: item.path,
                            current: sameCwd(item.path, store.currentWorkspacePath),
                            user: false
                        )
                    }
                }
            }

            if store.creatingWorkspace {
                HStack {
                    TextField("名称", text: $store.newWorkspaceName)
                        .textFieldStyle(.roundedBorder)
                    Button("创建", action: store.createWorkspace)
                        .disabled(store.newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            } else {
                Button("新建工作区") { store.creatingWorkspace = true }
                    .font(JieboFont.ui(14))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }

            Button {
                themeOpen = true
            } label: {
                Text("主题 · \(theme.palette.title)")
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.dim)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
            Button(action: store.logout) {
                Text("退出登录")
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.dim)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(JieboColor.paper.ignoresSafeArea())
        .sheet(isPresented: $themeOpen) {
            ThemeSettingsSheet()
        }
        .onAppear {
            store.openWorkspaceSwitcher()
            store.workspaceSheetOpen = false
        }
    }

    private func workspaceRow(name: String, path: String, current: Bool, user: Bool) -> some View {
        Button {
            store.switchWorkspace(to: path)
            close()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: user ? "person.crop.rectangle" : "folder")
                    .foregroundStyle(JieboColor.dim)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(JieboFont.ui(16, weight: user || current ? .semibold : .regular))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    if user {
                        Text("全部子工作区 · 网站只在这里公开")
                            .font(JieboFont.ui(11))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if current {
                    Text("正在用")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: user ? 58 : 48)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.clear)
            .overlay {
                if user {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(path.isEmpty)
    }
}
