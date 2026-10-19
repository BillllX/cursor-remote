import Foundation

// MARK: - 统一记忆中心（严格对齐 shared/protocol.ts）

struct WorkspaceMemoryItem: Sendable, Hashable, Identifiable {
    var id: String?
    var kind: String
    var layer: String
    var scopeId: String
    var section: String?
    var text: String
    var refs: [String]
    var missingRefs: [String]
    var at: String?
    var from: String?
    var state: String?
    var effectiveState: String
    var pinned: Bool
    var used: String?
    var uses: Int?
    var expires: String?
    var truncated: Bool
    var revision: String

    var stableId: String { id ?? "\(scopeId):\(text.prefix(48))" }

    static func from(_ json: JSONValue) -> WorkspaceMemoryItem? {
        guard let row = json.object else { return nil }
        guard let kind = mcReqString(row, "kind"),
              let layer = mcReqString(row, "layer"),
              let scopeId = mcReqString(row, "scopeId"),
              let text = mcReqString(row, "text"),
              let effectiveState = mcReqString(row, "effectiveState"),
              let refs = mcReqStringList(row["refs"]),
              let missingRefs = mcReqStringList(row["missingRefs"])
        else { return nil }
        guard case let .some(idValue) = mcReqStringOrNull(row, "id"),
              case let .some(sectionValue) = mcOptNonNullString(row, "section"),
              case let .some(atValue) = mcOptNullableString(row, "at"),
              case let .some(fromValue) = mcOptNullableString(row, "from"),
              case let .some(stateValue) = mcOptNullableString(row, "state"),
              case let .some(usedValue) = mcOptNullableString(row, "used"),
              case let .some(usesValue) = mcOptNonNullInt(row, "uses"),
              case let .some(expiresValue) = mcOptNullableString(row, "expires"),
              let pinned = mcOptNonNullBool(row, "pinned", default: false),
              let truncated = mcOptNonNullBool(row, "truncated", default: false),
              let revision = mcReqString(row, "revision")
        else { return nil }
        return WorkspaceMemoryItem(
            id: idValue?.nilIfEmpty,
            kind: kind,
            layer: layer,
            scopeId: scopeId,
            section: sectionValue?.nilIfEmpty,
            text: text,
            refs: refs,
            missingRefs: missingRefs,
            at: atValue?.nilIfEmpty,
            from: fromValue?.nilIfEmpty,
            state: stateValue?.nilIfEmpty,
            effectiveState: effectiveState,
            pinned: pinned,
            used: usedValue?.nilIfEmpty,
            uses: usesValue,
            expires: expiresValue?.nilIfEmpty,
            truncated: truncated,
            revision: revision
        )
    }
}

struct MemoryCenterMutateData: Sendable, Hashable {
    var scope: String
    var action: String
    var item: WorkspaceMemoryItem?
    var deletedId: String?
    var detail: MemoryCenterScopeDetail

    static func from(_ value: JSONValue?) -> MemoryCenterMutateData? {
        guard let object = value?.object,
              let scope = mcReqString(object, "scope"),
              let action = mcReqString(object, "action"),
              let detail = MemoryCenterScopeDetail.from(object["detail"])
        else { return nil }
        let item: WorkspaceMemoryItem?
        if case .some(let raw) = object["item"], raw != .null {
            guard let parsed = WorkspaceMemoryItem.from(raw) else { return nil }
            item = parsed
        } else {
            item = nil
        }
        let deletedId = object["deletedId"]?.string
        return MemoryCenterMutateData(
            scope: scope,
            action: action,
            item: item,
            deletedId: deletedId?.nilIfEmpty,
            detail: detail
        )
    }
}

struct RuleFile: Sendable, Hashable, Identifiable {
    var relPath: String
    var appliesDir: String
    var chars: Int
    var body: String
    var truncated: Bool

    var id: String { relPath }

