import Foundation

struct MemoryCenterExtrasDataState: Sendable, Hashable {
    var activityRows: [MemoryCenterActivityRow] = []
    var suggestionRows: [MemoryCenterSuggestionRow] = []
    var activityError: String?
    var suggestionsError: String?
    var activityGeneration = 0
    var activityLoadReqId: String?
    var activityCursor: String?
    var activityLoadAppend = false
    var activityLoadRequestedCursor: String?
    var suggestionsGeneration = 0
    var suggestionsLoadReqId: String?
    var suggestionsCursor: String?
    var suggestionsHasMore = false
    var suggestionsTotal: Int?
    var suggestionsLoadAppend = false
    var pendingActivityReqIds: [String: Int] = [:]
    var pendingSuggestionsReqIds: [String: Int] = [:]
    var restoreReqByAuditId: [String: String] = [:]
    var restoreErrorByAuditId: [String: String] = [:]
    var answerReqBySuggestionId: [String: String] = [:]
    var suggestionErrorById: [String: String] = [:]
    var suggestionBusyById: [String: Bool] = [:]
    var importBusyReqId: String?
    var importExportPath: String?
    var importExportSha256: String?
    var importExportBytes: Int?
    var importPlanId: String?
    var importChanges: [MemoryCenterImportChangeRow] = []
    var importWarnings: [String] = []
    var importResolutions: [String: MemoryCenterImportResolution] = [:]
    var importLastImportId: String?
    var importError: String?
    var skillRows: [SkillFactorySummaryRow] = []
    var skillProposals: [SkillFactoryProposalRow] = []
    var skillsLoading = false
    var skillsLoadReqId: String?
    var skillsLoadAppend = false
    var skillsHasMore = false
    var skillsNextCursor: String?
    var skillsTotal: Int?
    var skillsWorkspace: String?
    var skillsDecideReqById: [String: String] = [:]
    var skillsError: String?

    static var initial: MemoryCenterExtrasDataState { MemoryCenterExtrasDataState() }
}

enum MemoryCenterExtrasReducer {
    static func beginActivityLoad(_ state: MemoryCenterExtrasDataState, reqId: String, refresh: Bool) -> MemoryCenterExtrasDataState {
        var next = state
        if refresh {
            next.activityGeneration += 1
            next.activityRows = []
            next.activityCursor = nil
            next.activityLoadAppend = false
            next.activityLoadRequestedCursor = nil
        } else {
            next.activityLoadAppend = true
            next.activityLoadRequestedCursor = state.activityCursor
        }
        next.activityLoadReqId = reqId
        next.pendingActivityReqIds[reqId] = next.activityGeneration
        next.activityError = nil
        return next
    }

    static func beginSuggestionsLoad(_ state: MemoryCenterExtrasDataState, reqId: String, refresh: Bool) -> MemoryCenterExtrasDataState {
        var next = state
        if refresh {
            next.suggestionsGeneration += 1
            next.suggestionRows = []
            next.suggestionsCursor = nil
            next.suggestionsHasMore = false
            next.suggestionsTotal = nil
            next.suggestionsLoadAppend = false
        } else {
            next.suggestionsLoadAppend = true
        }
        next.suggestionsLoadReqId = reqId
        next.pendingSuggestionsReqIds[reqId] = next.suggestionsGeneration
        next.suggestionsError = nil
        return next
    }

    static func beginRestore(_ state: MemoryCenterExtrasDataState, reqId: String, auditId: String) -> MemoryCenterExtrasDataState {
        var next = state
        next.restoreReqByAuditId[auditId] = reqId
        next.restoreErrorByAuditId[auditId] = ""
        return next
    }

    static func beginAnswer(_ state: MemoryCenterExtrasDataState, reqId: String, suggestionId: String) -> MemoryCenterExtrasDataState {
        var next = state
        next.answerReqBySuggestionId[suggestionId] = reqId
        next.suggestionBusyById[suggestionId] = true
        next.suggestionErrorById[suggestionId] = ""
        return next
    }

    static func applyActivity(
        _ state: MemoryCenterExtrasDataState,
        reqId: String,
        generation: Int,
        append: Bool,
        cursor: String?,
        data: MemoryCenterActivityData?
    ) -> MemoryCenterExtrasDataState? {
        guard state.pendingActivityReqIds[reqId] == generation else { return nil }
        guard reqId == state.activityLoadReqId else { return nil }
        if append, let cursor, cursor != state.activityCursor { return nil }
        var next = state
        next.pendingActivityReqIds.removeValue(forKey: reqId)
        guard let data else {
            next.activityError = "数据格式错误"
            return next
        }
        if append {
            next.activityRows.append(contentsOf: MemoryCenterActivityRow.rows(from: data))
        } else {
            next.activityRows = MemoryCenterActivityRow.rows(from: data)
        }
        next.activityCursor = data.nextCursor
        next.activityError = nil
        return next
    }

    static func applySuggestions(
        _ state: MemoryCenterExtrasDataState,
        reqId: String,
        generation: Int,
        append: Bool = false,
        data: MemoryCenterSuggestionsData?
    ) -> MemoryCenterExtrasDataState? {
        guard state.pendingSuggestionsReqIds[reqId] == generation else { return nil }
        guard reqId == state.suggestionsLoadReqId else { return nil }
        var next = state
        next.pendingSuggestionsReqIds.removeValue(forKey: reqId)
        next.suggestionsLoadAppend = false
        guard let data else {
            next.suggestionsError = "数据格式错误"
            return next
        }
        let incoming = MemoryCenterSuggestionRow.rows(from: data)
        if append {
            let seen = Set(next.suggestionRows.map(\.id))
            next.suggestionRows.append(contentsOf: incoming.filter { !seen.contains($0.id) })
        } else {
            next.suggestionRows = incoming
        }
        next.suggestionsHasMore = data.hasMore
        next.suggestionsCursor = data.nextCursor
        next.suggestionsTotal = data.total
        next.suggestionsError = nil
        return next
    }

    static func applyRestore(
        _ state: MemoryCenterExtrasDataState,
        reqId: String,
        auditId: String,
        ok: Bool,
        error: String?
    ) -> MemoryCenterExtrasDataState? {
        guard state.restoreReqByAuditId[auditId] == reqId else { return nil }
        var next = state
        next.restoreReqByAuditId.removeValue(forKey: auditId)
        if ok {
            next.restoreErrorByAuditId[auditId] = ""
        } else {
            next.restoreErrorByAuditId[auditId] = error ?? "恢复失败"
        }
        return next
    }

    static func applyAnswer(
        _ state: MemoryCenterExtrasDataState,
        reqId: String,
        suggestionId: String,
        ok: Bool,
        error: String?,
        removeId: String?
    ) -> MemoryCenterExtrasDataState? {
        guard state.answerReqBySuggestionId[suggestionId] == reqId else { return nil }
        var next = state
        next.answerReqBySuggestionId.removeValue(forKey: suggestionId)
        next.suggestionBusyById[suggestionId] = false
        if ok, let removeId {
            next.suggestionRows.removeAll { $0.id == removeId }
            next.suggestionErrorById[suggestionId] = ""
        } else {
            next.suggestionErrorById[suggestionId] = error ?? "处理失败"
        }
        return next
    }
}
