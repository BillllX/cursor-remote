import Foundation

struct MemoryCenterExportData: Sendable, Hashable {
    var relativePath: String
    var sha256: String
    var bytes: Int
    var summaryScopes: Int

    static func from(_ value: JSONValue?) -> MemoryCenterExportData? {
        guard let o = value?.object,
              let relativePath = o["relativePath"]?.string,
              let sha256 = o["sha256"]?.string,
              let bytes = o["bytes"]?.int,
              let summary = o["summary"]?.object,
              summary["scopes"]?.array != nil,
              summary["personalEntries"]?.int != nil,
              summary["workspaceScopes"]?.int != nil,
              summary["rulesInventory"]?.int != nil
        else { return nil }
        let scopes = summary["scopes"]?.array?.count ?? 0
        return MemoryCenterExportData(relativePath: relativePath, sha256: sha256, bytes: bytes, summaryScopes: scopes)
    }
}

enum MemoryCenterImportResolution: String, Sendable, Hashable, CaseIterable {
    case keepCurrent = "keep_current"
    case useSnapshot = "use_snapshot"
    case duplicate = "duplicate"
}

struct MemoryCenterImportChangeRow: Sendable, Hashable, Identifiable {
    var id: String { changeId }
    var changeId: String
    var layer: String
    var action: String
    var scope: String?
    var itemId: String?
    var allowsDuplicate: Bool

    static func rows(from value: JSONValue?) -> [MemoryCenterImportChangeRow]? {
        guard let list = value?.object?["changes"]?.array else { return [] }
        var out: [MemoryCenterImportChangeRow] = []
        for item in list {
            guard let o = item.object,
                  let changeId = o["changeId"]?.string,
                  let layer = o["layer"]?.string,
                  let action = o["action"]?.string,
                  let allowedArr = o["allowedResolutions"]?.array
            else { return nil }
            let allowed = allowedArr.compactMap { $0.string }
            out.append(
                MemoryCenterImportChangeRow(
                    changeId: changeId,
                    layer: layer,
                    action: action,
                    scope: o["scope"]?.string,
                    itemId: o["id"]?.string,
                    allowsDuplicate: allowed.contains("duplicate")
                )
            )
        }
        return out
    }
}

struct MemoryCenterImportPreviewData: Sendable, Hashable {
    var planId: String
    var expiresAt: String
    var changes: [MemoryCenterImportChangeRow]
    var warnings: [String]

    static func from(_ value: JSONValue?) -> MemoryCenterImportPreviewData? {
        guard let o = value?.object,
              let planId = o["planId"]?.string,
              let expiresAt = o["expiresAt"]?.string,
              let summary = o["snapshotSummary"]?.object,
              summary["exportedAt"]?.string != nil,
              summary["schemaVersion"]?.int != nil,
              summary["checksum"]?.string != nil,
              o["changes"]?.array != nil,
              let warningsArr = o["warnings"]?.array
        else { return nil }
        for w in warningsArr {
            guard let wo = w.object, wo["code"]?.string != nil, wo["message"]?.string != nil else { return nil }
        }
        let warnings = warningsArr.compactMap { $0.object?["message"]?.string }
        guard let changes = MemoryCenterImportChangeRow.rows(from: value) else { return nil }
        return MemoryCenterImportPreviewData(
            planId: planId,
            expiresAt: expiresAt,
            changes: changes,
            warnings: warnings
        )
    }
}

struct MemoryCenterImportApplyData: Sendable, Hashable {
    var importId: String

    static func from(_ value: JSONValue?) -> MemoryCenterImportApplyData? {
        guard let o = value?.object,
              let importId = o["importId"]?.string,
              o["canRollback"]?.bool == true,
              let summary = o["summary"]?.object,
              summary["applied"]?.int != nil,
              summary["skipped"]?.int != nil,
              summary["conflictsResolved"]?.int != nil
        else { return nil }
        return MemoryCenterImportApplyData(importId: importId)
    }
}

enum MemoryCenterImportRollbackStatus: String, Sendable, Hashable {
    case rolledBack = "rolled_back"
    case alreadyRolledBack = "already_rolled_back"
}

struct MemoryCenterImportRollbackData: Sendable, Hashable {
    var importId: String
    var status: MemoryCenterImportRollbackStatus

    static func from(_ value: JSONValue?) -> MemoryCenterImportRollbackData? {
        guard let o = value?.object,
              let importId = o["importId"]?.string,
              let statusRaw = o["status"]?.string,
              let status = MemoryCenterImportRollbackStatus(rawValue: statusRaw)
        else { return nil }
        return MemoryCenterImportRollbackData(importId: importId, status: status)
    }
}
