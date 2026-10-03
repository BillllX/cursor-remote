import Foundation

/// 会话正文与列表的本机缓存，目录 Caches/JieboCache/<租户>/：
/// - bodies/<会话>/manifest.json + seg-<i>.json：正文按每段 100 轮切开，追加回合只重写变了的段
/// - list.json：最近一次服务端状态的会话元数据（不含 turns），冷启动先画侧栏用
/// 读写全部排在同一条后台串行队列上：先排先做，删除不会被更早排队的写入复活。失败一律静默，退回纯网络。
enum ChatCache {
    /// 本机缓存的会话列表。只读展示：不能标脏、不能上传，服务端状态到达后整份替换
    struct ListSnapshot {
        var stateRev: Int
        var chatRevs: [String: Int]
        /// ChatSession.json() 去掉 turns 键、补上 preview 的元数据行
        var chats: [JSONValue]
        var savedAt: Date
    }

    /// 缓存的完整正文，rev 是写入时对应的服务端会话版本（chatRevs[chatId]）
    struct Body {
        var rev: Int
        var turns: [Turn]
    }

    static let maxChats = 60
    static let maxBytes = 300 * 1024 * 1024
    static let segmentSize = 100

    private static let queue = DispatchQueue(label: "ai.jiebo.chat-cache", qos: .utility)

    private struct Manifest: Codable {
        var v: Int
        var chatId: String
        var rev: Int
        var count: Int
        var lastTurnId: String?
        /// 最近写入/打开时间，LRU 淘汰按它排
        var at: Double
        var bytes: Int
        var segments: [Segment]

        struct Segment: Codable {
            var file: String
            var hash: String
            var count: Int
            var bytes: Int
        }
    }

    // MARK: 正文

