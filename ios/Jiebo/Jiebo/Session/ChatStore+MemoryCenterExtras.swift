import Foundation

extension ChatStore {
    var memoryCenterActivityRows: [MemoryCenterActivityRow] {
        get { memoryCenterExtrasStorage.activityRows }
        set { memoryCenterExtrasStorage.activityRows = newValue }
    }

    var memoryCenterSuggestionRows: [MemoryCenterSuggestionRow] {
        get { memoryCenterExtrasStorage.suggestionRows }
        set { memoryCenterExtrasStorage.suggestionRows = newValue }
    }

    var memoryCenterActivityLoading: Bool {
        !memoryCenterExtrasStorage.pendingActivityReqIds.isEmpty
    }

    var memoryCenterSuggestionsLoading: Bool {
        !memoryCenterExtrasStorage.pendingSuggestionsReqIds.isEmpty
    }

    var memoryCenterActivityError: String? {
        get { memoryCenterExtrasStorage.activityError }
        set { memoryCenterExtrasStorage.activityError = newValue }
    }

    var memoryCenterSuggestionsError: String? {
        get { memoryCenterExtrasStorage.suggestionsError }
        set { memoryCenterExtrasStorage.suggestionsError = newValue }
    }

    func memoryCenterLoadActivity(scope: String? = nil, action: String? = nil, append: Bool = false) {
        guard connected, unlocked else { return }
        let reqId = UUID().uuidString
        memoryCenterExtrasStorage = MemoryCenterExtrasReducer.beginActivityLoad(
            memoryCenterExtrasStorage,
            reqId: reqId,
            refresh: !append
        )
        var args: [String: JSONValue] = ["limit": .number(40)]
        if let scope, !scope.isEmpty { args["scope"] = .string(scope) }
        if let action, !action.isEmpty { args["action"] = .string(action) }
        if append, let cursor = memoryCenterExtrasStorage.activityCursor { args["cursor"] = .string(cursor) }
        send(.assistantOp(op: "memory_center_activity", args: args, reqId: reqId))
    }

    func memoryCenterLoadSuggestions(scope: String? = nil, refresh: Bool = true) {
        guard connected, unlocked else { return }
        let reqId = UUID().uuidString
        memoryCenterExtrasStorage = MemoryCenterExtrasReducer.beginSuggestionsLoad(
            memoryCenterExtrasStorage,
            reqId: reqId,
            refresh: refresh
        )
        var args: [String: JSONValue] = [:]
        if let scope, !scope.isEmpty { args["scope"] = .string(scope) }
        send(.assistantOp(op: "memory_center_suggestions_get", args: args, reqId: reqId))
    }

    func memoryCenterRestore(scope: String, auditId: String) {
        guard connected, unlocked else { return }
        let reqId = UUID().uuidString
        memoryCenterExtrasStorage = MemoryCenterExtrasReducer.beginRestore(memoryCenterExtrasStorage, reqId: reqId, auditId: auditId)
        send(.assistantOp(op: "memory_center_restore", args: ["scope": .string(scope), "auditId": .string(auditId)], reqId: reqId))
    }

    func memoryCenterAnswerSuggestion(scope: String, id: String, accept: Bool) {
        guard connected, unlocked else { return }
        let reqId = UUID().uuidString
        memoryCenterExtrasStorage = MemoryCenterExtrasReducer.beginAnswer(memoryCenterExtrasStorage, reqId: reqId, suggestionId: id)
        send(.assistantOp(
            op: "memory_center_suggestion_answer",
            args: ["scope": .string(scope), "id": .string(id), "accept": .bool(accept)],
            reqId: reqId
        ))
    }