    static func from(_ json: JSONValue) -> RuleFile? {
        guard let row = json.object,
              let relPath = mcReqString(row, "relPath"),
              !relPath.isEmpty,
              let appliesDir = mcReqString(row, "appliesDir"),
              let chars = mcReqInt(row, "chars"),
              let body = mcReqString(row, "body")
        else { return nil }
        guard let truncated = mcOptNonNullBool(row, "truncated", default: false) else { return nil }
        return RuleFile(
            relPath: relPath,
            appliesDir: appliesDir,
            chars: chars,
            body: body,
            truncated: truncated
        )
    }
}

struct InjectionSelectionId: Sendable, Hashable {
    var id: String?
    var reason: String

    static func from(_ json: JSONValue) -> InjectionSelectionId? {
        guard let row = json.object,
              let reason = mcReqString(row, "reason")
        else { return nil }
        guard case let .some(idValue) = mcReqStringOrNull(row, "id") else { return nil }
        return InjectionSelectionId(id: idValue?.nilIfEmpty, reason: reason)
    }
}

struct InjectionSkipReason: Sendable, Hashable {
    var id: String?
    var reason: String

    static func from(_ json: JSONValue) -> InjectionSkipReason? {
        guard let row = json.object,
              let reason = mcReqString(row, "reason")
        else { return nil }
        guard case let .some(idValue) = mcReqStringOrNull(row, "id") else { return nil }
        return InjectionSkipReason(id: idValue?.nilIfEmpty, reason: reason)
    }
}

struct InjectionDiagnostics: Sendable, Hashable {
    var total: Int
    var selected: Int
    var skippedBudget: Int
    var hotSelected: Int
    var coldRecalled: Int
    var terminalSkipped: Int
    var coldUnrelatedSkipped: Int?
    var pinnedSelected: Int
    var relevantSelected: Int
    var strategy: String
    var selectedIds: [InjectionSelectionId]
    var skippedReasons: [InjectionSkipReason]
    var selectedIdsTruncated: Bool
    var skippedReasonsTruncated: Bool
    var truncated: Bool

    static func from(_ value: JSONValue?) -> InjectionDiagnostics? {
        guard let value else { return nil }
        if case .null = value { return nil }
        guard let row = value.object,
              let total = mcReqInt(row, "total"),
              let selected = mcReqInt(row, "selected"),
              let skippedBudget = mcReqInt(row, "skippedBudget"),
              let hotSelected = mcReqInt(row, "hotSelected"),
              let coldRecalled = mcReqInt(row, "coldRecalled"),
              let terminalSkipped = mcReqInt(row, "terminalSkipped"),
              let pinnedSelected = mcReqInt(row, "pinnedSelected"),
              let relevantSelected = mcReqInt(row, "relevantSelected"),
              let strategy = mcReqString(row, "strategy"),
              let selectedIds = mcDecodeArray(row["selectedIds"], InjectionSelectionId.from)
        else { return nil }
        guard let skippedReasons = mcOptNonNullArray(row, "skippedReasons", default: [], decode: InjectionSkipReason.from),
              case let .some(coldUnrelatedSkipped) = mcOptNonNullInt(row, "coldUnrelatedSkipped"),
              let selectedIdsTruncated = mcOptNonNullBool(row, "selectedIdsTruncated", default: false),
              let skippedReasonsTruncated = mcOptNonNullBool(row, "skippedReasonsTruncated", default: false),
              let truncated = mcOptNonNullBool(row, "truncated", default: false)
        else { return nil }
        return InjectionDiagnostics(
            total: total,
            selected: selected,
            skippedBudget: skippedBudget,
            hotSelected: hotSelected,
            coldRecalled: coldRecalled,
            terminalSkipped: terminalSkipped,
            coldUnrelatedSkipped: coldUnrelatedSkipped,
            pinnedSelected: pinnedSelected,
            relevantSelected: relevantSelected,
            strategy: strategy,
            selectedIds: selectedIds,
            skippedReasons: skippedReasons,
            selectedIdsTruncated: selectedIdsTruncated,
            skippedReasonsTruncated: skippedReasonsTruncated,
            truncated: truncated
        )
    }
}

