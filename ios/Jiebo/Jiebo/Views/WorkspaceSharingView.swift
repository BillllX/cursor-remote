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
    @State private var question = ""
    @State private var asking = false
    @State private var askError = ""
    @State private var answers: [(question: String, answer: String, result: JSONValue)] = []
    @State private var filesOpen = false
    @State private var confirmWrites = true
    @State private var applying = false
    @State private var composerBuffer = ComposerDraftBuffer()
    @State private var composerRevision = 0
    @State private var composerFocused = false
    @State private var selectedModel = ""
    private var canAsk: Bool { store.gatewayFeatures.contains("workspace_share_ask_v1") }
    private var canEdit: Bool { store.gatewayFeatures.contains("workspace_share_edit_v1") }

    private var dirty: Bool { draft != saved }
    private var available: Bool { store.workspaceSharing.items.contains { $0.id == workspace.id } }

    var body: some View {
        List {
            if canAsk && !filesOpen {
                ForEach(answers.indices, id: \.self) { index in
                    let turn = answers[index]
                    Section {
                        Text(turn.question).font(.headline)
                        Text(turn.answer).textSelection(.enabled)
                        let sources = turn.result["sources"]?.array?.compactMap(\.string) ?? []
                        if !sources.isEmpty { Text("读取了 " + sources.joined(separator: "、")).font(.caption) }
                        if let plan = turn.result["pending"], let id = plan["id"]?.string {
                            ForEach(plan["changes"]?.array ?? [], id: \.self) { change in
                                DisclosureGroup(change["path"]?.string ?? "文件") {
                                    Text(change["preview"]?.string ?? "").textSelection(.enabled)
                                }
                            }
                            Button("批准写入") { Task { await resolveChanges(index, id: id) } }.disabled(applying)
                            Button("拒绝") { Task { await resolveChanges(index, id: id, discard: true) } }.disabled(applying)
                        }
                        let applied = turn.result["changes"]?["applied"]?.array?.compactMap(\.string) ?? []
                        if !applied.isEmpty { Text("已写入 " + applied.joined(separator: "、")).font(.caption) }
                        ForEach(turn.result["changes"]?["failed"]?.array ?? [], id: \.self) { failure in
                            Text((failure["path"]?.string ?? "") + " · " + (failure["error"]?.string ?? "写入失败"))
                        }
                    }
                }
                if asking { ProgressView("Agent 正在处理…") }
                if !askError.isEmpty { Text(askError).foregroundStyle(.secondary) }
            }
            if filesOpen || !canAsk {
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
        }
        .toolbar {
            if canAsk {
                ToolbarItem(placement: .primaryAction) {
                    Button(filesOpen ? "对话" : "文件") { filesOpen.toggle() }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if canAsk && !filesOpen { sharedComposer }
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

    private var sharedComposer: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                let availableModels = store.models.filter { !$0.contains(":") }
                Menu(ModelCatalog.label(for: selectedModel.isEmpty ? (availableModels.first ?? "") : selectedModel)) {
                    ForEach(availableModels, id: \.self) { model in
                        Button(ModelCatalog.label(for: model)) { selectedModel = model }
                    }
                }
                if canEdit { Toggle("确认写", isOn: $confirmWrites).toggleStyle(.button) }
            }
            HStack(alignment: .bottom, spacing: 6) {
                ComposerEntryField(placeholder: "交代要做的事", lineLimit: 1 ... 6, buffer: composerBuffer,
                    revision: composerRevision, focused: $composerFocused, submitOnReturn: true,
                    onEdit: { question = $0 }, onSubmit: { Task { await askAgent() } })
                    .padding(.vertical, 10).padding(.leading, 12)
                if asking {
                    Button {
                        Task { _ = try? await store.workspaceSharing.request("cancel", workspace: workspace.id) }
                    } label: { Image(systemName: "stop.fill").frame(width: 36, height: 36) }
                    .accessibilityLabel("停止回复")
                } else {
                    Button { Task { await askAgent() } } label: {
                        Image(systemName: "arrow.up").frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("发送")
                    .disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(4)
            .modifier(CapsuleSurface(focused: composerFocused))
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func resolveChanges(_ index: Int, id: String, discard: Bool = false) async {
        guard !applying else { return }
        applying = true
        defer { applying = false }
        do {
            let applied = try await store.workspaceSharing.request("apply", workspace: workspace.id,
                fields: ["changeId": .string(id), "discard": .bool(discard)])
            guard available, answers.indices.contains(index), var result = answers[index].result.object else { return }
            result.removeValue(forKey: "pending")
            if !discard { result["changes"] = applied }
            answers[index].result = .object(result)
            if !discard { await loadFiles() }
        } catch { askError = error.localizedDescription }
    }

    private func askAgent() async {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !asking, available, !text.isEmpty else { return }
        asking = true
        askError = ""
        defer { asking = false }
        let history = answers.suffix(4).map { turn in
            JSONValue.object(["question": .string(turn.question), "answer": .string(turn.answer)])
        }
        do {
            var fields: [String: JSONValue] = ["question": .string(text), "path": .string(path), "history": .array(history)]
            if canEdit { fields["confirmWrites"] = .bool(confirmWrites) }
            if !selectedModel.isEmpty { fields["model"] = .string(selectedModel) }
            let result = try await store.workspaceSharing.request("ask", workspace: workspace.id, fields: fields)
            guard available, let answer = result["answer"]?.string else { return }
            answers.append((text, answer, result))
            if question.trimmingCharacters(in: .whitespacesAndNewlines) == text {
                question = ""
                composerBuffer.text = ""
                composerRevision += 1
            }
            if result["changes"] != nil { await loadFiles() }
        } catch {
            if (error as? WorkspaceShareFailure)?.code == "UNAVAILABLE" { dismiss() }
            else { askError = error.localizedDescription }
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
