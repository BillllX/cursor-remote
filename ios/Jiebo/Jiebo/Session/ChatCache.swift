import Foundation

/// 会话正文与列表的本机缓存，目录 Caches/JieboCache/<租户>/：
/// - bodies/<会话>/manifest.json + seg-<i>.json：正文按每段 100 轮切开，追加回合只重写变了的段
/// - list.json：最近一次服务端状态的会话元数据（不含 turns），冷启动先画侧栏用
/// 首屏尾段另放 Application Support/JieboChat/<租户>/tails/（系统不会当缓存清掉，已排除备份）：
/// 只存最近 40 轮已结束的回合，用来先把界面画出来。它不是权威正文，不能当补齐基线，也不能上传。
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
        /// 写入时服务端这个版本的段哈希（segHashes），没有就是 nil
        var serverSegs: [String]?
    }

    static let maxChats = 60
    static let maxBytes = 300 * 1024 * 1024
    static let segmentSize = 100

    private static let queue = DispatchQueue(label: "ai.jiebo.chat-cache", qos: .utility)
    /// 只在 queue 上读写：记录每个租户上次全盘淘汰时间，避免短时间内连续写正文反复扫 60 个 manifest.json。
    nonisolated(unsafe) private static var lastPruneAt: [String: Date] = [:]
    private static let pruneInterval: TimeInterval = 30

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
        /// 服务端段哈希（可选，旧清单没有）
        var serverSegs: [String]?

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

    /// 只读清单：版本、总轮数、段哈希。不解码任何一段正文。
    struct BodyHead: Sendable {
        var rev: Int
        var count: Int
        var serverSegs: [String]?
    }

    /// 从磁盘往前翻的一页。reachedStart 表示已经读到这份缓存的开头。
    struct EarlierPage: Sendable {
        var turns: [Turn]
        var reachedStart: Bool
    }

    static func loadBodyHead(tenant: String, chatId: String) async -> BodyHead? {
        await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume(returning: readBodyHead(tenant: tenant, chatId: chatId))
            }
        }
    }

    /// 只解码末尾几段，取出最近 limit 轮。长会话打开时不用把全文读进内存。
    static func loadRecentTurns(tenant: String, chatId: String, limit: Int) async -> [Turn]? {
        await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume(returning: readRecentTurns(tenant: tenant, chatId: chatId, limit: limit))
            }
        }
    }

    /// 从 beforeTurnId 往前取一页。锚点不在这份缓存里就返回 nil，调用方不能据此把尾部标成全文。
    static func loadTurnsBefore(tenant: String, chatId: String, beforeTurnId: String, limit: Int) async -> EarlierPage? {
        await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume(returning: readTurnsBefore(
                    tenant: tenant,
                    chatId: chatId,
                    beforeTurnId: beforeTurnId,
                    limit: limit
                ))
            }
        }
    }

    /// 后台执行 Turn.json() 与写盘，避免主线程递归截断大工具 JSON 导致掉帧。
    static func saveBody(tenant: String, chatId: String, rev: Int, turns: [Turn], serverSegs: [String]? = nil) {
        queue.async {
            let rows = turns.map { $0.json() }
            let createdDir = writeBody(tenant: tenant, chatId: chatId, rev: rev, rows: rows, serverSegs: serverSegs)
            let now = Date()
            if createdDir || lastPruneAt[tenant].map({ now.timeIntervalSince($0) >= pruneInterval }) ?? true {
                lastPruneAt[tenant] = now
                prune(tenant: tenant, keep: chatId)
            }
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
            removeTailFile(tenant: tenant, chatId: chatId)
        }
    }

    // MARK: 首屏尾段

    static let tailLimit = 40
    private static let tailFileLimit = 80

    struct Tail {
        var turns: [Turn]
        /// nil 表示旧版纯展示尾段；两者同时存在才是可安全续页的确认游标。
        var chatRev: Int?
        var nextFrom: Int?
    }

    static func loadTail(tenant: String, chatId: String) async -> Tail? {
        await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume(returning: readTail(tenant: tenant, chatId: chatId))
            }
        }
    }

    /// turns 是已经去掉正在生成的回合之后的纯值副本；先截断到 tailLimit 再在后台执行 Turn.json()，避免长会话白白序列化数百轮旧记录。
    static func saveTail(
        tenant: String,
        chatId: String,
        turns: [Turn],
        chatRev: Int? = nil,
        nextFrom: Int? = nil
    ) {
        let keptTurns = Array(turns.suffix(tailLimit))
        queue.async {
            let rows = keptTurns.map { $0.json() }
            writeTail(tenant: tenant, chatId: chatId, rows: rows, chatRev: chatRev, nextFrom: nextFrom)
        }
    }

    private static func readTail(tenant: String, chatId: String) -> Tail? {
        guard let file = tailFile(tenant, chatId),
              let data = try? Data(contentsOf: file),
              let object = (try? JSONValue.parse(data))?.object,
              let version = object["v"]?.int, version == 1 || version == 2,
              object["chatId"]?.string == chatId,
              let rows = object["turns"]?.array
        else { return nil }
        let turns = rows.compactMap(Turn.from)
        guard !turns.isEmpty, !Turn.hasDuplicateIds(turns) else {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
        return Tail(
            turns: turns,
            chatRev: version >= 2 ? object["chatRev"]?.int : nil,
            nextFrom: version >= 2 ? object["nextFrom"]?.int : nil
        )
    }

    private static func writeTail(
        tenant: String,
        chatId: String,
        rows: [JSONValue],
        chatRev: Int?,
        nextFrom: Int?
    ) {
        guard let file = tailFile(tenant, chatId) else { return }
        let dir = file.deletingLastPathComponent()
        let fm = FileManager.default
        if rows.isEmpty {
            try? fm.removeItem(at: file)
            return
        }
        let kept = Array(rows.suffix(tailLimit))
        var fields: [String: JSONValue] = [
            "v": .number(2),
            "chatId": .string(chatId),
            "turns": .array(kept),
        ]
        if let chatRev, let nextFrom {
            fields["chatRev"] = .number(Double(chatRev))
            fields["nextFrom"] = .number(Double(nextFrom))
        }
        let object: JSONValue = .object(fields)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            var root = dir.deletingLastPathComponent()
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? root.setResourceValues(values)
            try encode(object).write(to: file, options: .atomic)
            var written = file
            var fileValues = URLResourceValues()
            fileValues.isExcludedFromBackup = true
            try? written.setResourceValues(fileValues)
            pruneTails(dir, keep: file)
        } catch {
            try? fm.removeItem(at: file)
        }
    }

    private static func removeTailFile(tenant: String, chatId: String) {
        guard let file = tailFile(tenant, chatId) else { return }
        try? FileManager.default.removeItem(at: file)
    }

    /// 尾段只为打开过的会话服务。超过上限按修改时间删最旧的，刚写的这份留下
    private static func pruneTails(_ dir: URL, keep: URL) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        guard files.count > tailFileLimit else { return }
        // 预先一次性读取各文件修改时间，避免在 sort 比较器内 O(N log N) 次重复系统 stat 调用
        var extras: [(file: URL, date: Date)] = []
        extras.reserveCapacity(files.count)
        for file in files where file.lastPathComponent.hasSuffix(".json") && file.path != keep.path {
            let date = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            extras.append((file, date))
        }
        extras.sort { $0.date < $1.date }
        let overflow = files.count - tailFileLimit
        for entry in extras.prefix(overflow) {
            try? fm.removeItem(at: entry.file)
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

    struct ListCacheEntry {
        var session: ChatSession
        var preview: String
    }

    static func saveList(tenant: String, stateRev: Int, chatRevs: [String: Int], entries: [ListCacheEntry]) {
        queue.async {
            guard let dir = tenantDir(tenant) else { return }
            let rows: [JSONValue] = entries.compactMap { entry in
                var slim = entry.session
                slim.turnsComplete = false // json() 不写 turns 键
                guard var object = slim.json().object else { return nil }
                if !entry.preview.isEmpty {
                    object["preview"] = .string(entry.preview)
                }
                return .object(object)
            }
            let object: JSONValue = .object([
                "v": .number(1),
                "stateRev": .number(Double(stateRev)),
                "chatRevs": .object(chatRevs.mapValues { .number(Double($0)) }),
                "chats": .array(rows),
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
            lastPruneAt.removeValue(forKey: tenant)
            guard let dir = tenantDir(tenant) else { return }
            try? FileManager.default.removeItem(at: dir)
            if let tails = tailDir(tenant) {
                try? FileManager.default.removeItem(at: tails)
            }
        }
    }

    /// 退出登录：所有租户一起清
    static func clearAll() {
        queue.async {
            lastPruneAt.removeAll()
            guard let root else { return }
            try? FileManager.default.removeItem(at: root)
            if let tails = tailRoot {
                try? FileManager.default.removeItem(at: tails)
            }
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

    /// 不放在 Caches 里：系统清缓存时首屏还要能画出来
    private static var tailRoot: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("JieboChat", isDirectory: true)
    }

    private static func tailDir(_ tenant: String) -> URL? {
        guard !tenant.isEmpty else { return nil }
        return tailRoot?.appendingPathComponent(safeName(tenant), isDirectory: true)
            .appendingPathComponent("tails", isDirectory: true)
    }

    private static func tailFile(_ tenant: String, _ chatId: String) -> URL? {
        guard !chatId.isEmpty else { return nil }
        return tailDir(tenant)?.appendingPathComponent(safeName(chatId) + ".json")
    }

    /// id 做目录名：只留字母数字和 -_，其余换成 _；改动过或太长的补一段原文哈希防撞名
    private static func safeName(_ raw: String) -> String {
        var kept = String()
        kept.reserveCapacity(min(raw.utf8.count, 80))
        var count = 0
        for ch in raw {
            if count >= 80 { break }
            if ch.isASCII, ch.isLetter || ch.isNumber || ch == "-" || ch == "_" {
                kept.append(ch)
            } else {
                kept.append("_")
            }
            count += 1
        }
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

    private static func readBodyHead(tenant: String, chatId: String) -> BodyHead? {
        guard let dir = bodyDir(tenant, chatId), let manifest = readManifest(dir), manifest.chatId == chatId else { return nil }
        return BodyHead(rev: manifest.rev, count: manifest.count, serverSegs: manifest.serverSegs)
    }

    private static func readSegment(_ dir: URL, _ segment: Manifest.Segment) -> [Turn]? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(segment.file)),
              data.count == segment.bytes,
              fnv1a(data) == segment.hash,
              let rows = (try? JSONValue.parse(data))?.array,
              rows.count == segment.count
        else { return nil }
        let turns = rows.compactMap(Turn.from)
        guard turns.count == rows.count else { return nil }
        return turns
    }

    private static func readRecentTurns(tenant: String, chatId: String, limit: Int) -> [Turn]? {
        guard limit > 0, let dir = bodyDir(tenant, chatId), var manifest = readManifest(dir), manifest.chatId == chatId else { return nil }
        // 倒序收集各段，再一次性按正序合并，避免反复 insert(at: 0) 产生 O(N^2) 数组搬移
        var chunks: [[Turn]] = []
        var collected = 0
        for segment in manifest.segments.reversed() {
            guard let rows = readSegment(dir, segment) else {
                try? FileManager.default.removeItem(at: dir)
                return nil
            }
            chunks.append(rows)
            collected += rows.count
            if collected >= limit { break }
        }
        var turns: [Turn] = []
        turns.reserveCapacity(collected)
        for chunk in chunks.reversed() {
            turns.append(contentsOf: chunk)
        }
        let tail = Array(turns.suffix(limit))
        guard !tail.isEmpty, !Turn.hasDuplicateIds(tail) else {
            try? FileManager.default.removeItem(at: dir)
            return nil
        }
        manifest.at = Date().timeIntervalSince1970
        writeManifest(manifest, to: dir)
        return tail
    }

    private static func readTurnsBefore(tenant: String, chatId: String, beforeTurnId: String, limit: Int) -> EarlierPage? {
        guard limit > 0, let dir = bodyDir(tenant, chatId), let manifest = readManifest(dir), manifest.chatId == chatId else { return nil }
        var collected: [Turn] = []
        var seenAnchor = false
        for segment in manifest.segments.reversed() {
            guard let rows = readSegment(dir, segment) else {
                try? FileManager.default.removeItem(at: dir)
                return nil
            }
            for turn in rows.reversed() {
                if !seenAnchor {
                    if turn.id == beforeTurnId { seenAnchor = true }
                    continue
                }
                collected.append(turn)
                if collected.count >= limit {
                    return EarlierPage(turns: Array(collected.reversed()), reachedStart: false)
                }
            }
        }
        guard seenAnchor else { return nil }
        return EarlierPage(turns: Array(collected.reversed()), reachedStart: true)
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
        // 服务端正文里 id 不会重复；缓存里有重复说明存进来时本地已经合乱了，作废重拉
        guard turns.count == manifest.count, turns.last?.id == manifest.lastTurnId, !Turn.hasDuplicateIds(turns) else {
            try? FileManager.default.removeItem(at: dir)
            return nil
        }
        manifest.at = Date().timeIntervalSince1970
        writeManifest(manifest, to: dir)
        return Body(rev: manifest.rev, turns: turns, serverSegs: manifest.serverSegs)
    }

    @discardableResult
    private static func writeBody(tenant: String, chatId: String, rev: Int, rows: [JSONValue], serverSegs: [String]?) -> Bool {
        guard let dir = bodyDir(tenant, chatId) else { return false }
        let fm = FileManager.default
        let isNewChat = !fm.fileExists(atPath: dir.appendingPathComponent("manifest.json").path)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let old = readManifest(dir)
            // 容忍受损/旧版 manifest 含重复 file 名，避免 uniqueKeysWithValues 触发运行时 trap
            let oldByFile = Dictionary(
                (old?.segments ?? []).map { ($0.file, $0) },
                uniquingKeysWith: { _, latest in latest }
            )
            var segments: [Manifest.Segment] = []
            segments.reserveCapacity((rows.count + segmentSize - 1) / segmentSize)
            var keptFiles = Set<String>()
            var total = 0
            for (index, start) in stride(from: 0, to: rows.count, by: segmentSize).enumerated() {
                let chunk = Array(rows[start ..< min(start + segmentSize, rows.count)])
                let data = try encode(.array(chunk))
                let hash = fnv1a(data)
                let file = "seg-\(index).json"
                let url = dir.appendingPathComponent(file)
                let unchanged = oldByFile[file].map { $0.hash == hash && $0.bytes == data.count } == true
                    && fm.fileExists(atPath: url.path)
                if !unchanged {
                    try data.write(to: url, options: .atomic)
                }
                segments.append(Manifest.Segment(file: file, hash: hash, count: chunk.count, bytes: data.count))
                keptFiles.insert(file)
                total += data.count
            }
            // 段数变少（会话被截断）：删掉多出来的旧段
            for prior in old?.segments ?? [] where !keptFiles.contains(prior.file) {
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
                segments: segments,
                serverSegs: serverSegs
            )
            // 清单最后写：中途失败时旧清单的段哈希对不上新段，读的时候整条作废
            try JSONEncoder().encode(manifest).write(to: dir.appendingPathComponent("manifest.json"), options: .atomic)
            return isNewChat
        } catch {
            try? fm.removeItem(at: dir)
            return false
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