struct MemoryCenterScopeSummary: Sendable, Hashable, Identifiable {
    var id: String
    var label: String
    var kind: String
    var layer: String
    var parentId: String?
    var memoryCount: Int
    var hot: Int
    var cold: Int
    var done: Int
    var expired: Int
    var pinned: Int
    var missingRefs: Int
    var ruleFileCount: Int
    var tokenBudget: Int
    var injectionSelected: Int
    var injectionSkipped: Int
    var pendingCount: Int
    var health: String?
    var error: String?

    static func from(_ json: JSONValue) -> MemoryCenterScopeSummary? {
        guard let row = json.object,
              let id = mcReqString(row, "id"), !id.isEmpty,
              let label = mcReqString(row, "label"),
              let kind = mcReqString(row, "kind"),
              let layer = mcReqString(row, "layer"),
              let memoryCount = mcReqInt(row, "memoryCount"),
              let hot = mcReqInt(row, "hot"),
              let cold = mcReqInt(row, "cold"),
              let done = mcReqInt(row, "done"),
              let expired = mcReqInt(row, "expired"),
              let pinned = mcReqInt(row, "pinned"),
              let missingRefs = mcReqInt(row, "missingRefs"),
              let ruleFileCount = mcReqInt(row, "ruleFileCount"),
              let tokenBudget = mcReqInt(row, "tokenBudget"),
              let injectionSelected = mcReqInt(row, "injectionSelected"),
              let injectionSkipped = mcReqInt(row, "injectionSkipped"),
              let pendingCount = mcReqInt(row, "pendingCount")
        else { return nil }
        guard case let .some(parentId) = mcOptNullableString(row, "parentId"),
              case let .some(health) = mcOptNullableString(row, "health"),
              case let .some(error) = mcOptNullableString(row, "error")
        else { return nil }
        return MemoryCenterScopeSummary(
            id: id,
            label: label,
            kind: kind,
            layer: layer,
            parentId: parentId?.nilIfEmpty,
            memoryCount: memoryCount,
            hot: hot,
            cold: cold,
            done: done,
            expired: expired,
            pinned: pinned,
            missingRefs: missingRefs,
            ruleFileCount: ruleFileCount,
            tokenBudget: tokenBudget,
            injectionSelected: injectionSelected,
            injectionSkipped: injectionSkipped,
            pendingCount: pendingCount,
            health: health?.nilIfEmpty,
            error: error?.nilIfEmpty
        )
    }
}

struct MemoryCenterPersonalOverview: Sendable, Hashable {
    var validEntries: Int
    var invalidEntries: Int
    var coreFieldLines: Int
    var workPreferenceLines: Int
    var paused: Bool
    var coreBudget: Int
    var coreTokens: Int
    var workPreferenceBudget: Int

    static func from(_ value: JSONValue?) -> MemoryCenterPersonalOverview? {
        guard let object = value?.object,
              let validEntries = mcReqInt(object, "validEntries"),
              let invalidEntries = mcReqInt(object, "invalidEntries"),
              let coreFieldLines = mcReqInt(object, "coreFieldLines"),
              let workPreferenceLines = mcReqInt(object, "workPreferenceLines"),
              let paused = mcReqBool(object, "paused"),
              let coreBudget = mcReqInt(object, "coreBudget"),
              let coreTokens = mcReqInt(object, "coreTokens"),
              let workPreferenceBudget = mcReqInt(object, "workPreferenceBudget")
        else { return nil }
        return MemoryCenterPersonalOverview(
            validEntries: validEntries,
            invalidEntries: invalidEntries,
            coreFieldLines: coreFieldLines,
            workPreferenceLines: workPreferenceLines,
            paused: paused,
            coreBudget: coreBudget,
            coreTokens: coreTokens,
            workPreferenceBudget: workPreferenceBudget
        )
    }
}

struct MemoryCenterOverview: Sendable, Hashable {
    var personal: MemoryCenterPersonalOverview
    var scopes: [MemoryCenterScopeSummary]
    var scopesTruncated: Bool