    func memoryCenterHandleExtrasResult(reqId: String?, op: String, ok: Bool, error: String?, data: JSONValue?) -> Bool {
        guard let reqId else { return false }
        switch op {
        case "memory_center_activity":
            let parsed = ok ? MemoryCenterActivityData.from(data) : nil
            if let next = MemoryCenterExtrasReducer.applyActivity(
                memoryCenterExtrasStorage,
                reqId: reqId,
                generation: memoryCenterExtrasStorage.pendingActivityReqIds[reqId] ?? memoryCenterExtrasStorage.activityGeneration,
                append: false,
                cursor: nil,
                data: parsed
            ) {
                memoryCenterExtrasStorage = next
            } else if memoryCenterExtrasStorage.pendingActivityReqIds[reqId] != nil {
                var stale = memoryCenterExtrasStorage
                stale.pendingActivityReqIds.removeValue(forKey: reqId)
                memoryCenterExtrasStorage = stale
            }
            if !ok, reqId == memoryCenterExtrasStorage.activityLoadReqId {
                memoryCenterActivityError = error ?? "加载失败"
            }
            return true
        case "memory_center_restore":
            for (auditId, pendingReq) in memoryCenterExtrasStorage.restoreReqByAuditId where pendingReq == reqId {
                if let next = MemoryCenterExtrasReducer.applyRestore(
                    memoryCenterExtrasStorage,
                    reqId: reqId,
                    auditId: auditId,
                    ok: ok,
                    error: error
                ) {
                    memoryCenterExtrasStorage = next
                    if ok, let scope = data?.object?["scope"]?.string {
                        memoryCenterRefreshScope(scope)
                        memoryCenterLoadActivity(scope: scope)
                    }
                }
                return true
            }
            return true
        case "memory_center_suggestions_get":
            let parsed = ok ? MemoryCenterSuggestionsData.from(data) : nil
            if let next = MemoryCenterExtrasReducer.applySuggestions(
                memoryCenterExtrasStorage,
                reqId: reqId,
                generation: memoryCenterExtrasStorage.pendingSuggestionsReqIds[reqId] ?? memoryCenterExtrasStorage.suggestionsGeneration,
                data: parsed
            ) {
                memoryCenterExtrasStorage = next
            } else if memoryCenterExtrasStorage.pendingSuggestionsReqIds[reqId] != nil {
                var stale = memoryCenterExtrasStorage
                stale.pendingSuggestionsReqIds.removeValue(forKey: reqId)
                memoryCenterExtrasStorage = stale
            }
            if !ok, reqId == memoryCenterExtrasStorage.suggestionsLoadReqId {
                memoryCenterSuggestionsError = error ?? "加载失败"
            }
            return true
        case "memory_center_suggestion_answer":
            for (sid, pendingReq) in memoryCenterExtrasStorage.answerReqBySuggestionId where pendingReq == reqId {
                let payload = ok ? MemoryCenterSuggestionAnswerData.from(data) : nil
                if let next = MemoryCenterExtrasReducer.applyAnswer(
                    memoryCenterExtrasStorage,
                    reqId: reqId,
                    suggestionId: sid,
                    ok: ok && payload != nil,
                    error: error,
                    removeId: payload?.id
                ) {
                    memoryCenterExtrasStorage = next
                }
                return true
            }
            return true
        case "memory_center_export":
            guard reqId == memoryCenterExtrasStorage.importBusyReqId else { return true }
            var next = memoryCenterExtrasStorage
            next.importBusyReqId = nil
            if ok, let data = MemoryCenterExportData.from(data) {
                next.importExportPath = data.relativePath
                next.importExportSha256 = data.sha256
                next.importExportBytes = data.bytes
                next.importError = nil
            } else {
                next.importError = error ?? "导出失败"
            }
            memoryCenterExtrasStorage = next
            return true
        case "memory_center_import_preview":
            guard reqId == memoryCenterExtrasStorage.importBusyReqId else { return true }
            var next = memoryCenterExtrasStorage
            next.importBusyReqId = nil
            if ok, let data = MemoryCenterImportPreviewData.from(data) {
                next.importPlanId = data.planId
                next.importChanges = data.changes
                next.importWarnings = data.warnings
                next.importResolutions = [:]
                for row in data.changes where row.action == "conflict" {
                    next.importResolutions[row.changeId] = .keepCurrent
                }
                next.importError = nil
            } else {
                next.importError = error ?? "预演失败"
            }
            memoryCenterExtrasStorage = next
            return true
        case "memory_center_import_apply":
            guard reqId == memoryCenterExtrasStorage.importBusyReqId else { return true }
            var next = memoryCenterExtrasStorage
            next.importBusyReqId = nil
            if ok, let data = MemoryCenterImportApplyData.from(data) {
                next.importLastImportId = data.importId
                next.importPlanId = nil
                next.importChanges = []
                next.importWarnings = []
                next.importResolutions = [:]
                next.importError = nil
            } else {
                next.importError = error ?? "导入失败"
            }
            memoryCenterExtrasStorage = next
            return true
        case "memory_center_import_rollback":
            guard reqId == memoryCenterExtrasStorage.importBusyReqId else { return true }
            var next = memoryCenterExtrasStorage
            next.importBusyReqId = nil
            if ok, let data = MemoryCenterImportRollbackData.from(data) {
                if data.status == .rolledBack {
                    next.importLastImportId = nil
                }
                next.importError = nil
            } else {
                next.importError = error ?? "回滚失败"
            }
            memoryCenterExtrasStorage = next
            return true
        default:
            return false
        }
    }

    func memoryCenterExportSnapshot(scopes: [String]) {
        guard connected, unlocked, !scopes.isEmpty else { return }
        let reqId = UUID().uuidString
        var next = memoryCenterExtrasStorage
        next.importBusyReqId = reqId
        next.importError = nil
        memoryCenterExtrasStorage = next
        send(.assistantOp(op: "memory_center_export", args: ["scopes": .array(scopes.map { .string($0) })], reqId: reqId))
    }

    func memoryCenterImportPreview(path: String) {
        guard connected, unlocked, !path.isEmpty else { return }
        let reqId = UUID().uuidString
        var next = memoryCenterExtrasStorage
        next.importBusyReqId = reqId
        next.importError = nil
        memoryCenterExtrasStorage = next
        send(.assistantOp(op: "memory_center_import_preview", args: ["path": .string(path)], reqId: reqId))
    }

    func memoryCenterImportApply(planId: String, resolutions: [[String: JSONValue]]) {
        guard connected, unlocked else { return }
        let reqId = UUID().uuidString
        var next = memoryCenterExtrasStorage
        next.importBusyReqId = reqId
        memoryCenterExtrasStorage = next
        send(.assistantOp(op: "memory_center_import_apply", args: ["planId": .string(planId), "resolutions": .array(resolutions.map { .object($0) })], reqId: reqId))
    }

    func memoryCenterImportRollback(importId: String) {
        guard connected, unlocked else { return }
        let reqId = UUID().uuidString
        var next = memoryCenterExtrasStorage
        next.importBusyReqId = reqId
        memoryCenterExtrasStorage = next
        send(.assistantOp(op: "memory_center_import_rollback", args: ["importId": .string(importId)], reqId: reqId))
    }
}
