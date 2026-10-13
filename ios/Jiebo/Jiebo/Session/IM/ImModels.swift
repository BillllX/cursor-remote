import Foundation

// 即时消息的本机模型与纯函数（只依赖 Foundation）：消息合并、时间文案、预览文案、拼音。

enum ImSendState: String, Sendable, Hashable {
    case sent
    case sending
    case failed
}

/// 本机发出的图片：发送前压好的本地文件（在 outbox 目录下，按文件名存）和上传后拿到的 blob。
/// 上传成功一半就失败时，重发只补没传上去的那个
struct ImOutgoingImage: Sendable, Hashable {
    var file: String
    var thumbFile: String
    var mime: String
    var w: Int
    var h: Int
    var original: Bool
    var blob: String?
    var thumb: String?

    static func from(_ json: JSONValue?) -> ImOutgoingImage? {
        guard let row = json?.object, let file = row["file"]?.string, let thumbFile = row["thumbFile"]?.string else { return nil }
        return ImOutgoingImage(
            file: file,
            thumbFile: thumbFile,
            mime: row["mime"]?.string ?? "image/jpeg",
            w: row["w"]?.int ?? 0,
            h: row["h"]?.int ?? 0,
            original: row["original"]?.bool ?? false,
            blob: row["blob"]?.string?.nilIfEmpty,
            thumb: row["thumb"]?.string?.nilIfEmpty
        )
    }

    func json() -> JSONValue {
        var object: [String: JSONValue] = [
            "file": .string(file),
            "thumbFile": .string(thumbFile),
            "mime": .string(mime),
            "w": .number(Double(w)),
            "h": .number(Double(h)),
            "original": .bool(original),
        ]
        if let blob { object["blob"] = .string(blob) }
        if let thumb { object["thumb"] = .string(thumb) }
        return .object(object)
    }
}

/// 时间线里的一条：网关来的消息（seq 有值）或本机还没回 ack 的（seq 为 nil）
struct ImLocalMessage: Sendable, Hashable, Identifiable {
    var clientId: String
    var convId: String
    var seq: Int?
    var from: String
    var at: Double
    var kind: String
    var body: ImBody?
    var replyTo: Int?
    var recalled: Bool
    var rejected: Bool
    var state: ImSendState
    var outgoing: ImOutgoingImage?
    /// 图片上传进度 0...1，只在内存里
    var progress: Double?

    /// 本机发的那条 ack 前后 id 不变，气泡不会重建
    var id: String { clientId.isEmpty ? "seq-\(seq ?? 0)" : "\(from)|\(clientId)" }

    /// 已经有 seq 的才能当会话的最后一条
    var message: ImMessage? {
        guard let seq else { return nil }
        return ImMessage(
            convId: convId, seq: seq, from: from, at: at, kind: kind, body: body,
            replyTo: replyTo, recalled: recalled, rejected: rejected, clientId: clientId
        )
    }

    init(_ message: ImMessage) {
        clientId = message.clientId
        convId = message.convId
        seq = message.seq
        from = message.from
        at = message.at
        kind = message.kind
        body = message.body
        replyTo = message.replyTo
        recalled = message.recalled
        rejected = message.rejected
        state = .sent
    }

    init(pending clientId: String, convId: String, from: String, at: Double, kind: String, body: ImBody?, replyTo: Int?, outgoing: ImOutgoingImage?) {
        self.clientId = clientId
        self.convId = convId
        seq = nil
        self.from = from
        self.at = at
        self.kind = kind
        self.body = body
        self.replyTo = replyTo
        recalled = false
        rejected = false
        state = .sending
        self.outgoing = outgoing
    }

    static func from(_ json: JSONValue?) -> ImLocalMessage? {
        guard let row = json?.object else { return nil }
        let outgoing = ImOutgoingImage.from(row["outgoing"])
        if let message = ImMessage.from(json) {
            var local = ImLocalMessage(message)
            local.outgoing = outgoing
            return local
        }
        guard let clientId = row["clientId"]?.string, !clientId.isEmpty, let convId = row["convId"]?.string else { return nil }
        let kind = row["kind"]?.string ?? "text"
        var local = ImLocalMessage(
            pending: clientId,
            convId: convId,
            from: row["from"]?.string ?? "",
            at: row["at"]?.number ?? 0,
            kind: kind,
            body: ImBody.from(kind: kind, row["body"]),
            replyTo: row["replyTo"]?.int,
            outgoing: outgoing
        )
        // 上次退出时还在发的，重启后一律算失败，等用户手动重发
        local.state = .failed
        return local
    }

    func json() -> JSONValue {
        var object: [String: JSONValue] = [
            "clientId": .string(clientId),
            "convId": .string(convId),
            "from": .string(from),
            "at": .number(at),
            "kind": .string(kind),
        ]
        if let seq { object["seq"] = .number(Double(seq)) }
        if let body { object["body"] = body.json() }
        if let replyTo { object["replyTo"] = .number(Double(replyTo)) }
        if recalled { object["recalled"] = .bool(true) }
        if rejected { object["rejected"] = .bool(true) }
        if let outgoing { object["outgoing"] = outgoing.json() }
        return .object(object)
    }
}

enum ImTimeline {
    /// 本机最多缓存每个会话最近这么多条
    static let cacheLimit = 300