    static func from(_ value: JSONValue?) -> MemoryCenterOverview? {
        guard let object = value?.object,
              let personal = MemoryCenterPersonalOverview.from(object["personal"]),
              let scopes = mcDecodeArray(object["scopes"], MemoryCenterScopeSummary.from)
        else { return nil }
        guard let scopesTruncated = mcOptNonNullBool(object, "scopesTruncated", default: false) else { return nil }
        return MemoryCenterOverview(
            personal: personal,
            scopes: scopes,
            scopesTruncated: scopesTruncated
        )
    }
}

struct MemoryCenterScopeDetail: Sendable, Hashable {
    var scope: MemoryCenterScopeSummary
    var items: [WorkspaceMemoryItem]
    var rules: [RuleFile]
    var diagnostics: InjectionDiagnostics?
    var itemsTruncated: Bool
    var rulesTruncated: Bool
    var rulesPayloadTruncated: Bool

    static func from(_ value: JSONValue?) -> MemoryCenterScopeDetail? {
        guard let object = value?.object,
              let scopeValue = object["scope"],
              let scope = MemoryCenterScopeSummary.from(scopeValue),
              object.keys.contains("diagnostics"),
              let items = mcDecodeArray(object["items"], WorkspaceMemoryItem.from),
              let rules = mcDecodeArray(object["rules"], RuleFile.from)
        else { return nil }
        let diagnostics: InjectionDiagnostics?
        switch object["diagnostics"] {
        case .none:
            return nil
        case .some(.null):
            diagnostics = nil
        case .some(let raw):
            guard let parsed = InjectionDiagnostics.from(raw) else { return nil }
            diagnostics = parsed
        }
        guard let itemsTruncated = mcOptNonNullBool(object, "itemsTruncated", default: false),
              let rulesTruncated = mcOptNonNullBool(object, "rulesTruncated", default: false),
              let rulesPayloadTruncated = mcOptNonNullBool(object, "rulesPayloadTruncated", default: false)
        else { return nil }
        return MemoryCenterScopeDetail(
            scope: scope,
            items: items,
            rules: rules,
            diagnostics: diagnostics,
            itemsTruncated: itemsTruncated,
            rulesTruncated: rulesTruncated,
            rulesPayloadTruncated: rulesPayloadTruncated
        )
    }
}

struct MemoryCenterGetData: Sendable, Hashable {
    var mode: String
    var overview: MemoryCenterOverview?
    var detail: MemoryCenterScopeDetail?
    var payloadTruncated: Bool

    static func from(_ value: JSONValue?) -> MemoryCenterGetData? {
        guard let object = value?.object, let mode = mcReqString(object, "mode") else { return nil }
        guard let truncated = mcOptNonNullBool(object, "payloadTruncated", default: false) else { return nil }
        switch mode {
        case "overview":
            guard let overview = MemoryCenterOverview.from(object["overview"]) else { return nil }
            return MemoryCenterGetData(mode: mode, overview: overview, detail: nil, payloadTruncated: truncated)
        case "detail":
            guard let detail = MemoryCenterScopeDetail.from(object["detail"]) else { return nil }
            return MemoryCenterGetData(mode: mode, overview: nil, detail: detail, payloadTruncated: truncated)
        default:
            return nil
        }
    }
}

struct MemoryCenterSearchHit: Sendable, Hashable, Identifiable {
    var scopeId: String
    var kind: String
    var layer: String
    var id: String?
    var section: String?
    var text: String
    var refs: [String]
    var missingRefs: [String]
    var state: String?
    var effectiveState: String
    var pinned: Bool
    var reasons: [String]
    var score: Double

    var stableId: String { id ?? "\(scopeId):\(text.prefix(48))" }

