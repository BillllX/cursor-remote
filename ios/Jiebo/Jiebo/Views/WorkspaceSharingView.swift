import SwiftUI

struct ShareWorkspaceSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let name: String
    let path: String
    @State private var people: [JSONValue] = []
    @State private var selected: Set<String> = []
    @State private var revision = ""
    @State private var query = ""
    @State private var error = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            List {
                Text("所选同事登录后可直接打开此工作区、查看和编辑普通文件。个人对话、记忆和凭证各自保留。")
                TextField("搜索同事姓名", text: $query)
                ForEach(people.filter { row in
                    query.isEmpty || [row["name"]?.string, row["id"]?.string].compactMap { $0 }.contains { $0.localizedCaseInsensitiveContains(query) }
                }, id: \.self) { row in
                    if let id = row["id"]?.string {
                        Toggle(isOn: Binding(get: { selected.contains(id) }, set: { on in
                            if on { selected.insert(id) } else { selected.remove(id) }
                        })) {
                            VStack(alignment: .leading) {
                                Text(row["name"]?.string ?? id)
                                Text(id).font(.caption).foregroundStyle(.secondary)
                            }
                        }.disabled(saving)
                    }
                }
                if !error.isEmpty { Text(error).foregroundStyle(.secondary) }
                else if revision.isEmpty { ProgressView("正在读取同事名单…") }
                else if people.isEmpty { Text("没有可共享的同事") }
            }
            .navigationTitle("共享「\(name)」")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }.disabled(saving || revision.isEmpty)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        do {
            let value = try await store.workspaceSharing.request("people", workspace: path)
            people = value["people"]?.array ?? []
            selected = Set(value["memberIds"]?.array?.compactMap(\.string) ?? [])
            revision = value["memberRevision"]?.string ?? ""
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            _ = try await store.workspaceSharing.request("set", workspace: path, fields: [
                "memberIds": .array(selected.sorted().map { .string($0) }), "memberRevision": .string(revision),
            ])
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct SharedWorkspaceFileView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let workspace: SharedWorkspaceRow
    @State private var folder = ""
    @State private var entries: [JSONValue] = []
    @State private var truncated = false
    @State private var path = ""
    @State private var draft = ""
    @State private var saved = ""
    @State private var revision = ""
    @State private var conflict: JSONValue?
    @State private var notice = ""
    @State private var busy = false
    @State private var openTarget: String?

    private var dirty: Bool { draft != saved }
    private var available: Bool { store.workspaceSharing.items.contains { $0.id == workspace.id } }

    var body: some View {
        List {
            Section("来自 \(workspace.ownerName)") {
                if !folder.isEmpty {
                    Button("返回上一级") { folder = folder.split(separator: "/").dropLast().joined(separator: "/") }.disabled(busy)
                }
                ForEach(entries, id: \.self) { item in
                    if let name = item["name"]?.string {
                        let target = folder.isEmpty ? name : folder + "/" + name
                        if item["directory"]?.bool == true {
                            Button { folder = target } label: { Label(name, systemImage: "folder") }.disabled(busy)
                        } else {
                            Button {
                                if dirty { openTarget = target } else { Task { await open(target) } }
                            } label: { Label(name, systemImage: "doc") }.disabled(busy)
                        }
                    }
                }
                if truncated { Text("这个文件夹只显示前 400 项。").foregroundStyle(.secondary) }
            }
            if !path.isEmpty {
                Section(path) {
                    TextEditor(text: $draft).frame(minHeight: 160).disabled(busy)
                    Button("保存文件") { Task { await save() } }.disabled(busy || !dirty || conflict != nil)
                    if let conflict, let latest = conflict["content"]?.string {
                        Text("最新保存的版本").font(.headline)
                        Text(latest).textSelection(.enabled)
                        Button("保留草稿，基于新版继续编辑") {
                            saved = latest
                            revision = conflict["revision"]?.string ?? ""
                            self.conflict = nil
                        }
                    }
                }
            }
            if !notice.isEmpty { Text(notice) }
        }
        .navigationTitle(store.workspaceSharing.items.first { $0.id == workspace.id }?.name ?? workspace.name)
        .task(id: folder) { await loadFiles() }
        .onChange(of: available) { _, value in if !value { dismiss() } }
        .alert("放弃未保存的修改？", isPresented: Binding(get: { openTarget != nil }, set: { if !$0 { openTarget = nil } })) {
            Button("取消", role: .cancel) { openTarget = nil }
            Button("打开文件", role: .destructive) {
                if let target = openTarget { Task { await open(target) } }
                openTarget = nil
            }
        }
    }

    private func loadFiles() async {
        let target = folder
        do {
            let result = try await store.workspaceSharing.request("files", workspace: workspace.id, fields: ["path": .string(target)])
            guard !Task.isCancelled, available, target == folder else { return }
            entries = result["items"]?.array ?? []
            truncated = result["truncated"]?.bool ?? false
        } catch { if !Task.isCancelled { report(error) } }
    }

    private func open(_ target: String) async {
        guard !busy, available else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await store.workspaceSharing.request("read", workspace: workspace.id, fields: ["path": .string(target)])
            guard available else { return }
            path = target
            draft = result["content"]?.string ?? ""
            saved = draft
            revision = result["revision"]?.string ?? ""
            conflict = nil
            notice = ""
        } catch { report(error) }
    }

    private func save() async {
        guard !busy, available else { return }
        busy = true
        defer { busy = false }
        do {
            let result = try await store.workspaceSharing.request("write", workspace: workspace.id,
                fields: ["path": .string(path), "content": .string(draft), "revision": .string(revision)])
            guard available else { return }
            revision = result["revision"]?.string ?? revision
            saved = draft
            notice = "已保存"
        } catch {
            report(error)
            if (error as? WorkspaceShareFailure)?.code == "CONFLICT", available {
                do { conflict = try await store.workspaceSharing.request("read", workspace: workspace.id, fields: ["path": .string(path)]) }
                catch { report(error) }
            }
        }
    }

    private func report(_ error: Error) {
        if (error as? WorkspaceShareFailure)?.code == "UNAVAILABLE" { dismiss() }
        else { notice = error.localizedDescription }
    }
}
