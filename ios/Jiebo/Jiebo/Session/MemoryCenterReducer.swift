import Foundation

// MARK: - 记忆中心纯状态（对齐 web/components/assistant/memoryCenterReducer.ts）

enum MemoryCenterRequestKind: String, Sendable, Hashable {
    case overview, scope, search, mutation
}

struct MemoryCenterPendingRequest: Sendable, Hashable {
    var reqId: String
    var kind: MemoryCenterRequestKind
    var scopeId: String?
    var query: String?
}

struct MemoryCenterDataState: Sendable, Hashable {
    var overview: MemoryCenterOverview?
    var overviewPayloadTruncated = false
    var detail: MemoryCenterScopeDetail?
    var detailPayloadTruncated = false
    var search: MemoryCenterSearchData?
    var pending: [MemoryCenterPendingRequest] = []
    var overviewError = ""
    var scopeError = ""
    var searchError = ""
    var loadingOverview = false
    var loadingScope = false
    var loadingSearch = false
    var activeScopeId: String?
    var activeScopeReqId: String?
    var activeOverviewReqId: String?
    var activeSearchReqId: String?
    var activeMutationReqId: String?
    var mutationScopeId: String?
    var mutationError = ""
    var mutationErrorCode = ""
    var mutating = false
    var lastMutationOutcome: MemoryCenterMutationOutcome?

    static var initial: MemoryCenterDataState { MemoryCenterDataState() }
}

enum MemoryCenterMutationOutcome: Sendable, Hashable {
    case success(reqId: String, action: String)
    case failure(reqId: String, code: String, error: String)
}

struct MemoryCenterSearchParams: Sendable, Hashable {
    var query: String
    var scope: String
    var kind: String
    var state: String
}

struct MemoryCenterIncomingResult: Sendable {
    var reqId: String?
    var op: String
    var ok: Bool
    var error: String?
    var getData: MemoryCenterGetData?
    var searchData: MemoryCenterSearchData?
    var mutateData: MemoryCenterMutateData?
    var mutateFailureCode: String?
}

enum MemoryCenterReducer {
    /// 退出搜索 / 清空关键词：淘汰 search pending 与在途 reqId，迟到响应将被忽略
    static func clearSearchSession(_ data: MemoryCenterDataState) -> MemoryCenterDataState {
        var next = data
        next.pending = data.pending.filter { $0.kind != .search }
        next.search = nil
        next.searchError = ""
        next.loadingSearch = false
        next.activeSearchReqId = nil
        return next
    }

    /// 断线：清 pending/loading/active reqId，保留已展示的同租户缓存
    static func flushInFlight(_ data: MemoryCenterDataState) -> MemoryCenterDataState {
        var next = data
        next.pending = []
        next.loadingOverview = false
        next.loadingScope = false
        next.loadingSearch = false
        next.activeOverviewReqId = nil
        next.activeScopeReqId = nil
        next.activeSearchReqId = nil
        return next
    }

    static func registerPending(
        _ data: MemoryCenterDataState,
        req: MemoryCenterPendingRequest,
        replaceSameKind: Bool = false
    ) -> MemoryCenterDataState {
        let pending = replaceSameKind ? dropPendingOfKind(data.pending, kind: req.kind) : data.pending
        var next = data
        next.pending = pending + [req]

        switch req.kind {
        case .overview:
            next.loadingOverview = true
            next.activeOverviewReqId = req.reqId
            next.overviewError = ""
        case .scope:
            let scopeChanged = req.scopeId != nil && data.detail?.scope.id != req.scopeId
            next.loadingScope = true
            next.activeScopeId = req.scopeId
            next.activeScopeReqId = req.reqId
            if scopeChanged {
                next.detail = nil
                next.detailPayloadTruncated = false
            }
            next.scopeError = ""
        case .search:
            next.loadingSearch = true
            next.activeSearchReqId = req.reqId
            next.searchError = ""
        case .mutation:
            next.mutating = true
            next.activeMutationReqId = req.reqId
            next.mutationScopeId = req.scopeId
            next.mutationError = ""
            next.mutationErrorCode = ""
        }
        return next
    }