    static func loadBody(tenant: String, chatId: String) async -> Body? {
        await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume(returning: readBody(tenant: tenant, chatId: chatId))
            }
        }
    }

    /// turns 传 Turn.json() 的结果：编码和写盘都在后台做
    static func saveBody(tenant: String, chatId: String, rev: Int, turns: [JSONValue]) {
        queue.async {
            writeBody(tenant: tenant, chatId: chatId, rev: rev, rows: turns)
            prune(tenant: tenant, keep: chatId)
        }
    }

    /// 只刷新最近打开时间（LRU）
    static func touch(tenant: String, chatId: String) {
        queue.async {
            guard let dir = bodyDir(tenant, chatId), var manifest = readManifest(dir) else { return }
            manifest.at = Date().timeIntervalSince1970
            writeManifest(manifest, to: dir)
        }
    }

    static func remove(tenant: String, chatId: String) {
        queue.async {
            guard let dir = bodyDir(tenant, chatId) else { return }
            try? FileManager.default.removeItem(at: dir)
        }
    }

    // MARK: 列表

    static func loadList(tenant: String) async -> ListSnapshot? {
        await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume(returning: readList(tenant: tenant))
            }
        }
    }

    static func saveList(tenant: String, stateRev: Int, chatRevs: [String: Int], chats: [JSONValue]) {
        queue.async {
            guard let dir = tenantDir(tenant) else { return }
            let object: JSONValue = .object([
                "v": .number(1),
                "stateRev": .number(Double(stateRev)),
                "chatRevs": .object(chatRevs.mapValues { .number(Double($0)) }),
                "chats": .array(chats),
                "savedAt": .number(Date().timeIntervalSince1970),
            ])
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try encode(object).write(to: dir.appendingPathComponent("list.json"), options: .atomic)
            } catch {
                // 静默：下次状态变更再写
            }
        }
    }

    // MARK: 清理

    /// 换账号/重置租户会话：清掉这个租户的全部缓存
    static func clear(tenant: String) {
        queue.async {
            guard let dir = tenantDir(tenant) else { return }
            try? FileManager.default.removeItem(at: dir)
        }
    }

    /// 退出登录：所有租户一起清
    static func clearAll() {
        queue.async {
            guard let root else { return }
            try? FileManager.default.removeItem(at: root)
        }
    }

    // MARK: 路径

    private static var root: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("JieboCache", isDirectory: true)
    }

    private static func tenantDir(_ tenant: String) -> URL? {
        guard !tenant.isEmpty else { return nil }
        return root?.appendingPathComponent(safeName(tenant), isDirectory: true)
    }

    private static func bodyDir(_ tenant: String, _ chatId: String) -> URL? {
        guard !chatId.isEmpty else { return nil }
        return tenantDir(tenant)?
            .appendingPathComponent("bodies", isDirectory: true)
            .appendingPathComponent(safeName(chatId), isDirectory: true)
    }

    /// id 做目录名：只留字母数字和 -_，其余换成 _；改动过或太长的补一段原文哈希防撞名
    private static func safeName(_ raw: String) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        let kept = String(raw.map { allowed.contains($0) ? $0 : "_" }.prefix(80))
        if kept == raw { return raw }
        return kept + "-" + fnv1a(Data(raw.utf8))
    }

    // MARK: 后台实现（只在 queue 上调用）

    /// 键排序后编码：同样的内容每次编出同样的字节，段哈希才比得出「没变」
    private static func encode(_ value: JSONValue) throws -> Data {
        try JSONSerialization.data(withJSONObject: value.jsonObject(), options: [.sortedKeys])
    }

    private static func fnv1a(_ data: Data) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            for byte in buffer {
                hash ^= UInt64(byte)
                hash = hash &* 0x0000_0100_0000_01b3
            }
        }
        return String(hash, radix: 16)
    }

    private static func readManifest(_ dir: URL) -> Manifest? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("manifest.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data),
              manifest.v == 1
        else { return nil }
        return manifest
    }

    private static func writeManifest(_ manifest: Manifest, to dir: URL) {
        guard let data = try? JSONEncoder().encode(manifest) else { return }
        try? data.write(to: dir.appendingPathComponent("manifest.json"), options: .atomic)
    }

    private static func readBody(tenant: String, chatId: String) -> Body? {
        guard let dir = bodyDir(tenant, chatId), var manifest = readManifest(dir) else { return nil }
        guard manifest.chatId == chatId else { return nil }
        var turns: [Turn] = []
        turns.reserveCapacity(manifest.count)
        for segment in manifest.segments {
            // 段与清单对不上（写到一半被杀、文件损坏）：整条作废
            guard let data = try? Data(contentsOf: dir.appendingPathComponent(segment.file)),
                  data.count == segment.bytes,
                  fnv1a(data) == segment.hash,
                  let rows = (try? JSONValue.parse(data))?.array,
                  rows.count == segment.count
            else {
                try? FileManager.default.removeItem(at: dir)
                return nil
            }
            turns.append(contentsOf: rows.compactMap(Turn.from))
        }
        guard turns.count == manifest.count, turns.last?.id == manifest.lastTurnId else {
            try? FileManager.default.removeItem(at: dir)
            return nil
        }
        manifest.at = Date().timeIntervalSince1970
        writeManifest(manifest, to: dir)
        return Body(rev: manifest.rev, turns: turns)
    }

    private static func writeBody(tenant: String, chatId: String, rev: Int, rows: [JSONValue]) {
        guard let dir = bodyDir(tenant, chatId) else { return }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let old = readManifest(dir)
            var segments: [Manifest.Segment] = []
            var total = 0
            for (index, start) in stride(from: 0, to: rows.count, by: segmentSize).enumerated() {
                let chunk = Array(rows[start ..< min(start + segmentSize, rows.count)])
                let data = try encode(.array(chunk))
                let hash = fnv1a(data)
                let file = "seg-\(index).json"
                let url = dir.appendingPathComponent(file)
                let unchanged = old?.segments.contains(where: { $0.file == file && $0.hash == hash && $0.bytes == data.count }) == true
                    && fm.fileExists(atPath: url.path)
                if !unchanged {
                    try data.write(to: url, options: .atomic)
                }
                segments.append(Manifest.Segment(file: file, hash: hash, count: chunk.count, bytes: data.count))
                total += data.count
            }
            // 段数变少（会话被截断）：删掉多出来的旧段
            for prior in old?.segments ?? [] where !segments.contains(where: { $0.file == prior.file }) {
                try? fm.removeItem(at: dir.appendingPathComponent(prior.file))
            }
            let manifest = Manifest(
                v: 1,
                chatId: chatId,
                rev: rev,
                count: rows.count,
                lastTurnId: rows.last?["id"]?.string,
                at: Date().timeIntervalSince1970,
                bytes: total,
                segments: segments
            )
            // 清单最后写：中途失败时旧清单的段哈希对不上新段，读的时候整条作废
            try JSONEncoder().encode(manifest).write(to: dir.appendingPathComponent("manifest.json"), options: .atomic)
        } catch {
            try? fm.removeItem(at: dir)
        }
    }

    /// 超过 60 条或 300MB：按最近打开时间从旧到新淘汰。刚写入的那条最新，排在最前
    private static func prune(tenant: String, keep: String) {
        guard let bodies = tenantDir(tenant)?.appendingPathComponent("bodies", isDirectory: true),
              let names = try? FileManager.default.contentsOfDirectory(atPath: bodies.path)
        else { return }
        var entries: [(dir: URL, at: Double, bytes: Int, keep: Bool)] = []
        for name in names {
            let dir = bodies.appendingPathComponent(name, isDirectory: true)
            guard let manifest = readManifest(dir) else {
                // 没有清单的残骸（写入失败、旧格式）
                try? FileManager.default.removeItem(at: dir)
                continue
            }
            entries.append((dir: dir, at: manifest.at, bytes: manifest.bytes, keep: manifest.chatId == keep))
        }
        entries.sort { lhs, rhs in
            lhs.keep != rhs.keep ? lhs.keep : lhs.at > rhs.at
        }
        var kept = 0
        var used = 0
        for entry in entries {
            if kept < maxChats, used + entry.bytes <= maxBytes {
                kept += 1
                used += entry.bytes
            } else {
                try? FileManager.default.removeItem(at: entry.dir)
            }
        }
    }

    private static func readList(tenant: String) -> ListSnapshot? {
        guard let dir = tenantDir(tenant),
              let data = try? Data(contentsOf: dir.appendingPathComponent("list.json")),
              let object = (try? JSONValue.parse(data))?.object,
              object["v"]?.int == 1,
              let chats = object["chats"]?.array
        else { return nil }
        return ListSnapshot(
            stateRev: object["stateRev"]?.int ?? 0,
            chatRevs: object["chatRevs"]?.intMap ?? [:],
            chats: chats,
            savedAt: Date(timeIntervalSince1970: object["savedAt"]?.number ?? 0)
        )
    }
}