    static func from(_ json: JSONValue) -> MemoryCenterSearchHit? {
        guard let row = json.object,
              let scopeId = mcReqString(row, "scopeId"),
              let kind = mcReqString(row, "kind"),
              let layer = mcReqString(row, "layer"),
              let text = mcReqString(row, "text"),
              let effectiveState = mcReqString(row, "effectiveState"),
              let refs = mcReqStringList(row["refs"]),
              let missingRefs = mcReqStringList(row["missingRefs"]),
              let reasons = mcReqStringList(row["reasons"]),
              let score = mcReqDouble(row, "score")
        else { return nil }
        let validReasons: Set<String> = ["text", "section", "ref", "scope", "state", "pinned", "related"]
        guard reasons.allSatisfy({ validReasons.contains($0) }) else { return nil }
        guard case let .some(idValue) = mcReqStringOrNull(row, "id"),
              case let .some(sectionValue) = mcOptNonNullString(row, "section"),
              case let .some(stateValue) = mcOptNullableString(row, "state"),
              let pinned = mcOptNonNullBool(row, "pinned", default: false)
        else { return nil }
        return MemoryCenterSearchHit(
            scopeId: scopeId,
            kind: kind,
            layer: layer,
            id: idValue?.nilIfEmpty,
            section: sectionValue?.nilIfEmpty,
            text: text,
            refs: refs,
            missingRefs: missingRefs,
            state: stateValue?.nilIfEmpty,
            effectiveState: effectiveState,
            pinned: pinned,
            reasons: reasons,
            score: score
        )
    }
}

struct MemoryCenterSearchData: Sendable, Hashable {
    var hits: [MemoryCenterSearchHit]
    var truncated: Bool
    var payloadTruncated: Bool

    static func from(_ value: JSONValue?) -> MemoryCenterSearchData? {
        guard let object = value?.object,
              let hits = mcDecodeArray(object["hits"], MemoryCenterSearchHit.from)
        else { return nil }
        guard let truncated = mcOptNonNullBool(object, "truncated", default: false),
              let payloadTruncated = mcOptNonNullBool(object, "payloadTruncated", default: false)
        else { return nil }
        return MemoryCenterSearchData(
            hits: hits,
            truncated: truncated,
            payloadTruncated: payloadTruncated
        )
    }
}

// MARK: - 活动 / 建议 / 恢复（对齐 shared/protocol.ts）

struct MemoryCenterActivitySnapshotSummary: Sendable, Hashable {
    var id: String?
    var section: String
    var text: String
    var revision: String
    var state: String?
    var pinned: Bool?

    static func from(_ value: JSONValue?) -> MemoryCenterActivitySnapshotSummary? {
        guard let row = value?.object,
              let section = mcReqString(row, "section"),
              let text = mcReqString(row, "text"),
              let revision = mcReqString(row, "revision")
        else { return nil }
        guard case let .some(idValue) = mcReqStringOrNull(row, "id") else { return nil }
        guard case let .some(stateValue) = mcOptNullableString(row, "state") else { return nil }
        let pinned: Bool?
        if row["pinned"] == nil {
            pinned = nil
        } else if let b = mcOptNonNullBool(row, "pinned", default: false) {
            pinned = b
        } else {
            return nil
        }
        return MemoryCenterActivitySnapshotSummary(
            id: idValue?.nilIfEmpty,
            section: section,
            text: text,
            revision: revision,
            state: stateValue?.nilIfEmpty,
            pinned: pinned
        )
    }
}

struct MemoryCenterActivityEntry: Sendable, Hashable, Identifiable {
    var auditId: String
    var scope: String
    var itemId: String
    var action: String
    var actor: String
    var at: String
    var before: MemoryCenterActivitySnapshotSummary?
    var after: MemoryCenterActivitySnapshotSummary?
    var canRestore: Bool
    var restoreBlockedReason: String?
    var degraded: Bool?

    var id: String { auditId }

