import SwiftUI
import UIKit

/// 从小驳浏览工作区，或在工作台里直接切换文件夹。
struct WorkspacePickerSheet: View {
    var showWorkbench: (() -> Void)? = nil
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var phoneRouter: PhoneRouter?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.sceneSessionState) private var sceneSession
    @State private var shareTarget: WorkspaceItem?
    @State private var query = ""
    /// 正在改名 / 删除 / 清空对话的目标
    @State private var renaming: WorkspaceItem?
    @State private var renameDraft = ""
    @State private var deleting: WorkspaceItem?
    @State private var clearing: WorkspaceItem?
    @State private var selectedWorkspace: WorkspaceItem?
    /// 工作区列表分页展示窗口，避免工作区数量大时一次性创建全部 List 行
    @State private var visibleWorkspaceLimit = 30

    private var browsingWorkspaces: Bool { showWorkbench != nil }

    var body: some View {
        @Bindable var store = store
        // 单次快照复用 sidebarChats 与 normPath 统计，消除旧版 O(W × C) 的每行重复扫描
        let snapshot = store.workspacePickerSnapshot()
        let all = snapshot.items
        let stats = snapshot.stats
        let countsUnder = snapshot.countsUnderByNormPath
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentPath = store.workspacePath(anchoredTo: sceneSession?.workbenchChatId)
        let currentNormPath = browsingWorkspaces ? "" : normPath(currentPath)
        let items: [WorkspaceItem] = needle.isEmpty ? [] : all.filter {
            $0.name.range(of: needle, options: .caseInsensitive) != nil
                || $0.path.range(of: needle, options: .caseInsensitive) != nil
        }
        let sections: (recent: [(item: WorkspaceItem, key: String)], remaining: [(item: WorkspaceItem, key: String)], duplicates: Set<String>) = {
            guard needle.isEmpty else { return ([], [], []) }
            var recentList: [(item: WorkspaceItem, key: String)] = []
            recentList.reserveCapacity(5)
            var recentKeys: Set<String> = []
            var remainingList: [(item: WorkspaceItem, key: String)] = []
            remainingList.reserveCapacity(all.count)
            var nameCounts: [String: Int] = [:]
            nameCounts.reserveCapacity(all.count)
            for item in all {
                let key = normPath(item.path)
                nameCounts[item.name, default: 0] += 1
                if recentList.count < 5, (stats[key]?.touched ?? 0) > 0 || key == currentNormPath {
                    recentList.append((item, key))
                    recentKeys.insert(key)
                } else if !recentKeys.contains(key) {
                    remainingList.append((item, key))
                }
            }
            var duplicateNames: Set<String> = []
            for (name, count) in nameCounts where count > 1 {
                duplicateNames.insert(name)
            }
            return (recentList, remainingList, duplicateNames)
        }()
        let recent = sections.recent
        let remaining = sections.remaining
        let duplicates = sections.duplicates
        NavigationStack {
            List {
                if all.isEmpty {
                    Section {
                        if store.workspacesSyncInFlight {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("正在读取文件夹…")
                                    .font(JieboFont.text(.body))
                                    .foregroundStyle(JieboColor.dim)
                            }
                        } else if let title = store.workspaceListBlockedTitle {
                            Text(title)
                                .font(JieboFont.text(.body))
                                .foregroundStyle(JieboColor.dim)
                        } else {
                            Text(browsingWorkspaces ? "还没有工作区，点右上角 + 新建一个。" : "还没有子文件夹，点右上角 + 新建一个。")
                                .font(JieboFont.text(.body))
                                .foregroundStyle(JieboColor.dim)
                        }
                    }
                    .listRowBackground(JieboColor.white)
                } else if !needle.isEmpty, items.isEmpty {
                    Section {
                        Text(browsingWorkspaces ? "没有匹配的工作区" : "没有匹配的文件夹")
                            .font(JieboFont.text(.body))
                            .foregroundStyle(JieboColor.dim)
                    }
                    .listRowBackground(JieboColor.white)
                } else if !needle.isEmpty {
                    Section {
                        ForEach(items) { item in
                            let key = normPath(item.path)
                            row(
                                item,
                                showPath: true,
                                stat: stats[key],
                                current: key == currentNormPath,
                                chatCount: countsUnder[key] ?? 0
                            )
                        }
                    } header: {
                        JieboListHeader("搜索结果")
                    }
                    .listRowBackground(JieboColor.white)
                } else {
                    if !recent.isEmpty {
                        Section {
                            ForEach(recent, id: \.item.id) { entry in
                                row(
                                    entry.item,
                                    showPath: duplicates.contains(entry.item.name),
                                    stat: stats[entry.key],
                                    current: entry.key == currentNormPath,
                                    chatCount: countsUnder[entry.key] ?? 0
                                )
                            }
                        } header: {
                            JieboListHeader("最近")
                        }
                        .listRowBackground(JieboColor.white)
                    }
                    if !remaining.isEmpty {
                        let visibleRemaining = Array(remaining.prefix(visibleWorkspaceLimit))
                        Section {
                            ForEach(visibleRemaining, id: \.item.id) { entry in
                                row(
                                    entry.item,
                                    showPath: duplicates.contains(entry.item.name),
                                    stat: stats[entry.key],
                                    current: entry.key == currentNormPath,
                                    chatCount: countsUnder[entry.key] ?? 0
                                )
                            }
                            if remaining.count > visibleRemaining.count {
                                PaginationLoadMoreRow(
                                    hasMore: true,
                                    loadedCount: visibleRemaining.count,
                                    totalCount: remaining.count,
                                    label: browsingWorkspaces ? "加载更多工作区" : "加载更多文件夹",
                                    onLoadMore: { visibleWorkspaceLimit += 30 }
                                )
                            }
                        } header: {
                            JieboListHeader(browsingWorkspaces ? "其他工作区" : "其他文件夹")
                        } footer: {
                            if !browsingWorkspaces {
                                Text("切过去会打开那里最近的对话，没有就新建一个。长按或左滑可以重命名、清空对话、删除。")
                            }
                        }
                        .listRowBackground(JieboColor.white)
                    }
                }
                let sharedRows = store.workspaceSharing.items.filter {
                    needle.isEmpty
                        || $0.name.range(of: needle, options: .caseInsensitive) != nil
                        || $0.ownerName.range(of: needle, options: .caseInsensitive) != nil
                }
                if !sharedRows.isEmpty {
                    Section("共享给我") {
                        ForEach(sharedRows) { item in
                            NavigationLink {
                                SharedWorkspaceFileView(workspace: item)
                            } label: {
                                VStack(alignment: .leading) {
                                    Label(item.name, systemImage: "folder")
                                    Text("来自 \(item.ownerName)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(JieboColor.paper)
            .navigationTitle(browsingWorkspaces ? "工作区" : "切换文件夹")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $selectedWorkspace) { item in
                workspaceDetail(item)
            }
            .task {
                if browsingWorkspaces { store.requestWorkspaces() }
            }
            .onChange(of: store.gatewayReady) { _, ready in
                if browsingWorkspaces && ready { store.requestWorkspaces() }
            }
            .sheet(item: $shareTarget) { item in ShareWorkspaceSheet(name: item.name, path: item.path).environment(store) }
            .task { if store.gatewayFeatures.contains("workspace_share_v1") { await store.workspaceSharing.refresh() } }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: browsingWorkspaces ? "搜索工作区" : all.count > 6 ? "搜索 \(all.count) 个文件夹" : "搜索文件夹")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                if !browsingWorkspaces, store.gatewayFeatures.contains("workspace_share_v1"),
                   let item = all.first(where: { sameCwd($0.path, currentPath) && store.isTopLevelWorkspace($0.path) }) {
                    ToolbarItem(placement: .primaryAction) {
                        Button { shareTarget = item } label: {
                            Image(systemName: WorkspaceShareChrome.symbol).hitTarget()
                        }
                        .accessibilityLabel(WorkspaceShareChrome.title)
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        store.newWorkspaceName = ""
                        store.creatingWorkspace = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel(browsingWorkspaces ? "新建工作区" : "新建文件夹")
                }
            }
            .alert(browsingWorkspaces ? "新建工作区" : "新建文件夹", isPresented: $store.creatingWorkspace) {
                TextField("名称", text: $store.newWorkspaceName)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("取消", role: .cancel) { store.newWorkspaceName = "" }
                Button("创建") { store.createWorkspace(openChat: !browsingWorkspaces) }
                    .disabled(store.newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } message: {
                if !browsingWorkspaces {
                    Text(store.connected
                        ? "会在你的根目录下建一个同名文件夹，建好后直接进去。"
                        : "还没连上。会在连上后建到根目录下，建好后直接进去。")
                }
            }
            .alert(
                "重命名文件夹",
                isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
                presenting: renaming
            ) { item in
                TextField("新名字", text: $renameDraft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("取消", role: .cancel) { renaming = nil }
                Button("改名") {
                    store.renameWorkspace(item.path, to: renameDraft)
                    renaming = nil
                }
            } message: { item in
                Text(store.connected
                    ? "「\(item.name)」里的对话会跟着改到新名字下。"
                    : "还没连上。「\(item.name)」会在连上后改名，里面的对话跟着到新名字下。")
            }
            .alert(
                "清空这个文件夹的对话？",
                isPresented: Binding(get: { clearing != nil }, set: { if !$0 { clearing = nil } }),
                presenting: clearing
            ) { item in
                Button("清空", role: .destructive) {
                    store.clearWorkspaceChats(item.path)
                    clearing = nil
                }
                Button("取消", role: .cancel) { clearing = nil }
            } message: { item in
                Text(store.connected
                    ? "「\(item.name)」下的对话都会删掉，其他设备上也看不到。目录里的文件不动，删除后不能恢复。"
                    : "「\(item.name)」下的对话会先从这台设备去掉。连上后，其他设备上也看不到。目录里的文件不动，删除后不能恢复。")
            }
            .alert(
                "删除文件夹？",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                presenting: deleting
            ) { item in
                Button("删除", role: .destructive) {
                    store.deleteWorkspace(item.path)
                    deleting = nil
                }
                Button("取消", role: .cancel) { deleting = nil }
            } message: { item in
                Text(store.connected
                    ? "「\(item.name)」目录是空的会直接删掉；里面有文件的只从列表里隐藏，文件不动（以后同名新建就能找回）。"
                    : "还没连上。「\(item.name)」的删除会在连上后发出。空目录会删掉；里面有文件的只从列表里隐藏，文件不动。")
            }
            .onChange(of: store.activeId) { _, nextId in
                if !browsingWorkspaces, store.isWorkspaceChat(nextId) {
                    sceneSession?.workbenchChatId = nextId
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func selectWorkspace(_ item: WorkspaceItem) {
        if browsingWorkspaces {
            selectedWorkspace = item
        } else {
            openWorkspace(item)
        }
    }

    private func workspaceDetail(_ item: WorkspaceItem) -> some View {
        List {
            if store.subWorkspaces.contains(where: { $0.path == item.path }) {
                LabeledContent("目录", value: item.path)
                Button {
                    store.assistantOnly = false
                    openWorkspace(item)
                    showWorkbench?()
                } label: {
                    Label("打开工作台", systemImage: "rectangle.3.group")
                }
            } else {
                Text("此工作区已移动或移除，请返回列表重新选择。")
            }
        }
        .navigationTitle(item.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func openWorkspace(_ item: WorkspaceItem) {
        phoneRouter?.invalidatePendingNavigation()
        if phoneRouter != nil,
           let id = sceneSession?.phoneWorkspaceChat(in: item.path, store: store) {
            store.workspaceSheetOpen = false
            store.activateWorkspaceChat(id)
        } else {
            store.switchWorkspace(to: item.path)
        }
        if store.isWorkspaceChat(store.activeId) {
            sceneSession?.workbenchChatId = store.activeId
        }
        dismiss()
    }

    private func detailLine(_ stat: WorkspaceStat?) -> String? {
        guard let stat, stat.chats > 0 else { return nil }
        let when = agoText(stat.touched, long: true)
        return when.isEmpty ? "\(stat.chats) 个对话" : "\(stat.chats) 个对话 · \(when)"
    }

    private func row(_ item: WorkspaceItem, showPath: Bool, stat: WorkspaceStat?, current: Bool, chatCount: Int) -> some View {
        let manage = store.isTopLevelWorkspace(item.path)
        return Button {
            selectWorkspace(item)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "folder")
                    .font(JieboFont.text(.body, weight: .medium))
                    .foregroundStyle(JieboColor.brass)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name)
                        .font(JieboFont.text(.body, weight: current ? .semibold : .regular))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(2)
                    if let stat, stat.chats > 0 {
                        WorkspaceDetailTickLabel(chats: stat.chats, touched: stat.touched)
                    }
                    if showPath {
                        Text(item.path)
                            .font(JieboFont.monoText(.caption2))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(2)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                if current {
                    Image(systemName: "checkmark")
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(showPath ? "\(item.name)，\(item.path)" : item.name)
        .accessibilityValue([
            current ? "当前文件夹" : nil,
            detailLine(stat)
        ].compactMap { $0 }.joined(separator: "，"))
        .accessibilityHint(browsingWorkspaces ? "查看工作区详情" : "切换到这个文件夹")
        .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
        .contextMenu {
            if manage && store.gatewayFeatures.contains("workspace_share_v1") {
                Button { shareTarget = item } label: { Label(WorkspaceShareChrome.title, systemImage: WorkspaceShareChrome.symbol) }
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if manage {
                Button(role: .destructive) { deleting = item } label: {
                    Label("删除", systemImage: "trash")
                }
                .disabled(chatCount > 0)
            }
            if chatCount > 0 {
                Button { clearing = item } label: {
                    Label("清空对话", systemImage: "tray")
                }
                .tint(JieboColor.clay)
            }
            if manage {
                Button {
                    renameDraft = item.name
                    renaming = item
                } label: {
                    Label("重命名", systemImage: "pencil")
                }
                .tint(JieboColor.brass)
            }
        }
        .contextMenu {
            Section {
                Button {
                    selectWorkspace(item)
                } label: {
                    Label("打开", systemImage: "folder")
                }
                if manage {
                    Button {
                        renameDraft = item.name
                        renaming = item
                    } label: {
                        Label("重命名", systemImage: "pencil")
                    }
                }
                Button {
                    UIPasteboard.general.string = item.path
                    store.flash("已复制路径")
                } label: {
                    Label("复制路径", systemImage: "doc.on.doc")
                }
            }
            if chatCount > 0 || manage {
                Section {
                    if chatCount > 0 {
                        Button(role: .destructive) { clearing = item } label: {
                            Label("清空对话（\(chatCount)）", systemImage: "tray")
                        }
                    }
                    if manage {
                        Button(role: .destructive) { deleting = item } label: {
                            Label(chatCount > 0 ? "删除文件夹（先清空对话）" : "删除文件夹", systemImage: "trash")
                        }
                        .disabled(chatCount > 0)
                    }
                }
            }
        }
    }
}

/// 文件夹副标题时间文本：复用全局共享 MinuteClock 替代每行独立 TimelineView(.everyMinute)，超过 7 天零订阅。
private struct WorkspaceDetailTickLabel: View {
    let chats: Int
    let touched: Double?

    var body: some View {
        if let touched, AgoLabel.isLiveWindow(touched) {
            LiveWorkspaceDetailLabel(chats: chats, touched: touched)
        } else {
            Text(Self.format(chats: chats, touched: touched))
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(2)
        }
    }

    static func format(chats: Int, touched: Double?) -> String {
        let when = agoText(touched, long: true)
        return when.isEmpty ? "\(chats) 个对话" : "\(chats) 个对话 · \(when)"
    }
}

private struct LiveWorkspaceDetailLabel: View {
    let chats: Int
    let touched: Double
    @State private var expired = false

    var body: some View {
        Group {
            if expired {
                Text(WorkspaceDetailTickLabel.format(chats: chats, touched: touched))
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(2)
            } else {
                LiveWorkspaceDetailTickText(chats: chats, touched: touched) {
                    expired = true
                }
            }
        }
        .onChange(of: touched) { _, next in
            if expired && AgoLabel.isLiveWindow(next) {
                expired = false
            }
        }
    }
}

private struct LiveWorkspaceDetailTickText: View {
    let chats: Int
    let touched: Double
    let onExpire: () -> Void
    @State private var retained = false

    var body: some View {
        let tick = MinuteClock.shared.tick
        Text(WorkspaceDetailTickLabel.format(chats: chats, touched: touched))
            .font(JieboFont.text(.caption))
            .foregroundStyle(JieboColor.dim)
            .lineLimit(2)
            .onAppear {
                guard !retained else { return }
                retained = true
                MinuteClock.shared.retain()
            }
            .onChange(of: tick) { _, _ in
                if !AgoLabel.isLiveWindow(touched) {
                    onExpire()
                }
            }
            .onDisappear {
                guard retained else { return }
                retained = false
                MinuteClock.shared.release()
            }
    }
}
