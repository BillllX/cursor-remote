import Foundation

/// Small, tenant-scoped bootstrap snapshot. It is display-only: network replies remain authoritative.
struct AppBootstrapSnapshot: Sendable, Hashable {
    static let schema = 2

    struct FileIndex: Sendable, Hashable {
        var paths: [String]
        var truncated: Bool
        var status: [String: String]
    }

    var assistant: JSONValue?
    var assistantMemoryRevision: Int?
    var workspacesRoot: String
    var workspaces: [WorkspaceItem]
    var fileIndexes: [String: FileIndex]

    static func mergeFileIndexes(
        disk: [String: FileIndex],
        pending: [String: FileIndex],
        tombstones: Set<String>
    ) -> [String: FileIndex] {
        var merged = disk
        for (chatId, index) in pending { merged[chatId] = index }
        for chatId in tombstones { merged.removeValue(forKey: chatId) }
        return merged
    }
}

enum AppBootstrapDecode: Sendable {
    case hit(AppBootstrapSnapshot, assistantState: AssistantState?)
    case miss
    case corrupt
    case incompatible
}

enum AssistantStateReconcile: Sendable {
    case ignored
    case apply(AssistantState)

    static func resolve(current: AssistantState?, incoming: AssistantState) -> AssistantStateReconcile {
        guard let current else { return .apply(incoming) }
        if let currentRevision = current.revision, let incomingRevision = incoming.revision {
            if incomingRevision < currentRevision { return .ignored }
            if incomingRevision == currentRevision {
                guard let memory = incoming.memory else { return .ignored }
                var merged = current
                merged.memory = memory
                if var object = merged.rawJSON.object,
                   let incomingMemory = incoming.rawJSON.object?["memory"] {
                    object["memory"] = incomingMemory
                    merged.rawJSON = .object(object)
                }
                return .apply(merged)
            }
        }

        var next = incoming
        if next.memory == nil, let memory = current.memory {
            next.memory = memory
            if var object = next.rawJSON.object,
               let priorMemory = current.rawJSON.object?["memory"] {
                object["memory"] = priorMemory
                next.rawJSON = .object(object)
            }
        }
        // A legacy gateway has no revision. Keep the last conditional token without replacing
        // the freshly decoded legacy projection.
        if next.revision == nil, let revision = current.revision {
            next.revision = revision
            if var object = next.rawJSON.object {
                object["revision"] = .number(Double(revision))
                next.rawJSON = .object(object)
            }
        }
        return .apply(next)
    }
}

/// Pure request gate so Linux contract tests can exercise ready/page/foreground races.
struct AssistantSyncGate: Sendable, Hashable {
    struct Followup: Sendable, Hashable {
        var memory: Bool
        var force: Bool
    }

    private(set) var inFlight = false
    private(set) var includesMemory = false
    /// 在途期间最后一次调用表达的订阅意图；nil 表示没有后续请求。
    private(set) var pendingMemory: Bool?
    private(set) var forcePending = false
    private(set) var conditionalSynced = false
    private(set) var memorySynced = false

    mutating func begin(memory: Bool, force: Bool = false) -> Bool {
        if inFlight {
            if pendingMemory != nil || memory != includesMemory {
                pendingMemory = memory
            }
            if force { forcePending = true }
            return false
        }
        let alreadySynced = memory ? memorySynced : conditionalSynced
        if !force, alreadySynced { return false }
        inFlight = true
        includesMemory = memory
        return true
    }

    mutating func complete() -> Followup? {
        let completed = inFlight
        let completedMemory = includesMemory
        let followupMemory = pendingMemory ?? includesMemory
        let hasFollowup = pendingMemory != nil || forcePending
        let followupForce = forcePending
        inFlight = false
        includesMemory = false
        if completed {
            conditionalSynced = true
            if completedMemory { memorySynced = true }
        }
        pendingMemory = nil
        forcePending = false
        return hasFollowup ? .init(memory: followupMemory, force: followupForce) : nil
    }

    func shouldSettleState(carriesMemory: Bool, accepted: Bool) -> Bool {
        inFlight && accepted && (!includesMemory || carriesMemory)
    }

    mutating func fail() -> Followup? {
        let followup = pendingMemory.map { Followup(memory: $0, force: forcePending) }
            ?? (forcePending ? Followup(memory: includesMemory, force: true) : nil)
        if inFlight {
            if includesMemory {
                memorySynced = false
            } else {
                conditionalSynced = false
            }
        }
        inFlight = false
        includesMemory = false
        pendingMemory = nil
        forcePending = false
        return followup
    }

    mutating func resetConnection() {
        _ = fail()
        conditionalSynced = false
        memorySynced = false
    }
}

enum FileIndexResponsePolicy {
    /// 无 reqId 的主动广播可以更新缓存，但不能结清一个带标识的 list_files 请求。
    static func shouldSettle(expectedReqId: String?, responseReqId: String?) -> Bool {
        guard let expectedReqId, let responseReqId else { return false }
        return expectedReqId == responseReqId
    }
}

enum FileIndexFreshnessPolicy {
    static let window: TimeInterval = 60

    /// 只有完整且非空的索引才能抑制自动重拉；截断或空清单仍允许再次对账。
    static func isFresh(
        paths: [String],
        truncated: Bool,
        lastUpdatedAt: Date?,
        now: Date = Date()
    ) -> Bool {
        guard !paths.isEmpty, !truncated, let lastUpdatedAt else { return false }
        return now.timeIntervalSince(lastUpdatedAt) < window
    }
}