    static func from(_ json: JSONValue) -> MemoryCenterActivityEntry? {
        guard let row = json.object,
              let auditId = mcReqString(row, "auditId"),
              let scope = mcReqString(row, "scope"),
              let itemId = mcReqString(row, "itemId"),
              let action = mcReqString(row, "action"),
              let actor = mcReqString(row, "actor"),
              let at = mcReqString(row, "at"),
              let canRestore = mcReqBool(row, "canRestore")
        else { return nil }
        let actions: Set<String> = ["create", "update", "set_state", "set_pinned", "delete", "restore"]
        guard actions.contains(action), actor == "user" || actor == "maintenance" else { return nil }
        let before: MemoryCenterActivitySnapshotSummary?
        if row["before"] == nil || row["before"] == .null {
            before = nil
        } else {
            guard let parsed = MemoryCenterActivitySnapshotSummary.from(row["before"]) else { return nil }
            before = parsed
        }
        let after: MemoryCenterActivitySnapshotSummary?
        if row["after"] == nil || row["after"] == .null {
            after = nil
        } else {
            guard let parsed = MemoryCenterActivitySnapshotSummary.from(row["after"]) else { return nil }
            after = parsed
        }
        let restoreBlockedReason = mcOptNonNullString(row, "restoreBlockedReason")?.flatMap { $0 }
        if row["restoreBlockedReason"] != nil && row["restoreBlockedReason"] != .null && restoreBlockedReason == nil {
            return nil
        }
        let degraded = mcOptNonNullBool(row, "degraded", default: false)
        if row["degraded"] != nil && row["degraded"] != .null && degraded == nil { return nil }
        return MemoryCenterActivityEntry(
            auditId: auditId,
            scope: scope,
            itemId: itemId,
            action: action,
            actor: actor,
            at: at,
            before: before,
            after: after,
            canRestore: canRestore,
            restoreBlockedReason: restoreBlockedReason?.nilIfEmpty,
            degraded: degraded
        )
    }
}

struct MemoryCenterActivityData: Sendable, Hashable {
    var entries: [MemoryCenterActivityEntry]
    var nextCursor: String?
    var truncated: Bool?
    var degraded: Bool?

    static func from(_ value: JSONValue?) -> MemoryCenterActivityData? {
        guard let object = value?.object,
              let entries = mcDecodeArray(object["entries"], MemoryCenterActivityEntry.from)
        else { return nil }
        let nextCursor = mcOptNonNullString(object, "nextCursor")?.flatMap { $0 }
        if object["nextCursor"] != nil && object["nextCursor"] != .null && nextCursor == nil { return nil }
        let truncated = mcOptNonNullBool(object, "truncated", default: false)
        if object["truncated"] != nil && object["truncated"] != .null && truncated == nil { return nil }
        let degraded = mcOptNonNullBool(object, "degraded", default: false)
        if object["degraded"] != nil && object["degraded"] != .null && degraded == nil { return nil }
        return MemoryCenterActivityData(
            entries: entries,
            nextCursor: nextCursor?.nilIfEmpty,
            truncated: truncated,
            degraded: degraded
        )
    }
}

struct MemoryCenterSuggestionProposedAction: Sendable, Hashable {
    var kind: String
    var state: String?
    var targetId: String?
    var keepId: String?

    static func from(_ value: JSONValue?) -> MemoryCenterSuggestionProposedAction? {
        guard let row = value?.object, let kind = mcReqString(row, "kind") else { return nil }
        let allowed: Set<String> = ["dismiss", "mark_handled", "set_state", "mark_done"]
        guard allowed.contains(kind) else { return nil }
        let state = mcOptNonNullString(row, "state")?.flatMap { $0 }
        let targetId = mcOptNonNullString(row, "targetId")?.flatMap { $0 }
        let keepId = mcOptNonNullString(row, "keepId")?.flatMap { $0 }
        return MemoryCenterSuggestionProposedAction(kind: kind, state: state?.nilIfEmpty, targetId: targetId?.nilIfEmpty, keepId: keepId?.nilIfEmpty)
    }
}

struct MemoryCenterSuggestionEntry: Sendable, Hashable, Identifiable {
    var id: String
    var scope: String
    var kind: String
    var summary: String
    var reason: String
    var risk: String
    var itemIds: [String]
    var revisions: [String]
    var proposedAction: MemoryCenterSuggestionProposedAction

