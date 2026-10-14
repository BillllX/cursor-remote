import Foundation

/// 即时消息的本机缓存：Application Support/im/<租户>/
///   state.json            我的资料、联系人、会话列表、拉黑、草稿、本地删除的 seq
///   conv/<会话号>.json     每会话最近 300 条 + 没发出去的
///   outbox/               待发图片、语音、文件和链接图标（没传完时重传；传完搬进 media）
///   media/<blob>          下载/上传过的全部附件和头像（blob 是 sha256，同内容一份；超过 300MB 删旧的）
/// 读写都排在一条串行队列上；退出登录整个 im 目录删掉，换账号删旧租户的
enum ImCache {
    private static let queue = DispatchQueue(label: "ai.jiebo.im-cache", qos: .utility)

    struct Snapshot: Sendable {
        var me: ImMe?
        var users: [ImUser] = []
        var convs: [ImConvRow] = []
        var blocked: [String] = []
        var drafts: [String: String] = [:]
        var hidden: [String: [Int]] = [:]
        var heardVoice: [String: [Int]] = [:]
        var voiceText: [String: [String: String]] = [:]
        var timelines: [String: [ImLocalMessage]] = [:]
    }

    // MARK: 读

    static func load(tenant: String) async -> Snapshot? {
        await withCheckedContinuation { (continuation: CheckedContinuation<Snapshot?, Never>) in
            queue.async {
                continuation.resume(returning: read(tenant: tenant))
            }
        }
    }

