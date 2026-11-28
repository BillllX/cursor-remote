import SwiftUI

private struct SharePerson: Identifiable, Equatable {
    let id: String
    let name: String
}

struct ShareWorkspaceSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let name: String
    let path: String
    @State private var people: [SharePerson] = []
    @State private var duplicateNames: Set<String> = []
    @State private var selected: Set<String> = []
    @State private var savedSelection: Set<String> = []
    @State private var loading = true
    @State private var revision = ""
    @State private var query = ""
    @State private var error = ""
    @State private var saving = false

    private var filtered: [SharePerson] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return people }
        return people.filter { person in
            person.name.localizedCaseInsensitiveContains(needle)
                || person.id.localizedCaseInsensitiveContains(needle)
        }
    }

    var body: some View {
        let visiblePeople = filtered
        NavigationStack {
            List {
                Section {
                    Text("所选同事可在工作区列表打开此目录，并使用 Agent 处理共享文件。")
                        .font(.subheadline)
                        .foregroundStyle(JieboColor.dim)
                } header: {
                    JieboListHeader(name)
                }
                Section {
                    ForEach(visiblePeople) { person in
                        let isSelected = selected.contains(person.id)
                        Button {
                            if isSelected { selected.remove(person.id) }
                            else { selected.insert(person.id) }
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: NavigationIconId.account.symbol).foregroundStyle(JieboColor.dim)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(person.name).foregroundStyle(JieboColor.ink)
                                    if duplicateNames.contains(person.name) {
                                        Text(person.id).font(.caption).foregroundStyle(JieboColor.dim)
                                    }
                                }
                                Spacer()
                                if isSelected {
                                    Image(systemName: "checkmark").foregroundStyle(JieboColor.pine)
                                }
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                        .accessibilityAddTraits(isSelected ? .isSelected : [])
                        .disabled(saving)
                    }
                    if loading { ProgressView("正在读取同事名单…") }
                    else if visiblePeople.isEmpty && error.isEmpty {
                        Text(people.isEmpty ? "没有可共享的同事" : "没有匹配的同事")
                            .foregroundStyle(JieboColor.dim)
                    }
                    if !error.isEmpty {
                        Text(error).foregroundStyle(JieboColor.danger)
                        Button("重新读取名单") { Task { await load() } }.disabled(saving || loading)
                    }
                } header: {
                    JieboListHeader("同事")
                } footer: {
                    if !revision.isEmpty { Text("已选 \(selected.count) 位同事") }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(JieboColor.paper)
            .navigationTitle(WorkspaceShareChrome.title)
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "按姓名搜索")
            .interactiveDismissDisabled(saving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "正在保存…" : "保存") { Task { await save() } }
                        .disabled(saving || loading || revision.isEmpty || selected == savedSelection)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        loading = true
        error = ""
        defer { loading = false }
        do {
            let value = try await store.workspaceSharing.request("people", workspace: path)
            let rawPeople = value["people"]?.array ?? []
            var parsed: [SharePerson] = []
            parsed.reserveCapacity(rawPeople.count)
            var nameCounts: [String: Int] = [:]
            for row in rawPeople {
                guard let id = row["id"]?.string else { continue }
                let rawName = row["name"]?.string
                if let rawName { nameCounts[rawName, default: 0] += 1 }
                parsed.append(SharePerson(id: id, name: rawName ?? id))
            }
            people = parsed
            duplicateNames = Set(nameCounts.compactMap { $0.value > 1 ? $0.key : nil })
            selected = Set(value["memberIds"]?.array?.compactMap(\.string) ?? [])
            savedSelection = selected
            revision = value["memberRevision"]?.string ?? ""
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        guard !saving, !loading, !revision.isEmpty, selected != savedSelection else { return }
        error = ""
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

private struct SharedFileEntry: Identifiable, Equatable {
    let name: String
    let isDirectory: Bool
    var id: String { "\(isDirectory ? "d" : "f")|\(name)" }
}

private struct SharedPendingChange: Identifiable, Equatable {
    let id: Int
    let path: String
    let preview: String
}

private struct SharedFailedChange: Identifiable, Equatable {
    let id: Int
    let path: String
    let error: String
}

private struct SharedAnswerTurn: Identifiable, Equatable {
    let id = UUID()
    let serverTurnId: String?
    let question: String
    let answer: String
    let sources: [String]
    var pendingId: String?
    var pendingChanges: [SharedPendingChange]
    var applied: [String]
    var failed: [SharedFailedChange]

    init(question: String, answer: String, result: JSONValue) {
        self.serverTurnId = result["id"]?.string?.nilIfEmpty
        self.question = question
        self.answer = answer
        self.sources = result["sources"]?.array?.compactMap(\.string) ?? []
        if let plan = result["pending"], let planId = plan["id"]?.string {
            self.pendingId = planId
            self.pendingChanges = (plan["changes"]?.array ?? []).enumerated().map { idx, change in
                SharedPendingChange(
                    id: idx,
                    path: change["path"]?.string ?? "文件",
                    preview: change["preview"]?.string ?? ""
                )
            }
        } else {
            self.pendingId = nil
            self.pendingChanges = []
        }
        self.applied = result["changes"]?["applied"]?.array?.compactMap(\.string) ?? []
        self.failed = (result["changes"]?["failed"]?.array ?? []).enumerated().map { idx, failure in
            SharedFailedChange(
                id: idx,
                path: failure["path"]?.string ?? "",
                error: failure["error"]?.string ?? "写入失败"
            )
        }
    }

    mutating func resolve(appliedResult: JSONValue?, discard: Bool) {
        pendingId = nil
        pendingChanges = []
        if !discard, let appliedResult {
            applied = appliedResult["applied"]?.array?.compactMap(\.string) ?? []
            failed = (appliedResult["failed"]?.array ?? []).enumerated().map { idx, failure in
                SharedFailedChange(
                    id: idx,
                    path: failure["path"]?.string ?? "",
                    error: failure["error"]?.string ?? "写入失败"
                )
            }
        }
    }
}

struct SharedWorkspaceFileView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let workspace: SharedWorkspaceRow
    @State private var folder = ""
    @State private var entries: [SharedFileEntry] = []
    @State private var truncated = false
    @State private var filesHasMore = false
    @State private var filesNextCursor: String? = nil
    @State private var filesTotal: Int? = nil
    @State private var loadingMoreFiles = false
    @State private var path = ""
    @State private var draft = ""
    @State private var saved = ""
    @State private var revision = ""
    @State private var conflict: JSONValue?
    @State private var notice = ""
    @State private var busy = false
    @State private var openTarget: String?
    @State private var hasQuestion = false
    @State private var historyLoaded = false
    @State private var historyHasMore = false
    @State private var historyNextBefore: String? = nil
    @State private var loadingMoreHistory = false
    @State private var asking = false
    @State private var askError = ""
    @State private var answers: [SharedAnswerTurn] = []
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
        let currentWorkspace = store.workspaceSharing.items.first { $0.id == workspace.id }
        List {
            if canAsk && !filesOpen {
                if historyHasMore || loadingMoreHistory {
                    Section {
                        PaginationLoadEarlierHeader(
                            hasMore: historyHasMore,
                            loading: loadingMoreHistory,
                            label: "加载更早问答",
                            onLoadMore: {
                                if let before = historyNextBefore {
                                    Task { await loadHistory(beforeTurn: before) }
                                }
                            }
                        )
                    }
                }
                ForEach(answers) { turn in
                    Section {
                        Text(turn.question).font(.headline)
                        ChunkedAssistantMessage(text: turn.answer).equatable()
                        if !turn.sources.isEmpty { Text("读取了 " + turn.sources.joined(separator: "、")).font(.caption) }
                        if let id = turn.pendingId {
                            ForEach(turn.pendingChanges) { change in
                                DisclosureGroup(change.path) {
                                    Text(change.preview).textSelection(.enabled)
                                }
                            }
                            Button("批准写入") { Task { await resolveChanges(turn.id, id: id) } }.disabled(applying)
                            Button("拒绝") { Task { await resolveChanges(turn.id, id: id, discard: true) } }.disabled(applying)
                        }
                        if !turn.applied.isEmpty { Text("已写入 " + turn.applied.joined(separator: "、")).font(.caption) }
                        ForEach(turn.failed) { failure in
                            Text(failure.path + " · " + failure.error)
                        }
                    }
                }
                if asking { ProgressView("Agent 正在处理…") }
                if !askError.isEmpty { Text(askError).foregroundStyle(.secondary) }
                if !historyLoaded { Button("恢复会话记录") { Task { await loadHistory() } } }
            }
            if filesOpen || !canAsk {
            Section("来自 \(workspace.ownerName)") {
                if !folder.isEmpty {
                    Button("返回上一级") { folder = folder.split(separator: "/").dropLast().joined(separator: "/") }.disabled(busy)
                }
                ForEach(entries) { item in
                    let target = folder.isEmpty ? item.name : folder + "/" + item.name
                    if item.isDirectory {
                        Button { folder = target } label: { Label(item.name, systemImage: "folder") }.disabled(busy)
                    } else {
                        Button {
                            if dirty { openTarget = target } else { Task { await open(target) } }
                        } label: { Label(item.name, systemImage: "doc") }.disabled(busy)
                    }
                }
                if filesHasMore || loadingMoreFiles {
                    PaginationLoadMoreRow(
                        hasMore: filesHasMore,
                        loading: loadingMoreFiles,
                        loadedCount: entries.count,
                        totalCount: filesTotal,
                        label: "加载更多文件",
                        onLoadMore: {
                            if let cursor = filesNextCursor {
                                Task { await loadFiles(cursor: cursor, append: true) }
                            }
                        }
                    )
                } else if truncated {
                    Text("当前目录项较多，已展示前 \(entries.count) 项。").foregroundStyle(.secondary)
                }
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
                    Button { filesOpen.toggle() } label: {
                        Image(systemName: (filesOpen ? NavigationIconId.chats : .files).symbol).hitTarget()
                    }
                    .accessibilityLabel(filesOpen ? "返回对话" : NavigationIconId.files.label)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if canAsk && !filesOpen { sharedComposer }
        }
        .navigationTitle(currentWorkspace?.name ?? workspace.name)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: folder) { await loadFiles() }
        .task { await loadHistory() }
        .onChange(of: currentWorkspace != nil) { _, value in if !value { dismiss() } }
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
                    onEdit: { value in
                        let filled = value.contains { !$0.isWhitespace }
                        if filled != hasQuestion { hasQuestion = filled }
                    }, onSubmit: { Task { await askAgent() } })
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
                    .disabled(!hasQuestion)
                }
            }
            .padding(4)
            .modifier(CapsuleSurface(focused: composerFocused))
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func resolveChanges(_ turnId: UUID, id: String, discard: Bool = false) async {
        guard !applying else { return }
        applying = true
        defer { applying = false }
        do {
            let applied = try await store.workspaceSharing.request("apply", workspace: workspace.id,
                fields: ["changeId": .string(id), "discard": .bool(discard)])
            guard available, let idx = answers.firstIndex(where: { $0.id == turnId && $0.pendingId == id }) else { return }
            answers[idx].resolve(appliedResult: applied, discard: discard)
            if !discard { await loadFiles() }
        } catch { askError = error.localizedDescription }
    }

    private func loadHistory(beforeTurn: String? = nil) async {
        guard store.gatewayFeatures.contains("workspace_share_history_v1") else { historyLoaded = true; return }
        if beforeTurn != nil {
            guard !loadingMoreHistory else { return }
            loadingMoreHistory = true
        }
        defer { if beforeTurn != nil { loadingMoreHistory = false } }
        do {
            var fields: [String: JSONValue] = [:]
            if let beforeTurn, !beforeTurn.isEmpty { fields["beforeTurn"] = .string(beforeTurn) }
            let result = try await store.workspaceSharing.request("history", workspace: workspace.id, fields: fields)
            guard available, !Task.isCancelled else { return }
            let rows = (result["turns"]?.array ?? []).compactMap { turn -> SharedAnswerTurn? in
                guard let question = turn["question"]?.string, let answer = turn["answer"]?.string else { return nil }
                return SharedAnswerTurn(question: question, answer: answer, result: turn)
            }
            if beforeTurn != nil {
                answers = rows + answers
            } else {
                answers = rows
            }
            let oldestTurnId = answers.first?.serverTurnId
            historyHasMore = (result["hasMore"]?.bool ?? false) && oldestTurnId != nil
            historyNextBefore = historyHasMore ? oldestTurnId : nil
            historyLoaded = true
        } catch { askError = error.localizedDescription }
    }

    private func askAgent() async {
        let text = composerBuffer.commitText().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !asking, historyLoaded, available, !text.isEmpty else { return }
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
            answers.append(SharedAnswerTurn(question: text, answer: answer, result: result))
            if composerBuffer.text.trimmingCharacters(in: .whitespacesAndNewlines) == text {
                hasQuestion = false
                composerBuffer.text = ""
                composerRevision += 1
            }
            if result["changes"] != nil { await loadFiles() }
        } catch {
            if (error as? WorkspaceShareFailure)?.code == "UNAVAILABLE" { dismiss() }
            else { askError = error.localizedDescription }
        }
    }

    private func loadFiles(cursor: String? = nil, append: Bool = false) async {
        let target = folder
        if append {
            guard !loadingMoreFiles else { return }
            loadingMoreFiles = true
        } else {
            // 切换目录时先清空上一目录的分页状态，防止旧游标串目录触发 autoLoad
            filesHasMore = false
            filesNextCursor = nil
            filesTotal = nil
            loadingMoreFiles = false
        }
        defer { if append { loadingMoreFiles = false } }
        do {
            var fields: [String: JSONValue] = ["path": .string(target), "limit": .number(100)]
            if let cursor, !cursor.isEmpty { fields["cursor"] = .string(cursor) }
            let result = try await store.workspaceSharing.request("files", workspace: workspace.id, fields: fields)
            guard !Task.isCancelled, available, target == folder else { return }
            let rows = (result["items"]?.array ?? []).compactMap { item -> SharedFileEntry? in
                guard let name = item["name"]?.string else { return nil }
                return SharedFileEntry(name: name, isDirectory: item["directory"]?.bool == true)
            }
            if append {
                let seen = Set(entries.map(\.id))
                entries.append(contentsOf: rows.filter { !seen.contains($0.id) })
            } else {
                entries = rows
            }
            truncated = result["truncated"]?.bool ?? false
            filesHasMore = result["hasMore"]?.bool ?? false
            filesNextCursor = result["nextCursor"]?.string?.nilIfEmpty
            filesTotal = result["total"]?.int
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