    static func from(_ json: JSONValue) -> MemoryCenterSuggestionEntry? {
        guard let row = json.object,
              let id = mcReqString(row, "id"),
              let scope = mcReqString(row, "scope"),
              let kind = mcReqString(row, "kind"),
              let summary = mcReqString(row, "summary"),
              let reason = mcReqString(row, "reason"),
              let risk = mcReqString(row, "risk"),
              let itemIds = mcReqStringList(row["itemIds"]),
              let revisions = mcReqStringList(row["revisions"]),
              let proposedAction = MemoryCenterSuggestionProposedAction.from(row["proposedAction"])
        else { return nil }
        let kinds: Set<String> = ["missing_ref", "stale_hot", "duplicate", "budget_pressure", "stale_ongoing"]
        guard kinds.contains(kind), risk == "low" || risk == "medium" else { return nil }
        return MemoryCenterSuggestionEntry(
            id: id,
            scope: scope,
            kind: kind,
            summary: summary,
            reason: reason,
            risk: risk,
            itemIds: itemIds,
            revisions: revisions,
            proposedAction: proposedAction
        )
    }
}

struct MemoryCenterSuggestionsData: Sendable, Hashable {
    var generatedAt: String
    var lastRunAt: String?
    var entries: [MemoryCenterSuggestionEntry]
    var truncated: Bool?

    static func from(_ value: JSONValue?) -> MemoryCenterSuggestionsData? {
        guard let object = value?.object,
              let generatedAt = mcReqString(object, "generatedAt"),
              let entries = mcDecodeArray(object["entries"], MemoryCenterSuggestionEntry.from)
        else { return nil }
        let lastRunAt = mcOptNonNullString(object, "lastRunAt")?.flatMap { $0 }
        if object["lastRunAt"] != nil && object["lastRunAt"] != .null && lastRunAt == nil { return nil }
        let truncated = mcOptNonNullBool(object, "truncated", default: false)
        if object["truncated"] != nil && object["truncated"] != .null && truncated == nil { return nil }
        return MemoryCenterSuggestionsData(
            generatedAt: generatedAt,
            lastRunAt: lastRunAt?.nilIfEmpty,
            entries: entries,
            truncated: truncated
        )
    }
}

struct MemoryCenterSuggestionAnswerData: Sendable, Hashable {
    var id: String
    var status: String
    var detail: String?

    static func from(_ value: JSONValue?) -> MemoryCenterSuggestionAnswerData? {
        guard let object = value?.object,
              let id = mcReqString(object, "id"),
              let status = mcReqString(object, "status")
        else { return nil }
        guard status == "accepted" || status == "dismissed" || status == "stale" else { return nil }
        let detail = mcOptNonNullString(object, "detail")?.flatMap { $0 }
        if object["detail"] != nil && object["detail"] != .null && detail == nil { return nil }
        return MemoryCenterSuggestionAnswerData(id: id, status: status, detail: detail?.nilIfEmpty)
    }
}

// MARK: - 活动 / 建议 UI 行模型

struct MemoryCenterActivityRow: Identifiable, Hashable, Sendable {
    var id: String { auditId }
    var auditId: String
    var scope: String
    var action: String
    var summary: String
    var canRestore: Bool
    var blocked: String?

    static func from(_ entry: MemoryCenterActivityEntry) -> MemoryCenterActivityRow {
        let before = entry.before?.text
        let after = entry.after?.text
        let summary = [before, after].compactMap { $0 }.joined(separator: " → ")
        return MemoryCenterActivityRow(
            auditId: entry.auditId,
            scope: entry.scope,
            action: entry.action,
            summary: summary.isEmpty ? entry.auditId : summary,
            canRestore: entry.canRestore,
            blocked: entry.restoreBlockedReason
        )
    }

    static func rows(from data: MemoryCenterActivityData) -> [MemoryCenterActivityRow] {
        data.entries.map(Self.from)
    }
}

