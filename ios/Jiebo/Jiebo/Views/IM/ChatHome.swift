import SwiftUI
import UIKit
import PhotosUI

/// 聊天主页：列表 → 聊天页，只有两层。手机和 iPad 窄窗用导航栈，iPad 宽窗左右分栏。
/// 打开的会话保存在当前 WindowGroup 的 SceneSessionState，不会带着其它窗口跳转。
struct ChatHome: View {
    @Environment(ImStore.self) private var im
    @Environment(ChatStore.self) private var store
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.assistantSceneToken) private var sceneToken
    @Environment(\.sceneSessionState) private var sceneSession
    @State private var settingsOpen = false
    @State private var columnVisibility = NavigationSplitViewVisibility.all

    private var split: Bool {
        UIDevice.current.userInterfaceIdiom == .pad && sizeClass == .regular
    }

    private var activePreviewTab: PreviewTab? {
        if let sceneSession { return sceneSession.previewTab(in: store) }
        return store.activePreviewTab
    }

    private var previewPanelOpen: Bool {
        sceneSession != nil ? activePreviewTab != nil : store.previewPanelOpen
    }

    var body: some View {
        Group {
            if split {
                splitLayout
            } else {
                stackLayout
            }
        }
        .background(JieboColor.paper)
        .overlay(alignment: .top) {
            ImToast(text: im.toast)
        }
        .sheet(isPresented: $settingsOpen) {
            ChatSettingsSheet()
        }
        .onReceive(NotificationCenter.default.publisher(for: .padSceneSidebarToggleRequested)) { note in
            guard split,
                  let delivery = note.object as? PadSceneCommandDelivery,
                  delivery.sceneToken == sceneToken
            else { return }
            columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
        }
        // iPad 两个主页一直同时挂着，聊天层需要自己的预览；iPhone 由 PhoneTabShell 全局承载。
        .overlay {
            ZStack {
                if UIDevice.current.userInterfaceIdiom == .pad,
                   previewPanelOpen,
                   let tab = activePreviewTab {
                    Color.black.opacity(0.28)
                        .ignoresSafeArea()
                        .onTapGesture {
                            if let sceneSession { sceneSession.dismissPreview() }
                            else { store.collapsePreview() }
                        }
                        .transition(.opacity)
                        .accessibilityHidden(true)
                    PreviewPanelView(tab: tab)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(JieboColor.white)
                        .transition(.move(edge: .trailing))
                        .zIndex(3)
                }
            }
            .animation(JieboMotion.panel(reduceMotion), value: previewPanelOpen)
        }
    }

    private var path: Binding<[ChatDestination]> {
        Binding(
            get: { destination.map { [$0] } ?? [] },
            set: { destinations in
                let next = destinations.last
                if case .some(.workspace(_)) = next {
                    // 工作区线程自行维护 viewing。
                } else {
                    store.leaveWorkspaceThread()
                }
                setDestination(next)
            }
        )
    }

    private var stackLayout: some View {
        NavigationStack(path: path) {
            ChatListView(openSettings: { settingsOpen = true })
                .navigationDestination(for: ChatDestination.self) { destination in
                    destinationView(destination)
                }
        }
    }

    private var splitLayout: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            ChatListView(openSettings: { settingsOpen = true })
                .navigationSplitViewColumnWidth(min: 280, ideal: 330, max: 420)
        } detail: {
            if let destination {
                NavigationStack {
                    destinationView(destination)
                }
                .id(destination)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(JieboColor.dim)
                    Text("选一个人开始聊天")
                        .font(JieboFont.text(.callout))
                        .foregroundStyle(JieboColor.dim)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(JieboColor.paper)
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    @ViewBuilder
    private func destinationView(_ destination: ChatDestination) -> some View {
        switch destination {
        case .person(let peer):
            ChatThreadView(peer: peer)
        case .group(let convId):
            CollabRunGraphView(convId: convId, embedded: true)
        case .assistant:
            if let chatId = store.assistantChatId {
                ThreadView(chrome: .embedded, chatId: chatId)
                    .onAppear { store.prepareAssistantThread() }
            } else {
                ProgressView("正在加载助理…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onAppear { store.prepareAssistantThread() }
            }
        case .workspace(let path):
            WorkspaceAgentThread(path: path)
        }
    }

    private var destination: ChatDestination? {
        sceneSession?.chatDestination ?? store.chatHomeDestination
    }

    private func setDestination(_ destination: ChatDestination?) {
        if let sceneSession {
            sceneSession.chatDestination = destination
        } else {
            store.chatHomeDestination = destination
        }
    }
}

// MARK: 列表

struct ChatListView: View {
    @Environment(ImStore.self) private var im
    @Environment(ChatStore.self) private var store
    @Environment(\.assistantSceneToken) private var sceneToken
    @Environment(\.sceneSessionState) private var sceneSession
    var openSettings: () -> Void
    @State private var query = ""
    @State private var searchPresented = false
    @State private var editingWorkspace: WorkspaceAgentItem?

    var body: some View {
        let rows = im.directory(query: query)
        let groups = im.groupConversations(query: query)
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let agents = store.workspaceAgents.filter {
            needle.isEmpty
                || $0.displayName.lowercased().contains(needle)
                || $0.directoryName.lowercased().contains(needle)
        }
        let assistantSelected = destination == .assistant
        List {
            Section {
                Button {
                    setDestination(.assistant)
                    store.prepareAssistantThread()
                } label: {
                    HStack(spacing: 12) {
                        Capsule()
                            .fill(assistantSelected ? JieboColor.pine : Color.clear)
                            .frame(width: 3, height: 28)
                            .accessibilityHidden(true)
                        Image(systemName: NavigationIconId.assistant.symbol)
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(JieboColor.brass)
                            .frame(width: 48, height: 48)
                            .background(JieboColor.sidebar)
                            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(store.assistantName)
                                .font(JieboFont.text(.body, weight: .semibold))
                                .foregroundStyle(JieboColor.ink)
                            Text("个人助理")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.dim)
                        }
                        Spacer()
                        if assistantSelected {
                            Text("当前")
                                .font(JieboFont.text(.caption2, weight: .semibold))
                                .foregroundStyle(JieboColor.pine)
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(JieboColor.pine.opacity(0.12))
                                .clipShape(Capsule())
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .listRowBackground(assistantSelected ? JieboColor.pine.opacity(0.1) : JieboColor.paper)
                .accessibilityLabel(assistantSelected ? "\(store.assistantName)，个人助理，当前会话" : "\(store.assistantName)，个人助理")
                .accessibilityAddTraits(assistantSelected ? .isSelected : [])
            }
            if !rows.chatted.isEmpty {
                Section {
                    ForEach(rows.chatted) { row in
                        conversationRow(row)
                    }
                }
            }
            if !groups.isEmpty {
                Section("iOS 协作") {
                    ForEach(groups, id: \.convId) { group in
                        groupRow(group)
                    }
                }
            }
            if !rows.others.isEmpty {
                Section {
                    ForEach(rows.others) { row in
                        contactRow(row)
                    }
                } header: {
                    Text(rows.chatted.isEmpty ? "平台上的人" : "还没聊过")
                }
            }
            if !agents.isEmpty {
                Section("工作区对话") {
                    ForEach(agents) { item in
                        workspaceRow(item)
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .overlay {
            if rows.chatted.isEmpty, rows.others.isEmpty, groups.isEmpty, agents.isEmpty {
                emptyState
            }
        }
        .searchable(text: $query, isPresented: $searchPresented, prompt: "搜昵称或拼音首字母")
        .onReceive(NotificationCenter.default.publisher(for: .padSceneSearchRequested)) { note in
            guard let delivery = note.object as? PadSceneCommandDelivery,
                  delivery.sceneToken == sceneToken
            else { return }
            searchPresented = true
        }
        .refreshable { im.refreshList() }
        .navigationTitle("聊天")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: openSettings) {
                    Image(systemName: NavigationIconId.account.symbol)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                }
                .accessibilityLabel("聊天设置")
            }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text("聊天")
                        .font(JieboFont.text(.headline))
                        .foregroundStyle(JieboColor.ink)
                    if !im.online {
                        Text(store.connected ? "服务器没开聊天功能" : "正在连接…")
                            .font(JieboFont.text(.caption2))
                            .foregroundStyle(JieboColor.dim)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .sheet(item: $editingWorkspace) { item in
            WorkspaceAgentProfileSheet(item: item)
        }
    }

    // MARK: 行

    private func groupRow(_ group: ImConvRow) -> some View {
        let selected = destination == .group(group.convId)
        return Button {
            setDestination(.group(group.convId))
            im.syncCollab(convId: group.convId)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: NavigationIconId.collab.symbol)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(JieboColor.brass)
                    .frame(width: 48, height: 48)
                    .background(JieboColor.sidebar)
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                    .overlay(alignment: .topTrailing) { unreadMark(group).offset(x: 6, y: -6) }
                VStack(alignment: .leading, spacing: 4) {
                    Text(group.title ?? "协作群")
                        .font(JieboFont.text(.body, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    Text(group.memberCount > 0 ? "\(group.memberCount) 位成员 · 只读运行图" : "只读运行图")
                        .font(JieboFont.text(.subheadline))
                        .foregroundStyle(JieboColor.dim)
                }
                Spacer()
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(selected ? JieboColor.mist : JieboColor.paper)
        .accessibilityLabel("\(group.title ?? "协作群")，只读协作运行图")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func conversationRow(_ row: ImDirectoryRow) -> some View {
        let conv = row.conv
        let selected = destination == .person(row.user.id)
        return Button {
            setDestination(.person(row.user.id))
        } label: {
            HStack(spacing: 12) {
                ImAvatar(user: row.user, size: 48)
                    .overlay(alignment: .topTrailing) {
                        unreadMark(conv)
                            .offset(x: 6, y: -6)
                    }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(row.user.nickname)
                            .font(JieboFont.text(.body, weight: .medium))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(ImFormat.listTime(im.lastActivity(conv)))
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.dim)
                    }
                    HStack(spacing: 6) {
                        previewLine(conv, peer: row.user)
                            .font(JieboFont.text(.subheadline))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        if conv?.mute == true {
                            Image(systemName: "bell.slash")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.dim)
                        }
                    }
                }
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(selected ? JieboColor.mist : (conv?.pin == true ? JieboColor.sidebar : JieboColor.paper))
        .accessibilityLabel(rowAccessibility(row))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let conv {
                if im.canChangeSettings {
                    Button(role: .destructive) {
                        im.clearHistory(conv.convId)
                    } label: {
                        Label("删除", systemImage: "trash")
                    }
                    Button {
                        im.setPin(conv.convId, !conv.pin)
                    } label: {
                        Label(conv.pin ? "取消置顶" : "置顶", systemImage: conv.pin ? "pin.slash" : "pin")
                    }
                    .tint(JieboColor.brass)
                } else {
                    // 断线时删除、置顶发不出去：不给按钮，只告诉为什么
                    Button {
                        im.showToast("未连接，连上服务器后再试")
                    } label: {
                        Label("未连接", systemImage: "wifi.slash")
                    }
                    .tint(JieboColor.dim)
                }
            }
        }
    }

    private func contactRow(_ row: ImDirectoryRow) -> some View {
        Button {
            setDestination(.person(row.user.id))
        } label: {
            HStack(spacing: 12) {
                ImAvatar(user: row.user, size: 40)
                Text(row.user.nickname)
                    .font(JieboFont.text(.body))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(destination == .person(row.user.id) ? JieboColor.mist : JieboColor.paper)
        .accessibilityLabel(row.user.nickname)
    }

    private func workspaceRow(_ item: WorkspaceAgentItem) -> some View {
        let selected = destination == .workspace(item.path)
        return Button {
            setDestination(.workspace(item.path))
            store.requestWorkspaceAgent(item)
        } label: {
            HStack(spacing: 12) {
                Capsule()
                    .fill(selected ? JieboColor.pine : Color.clear)
                    .frame(width: 3, height: 28)
                    .accessibilityHidden(true)
                WorkspaceAgentAvatar(item: item, size: 44)
                    .overlay(alignment: .topTrailing) {
                        if item.unread > 0 {
                            ImUnreadBadge(count: item.unread)
                                .offset(x: 6, y: -6)
                        }
                    }
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.displayName)
                        .font(JieboFont.text(.body, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    if item.displayName != item.directoryName {
                        Text(item.directoryName)
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(1)
                    }
                }
                Spacer()
                if selected {
                    Text("当前")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(JieboColor.pine.opacity(0.12))
                        .clipShape(Capsule())
                        .accessibilityHidden(true)
                }
                if item.status != "idle" {
                    Text(item.status == "awaiting" ? "需处理" : "运行中")
                        .font(JieboFont.text(.caption2, weight: .medium))
                        .foregroundStyle(item.status == "awaiting" ? JieboColor.danger : JieboColor.pine)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(selected ? JieboColor.pine.opacity(0.1) : JieboColor.paper)
        .accessibilityLabel([
            item.displayName,
            "工作区对话",
            selected ? "当前会话" : nil,
            item.status == "idle" ? nil : (item.status == "awaiting" ? "需处理" : "运行中")
        ].compactMap { $0 }.joined(separator: "，"))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                editingWorkspace = item
            } label: {
                Label("聊天资料", systemImage: "pencil")
            }
            .tint(JieboColor.brass)
        }
        .contextMenu {
            Button {
                editingWorkspace = item
            } label: {
                Label("编辑聊天资料", systemImage: "person.crop.square")
            }
        }
    }

    private var destination: ChatDestination? {
        sceneSession?.chatDestination ?? store.chatHomeDestination
    }

    private func setDestination(_ destination: ChatDestination?) {
        if let sceneSession {
            sceneSession.chatDestination = destination
        } else {
            store.chatHomeDestination = destination
        }
    }

    @ViewBuilder
    private func unreadMark(_ conv: ImConvRow?) -> some View {
        if let conv, conv.unread > 0 {
            if conv.mute {
                Circle()
                    .fill(JieboColor.danger)
                    .frame(width: 10, height: 10)
                    .accessibilityHidden(true)
            } else {
                ImUnreadBadge(count: conv.unread)
            }
        }
    }

    /// 草稿优先（红色「[草稿]」）；再看最后一条（含本机还没发出去的）
    private func previewLine(_ conv: ImConvRow?, peer: ImUser) -> Text {
        guard let conv else { return Text("") }
        if destination != .person(peer.id),
           let draft = im.drafts[conv.convId]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !draft.isEmpty {
            let draftText = draft.replacingOccurrences(of: "\n", with: " ")
            return Text(
                "\(Text("[草稿] ").foregroundStyle(JieboColor.danger))\(Text(draftText).foregroundStyle(JieboColor.dim))"
            )
        }
        let pending = im.timelines[conv.convId]?.last(where: { $0.seq == nil })
        let latest: ImLocalMessage?
        if let pending, pending.at >= (conv.last?.at ?? 0) {
            latest = pending
        } else {
            latest = conv.last.map(ImLocalMessage.init)
        }
        guard let latest else { return Text("") }
        if latest.recalled {
            let who = latest.from == im.meId ? "你" : peer.nickname
            return Text("\(who)撤回了一条消息").foregroundStyle(JieboColor.dim)
        }
        var text = ImFormat.preview(kind: latest.kind, body: latest.body)
        if latest.kind == "image", latest.body == nil { text = "[图片]" }
        if conv.mute, conv.unread > 1 { text = "[\(ImFormat.badge(conv.unread))条] " + text }
        if latest.state == .failed {
            return Text(
                "\(Text("[发送失败] ").foregroundStyle(JieboColor.danger))\(Text(text).foregroundStyle(JieboColor.dim))"
            )
        }
        return Text(text).foregroundStyle(JieboColor.dim)
    }

    private func rowAccessibility(_ row: ImDirectoryRow) -> String {
        var parts = [row.user.nickname]
        if let conv = row.conv {
            if conv.pin { parts.append("置顶") }
            if conv.unread > 0 { parts.append("\(conv.unread) 条未读") }
            if conv.mute { parts.append("消息免打扰") }
            if let last = conv.last, !last.recalled { parts.append(ImFormat.preview(kind: last.kind, body: last.body)) }
        }
        return parts.joined(separator: "，")
    }

    @ViewBuilder
    private var emptyState: some View {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(spacing: 10) {
            Image(systemName: trimmed.isEmpty ? "person.2" : "magnifyingglass")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(JieboColor.dim)
            if !trimmed.isEmpty {
                Text("没找到「\(trimmed)」")
                    .font(JieboFont.text(.callout))
                    .foregroundStyle(JieboColor.ink2)
            } else if !im.contactsLoaded {
                Text(im.online ? "正在加载…" : "连上服务器后，这里会列出平台上的人")
                    .font(JieboFont.text(.callout))
                    .foregroundStyle(JieboColor.ink2)
                    .multilineTextAlignment(.center)
            } else {
                Text("平台上还没有别人")
                    .font(JieboFont.text(.callout, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                Text("等有人加入，就能在这里找到他们、发消息")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: 工作区 Agent

struct WorkspaceAgentThread: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.sceneSessionState) private var sceneSession
    let path: String

    private var item: WorkspaceAgentItem? { store.workspaceAgent(path: path) }

    var body: some View {
        Group {
            if let item, let chatId = item.mainChatId, store.chats.contains(where: { $0.id == chatId }) {
                ThreadView(chrome: .embedded, chatId: chatId)
                    .navigationTitle(item.directoryName)
                    .navigationBarTitleDisplayMode(.inline)
                    .onAppear { prepare(item, chatId: chatId) }
            } else {
                ProgressView("正在打开工作区…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task {
                        if let item { store.requestWorkspaceAgent(item) }
                    }
            }
        }
        .onChange(of: item?.mainChatId) { _, chatId in
            if let item, let chatId { prepare(item, chatId: chatId) }
        }
        .onChange(of: scenePhase) { _, phase in
            guard let chatId = item?.mainChatId else { return }
            if phase == .active {
                if let item { prepare(item, chatId: chatId) }
            } else if sceneSession == nil {
                store.send(.workspaceAgentViewing(chatId: nil))
            }
        }
        .onDisappear {
            if sceneSession == nil { store.leaveWorkspaceThread() }
        }
    }

    private func prepare(_ item: WorkspaceAgentItem, chatId: String) {
        if sceneSession != nil {
            store.prepareWorkspaceThread(item, chatId: chatId)
        } else {
            store.enterWorkspaceThread(path: path, chatId: chatId)
        }
    }
}

struct WorkspaceAgentAvatar: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(\.displayScale) private var displayScale
    let item: WorkspaceAgentItem
    let size: CGFloat
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                JieboColor.sidebar
                Image(systemName: "folder.fill")
                    .font(.system(size: size * 0.42, weight: .medium))
                    .foregroundStyle(JieboColor.brass)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .task(id: "\(item.avatarBlob ?? "")|\(store.workspaceAvatarTicket?.sig ?? "")") {
            guard let blob = item.avatarBlob, let ticket = store.workspaceAvatarTicket else {
                image = nil
                return
            }
            let pixel = Int(size * displayScale)
            let url = GatewayConfig.imMediaURL(scope: "workspace-avatars", blob: blob, ticket: ticket)
            image = await ImImageCache.shared.image(blob: blob, tenant: im.tenant, remote: url, maxPixel: pixel)
        }
        .accessibilityHidden(true)
    }
}

struct WorkspaceAgentProfileSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(\.dismiss) private var dismiss
    let item: WorkspaceAgentItem
    @State private var displayName: String
    @State private var avatarItem: PhotosPickerItem?

    init(item: WorkspaceAgentItem) {
        self.item = item
        _displayName = State(initialValue: item.displayName)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("显示名", text: $displayName)
                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        Label("更换头像", systemImage: "photo")
                    }
                    Button("恢复默认") {
                        store.updateWorkspaceProfile(path: item.path, displayName: "", avatar: "")
                        dismiss()
                    }
                } header: {
                    Text("聊天列表资料")
                } footer: {
                    Text("只改变聊天列表里的名称和头像，不会修改目录名、工作目录或会话标题。")
                }
            }
            .navigationTitle("工作区聊天资料")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        store.updateWorkspaceProfile(path: item.path, displayName: displayName, avatar: nil)
                        dismiss()
                    }
                }
            }
            .onChange(of: avatarItem) { _, picked in
                guard let picked else { return }
                avatarItem = nil
                uploadAvatar(picked)
            }
        }
    }

    private func uploadAvatar(_ picked: PhotosPickerItem) {
        let tenant = im.tenant
        Task { @MainActor in
            guard let source = await ImPickTemp.load(picked) else { return }
            let file = await Task.detached(priority: .userInitiated) {
                let output = ImImagePrep.avatar(file: source, tenant: tenant)
                ImPickTemp.remove([source])
                return output
            }.value
            guard tenant == im.tenant, let file else { return }
            im.uploadWorkspaceAvatar(file: file, path: item.path)
        }
    }
}

// MARK: 头像

/// 有头像画头像，没有就用昵称第一个字当占位
struct ImAvatar: View {
    @Environment(ImStore.self) private var im
    @Environment(\.displayScale) private var displayScale
    var user: ImUser
    var size: CGFloat
    @State private var image: UIImage?

    private static let tints: [Color] = [JieboColor.pine, JieboColor.brass, JieboColor.clay, JieboColor.okSoft, JieboColor.run]

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Self.tint(for: user.id)
                Text(initial)
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .accessibilityHidden(true)
        .task(id: taskKey) { await load() }
    }

    private var initial: String {
        let trimmed = user.nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.first.map { String($0).uppercased() } ?? "?"
    }

    private var pixel: Int { Int(size * displayScale) }

    private var taskKey: String {
        "\(user.avatar ?? "")|\(im.avatarTicket?.sig ?? "")"
    }

    static func tint(for id: String) -> Color {
        let sum = id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return tints[sum % tints.count]
    }

    @MainActor
    private func load() async {
        guard let blob = user.avatar else {
            image = nil
            return
        }
        if let hit = ImImageCache.shared.cached(blob, maxPixel: pixel) {
            image = hit
            return
        }
        image = await ImImageCache.shared.image(blob: blob, tenant: im.tenant, remote: im.avatarURL(blob), maxPixel: pixel)
    }
}

// MARK: 轻提示

struct ImToast: View {
    var text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if !text.isEmpty {
                Text(text)
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(JieboColor.white)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(JieboColor.line, lineWidth: 1))
                    .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .animation(JieboMotion.fade(reduceMotion), value: text)
        .allowsHitTesting(false)
    }
}
