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
                    title: store.memoryCenterReadPendingTitle ?? "还没有活动",
                    hint: store.memoryCenterReadPendingTitle == nil ? "改过的记忆会出现在这里。" : ""
                )
            }
            ForEach(store.memoryCenterActivityRows) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(row.action) · \(row.scope)").font(JieboFont.text(.subheadline, weight: .semibold))
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
}

struct MemoryCenterSuggestionsPane: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let err = store.memoryCenterSuggestionsError, !err.isEmpty {
                Text(err).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warnFg)
            }
            if store.memoryCenterSuggestionsLoading {
                ProgressView().accessibilityLabel("加载建议")
            } else if store.memoryCenterSuggestionRows.isEmpty {
                MemoryCenterEmptyBlock(
                    title: store.memoryCenterReadPendingTitle ?? "还没有整理建议",
                    hint: store.memoryCenterReadPendingTitle == nil ? "小驳整理出可以合并或删掉的记忆后，会出现在这里。" : ""
                )
            }
            ForEach(store.memoryCenterSuggestionRows) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(row.kind) · \(row.scope)").font(JieboFont.text(.subheadline, weight: .semibold))
                    Text(row.summary).font(JieboFont.text(.footnote))
                    HStack(spacing: 8) {
                        ActionButton(title: "接受", kind: .primary) {
                            store.memoryCenterAnswerSuggestion(scope: row.scope, id: row.id, accept: true)
                        }
                        .disabled(store.memoryCenterExtrasStorage.suggestionBusyById[row.id] == true)
                        ActionButton(title: "忽略", kind: .outline) {
                            store.memoryCenterAnswerSuggestion(scope: row.scope, id: row.id, accept: false)
                        }
                        .disabled(store.memoryCenterExtrasStorage.suggestionBusyById[row.id] == true)
                    }
                    if let err = store.memoryCenterExtrasStorage.suggestionErrorById[row.id], !err.isEmpty {
                        Text(err).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.warnFg)
                    }
                }
                .assistantCard()
            }
        }
        .onAppear { store.memoryCenterLoadSuggestions() }
    }
}