    /// 按 seq 合并：同 seq 以新来的为准；本机待发的那条按 clientId 认领（自己发的才认）。
    /// 结果：有 seq 的按 seq 升序，还没 ack 的按时间排在最后
    static func merge(_ existing: [ImLocalMessage], _ incoming: [ImLocalMessage], me: String) -> [ImLocalMessage] {
        var bySeq: [Int: ImLocalMessage] = [:]
        var pending: [ImLocalMessage] = []
        for item in existing {
            if let seq = item.seq { bySeq[seq] = item } else { pending.append(item) }
        }
        for item in incoming {
            guard let seq = item.seq else {
                if let index = pending.firstIndex(where: { $0.clientId == item.clientId }) {
                    pending[index] = item
                } else {
                    pending.append(item)
                }
                continue
            }
            var next = item
            if let index = pending.firstIndex(where: { $0.clientId == item.clientId && item.from == me }) {
                next.outgoing = next.outgoing ?? pending[index].outgoing
                pending.remove(at: index)
            }
            if let old = bySeq[seq] {
                next.outgoing = next.outgoing ?? old.outgoing
            }
            bySeq[seq] = next
        }
        let sent = bySeq.keys.sorted().compactMap { bySeq[$0] }
        return sent + pending.sorted { $0.at < $1.at }
    }

    static func maxSeq(_ items: [ImLocalMessage]) -> Int {
        items.reduce(0) { max($0, $1.seq ?? 0) }
    }

    static func minSeq(_ items: [ImLocalMessage]) -> Int? {
        items.compactMap(\.seq).min()
    }

    /// 写缓存时只留最近 cacheLimit 条有 seq 的，加上所有还没发出去的
    static func trimmed(_ items: [ImLocalMessage]) -> [ImLocalMessage] {
        let sent = items.filter { $0.seq != nil }
        let pending = items.filter { $0.seq == nil }
        return Array(sent.suffix(cacheLimit)) + pending
    }
}

enum ImFormat {
    /// 未读数：≥1000 显示 999+
    static func badge(_ count: Int) -> String {
        count >= 1000 ? "999+" : "\(count)"
    }

    /// 会话列表的时间：今天 HH:mm、昨天、一周内星期几、更早 yyyy/M/d
    static func listTime(_ ms: Double, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard ms > 0 else { return "" }
        let date = Date(timeIntervalSince1970: ms / 1000)
        if calendar.isDate(date, inSameDayAs: now) { return clock(date, calendar: calendar) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "昨天"
        }
        if let days = dayDistance(from: date, to: now, calendar: calendar), days < 7, days > 0 {
            return weekday(date, calendar: calendar)
        }
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return "\(parts.year ?? 0)/\(parts.month ?? 0)/\(parts.day ?? 0)"
    }

    /// 聊天页里居中的时间：今天 HH:mm、昨天 HH:mm、一周内「星期几 HH:mm」、更早 yyyy/M/d HH:mm
    static func dividerTime(_ ms: Double, now: Date = Date(), calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let time = clock(date, calendar: calendar)
        if calendar.isDate(date, inSameDayAs: now) { return time }
        let day = listTime(ms, now: now, calendar: calendar)
        return "\(day) \(time)"
    }

    private static func clock(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    private static func weekday(_ date: Date, calendar: Calendar) -> String {
        let names = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"]
        let index = calendar.component(.weekday, from: date) - 1
        return names.indices.contains(index) ? names[index] : ""
    }

    private static func dayDistance(from date: Date, to now: Date, calendar: Calendar) -> Int? {
        calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day
    }

    /// 列表和引用里的一行预览
    static func preview(kind: String, body: ImBody?) -> String {
        switch body {
        case .text(let text)?:
            return text.replacingOccurrences(of: "\n", with: " ")
        case .image?:
            return "[图片]"
        case .voice?:
            return "[语音]"
        case .file(_, let name, _, _)?:
            return name.isEmpty ? "[文件]" : "[文件] \(name)"
        case .link(_, let title, _, _)?:
            return title.map { "[链接] \($0)" } ?? "[链接]"
        case .location(_, _, let name, _)?:
            return name.isEmpty ? "[位置]" : "[位置] \(name)"
        case .unknown?, nil:
            return placeholder(kind)
        }
    }

    /// 还没做的消息类型在气泡里显示的占位
    static func placeholder(_ kind: String) -> String {
        switch kind {
        case "text": return "[文字]"
        case "image": return "[图片]"
        case "voice": return "[语音]"
        case "file": return "[文件]"
        case "link": return "[链接]"
        case "location": return "[位置]"
        default: return "[暂不支持的消息]"
        }
    }

    /// 只能是 1–64 位字母数字或 _.:-
    static func newClientId(now: Date = Date()) -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        let tail = String((0 ..< 6).map { _ in alphabet[Int.random(in: 0 ..< alphabet.count)] })
        return "ios-\(Int64(now.timeIntervalSince1970 * 1000))-\(tail)"
    }
}

/// 昵称的拼音：全拼（不带空格）和首字母，用来搜索和排序
struct ImPinyin: Sendable, Hashable {
    var full: String
    var initials: String

    init(_ name: String) {
        let latin = name.applyingTransform(.toLatin, reverse: false) ?? name
        let plain = (latin.applyingTransform(.stripDiacritics, reverse: false) ?? latin).lowercased()
        let words = plain.split(whereSeparator: { $0 == " " || $0 == "\u{00A0}" })
        full = words.joined()
        initials = String(words.compactMap(\.first))
    }

    /// 昵称本身、全拼、首字母任一包含查询词
    static func matches(nickname: String, key: ImPinyin, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return true }
        if nickname.lowercased().contains(needle) { return true }
        let compact = needle.replacingOccurrences(of: " ", with: "")
        return key.full.contains(compact) || key.initials.contains(compact)
    }
}
