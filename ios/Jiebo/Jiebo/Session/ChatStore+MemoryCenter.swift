import Foundation

extension ChatStore {
    /// 记忆中心只读 UI 是否在前台（关层后保留 overview 缓存，可 refresh）
    var memoryCenterActive: Bool { memoryCenterActiveCount > 0 }

    func memoryCenterSetActive(_ active: Bool) {
        if active {
            memoryCenterActiveCount += 1
        } else {
            memoryCenterActiveCount = max(0, memoryCenterActiveCount - 1)
            if memoryCenterActiveCount == 0 {
                memoryCenterCancelSearchDebounce()
            }
        }
    }

    func memoryCenterResetIfInactive() {
        guard !memoryCenterActive else { return }
        memoryCenterCancelSearchDebounce()
        let cachedOverview = memoryCenterData.overview
        let cachedOverviewTruncated = memoryCenterData.overviewPayloadTruncated
        memoryCenterData = MemoryCenterReducer.clearSearchSession(.initial)
        memoryCenterData.overview = cachedOverview
        memoryCenterData.overviewPayloadTruncated = cachedOverviewTruncated
    }

    /// 换租户 / 登出：完整清空，防跨租户泄漏
    func memoryCenterResetTenant() {
        memoryCenterCancelSearchDebounce()
        memoryCenterLastSearch = nil
        memoryCenterData = .initial
    }

    /// WebSocket 断开：取消在途请求状态，保留已解码缓存
    func memoryCenterOnDisconnect() {
        memoryCenterCancelSearchDebounce()
        memoryCenterData = MemoryCenterReducer.flushInFlight(memoryCenterData)
    }

    func memoryCenterRefreshOverview() {
        memoryCenterSendGet(scopeId: nil, replaceSameKind: true)
    }

    func memoryCenterRefreshScope(_ scopeId: String) {
        memoryCenterSendGet(scopeId: scopeId, replaceSameKind: true)
    }

    func memoryCenterSendGet(scopeId: String?, replaceSameKind: Bool = false) {
        guard connected, unlocked else { return }
        let reqId = UUID().uuidString
        let kind: MemoryCenterRequestKind = scopeId == nil ? .overview : .scope
        let pending = MemoryCenterPendingRequest(reqId: reqId, kind: kind, scopeId: scopeId, query: nil)
        memoryCenterData = MemoryCenterReducer.registerPending(
            memoryCenterData,
            req: pending,
            replaceSameKind: replaceSameKind || kind == .scope
        )
        var args: [String: JSONValue] = [:]
        if let scopeId { args["scope"] = .string(scopeId) }
        send(.assistantOp(op: "memory_center_get", args: args, reqId: reqId))
    }

    func memoryCenterSendSearch(
        query: String,
        scope: String?,
        kind: String?,
        state: String?,
        replaceSameKind: Bool = true
    ) {
        guard connected, unlocked else { return }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let scopeTag = scope ?? "all"
        let kindTag = kind ?? "all"
        let stateTag = state ?? "all"
        memoryCenterLastSearch = MemoryCenterSearchParams(
            query: trimmed,
            scope: scopeTag,
            kind: kindTag,
            state: stateTag
        )
        let reqId = UUID().uuidString
        let pending = MemoryCenterPendingRequest(reqId: reqId, kind: .search, scopeId: scope, query: trimmed)
        memoryCenterData = MemoryCenterReducer.registerPending(memoryCenterData, req: pending, replaceSameKind: replaceSameKind)
        var args: [String: JSONValue] = ["query": .string(trimmed)]
        if scopeTag != "all", !scopeTag.isEmpty { args["scope"] = .string(scopeTag) }
        if kindTag != "all", !kindTag.isEmpty { args["kind"] = .string(kindTag) }
        if stateTag != "all", !stateTag.isEmpty { args["state"] = .string(stateTag) }
        send(.assistantOp(op: "memory_center_search", args: args, reqId: reqId))
    }