    static func dropPending(_ data: MemoryCenterDataState, reqId: String) -> MemoryCenterDataState {
        var next = data
        next.pending = data.pending.filter { $0.reqId != reqId }
        next.loadingOverview = next.pending.contains { $0.kind == .overview }
        next.loadingScope = next.pending.contains { $0.kind == .scope }
        next.loadingSearch = next.pending.contains { $0.kind == .search }
        next.mutating = next.pending.contains { $0.kind == .mutation }
        return next
    }

    static func findPending(_ data: MemoryCenterDataState, reqId: String?) -> MemoryCenterPendingRequest? {
        guard let reqId, !reqId.isEmpty else { return nil }
        return data.pending.first { $0.reqId == reqId }
    }

    static func applyResult(_ dataBefore: MemoryCenterDataState, message: MemoryCenterIncomingResult) -> MemoryCenterDataState? {
        guard message.op == "memory_center_get" || message.op == "memory_center_search" || message.op == "memory_center_mutate" else {
            return nil
        }
        guard let pending = findPending(dataBefore, reqId: message.reqId) else { return nil }

        var next = dropPending(dataBefore, reqId: pending.reqId)

        if message.op == "memory_center_mutate" {
            return applyMutateResult(dataBefore: dataBefore, data: next, pending: pending, message: message)
        }

        if !message.ok {
            let err = message.error?.nilIfEmpty ?? "请求失败"
            switch pending.kind {
            case .search:
                guard message.reqId == dataBefore.activeSearchReqId else { return next }
                next.searchError = err
            case .overview:
                guard message.reqId == dataBefore.activeOverviewReqId else { return next }
                next.overviewError = err
            case .scope:
                guard message.reqId == dataBefore.activeScopeReqId else { return next }
                next.scopeError = err
            case .mutation:
                guard message.reqId == dataBefore.activeMutationReqId else { return next }
                next.mutationError = err
                next.mutationErrorCode = message.mutateFailureCode ?? ""
            }
            return next
        }

        if message.op == "memory_center_get", let payload = message.getData {
            return applyGetResult(dataBefore: dataBefore, data: next, pending: pending, payload: payload)
        }
        if message.op == "memory_center_search", let payload = message.searchData {
            guard message.reqId == dataBefore.activeSearchReqId else { return next }
            next.search = payload
            next.searchError = ""
            return next
        }
        return next
    }

    private static func applyMutateResult(
        dataBefore: MemoryCenterDataState,
        data: MemoryCenterDataState,
        pending: MemoryCenterPendingRequest,
        message: MemoryCenterIncomingResult
    ) -> MemoryCenterDataState {
        guard pending.kind == .mutation, pending.reqId == dataBefore.activeMutationReqId else { return data }
        if let want = pending.scopeId, let active = dataBefore.mutationScopeId, want != active { return data }
        var next = data
        if !message.ok {
            next.mutationError = message.error?.nilIfEmpty ?? "保存失败"
            next.mutationErrorCode = message.mutateFailureCode ?? ""
            next.lastMutationOutcome = .failure(
                reqId: pending.reqId,
                code: next.mutationErrorCode,
                error: next.mutationError
            )
            if next.mutationErrorCode == "conflict", let detail = message.mutateData?.detail {
                if dataBefore.activeScopeId == detail.scope.id {
                    next.detail = detail
                }
            }
            return next
        }
        guard let payload = message.mutateData else {
            next.mutationError = "响应缺少 detail。"
            return next
        }
        if let want = pending.scopeId, payload.detail.scope.id != want { return data }
        if let active = dataBefore.activeScopeId, payload.detail.scope.id != active { return data }
        next.detail = payload.detail
        next.mutationError = ""
        next.mutationErrorCode = ""
        next.scopeError = ""
        next.lastMutationOutcome = .success(reqId: pending.reqId, action: payload.action)
        return next
    }

    private static func applyGetResult(
        dataBefore: MemoryCenterDataState,
        data: MemoryCenterDataState,
        pending: MemoryCenterPendingRequest,
        payload: MemoryCenterGetData
    ) -> MemoryCenterDataState {
        var next = data
        if payload.mode == "overview" {
            guard pending.kind == .overview, pending.reqId == dataBefore.activeOverviewReqId else { return next }
            next.overview = payload.overview
            next.overviewPayloadTruncated = payload.payloadTruncated
            next.overviewError = ""
            return next
        }
        guard pending.kind == .scope, pending.reqId == dataBefore.activeScopeReqId else { return next }
        guard let detail = payload.detail else { return next }
        if let want = pending.scopeId, detail.scope.id != want { return next }
        if let active = dataBefore.activeScopeId, detail.scope.id != active { return next }
        next.detail = detail
        next.detailPayloadTruncated = payload.payloadTruncated
        next.scopeError = ""
        return next
    }