struct MemoryCenterSuggestionRow: Identifiable, Hashable, Sendable {
    var id: String
    var scope: String
    var kind: String
    var summary: String
    var risk: String

    static func from(_ entry: MemoryCenterSuggestionEntry) -> MemoryCenterSuggestionRow {
        MemoryCenterSuggestionRow(
            id: entry.id,
            scope: entry.scope,
            kind: entry.kind,
            summary: entry.summary,
            risk: entry.risk
        )
    }

    static func rows(from data: MemoryCenterSuggestionsData) -> [MemoryCenterSuggestionRow] {
        data.entries.map(Self.from)
    }
}

// MARK: - 严格 JSON 解码辅助

private func mcReqString(_ row: [String: JSONValue], _ key: String) -> String? {
    row[key]?.string
}

private func mcReqInt(_ row: [String: JSONValue], _ key: String) -> Int? {
    row[key]?.int
}

private func mcReqBool(_ row: [String: JSONValue], _ key: String) -> Bool? {
    row[key]?.bool
}

private func mcReqDouble(_ row: [String: JSONValue], _ key: String) -> Double? {
    guard let value = row[key] else { return nil }
    if let n = value.number { return n }
    if let i = value.int { return Double(i) }
    return nil
}

// MARK: - Optional 字段（对齐 TS：`?: T` vs `?: T | null`）

/// `?: boolean` — 缺失 → default；JSON null 或类型错 → 失败
private func mcOptNonNullBool(_ row: [String: JSONValue], _ key: String, default defaultValue: Bool) -> Bool? {
    guard let value = row[key] else { return defaultValue }
    if case .null = value { return nil }
    return value.bool
}

/// `?: number` — 缺失 → .some(nil)；JSON null 或类型错 → 失败
private func mcOptNonNullInt(_ row: [String: JSONValue], _ key: String) -> Int?? {
    guard let value = row[key] else { return .some(nil) }
    if case .null = value { return nil }
    guard let n = value.int else { return nil }
    return .some(n)
}

/// `?: string` — 缺失 → .some(nil)；JSON null 或类型错 → 失败
private func mcOptNonNullString(_ row: [String: JSONValue], _ key: String) -> String?? {
    guard let value = row[key] else { return .some(nil) }
    if case .null = value { return nil }
    guard let text = value.string else { return nil }
    return .some(text)
}

/// `?: string | null` 等 — 缺失 → .some(nil)；JSON null → .some(nil)；类型错 → 失败
private func mcOptNullableString(_ row: [String: JSONValue], _ key: String) -> String?? {
    guard let value = row[key] else { return .some(nil) }
    if case .null = value { return .some(nil) }
    guard let text = value.string else { return nil }
    return .some(text)
}

/// `?: T[]` — 缺失 → default；JSON null 或类型错 → 失败
private func mcOptNonNullArray<T>(
    _ row: [String: JSONValue],
    _ key: String,
    default defaultValue: [T],
    decode: (JSONValue) -> T?
) -> [T]? {
    guard let value = row[key] else { return defaultValue }
    if case .null = value { return nil }
    return mcDecodeArray(value, decode)
}

/// 必填 `string | null`：键必须存在；值为 null 或 string
private func mcReqStringOrNull(_ row: [String: JSONValue], _ key: String) -> String?? {
    guard let value = row[key] else { return nil }
    if case .null = value { return .some(nil) }
    guard let text = value.string else { return nil }
    return .some(text)
}

private func mcReqStringList(_ value: JSONValue?) -> [String]? {
    guard let value else { return nil }
    guard let array = value.array else { return nil }
    var out: [String] = []
    for element in array {
        guard let text = element.string else { return nil }
        out.append(text)
    }
    return out
}

private func mcDecodeArray<T>(_ value: JSONValue?, _ decode: (JSONValue) -> T?) -> [T]? {
    guard let value else { return nil }
    guard let array = value.array else { return nil }
    var out: [T] = []
    for element in array {
        guard let item = decode(element) else { return nil }
        out.append(item)
    }
    return out
}
