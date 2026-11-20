import SwiftUI

/// 手机与 iPad 使用同一项目页面，项目 ID 永不当作个人 cwd。
struct SharedProjectsView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var target = ""
    @State private var chatTitle = ""
    @State private var chatId = ""
    @State private var draft = ""
    @State private var filePath = ""
    @State private var fileText = ""
    @State private var members: [JSONValue] = []
    private var projectId: String? { store.projects.selected?["workspaceId"]?.string }
    private var writable: Bool { store.projects.selected?["role"]?.string != "viewer" && store.projects.selected?["state"]?.string == "active" }
    private func operation() -> JSONValue { .string(UUID().uuidString.lowercased()) }
    private func act(_ work: @escaping @MainActor () async throws -> Void) {
        Task { @MainActor in
            do { try await work() } catch { store.projects.notice = error.localizedDescription }
        }
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("项目文件与会话对当前成员可见全部历史；下载副本不能通过撤权收回。")
                    if !store.projects.notice.isEmpty { Text(store.projects.notice) }
                    TextField("新项目名称", text: $title)
                    Button("新建项目") { act {
                        _ = try await store.projects.request("project_create", payload: ["operationId": operation(), "title": .string(title)])
                        try await store.projects.refresh()
                    } }.disabled(title.isEmpty || !store.connected)
                }
                Section("项目") {
                    ForEach(Array(store.projects.items.enumerated()), id: \.offset) { _, row in
                        Button((row["title"]?.string ?? "项目") + " · " + (row["role"]?.string ?? "")) { act {
                            guard let id = row["workspaceId"]?.string else { return }
                            try await store.projects.open(id); fileText = ""; filePath = ""; chatId = ""
                        } }
                    }
                }
                Section("邀请收件箱") {
                    ForEach(Array(store.projects.invitations.enumerated()), id: \.offset) { _, row in
                        Button("接受：" + (row["title"]?.string ?? "项目") + "（全部历史可见）") { act {
                            _ = try await store.projects.request("project_invite_accept", payload: ["operationId": operation(), "inviteId": row["inviteId"] ?? .null])
                            try await store.projects.refresh()
                        } }
                    }
                }
                if let id = projectId {
                    Section("当前项目") {
                        Text((store.projects.selected?["title"]?.string ?? "") + " · " + (store.projects.selected?["role"]?.string ?? ""))
                        Button("刷新项目") { act { try await store.projects.open(id) } }
                        if ["owner", "admin"].contains(store.projects.selected?["role"]?.string ?? "") {
                            TextField("完整站内账号 ID", text: $target).textInputAutocapitalization(.never)
                            Button("邀请为查看者") { act {
                                _ = try await store.projects.request("project_invite", project: id, payload: ["operationId": operation(), "targetTenantId": .string(target), "role": .string("viewer")])
                                store.projects.notice = "邀请已进入对方项目收件箱"
                            } }
                        }
                        Button("查看成员") { act { members = try await store.projects.request("project_members", project: id)["items"]?.array ?? [] } }
                        ForEach(Array(members.enumerated()), id: \.offset) { _, row in
                            Text((row["tenantId"]?.string ?? "") + " · " + (row["role"]?.string ?? ""))
                        }
                    }
                    Section("文件") {
                        ForEach(Array(store.projects.files.enumerated()), id: \.offset) { _, row in
                            Button(row["path"]?.string ?? "文件") { act {
                                guard let path = row["path"]?.string else { return }
                                let result = try await store.projects.request("project_file_read", project: id, payload: ["path": .string(path)])
                                guard let text = result["text"]?.string else { store.projects.notice = "该文件需受控下载"; return }
                                filePath = path; fileText = text
                            } }.disabled(row["kind"]?.string == "dir")
                        }
                        TextField("文件相对路径", text: $filePath).textInputAutocapitalization(.never)
                        if !filePath.isEmpty { Text(filePath); TextEditor(text: $fileText).frame(minHeight: 160).disabled(!writable)
                            Button("保存文件") { act {
                                try await store.projects.saveFile(project: id, path: filePath, text: fileText, revision: store.projects.selected?["revision"]?.int ?? 0)
                            } }.disabled(!writable)
                            Text("发生版本冲突时保留内存草稿，不会自动覆盖新版本。")
                        }
                    }
                    Section("共享对话") {
                        ForEach(Array(store.projects.chats.enumerated()), id: \.offset) { _, row in
                            Button(row["title"]?.string ?? "对话") { act {
                                chatId = row["chatId"]?.string ?? ""
                                store.projects.messages = try await store.projects.request("project_chat_read", project: id, payload: ["chatId": .string(chatId)])["items"]?.array ?? []
                            } }
                        }
                        TextField("新对话标题", text: $chatTitle)
                        Button("新建共享对话") { act {
                            let row = try await store.projects.request("project_chat_create", project: id, payload: ["operationId": operation(), "title": .string(chatTitle)])
                            chatId = row["chatId"]?.string ?? ""; try await store.projects.open(id)
                        } }.disabled(!writable || chatTitle.isEmpty)
                        ForEach(Array(store.projects.messages.enumerated()), id: \.offset) { _, row in Text((row["actor"]?.string ?? "") + "：" + (row["text"]?.string ?? "")) }
                        TextField("全体成员可见的消息", text: $draft, axis: .vertical)
                        Button("发送共享消息") { act {
                            _ = try await store.projects.request("project_message_send", project: id, payload: ["operationId": operation(), "chatId": .string(chatId), "text": .string(draft), "runAgent": .bool(false)])
                            draft = ""; store.projects.messages = try await store.projects.request("project_chat_read", project: id, payload: ["chatId": .string(chatId)])["items"]?.array ?? []
                        } }.disabled(!writable || chatId.isEmpty || draft.isEmpty)
                    }
                }
            }
            .navigationTitle("共享项目")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("刷新") { act { try await store.projects.refresh() } } }
            }
            .task {
                store.projects.sendFrame = { [weak store] value in store?.send(.project(value)) }
                store.projects.online = store.connected && store.unlocked
                do { try await store.projects.refresh() } catch { store.projects.notice = error.localizedDescription }
            }
            .onChange(of: store.connected) { _, connected in
                store.projects.online = connected && store.unlocked
                if !connected { fileText = ""; draft = ""; members = [] }
            }
        }
    }
}
