import SwiftUI

struct MemoryCenterActivityPane: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let err = store.memoryCenterActivityError, !err.isEmpty {
                Text(err).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warnFg)
            }
            if store.memoryCenterActivityLoading {
                ProgressView().accessibilityLabel("加载活动")
            } else if store.memoryCenterActivityRows.isEmpty {
                MemoryCenterEmptyBlock(
                    title: store.memoryCenterReadPendingTitle ?? "还没有改动",
                    hint: store.memoryCenterReadPendingTitle == nil ? "改过的记忆会出现在这里。" : ""
                )
            }
            ForEach(store.memoryCenterActivityRows) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(Self.actionLabel(row.action)) · \(row.scope)").font(JieboFont.text(.subheadline, weight: .semibold))
                    Text(row.summary).font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.ink2)
                    if row.canRestore {
                        Button("恢复") { store.memoryCenterRestore(scope: row.scope, auditId: row.auditId) }
                            .font(JieboFont.text(.footnote))
                            .disabled(store.memoryCenterExtrasStorage.restoreReqByAuditId[row.auditId] != nil)
                    } else if let blocked = row.blocked {
                        Text(blocked).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.dim)
                    }
                    if let err = store.memoryCenterExtrasStorage.restoreErrorByAuditId[row.auditId], !err.isEmpty {
                        Text(err).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.warnFg)
                    }
                }
                .assistantCard()
            }
        }
        .onAppear { store.memoryCenterLoadActivity() }
    }

    private static func actionLabel(_ action: String) -> String {
        switch action {
        case "create": return "创建"
        case "update": return "更新"
        case "set_state": return "改状态"
        case "set_pinned": return "始终带上"
        case "delete": return "删除"
        case "restore": return "恢复"
        default: return action
        }
    }
}

struct MemoryCenterSuggestionsPane: View {
    @Environment(ChatStore.self) private var store
    @State private var confirmBulk = false

    private var bulk: [MemoryCenterSuggestionRow] {
        store.memoryCenterSuggestionRows.filter { $0.risk == "low" && $0.kind != "missing_ref" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if confirmBulk {
                Button("返回") { confirmBulk = false }
                    .font(JieboFont.text(.subheadline))
                Text("看完全文再确认。缺引用的不会进这里。")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                ForEach(bulk) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("「\(row.summary)」").font(JieboFont.text(.subheadline))
                        Text(row.reason).font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.ink2)
                        Text(MemoryCenterLabels.suggestionOutcome(row.kind))
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.clay)
                    }
                    .assistantCard()
                }
                ActionButton(title: "确认处理这些", kind: .primary) {
                    for row in bulk {
                        store.memoryCenterAnswerSuggestion(scope: row.scope, id: row.id, accept: true)
                    }
                    confirmBulk = false
                }
            } else {
            suggestionList
            if !bulk.isEmpty {
                Button("一次处理风险低的 \(bulk.count) 条") { confirmBulk = true }
                    .font(JieboFont.text(.subheadline))
                    .padding(.top, 8)
            }
            }
        }
        .onAppear { store.memoryCenterLoadSuggestions() }
    }

    private var suggestionList: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let err = store.memoryCenterSuggestionsError, !err.isEmpty {
                Text(err).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warnFg)
            }
            if store.memoryCenterSuggestionsLoading {
                ProgressView().accessibilityLabel("加载建议")
            } else if store.memoryCenterSuggestionRows.isEmpty {
                MemoryCenterEmptyBlock(
                    title: store.memoryCenterReadPendingTitle ?? "都处理完了",
                    hint: store.memoryCenterReadPendingTitle == nil ? "" : ""
                )
            }
            ForEach(store.memoryCenterSuggestionRows) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text("「\(row.summary)」").font(JieboFont.text(.subheadline))
                    Text(row.reason).font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.ink2)
                    HStack(spacing: 8) {
                        ActionButton(title: "先留着", kind: .primary) {
                            store.memoryCenterAnswerSuggestion(scope: row.scope, id: row.id, accept: false)
                        }
                        .disabled(store.memoryCenterExtrasStorage.suggestionBusyById[row.id] == true)
                        Button(MemoryCenterLabels.suggestionOutcome(row.kind)) {
                            store.memoryCenterAnswerSuggestion(scope: row.scope, id: row.id, accept: true)
                        }
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.clay)
                        .disabled(store.memoryCenterExtrasStorage.suggestionBusyById[row.id] == true)
                    }
                    if let err = store.memoryCenterExtrasStorage.suggestionErrorById[row.id], !err.isEmpty {
                        Text(err).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.warnFg)
                    }
                }
                .assistantCard()
            }
        }
    }
}
