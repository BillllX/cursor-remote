import SwiftUI

struct SidebarView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                JieboMark(size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("接驳")
                        .font(JieboFont.display(22))
                        .foregroundStyle(JieboColor.ink)
                    Text(store.connected ? workspaceName(store.cwd.isEmpty ? store.workspaceRoot : store.cwd) : "正在重连…")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                }
                Spacer()
                Button(action: store.openNewChat) {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .frame(width: 36, height: 36)
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                }
                .buttonStyle(.plain)
                .keyboardShortcut("n", modifiers: .command)
                .accessibilityLabel("新对话")
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 12)

            List {
                ForEach(store.chats) { chat in
                    Button {
                        store.select(chat.id)
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Circle()
                                .fill(chat.turns.contains(where: \.running) ? JieboColor.pine : (chat.unread ? JieboColor.brass : .clear))
                                .frame(width: 8, height: 8)
                                .padding(.top, 7)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(chat.title)
                                    .font(JieboFont.ui(15, weight: chat.unread ? .semibold : .medium))
                                    .foregroundStyle(JieboColor.ink)
                                    .lineLimit(1)
                                if !chat.preview.isEmpty {
                                    Text(chat.preview)
                                        .font(JieboFont.ui(12))
                                        .foregroundStyle(JieboColor.dim)
                                        .lineLimit(2)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(chat.id == store.activeId ? JieboColor.userBubble : JieboColor.mist)
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) {
                            store.deleteChat(chat.id)
                        } label: {
                            Label("删除", systemImage: "trash")
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)

            HStack {
                Button("退出登录", action: store.logout)
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.ink2)
                Spacer()
                Circle()
                    .fill(store.connected ? JieboColor.ok : JieboColor.clay)
                    .frame(width: 8, height: 8)
            }
            .padding(16)
        }
        .background(JieboColor.mist.ignoresSafeArea())
        .sheet(isPresented: $store.workspaceSheetOpen) {
            WorkspaceSheet()
        }
    }
}

private struct WorkspaceSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            List {
                Section("工作区") {
                    ForEach(store.workspaces) { item in
                        Button {
                            store.startChat(in: item.path)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.name)
                                    .font(JieboFont.ui(16, weight: .medium))
                                    .foregroundStyle(JieboColor.ink)
                                Text(item.path)
                                    .font(JieboFont.mono(12))
                                    .foregroundStyle(JieboColor.dim)
                                    .lineLimit(1)
                            }
                        }
                    }
                    if store.workspaces.isEmpty {
                        Button {
                            store.startChat(in: store.workspaceRoot.isEmpty ? store.cwd : store.workspaceRoot)
                            dismiss()
                        } label: {
                            Text(store.workspaceRoot.isEmpty ? "正在读取工作区…" : workspaceName(store.workspaceRoot))
                                .foregroundStyle(JieboColor.ink)
                        }
                        .disabled(store.workspaceRoot.isEmpty && store.cwd.isEmpty)
                    }
                }
                Section {
                    if store.creatingWorkspace {
                        HStack {
                            TextField("名称", text: $store.newWorkspaceName)
                                .onSubmit { store.createWorkspace() }
                            Button("创建", action: store.createWorkspace)
                                .disabled(store.newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    } else {
                        Button("新建工作区") {
                            store.creatingWorkspace = true
                        }
                    }
                }
            }
            .navigationTitle("新对话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