    private static func dropPendingOfKind(_ pending: [MemoryCenterPendingRequest], kind: MemoryCenterRequestKind) -> [MemoryCenterPendingRequest] {
        if kind == .scope { return pending.filter { $0.kind != .scope } }
        if kind == .mutation { return pending.filter { $0.kind != .mutation } }
        return pending.filter { $0.kind != kind }
    }

    static func detailForScope(_ detail: MemoryCenterScopeDetail?, scopeId: String?) -> MemoryCenterScopeDetail? {
        guard let detail, let scopeId, !scopeId.isEmpty else { return nil }
        return detail.scope.id == scopeId ? detail : nil
    }

    static func resolveScopeLabel(scopeId: String, scopes: [MemoryCenterScopeSummary]) -> String {
        scopes.first { $0.id == scopeId }?.label ?? scopeId
    }

    struct ScopeTreeRow: Identifiable, Hashable, Sendable {
        var summary: MemoryCenterScopeSummary
        var depth: Int
        var id: String { summary.id }
    }

    static func buildScopeTreeRows(scopes: [MemoryCenterScopeSummary]) -> [ScopeTreeRow] {
        let workspace = scopes.filter { $0.id != "personal" && $0.id != "work_preference" }
        var byParent: [String?: [MemoryCenterScopeSummary]] = [:]
        for row in workspace {
            let key = row.parentId
            byParent[key, default: []].append(row)
        }
        for key in byParent.keys {
            byParent[key]?.sort { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
        }
        var out: [ScopeTreeRow] = []
        func walk(parentId: String?, depth: Int) {
            for row in byParent[parentId] ?? [] {
                out.append(ScopeTreeRow(summary: row, depth: depth))
                walk(parentId: row.id, depth: depth + 1)
            }
        }
        walk(parentId: nil, depth: 0)
        return out
    }

    static func overviewPendingTotal(scopes: [MemoryCenterScopeSummary]) -> Int {
        scopes.reduce(0) { $0 + $1.pendingCount }
    }

    static func workspaceScopesForOverview(scopes: [MemoryCenterScopeSummary]) -> [MemoryCenterScopeSummary] {
        scopes.filter { $0.id != "personal" && $0.id != "work_preference" }
    }

    static func filterItemsByState(items: [WorkspaceMemoryItem], stateFilter: String) -> [WorkspaceMemoryItem] {
        if stateFilter == "all" { return items }
        return items.filter { row in
            if stateFilter == "pinned" { return row.pinned }
            if stateFilter == "待核实" { return !row.missingRefs.isEmpty }
            return row.effectiveState == stateFilter || row.state == stateFilter
        }
    }

    static func pinnedOnlyItems(_ items: [WorkspaceMemoryItem]) -> [WorkspaceMemoryItem] {
        items.filter(\.pinned)
    }

    static func injectionRoundItems(items: [WorkspaceMemoryItem], diagnostics: InjectionDiagnostics?) -> [WorkspaceMemoryItem] {
        let ids = Set(
            (diagnostics?.selectedIds ?? [])
                .compactMap(\.id)
                .filter { !$0.isEmpty }
        )
        guard !ids.isEmpty else { return [] }
        return items.filter { item in
            guard let id = item.id else { return false }
            return ids.contains(id)
        }
    }

    static func selectionReasonForItem(id: String?, diagnostics: InjectionDiagnostics?) -> String? {
        guard let id, let diagnostics else { return nil }
        return diagnostics.selectedIds.first { $0.id == id }?.reason
    }

    static func skipReasonForItem(id: String?, diagnostics: InjectionDiagnostics?) -> String? {
        guard let id, let diagnostics else { return nil }
        return diagnostics.skippedReasons.first { $0.id == id }?.reason
    }

    static func scopeIdForNav(_ navId: String) -> String? {
        if navId == "overview" || navId == "activity" || navId == "suggestions" || navId == "settings" { return nil }
        return navId
    }

    static func isPlaceholderNav(_ navId: String) -> Bool {
        navId == "settings"
    }

    static func itemKey(scopeId: String, id: String?) -> String {
        "\(scopeId):\(id ?? "_")"
    }
}
