import SwiftUI

struct MemoryCenterActivityPane: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let err = store.memoryCenterActivityError, !err.isEmpty {
                Text(err).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warn)
            }
            if store.memoryCenterActivityLoading {
                ProgressView().accessibilityLabel("加载活动")
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
                        Text(err).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.warn)
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
                Text(err).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warn)
            }
            if store.memoryCenterSuggestionsLoading {
                ProgressView().accessibilityLabel("加载建议")
            }
            ForEach(store.memoryCenterSuggestionRows) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(row.kind) · \(row.scope)").font(JieboFont.text(.subheadline, weight: .semibold))
                    Text(row.summary).font(JieboFont.text(.footnote))
                    HStack {
                        Button("接受") {
                            store.memoryCenterAnswerSuggestion(scope: row.scope, id: row.id, accept: true)
                        }
                        .disabled(store.memoryCenterExtrasStorage.suggestionBusyById[row.id] == true)
                        Button("忽略") {
                            store.memoryCenterAnswerSuggestion(scope: row.scope, id: row.id, accept: false)
                        }
                        .disabled(store.memoryCenterExtrasStorage.suggestionBusyById[row.id] == true)
                    }
                    .font(JieboFont.text(.footnote))
                    if let err = store.memoryCenterExtrasStorage.suggestionErrorById[row.id], !err.isEmpty {
                        Text(err).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.warn)
                    }
                }
                .assistantCard()
            }
        }
        .onAppear { store.memoryCenterLoadSuggestions() }
    }
}
