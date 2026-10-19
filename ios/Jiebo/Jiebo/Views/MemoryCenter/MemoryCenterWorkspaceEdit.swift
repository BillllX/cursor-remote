import SwiftUI

private let mcSections = ["约定", "命令", "坑", "决定", "进行中"]

struct MemoryCenterWorkspaceCreateSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let scopeId: String

    @State private var section = "约定"
    @State private var text = ""
    @State private var refsText = ""
    @State private var expires = ""
    @State private var pendingReqId: String?

    var body: some View {
        NavigationStack {
            Form {
                mutationErrorBlock
                Picker("章节", selection: $section) {
                    ForEach(mcSections, id: \.self) { Text($0).tag($0) }
                }
                TextField("正文", text: $text, axis: .vertical)
                    .lineLimit(4...8)
                TextField("引用（逗号分隔）", text: $refsText, axis: .vertical)
                    .lineLimit(2...4)
                TextField("过期 YYYY-MM-DD", text: $expires)
                    .textInputAutocapitalization(.never)
            }
            .navigationTitle("新增记忆")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建") { submitCreate() }
                        .disabled(store.memoryCenterData.mutating || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .disabled(store.memoryCenterData.mutating)
            .onChange(of: store.memoryCenterData.lastMutationOutcome) { _, outcome in
                guard let outcome, case .success(let reqId, _) = outcome, reqId == pendingReqId else { return }
                dismiss()
            }
        }
    }

    @ViewBuilder
    private var mutationErrorBlock: some View {
        if !store.memoryCenterData.mutationError.isEmpty {
            Text(store.memoryCenterData.mutationError)
                .foregroundStyle(.red)
                .font(JieboFont.text(.caption))
                .accessibilityLabel("保存错误")
        }
    }

    private func submitCreate() {
        let refs = refsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var mutation: [String: JSONValue] = [
            "action": .string("create"),
            "section": .string(section),
            "text": .string(text.trimmingCharacters(in: .whitespacesAndNewlines)),
        ]
        if !refs.isEmpty { mutation["refs"] = .array(refs.map { .string(String($0)) }) }
        if !expires.isEmpty { mutation["expires"] = .string(expires) }
        pendingReqId = store.memoryCenterSendMutate(scopeId: scopeId, mutation: mutation)
    }
}

struct MemoryCenterWorkspaceEditSheet: View {
    @Environment(ChatStore.self) private var store
    let scopeId: String
    let item: WorkspaceMemoryItem
    var onDeleted: (() -> Void)?
    @Environment(\.dismiss) private var dismiss

    @State private var section: String
    @State private var text: String
    @State private var refsText: String
    @State private var expires: String
    @State private var confirmDelete = false
    @State private var pendingReqId: String?

    init(scopeId: String, item: WorkspaceMemoryItem, onDeleted: (() -> Void)? = nil) {
        self.scopeId = scopeId
        self.item = item
        self.onDeleted = onDeleted
        _section = State(initialValue: item.section ?? "约定")
        _text = State(initialValue: item.text)
        _refsText = State(initialValue: item.refs.joined(separator: ", "))
        _expires = State(initialValue: item.expires ?? "")
    }

    private var liveItem: WorkspaceMemoryItem {
        let detail = MemoryCenterReducer.detailForScope(store.memoryCenterData.detail, scopeId: scopeId)
        if let id = item.id,
           let hit = detail?.items.first(where: { $0.id == id })
        {
            return hit
        }
        return item
    }