    private static func read(tenant: String) -> Snapshot? {
        guard let dir = tenantDir(tenant),
              let data = try? Data(contentsOf: dir.appendingPathComponent("state.json")),
              let state = try? JSONValue.parse(data).object
        else { return nil }
        var snapshot = Snapshot()
        snapshot.me = ImMe.from(state["me"])
        snapshot.users = state["users"]?.array?.compactMap { ImUser.from($0) } ?? []
        snapshot.convs = state["convs"]?.array?.compactMap { ImConvRow.from($0) } ?? []
        snapshot.blocked = state["blocked"]?.array?.compactMap(\.string) ?? []
        for (key, value) in state["drafts"]?.object ?? [:] {
            if let text = value.string, !text.isEmpty { snapshot.drafts[key] = text }
        }
        for (key, value) in state["hidden"]?.object ?? [:] {
            snapshot.hidden[key] = value.array?.compactMap(\.int) ?? []
        }
        for (key, value) in state["heardVoice"]?.object ?? [:] {
            snapshot.heardVoice[key] = value.array?.compactMap(\.int) ?? []
        }
        for (convId, value) in state["voiceText"]?.object ?? [:] {
            snapshot.voiceText[convId] = value.object?.compactMapValues(\.string) ?? [:]
        }
        let convDir = dir.appendingPathComponent("conv", isDirectory: true)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: convDir.path)) ?? []
        for name in names where name.hasSuffix(".json") {
            guard let data = try? Data(contentsOf: convDir.appendingPathComponent(name)),
                  let row = try? JSONValue.parse(data).object,
                  let convId = row["convId"]?.string, !convId.isEmpty
            else { continue }
            let items = row["messages"]?.array?.compactMap { ImLocalMessage.from($0) } ?? []
            if !items.isEmpty { snapshot.timelines[convId] = items }
        }
        return snapshot
    }

    // MARK: 写

    static func saveState(tenant: String, state: JSONValue) {
        queue.async {
            guard let dir = tenantDir(tenant), let data = try? state.data() else { return }
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? data.write(to: dir.appendingPathComponent("state.json"), options: .atomic)
        }
    }

    static func saveTimeline(tenant: String, convId: String, items: [ImLocalMessage]) {
        let rows = ImTimeline.trimmed(items).map { $0.json() }
        queue.async {
            guard let dir = tenantDir(tenant)?.appendingPathComponent("conv", isDirectory: true) else { return }
            let file = dir.appendingPathComponent(safeName(convId) + ".json")
            if rows.isEmpty {
                try? FileManager.default.removeItem(at: file)
                return
            }
            let object: JSONValue = .object(["convId": .string(convId), "messages": .array(rows)])
            guard let data = try? object.data() else { return }
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
        }
    }

    // MARK: 附件

    /// 待发附件放这里，消息里只记文件名
    static func outboxDir(tenant: String) -> URL? {
        tenantDir(tenant)?.appendingPathComponent("outbox", isDirectory: true)
    }

    static func mediaDir(tenant: String) -> URL? {
        tenantDir(tenant)?.appendingPathComponent("media", isDirectory: true)
    }

    /// 上传成功后把 outbox 里的文件按 blob 搬进 media（之后显示不必再下载，outbox 也不留副本）。
    /// 消息之后重发只用 blob，用不到这个文件
    static func adopt(tenant: String, file: URL, blob: String) {
        queue.async {
            guard let dir = mediaDir(tenant: tenant), isBlob(blob) else { return }
            let target = dir.appendingPathComponent(blob)
            let manager = FileManager.default
            if manager.fileExists(atPath: target.path) {
                try? manager.removeItem(at: file)
            } else {
                try? manager.createDirectory(at: dir, withIntermediateDirectories: true)
                if (try? manager.moveItem(at: file, to: target)) == nil {
                    try? manager.copyItem(at: file, to: target)
                    try? manager.removeItem(at: file)
                }
            }
            trimMediaLater(dir)
        }
    }

    /// 删掉 outbox 里的这些文件（待发的消息被删掉了）
    static func removeOutbox(tenant: String, files: [String]) {
        queue.async {
            guard let dir = outboxDir(tenant: tenant) else { return }
            for name in files where !name.isEmpty && !name.contains("/") {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
            }
        }
    }

    /// 启动时清 outbox：不在 keep 里、且放了超过 outboxGrace 的文件都删掉（刚压好还没进时间线的不动）
    static func sweepOutbox(tenant: String, keep: Set<String>) {
        queue.async {
            guard let dir = outboxDir(tenant: tenant) else { return }
            let manager = FileManager.default
            let keys: [URLResourceKey] = [.contentModificationDateKey]
            let files = (try? manager.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys)) ?? []
            let cutoff = Date().addingTimeInterval(-outboxGrace)
            for file in files where !keep.contains(file.lastPathComponent) {
                let changed = (try? file.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? Date()
                if changed < cutoff { try? manager.removeItem(at: file) }
            }
        }
    }

    // MARK: 下载缓存的磁盘预算

    /// media 目录的上限；超了按最近使用时间从旧往新删到 mediaTrimTarget
    static let mediaBudget: Int64 = 300 * 1024 * 1024
    static let mediaTrimTarget: Int64 = 240 * 1024 * 1024
    private static let outboxGrace: TimeInterval = 10 * 60
    /// 只在 queue 上读写
    nonisolated(unsafe) private static var trimPending: Set<String> = []
    nonisolated(unsafe) private static var touched: [String: Date] = [:]

    /// 读到磁盘缓存：把修改时间刷成现在，当作「最近用过」（文件系统的访问时间不可靠）。同一文件一小时最多刷一次
    static func noteUse(_ file: URL) {
        queue.async {
            let now = Date()
            if let last = touched[file.path], now.timeIntervalSince(last) < 3600 { return }
            touched[file.path] = now
            try? FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: file.path)
        }
    }

    /// 新文件进了 media：过几秒算一次总量（连着下好几张只算一次）
    static func noteDownloaded(_ file: URL) {
        queue.async { trimMediaLater(file.deletingLastPathComponent()) }
    }

    /// 只在 queue 上调；按目录各自排一个（不同租户/不同会话的下载互不挡，谁超预算谁触发自己的清理）
    private static func trimMediaLater(_ dir: URL) {
        let key = dir.path
        guard !trimPending.contains(key) else { return }
        trimPending.insert(key)
        queue.asyncAfter(deadline: .now() + 3) {
            trimPending.remove(key)
            trimMedia(dir)
        }
    }

    private static func trimMedia(_ dir: URL) {
        let manager = FileManager.default
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? manager.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
        var rows: [(file: URL, size: Int64, used: Date)] = []
        var total: Int64 = 0
        for file in files {
            guard let values = try? file.resourceValues(forKeys: Set(keys)) else { continue }
            let size = Int64(values.fileSize ?? 0)
            total += size
            rows.append((file: file, size: size, used: values.contentModificationDate ?? .distantPast))
        }
        guard total > mediaBudget else { return }
        rows.sort { $0.used < $1.used }
        for row in rows {
            guard total > mediaTrimTarget else { break }
            if (try? manager.removeItem(at: row.file)) != nil {
                total -= row.size
                touched[row.file.path] = nil
            }
        }
    }

    static func isBlob(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { $0.isHexDigit }
    }

    // MARK: 清理

    static func clear(tenant: String) {
        queue.async {
            guard let dir = tenantDir(tenant) else { return }
            try? FileManager.default.removeItem(at: dir)
        }
    }

    static func clearAll() {
        queue.async {
            guard let root else { return }
            try? FileManager.default.removeItem(at: root)
        }
    }

    // MARK: 路径

    private static var root: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("im", isDirectory: true)
    }

    static func tenantDir(_ tenant: String) -> URL? {
        guard !tenant.isEmpty else { return nil }
        return root?.appendingPathComponent(safeName(tenant), isDirectory: true)
    }

    /// 租户 id、会话号只含小写字母数字、短横线和 ~；别的字符一律换成 _
    private static func safeName(_ raw: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_~")
        return String(raw.map { allowed.contains($0) ? $0 : "_" }.prefix(160))
    }
}
