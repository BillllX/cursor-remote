import SwiftUI
import UIKit

/// 切换工作区（iPad 侧栏与手机抽屉共用）。由 store.workspaceSheetOpen 驱动，系统表单样式：
/// 当前项打勾，新建走右上角 + 和 alert，不夹带主题、退出这类账号操作。
struct WorkspacePickerSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.sceneSessionState) private var sceneSession
    @State private var query = ""
    /// 正在改名 / 删除 / 清空对话的目标
    @State private var renaming: WorkspaceItem?
    @State private var renameDraft = ""
    @State private var deleting: WorkspaceItem?
    @State private var clearing: WorkspaceItem?

    var body: some View {
        @Bindable var store = store
        let all = store.recentSubWorkspaces
        let stats = store.workspaceStatsByKey
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let items = all.filter { $0.name.lowercased().contains(needle) || $0.path.lowercased().contains(needle) }
        let recent = Array(all.filter {
            (stats[normPath($0.path)]?.touched ?? 0) > 0
                || sameCwd($0.path, store.currentWorkspacePath)
        }.prefix(5))
        let recentPaths = Set(recent.map { normPath($0.path) })
        let remaining = all.filter { !recentPaths.contains(normPath($0.path)) }
        let duplicates = Set(Dictionary(grouping: all, by: \.name).filter { $0.value.count > 1 }.keys)
        NavigationStack {
            List {
                if all.isEmpty {
                    Section {
                        if store.workspaces.isEmpty {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("正在读取工作区…")
                                    .font(JieboFont.text(.body))
                                    .foregroundStyle(JieboColor.dim)
                            }
                        } else {
                            Text("还没有子工作区，点右上角 + 新建一个。")
                                .font(JieboFont.text(.body))
                                .foregroundStyle(JieboColor.dim)
                        }
                    }
                } else if !needle.isEmpty, items.isEmpty {
                    Section {
                        Text("没有匹配的工作区")
                            .font(JieboFont.text(.body))
                            .foregroundStyle(JieboColor.dim)
                    }
                } else if !needle.isEmpty {
                    Section("搜索结果") {
                        ForEach(items) { item in
                            row(item, showPath: true, stat: stats[normPath(item.path)])
                        }
                    }
                } else {
                    if !recent.isEmpty {
                        Section("最近") {
                            ForEach(recent) { item in
                                row(item, showPath: duplicates.contains(item.name), stat: stats[normPath(item.path)])
                            }
                        }
                    }
                    if !remaining.isEmpty {
                        Section {
                            ForEach(remaining) { item in
                                row(item, showPath: duplicates.contains(item.name), stat: stats[normPath(item.path)])
                            }
                        } header: {
                            Text("其他工作区")
                        } footer: {
                            Text("切过去会打开那里最近的对话，没有就新建一个。长按或左滑可以重命名、清空对话、删除。")
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(JieboColor.paper)
            .navigationTitle("切换工作区")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: all.count > 6 ? "搜索 \(all.count) 个工作区" : "搜索工作区")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        store.newWorkspaceName = ""
                        store.creatingWorkspace = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("新建工作区")
                }
            }
            .alert("新建工作区", isPresented: $store.creatingWorkspace) {
                TextField("名称", text: $store.newWorkspaceName)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("取消", role: .cancel) { store.newWorkspaceName = "" }
                Button("创建", action: store.createWorkspace)
                    .disabled(store.newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } message: {
                Text("会在你的根目录下建一个同名文件夹，建好后直接进去。")
            }
            .alert(
                "重命名工作区",
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
                Text("「\(item.name)」里的对话会跟着改到新名字下。")
            }
            .alert(
                "清空这个工作区的对话？",
                isPresented: Binding(get: { clearing != nil }, set: { if !$0 { clearing = nil } }),
                presenting: clearing
            ) { item in
                Button("清空", role: .destructive) {
                    store.clearWorkspaceChats(item.path)
                    clearing = nil
                }
                Button("取消", role: .cancel) { clearing = nil }
            } message: { item in
                Text("「\(item.name)」下的对话都会删掉，目录里的文件不动，删除后不能恢复。")
            }
            .alert(
                "删除工作区？",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                presenting: deleting
            ) { item in
                Button("删除", role: .destructive) {
                    store.deleteWorkspace(item.path)
                    deleting = nil
                }
                Button("取消", role: .cancel) { deleting = nil }
            } message: { item in
                Text("「\(item.name)」目录是空的会直接删掉；里面有文件的只从列表里隐藏，文件不动（以后同名新建就能找回）。")
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func detailLine(_ stat: WorkspaceStat?) -> String? {
        guard let stat, stat.chats > 0 else { return nil }
        let when = agoText(stat.touched, long: true)
        return when.isEmpty ? "\(stat.chats) 个对话" : "\(stat.chats) 个对话 · \(when)"
    }

    private func row(_ item: WorkspaceItem, showPath: Bool, stat: WorkspaceStat?) -> some View {
        let current = sameCwd(item.path, store.currentWorkspacePath)
        let manage = store.isTopLevelWorkspace(item.path)
        let chatCount = store.chatCountUnder(item.path)
        return Button {
            store.switchWorkspace(to: item.path)
            sceneSession?.workbenchChatId = store.activeId
            dismiss()
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
                        TimelineView(.everyMinute) { _ in
                            Text(detailLine(stat) ?? "")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.dim)
                                .lineLimit(2)
                        }
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
            current ? "当前工作区" : nil,
            detailLine(stat)
        ].compactMap { $0 }.joined(separator: "，"))
        .accessibilityHint("切换到这个工作区")
        .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
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
                    store.switchWorkspace(to: item.path)
                    sceneSession?.workbenchChatId = store.activeId
                    dismiss()
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
                            Label(chatCount > 0 ? "删除工作区（先清空对话）" : "删除工作区", systemImage: "trash")
                        }
                        .disabled(chatCount > 0)
                    }
                }
            }
        }
    }
}