enum AppBootstrapCache {
    private static let queue = DispatchQueue(label: "ai.jiebo.bootstrap-cache", qos: .utility)

    static func decode(_ data: Data) -> AppBootstrapDecode {
        guard let root = try? JSONValue.parse(data), let object = root.object else { return .corrupt }
        guard object["v"]?.int == AppBootstrapSnapshot.schema else { return .incompatible }
        guard let workspaceRows = object["workspaces"]?.array,
              let fileRows = object["fileIndexes"]?.object
        else { return .corrupt }

        let workspaces = workspaceRows.compactMap { value -> WorkspaceItem? in
            guard let row = value.object, let path = row["path"]?.string?.nilIfEmpty else { return nil }
            return WorkspaceItem(
                path: path,
                name: row["name"]?.string ?? URL(fileURLWithPath: path).lastPathComponent,
                user: row["user"]?.bool ?? false
            )
        }
        guard workspaces.count == workspaceRows.count else { return .corrupt }

        var indexes: [String: AppBootstrapSnapshot.FileIndex] = [:]
        for (chatId, value) in fileRows {
            guard !chatId.isEmpty, let row = value.object, let paths = row["paths"]?.array?.compactMap(\.string),
                  paths.count == row["paths"]?.array?.count
            else { return .corrupt }
            var status: [String: String] = [:]
            for (path, letter) in row["status"]?.object ?? [:] {
                guard let value = letter.string else { return .corrupt }
                status[path] = value
            }
            indexes[chatId] = .init(
                paths: paths,
                truncated: row["truncated"]?.bool ?? false,
                status: status
            )
        }
        let assistant = object["assistant"].flatMap { $0 == .null ? nil : $0 }
        let assistantState = assistant.flatMap(AssistantState.from)
        if assistant != nil, assistantState == nil { return .corrupt }
        let memoryRevision: Int?
        if let value = object["assistantMemoryRevision"], value != .null {
            guard let number = value.number,
                  number.isFinite,
                  number > 0,
                  number == number.rounded(),
                  number <= Double(Int.max)
            else { return .corrupt }
            memoryRevision = Int(number)
        } else {
            memoryRevision = nil
        }
        if let memoryRevision {
            guard assistantState?.memory != nil,
                  let stateRevision = assistantState?.revision,
                  memoryRevision <= stateRevision
            else { return .corrupt }
        }
        return .hit(.init(
            assistant: assistant,
            assistantMemoryRevision: memoryRevision,
            workspacesRoot: object["workspacesRoot"]?.string ?? "",
            workspaces: workspaces,
            fileIndexes: indexes
        ), assistantState: assistantState)
    }

    static func encode(_ snapshot: AppBootstrapSnapshot) -> Data? {
        let workspaces = snapshot.workspaces.map {
            JSONValue.object([
                "path": .string($0.path),
                "name": .string($0.name),
                "user": .bool($0.user),
            ])
        }
        let indexes = snapshot.fileIndexes.mapValues { item in
            JSONValue.object([
                "paths": .array(item.paths.map(JSONValue.string)),
                "truncated": .bool(item.truncated),
                "status": .object(item.status.mapValues(JSONValue.string)),
            ])
        }
        let value = JSONValue.object([
            "v": .number(Double(AppBootstrapSnapshot.schema)),
            "assistant": snapshot.assistant ?? .null,
            "assistantMemoryRevision": snapshot.assistantMemoryRevision.map { .number(Double($0)) } ?? .null,
            "workspacesRoot": .string(snapshot.workspacesRoot),
            "workspaces": .array(workspaces),
            "fileIndexes": .object(indexes),
        ])
        return try? value.data()
    }

    static func load(tenant: String) -> AppBootstrapDecode {
        queue.sync {
            guard let file = file(tenant) else { return .miss }
            guard FileManager.default.fileExists(atPath: file.path) else { return .miss }
            guard let data = try? Data(contentsOf: file) else { return .corrupt }
            return decode(data)
        }
    }

    static func save(_ snapshot: AppBootstrapSnapshot, tenant: String) {
        queue.async {
            guard let file = file(tenant), let data = encode(snapshot) else { return }
            do {
                try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                var directory = file.deletingLastPathComponent()
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? directory.setResourceValues(values)
                try data.write(to: file, options: .atomic)
            } catch {
                // Bootstrap caching is best effort.
            }
        }
    }

    static func remove(tenant: String) {
        queue.async {
            guard let file = file(tenant) else { return }
            try? FileManager.default.removeItem(at: file)
        }
    }

    static func removeAll() {
        queue.async {
            guard let root else { return }
            try? FileManager.default.removeItem(at: root)
        }
    }

    private static var root: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("JieboBootstrap", isDirectory: true)
    }

    private static func file(_ tenant: String) -> URL? {
        guard let safe = tenantStorageKey(tenant) else { return nil }
        return root?.appendingPathComponent(safe, isDirectory: true).appendingPathComponent("bootstrap.json")
    }

    static func tenantStorageKey(_ tenant: String) -> String? {
        guard !tenant.isEmpty else { return nil }
        let safe = tenant.data(using: .utf8)?.base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "") ?? ""
        guard !safe.isEmpty else { return nil }
        return safe
    }
}