    var body: some View {
        NavigationStack {
            Form {
                mutationErrorBlock
                Picker("章节", selection: $section) {
                    ForEach(mcSections, id: \.self) { Text($0).tag($0) }
                }
                TextField("正文", text: $text, axis: .vertical)
                    .lineLimit(4...8)
                TextField("引用（逗号分隔）", text: $refsText, axis: .vertical)
                    .lineLimit(2...4)
                TextField("过期 YYYY-MM-DD", text: $expires)
                    .textInputAutocapitalization(.never)
                Section("状态") {
                    Button(liveItem.pinned ? "取消置顶" : "置顶") {
                        sendMutation([
                            "action": .string("set_pinned"),
                            "id": .string(liveItem.id!),
                            "revision": .string(liveItem.revision),
                            "pinned": .bool(!liveItem.pinned),
                        ])
                    }
                    .disabled(store.memoryCenterData.mutating || liveItem.id == nil)
                    if liveItem.effectiveState == "done" || liveItem.state == "done" {
                        Button("恢复为热") {
                            sendMutation([
                                "action": .string("set_state"),
                                "id": .string(liveItem.id!),
                                "revision": .string(liveItem.revision),
                                "state": .string("hot"),
                            ])
                        }
                    } else if liveItem.effectiveState == "expired" {
                        Button("恢复为热") {
                            sendMutation([
                                "action": .string("set_state"),
                                "id": .string(liveItem.id!),
                                "revision": .string(liveItem.revision),
                                "state": .string("hot"),
                            ])
                        }
                        Button("恢复为冷") {
                            sendMutation([
                                "action": .string("set_state"),
                                "id": .string(liveItem.id!),
                                "revision": .string(liveItem.revision),
                                "state": .string("cold"),
                            ])
                        }
                    } else {
                        Button("标为完成") {
                            sendMutation([
                                "action": .string("set_state"),
                                "id": .string(liveItem.id!),
                                "revision": .string(liveItem.revision),
                                "state": .string("done"),
                            ])
                        }
                        .disabled(liveItem.pinned)
                        Button(liveItem.state == "cold" ? "设为热" : "设为冷") {
                            sendMutation([
                                "action": .string("set_state"),
                                "id": .string(liveItem.id!),
                                "revision": .string(liveItem.revision),
                                "state": .string(liveItem.state == "cold" ? "hot" : "cold"),
                            ])
                        }
                    }
                    if confirmDelete {
                        Button("确认永久删除", role: .destructive) {
                            sendMutation([
                                "action": .string("delete"),
                                "id": .string(liveItem.id!),
                                "revision": .string(liveItem.revision),
                            ], deleteAfter: true)
                        }
                    } else {
                        Button("彻底删除…", role: .destructive) { confirmDelete = true }
                    }
                }
            }
            .navigationTitle("编辑记忆")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { savePatch() }
                        .disabled(store.memoryCenterData.mutating || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .disabled(store.memoryCenterData.mutating)
            .onChange(of: store.memoryCenterData.lastMutationOutcome) { _, outcome in
                guard let outcome, let pendingReqId else { return }
                switch outcome {
                case .success(let reqId, _) where reqId == pendingReqId:
                    if pendingDelete {
                        onDeleted?()
                        dismiss()
                    } else if pendingDismissOnSuccess {
                        dismiss()
                    }
                    pendingDelete = false
                    pendingDismissOnSuccess = false
                    self.pendingReqId = nil
                case .failure(let reqId, _, _) where reqId == pendingReqId:
                    break
                default:
                    break
                }
            }
        }
    }

    @State private var pendingDismissOnSuccess = false
    @State private var pendingDelete = false

    @ViewBuilder
    private var mutationErrorBlock: some View {
        if !store.memoryCenterData.mutationError.isEmpty {
            Text(store.memoryCenterData.mutationError)
                .foregroundStyle(.red)
                .font(JieboFont.text(.caption))
        }
    }

    private func savePatch() {
        guard let id = liveItem.id else { return }
        let refs = refsText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var patch: [String: JSONValue] = [
            "section": .string(section),
            "text": .string(text.trimmingCharacters(in: .whitespacesAndNewlines)),
            "refs": .array(refs.map { .string(String($0)) }),
        ]
        patch["expires"] = expires.isEmpty ? .null : .string(expires)
        pendingDismissOnSuccess = true
        sendMutation([
            "action": .string("update"),
            "id": .string(id),
            "revision": .string(liveItem.revision),
            "patch": .object(patch),
        ])
    }

    private func sendMutation(_ mutation: [String: JSONValue], deleteAfter: Bool = false) {
        pendingDelete = deleteAfter
        if !deleteAfter {
            if case .some(.string("update")) = mutation["action"] {
                // savePatch 已设 pendingDismissOnSuccess
            } else {
                pendingDismissOnSuccess = false
            }
        }
        pendingReqId = store.memoryCenterSendMutate(scopeId: scopeId, mutation: mutation)
    }
}