    func memoryCenterScheduleSearch(
        query: String,
        scope: String,
        kind: String,
        state: String,
        debounceKey: String
    ) {
        memoryCenterSearchDebounceTask?.cancel()
        memoryCenterPendingSearchKey = debounceKey
        memoryCenterSearchDebounceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, !Task.isCancelled else { return }
            guard self.memoryCenterPendingSearchKey == debounceKey else { return }
            let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            self.memoryCenterSendSearch(
                query: trimmed,
                scope: scope == "all" ? nil : scope,
                kind: kind == "all" ? nil : kind,
                state: state == "all" ? nil : state
            )
        }
    }

    func memoryCenterCancelSearchDebounce() {
        memoryCenterSearchDebounceTask?.cancel()
        memoryCenterSearchDebounceTask = nil
        memoryCenterPendingSearchKey = nil
    }

    func memoryCenterClearSearchResults() {
        memoryCenterCancelSearchDebounce()
        memoryCenterData = MemoryCenterReducer.clearSearchSession(memoryCenterData)
    }

    /// 搜索失败重试：用最近一次成功提交的 query / 筛选重新发请求
    func memoryCenterRetrySearch() {
        memoryCenterCancelSearchDebounce()
        guard let last = memoryCenterLastSearch else { return }
        memoryCenterSendSearch(
            query: last.query,
            scope: last.scope == "all" ? nil : last.scope,
            kind: last.kind == "all" ? nil : last.kind,
            state: last.state == "all" ? nil : last.state,
            replaceSameKind: true
        )
    }

    func memoryCenterHandleAssistantResult(
        reqId: String?,
        op: String,
        ok: Bool,
        error: String?,
        data: JSONValue?
    ) -> Bool {
        guard op == "memory_center_get" || op == "memory_center_search" || op == "memory_center_mutate" else {
            return false
        }
        var failureCode: String?
        var conflictDetail: MemoryCenterScopeDetail?
        if op == "memory_center_mutate", !ok, let row = data?.object {
            failureCode = row["code"]?.string
            if failureCode == "conflict" {
                conflictDetail = MemoryCenterScopeDetail.from(row["detail"])
            }
        }
        let mutatePayload = op == "memory_center_mutate" ? MemoryCenterMutateData.from(data) : nil
        let incoming = MemoryCenterIncomingResult(
            reqId: reqId,
            op: op,
            ok: ok,
            error: error,
            getData: op == "memory_center_get" ? MemoryCenterGetData.from(data) : nil,
            searchData: op == "memory_center_search" ? MemoryCenterSearchData.from(data) : nil,
            mutateData: mutatePayload ?? (conflictDetail.map {
                MemoryCenterMutateData(scope: "", action: "", item: nil, deletedId: nil, detail: $0)
            }),
            mutateFailureCode: failureCode
        )
        guard let applied = MemoryCenterReducer.applyResult(memoryCenterData, message: incoming) else {
            return false
        }
        memoryCenterData = applied
        return true
    }

    @discardableResult
    func memoryCenterSendMutate(scopeId: String, mutation: [String: JSONValue]) -> String? {
        guard connected, unlocked else { return nil }
        let reqId = UUID().uuidString
        let pending = MemoryCenterPendingRequest(reqId: reqId, kind: .mutation, scopeId: scopeId, query: nil)
        memoryCenterData = MemoryCenterReducer.registerPending(memoryCenterData, req: pending, replaceSameKind: false)
        let args: [String: JSONValue] = [
            "scope": .string(scopeId),
            "mutation": .object(mutation),
        ]
        send(.assistantOp(op: "memory_center_mutate", args: args, reqId: reqId))
        return reqId
    }

    func memoryCenterEnsureLoaded(navId: String, searchActive: Bool) {
        guard memoryCenterActive else { return }
        if searchActive { return }
        if navId == "overview" {
            if memoryCenterData.overview == nil, !memoryCenterData.loadingOverview {
                memoryCenterSendGet(scopeId: nil)
            }
            return
        }
        guard let scope = MemoryCenterReducer.scopeIdForNav(navId) else { return }
        let detailOk = memoryCenterData.detail?.scope.id == scope
        if !detailOk, !memoryCenterData.loadingScope {
            memoryCenterSendGet(scopeId: scope)
        }
    }
}
