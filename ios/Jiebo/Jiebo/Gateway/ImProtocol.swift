import Foundation

// 平台用户之间的即时消息（im_*），对齐 shared/protocol.ts 的 Im* 类型与 docs/im.md。
// kind / what / code 一律存 String：网关加新值时整条消息照样解得出来。

/// 下载票据：签名绑定（租户, scope, exp），exp 是毫秒，2 小时有效
struct ImTicket: Sendable, Hashable {
    var exp: Double
    var sig: String

    static func from(_ json: JSONValue?) -> ImTicket? {
        guard let row = json?.object, let exp = row["exp"]?.number, let sig = row["sig"]?.string, !sig.isEmpty else { return nil }
        return ImTicket(exp: exp, sig: sig)
    }

    func json() -> JSONValue {
        .object(["exp": .number(exp), "sig": .string(sig)])
    }
}

struct ImUser: Sendable, Hashable, Identifiable {
    var id: String
    var nickname: String
    /// 头像 blob（sha256 hex），没有头像时 nil
    var avatar: String?

    static func from(_ json: JSONValue?) -> ImUser? {
        guard let row = json?.object, let id = row["id"]?.string, !id.isEmpty else { return nil }
        return ImUser(id: id, nickname: row["nickname"]?.string?.nilIfEmpty ?? id, avatar: row["avatar"]?.string?.nilIfEmpty)
    }

    func json() -> JSONValue {
        var object: [String: JSONValue] = ["id": .string(id), "nickname": .string(nickname)]
        if let avatar { object["avatar"] = .string(avatar) }
        return .object(object)
    }
}

struct ImMe: Sendable, Hashable {
    var id: String
    var nickname: String
    var avatar: String?
    /// 通知里显示正文，默认关
    var notifyPreview: Bool

    var user: ImUser { ImUser(id: id, nickname: nickname, avatar: avatar) }

    static func from(_ json: JSONValue?) -> ImMe? {
        guard let user = ImUser.from(json) else { return nil }
        return ImMe(id: user.id, nickname: user.nickname, avatar: user.avatar, notifyPreview: json?["notifyPreview"]?.bool ?? false)
    }

    func json() -> JSONValue {
        var object = user.json().object ?? [:]
        object["notifyPreview"] = .bool(notifyPreview)
        return .object(object)
    }
}

/// 六种消息体。认不出的 kind 或缺字段的 body 落到 unknown，界面显示占位，不会解码失败
enum ImBody: Sendable, Hashable {
    case text(String)
    case image(blob: String, thumb: String, w: Int, h: Int, original: Bool)
    case voice(blob: String, durationMs: Int, waveform: [Double])
    case file(blob: String, name: String, size: Double, mime: String)
    case link(url: String, title: String?, desc: String?, icon: String?)
    case location(lat: Double, lng: Double, name: String, address: String)
    case unknown(JSONValue)

    static func from(kind: String, _ json: JSONValue?) -> ImBody? {
        guard let json else { return nil }
        guard let row = json.object else { return .unknown(json) }
        func text(_ key: String) -> String? { row[key]?.string }
        switch kind {
        case "text":
            if let value = text("text") { return .text(value) }
        case "image":
            if let blob = text("blob"), let thumb = text("thumb") {
                return .image(blob: blob, thumb: thumb, w: row["w"]?.int ?? 0, h: row["h"]?.int ?? 0, original: row["original"]?.bool ?? false)
            }
        case "voice":
            if let blob = text("blob") {
                return .voice(
                    blob: blob,
                    durationMs: row["durationMs"]?.int ?? 0,
                    waveform: row["waveform"]?.array?.compactMap(\.number) ?? []
                )
            }
        case "file":
            if let blob = text("blob") {
                return .file(blob: blob, name: text("name") ?? "", size: row["size"]?.number ?? 0, mime: text("mime") ?? "")
            }
        case "link":
            if let url = text("url") {
                return .link(url: url, title: text("title")?.nilIfEmpty, desc: text("desc")?.nilIfEmpty, icon: text("icon")?.nilIfEmpty)
            }
        case "location":
            if let lat = row["lat"]?.number, let lng = row["lng"]?.number {
                return .location(lat: lat, lng: lng, name: text("name") ?? "", address: text("address") ?? "")
            }
        default:
            break
        }
        return .unknown(json)
    }

    func json() -> JSONValue {
        switch self {
        case .text(let text):
            return .object(["text": .string(text)])
        case .image(let blob, let thumb, let w, let h, let original):
            return .object([
                "blob": .string(blob),
                "thumb": .string(thumb),
                "w": .number(Double(w)),
                "h": .number(Double(h)),
                "original": .bool(original),
            ])
        case .voice(let blob, let durationMs, let waveform):
            return .object([
                "blob": .string(blob),
                "durationMs": .number(Double(durationMs)),
                "waveform": .array(waveform.map(JSONValue.number)),
            ])
        case .file(let blob, let name, let size, let mime):
            return .object(["blob": .string(blob), "name": .string(name), "size": .number(size), "mime": .string(mime)])
        case .link(let url, let title, let desc, let icon):
            var object: [String: JSONValue] = ["url": .string(url)]
            if let title, !title.isEmpty { object["title"] = .string(title) }
            if let desc, !desc.isEmpty { object["desc"] = .string(desc) }
            if let icon, !icon.isEmpty { object["icon"] = .string(icon) }
            return .object(object)
        case .location(let lat, let lng, let name, let address):
            return .object(["lat": .number(lat), "lng": .number(lng), "name": .string(name), "address": .string(address)])
        case .unknown(let json):
            return json
        }
    }
}

struct ImMessage: Sendable, Hashable {
    var convId: String
    /// 会话内从 1 递增
    var seq: Int
    /// 发件人租户 id
    var from: String
    /// 网关落盘时间（毫秒）
    var at: Double
    var kind: String
    /// 撤回后没有
    var body: ImBody?
    var replyTo: Int?
    var recalled: Bool
    /// 只出现在发件人自己的视图：被对方拒收
    var rejected: Bool
    var clientId: String

    static func from(_ json: JSONValue?) -> ImMessage? {
        guard let row = json?.object,
              let convId = row["convId"]?.string, !convId.isEmpty,
              let seq = row["seq"]?.int, seq > 0
        else { return nil }
        let kind = row["kind"]?.string ?? "text"
        return ImMessage(
            convId: convId,
            seq: seq,
            from: row["from"]?.string ?? "",
            at: row["at"]?.number ?? 0,
            kind: kind,
            body: ImBody.from(kind: kind, row["body"]),
            replyTo: row["replyTo"]?.int,
            recalled: row["recalled"]?.bool ?? false,
            rejected: row["rejected"]?.bool ?? false,
            clientId: row["clientId"]?.string ?? ""
        )
    }

    func json() -> JSONValue {
        var object: [String: JSONValue] = [
            "convId": .string(convId),
            "seq": .number(Double(seq)),
            "from": .string(from),
            "at": .number(at),
            "kind": .string(kind),
            "clientId": .string(clientId),
        ]
        if let body { object["body"] = body.json() }
        if let replyTo { object["replyTo"] = .number(Double(replyTo)) }
        if recalled { object["recalled"] = .bool(true) }
        if rejected { object["rejected"] = .bool(true) }
        return .object(object)
    }
}

struct ImConvRow: Sendable, Hashable {
    var convId: String
    var peer: String
    /// 自己可见的最后一条；缺省 = 没有可见消息（清空过）
    var last: ImMessage?
    /// 最多 1000（封顶）
    var unread: Int
    var readSeq: Int
    /// 自己可见的最大 seq
    var maxSeq: Int
    var pin: Bool
    var mute: Bool
    var hideBefore: Int
    var ticket: ImTicket?

    static func from(_ json: JSONValue?) -> ImConvRow? {
        guard let row = json?.object,
              let convId = row["convId"]?.string, !convId.isEmpty,
              let peer = row["peer"]?.string, !peer.isEmpty
        else { return nil }
        return ImConvRow(
            convId: convId,
            peer: peer,
            last: ImMessage.from(row["last"]),
            unread: row["unread"]?.int ?? 0,
            readSeq: row["readSeq"]?.int ?? 0,
            maxSeq: row["maxSeq"]?.int ?? 0,
            pin: row["pin"]?.bool ?? false,
            mute: row["mute"]?.bool ?? false,
            hideBefore: row["hideBefore"]?.int ?? 0,
            ticket: ImTicket.from(row["ticket"])
        )
    }

    func json() -> JSONValue {
        var object: [String: JSONValue] = [
            "convId": .string(convId),
            "peer": .string(peer),
            "unread": .number(Double(unread)),
            "readSeq": .number(Double(readSeq)),
            "maxSeq": .number(Double(maxSeq)),
            "pin": .bool(pin),
            "mute": .bool(mute),
            "hideBefore": .number(Double(hideBefore)),
        ]
        if let last { object["last"] = last.json() }
        if let ticket { object["ticket"] = ticket.json() }
        return .object(object)
    }
}

/// im_update：what 决定带哪些字段（recall / read / settings / prefs / profile / block）
struct ImUpdate: Sendable, Hashable {
    var what: String
    var convId: String?
    var seq: Int?
    var pin: Bool?
    var mute: Bool?
    var hideBefore: Int?
    var me: ImMe?
    var user: ImUser?
    var avatarTicket: ImTicket?
    var blocked: [String]?
    /// recall / read / settings：自己在这个会话的权威未读（旧网关不带）
    var unread: Int?
}

/// 网关下发的 im_*（只发给 hello caps 含 "im" 的连接）
enum ImEvent: Sendable, Hashable {
    case contacts(me: ImMe, users: [ImUser], avatarTicket: ImTicket?)
    case list(convs: [ImConvRow], blocked: [String], more: Bool, cursor: String?)
    /// messages 按 seq 升序；more：请求带 after 时表示后面还有，否则表示前面还有
    case history(convId: String, messages: [ImMessage], more: Bool, ticket: ImTicket?, before: Int?, after: Int?)
    case ack(clientId: String, convId: String, seq: Int, at: Double, rejected: Bool)
    /// unread：自己在这个会话的权威未读（旧网关不带）
    case message(ImMessage, ticket: ImTicket?, unread: Int?)
    case update(ImUpdate)
    case error(clientId: String?, code: String, message: String)

    static func decode(type: String, _ object: [String: JSONValue]) -> ImEvent? {
        switch type {
        case "im_contacts":
            guard let me = ImMe.from(object["me"]) else { return nil }
            return .contacts(
                me: me,
                users: object["users"]?.array?.compactMap { ImUser.from($0) } ?? [],
                avatarTicket: ImTicket.from(object["avatarTicket"])
            )
        case "im_list":
            return .list(
                convs: object["convs"]?.array?.compactMap { ImConvRow.from($0) } ?? [],
                blocked: object["blocked"]?.array?.compactMap(\.string) ?? [],
                more: object["more"]?.bool ?? false,
                cursor: object["cursor"]?.string?.nilIfEmpty
            )
        case "im_history":
            guard let convId = object["convId"]?.string, !convId.isEmpty else { return nil }
            return .history(
                convId: convId,
                messages: object["messages"]?.array?.compactMap { ImMessage.from($0) } ?? [],
                more: object["more"]?.bool ?? false,
                ticket: ImTicket.from(object["ticket"]),
                before: object["before"]?.int,
                after: object["after"]?.int
            )
        case "im_ack":
            guard let clientId = object["clientId"]?.string, !clientId.isEmpty,
                  let convId = object["convId"]?.string, !convId.isEmpty,
                  let seq = object["seq"]?.int
            else { return nil }
            return .ack(clientId: clientId, convId: convId, seq: seq, at: object["at"]?.number ?? 0, rejected: object["rejected"]?.bool ?? false)
        case "im_message":
            guard let message = ImMessage.from(object["message"]) else { return nil }
            return .message(message, ticket: ImTicket.from(object["ticket"]), unread: object["unread"]?.int)
        case "im_update":
            guard let what = object["what"]?.string, !what.isEmpty else { return nil }
            return .update(ImUpdate(
                what: what,
                convId: object["convId"]?.string?.nilIfEmpty,
                seq: object["seq"]?.int,
                pin: object["pin"]?.bool,
                mute: object["mute"]?.bool,
                hideBefore: object["hideBefore"]?.int,
                me: ImMe.from(object["me"]),
                user: ImUser.from(object["user"]),
                avatarTicket: ImTicket.from(object["avatarTicket"]),
                blocked: object["blocked"]?.array?.compactMap(\.string),
                unread: object["unread"]?.int
            ))
        case "im_error":
            return .error(
                clientId: object["clientId"]?.string?.nilIfEmpty,
                code: object["code"]?.string ?? "internal",
                message: object["message"]?.string ?? ""
            )
        default:
            return nil
        }
    }
}

/// 会话号：dm~<较小租户 id>~<较大租户 id>（按字符串排序）
enum ImConv {
    static func dm(_ a: String, _ b: String) -> String {
        "dm~" + [a, b].sorted().joined(separator: "~")
    }

    /// 单聊里对方的租户 id；不是单聊或不含自己时 nil
    static func peer(of convId: String, me: String) -> String? {
        let parts = convId.split(separator: "~", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, parts[0] == "dm", parts.contains(me) else { return nil }
        return parts[1] == me ? parts[2] : parts[1]
    }
}

extension GatewayConfig {
    /// IM 附件下载地址：scope 是会话号或 "avatars"，票据在查询参数里（不带 Authorization）
    static func imMediaURL(scope: String, blob: String, ticket: ImTicket) -> URL? {
        var components = URLComponents()
        components.path = "/media/im"
        components.queryItems = [
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "blob", value: blob),
            URLQueryItem(name: "exp", value: String(Int64(ticket.exp))),
            URLQueryItem(name: "sig", value: ticket.sig),
        ]
        guard let relative = components.string else { return nil }
        return resolveHTTP(relative)
    }

    /// IM 上传地址：POST /upload/im?kind=&mime=，Authorization: Bearer + 原始字节
    static func imUploadURL(kind: String, mime: String) -> URL? {
        var components = URLComponents()
        components.path = "/upload/im"
        components.queryItems = [URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "mime", value: mime)]
        guard let relative = components.string else { return nil }
        return resolveHTTP(relative)
    }

    /// 放在 /upload 前缀下，沿用线上已经开放给网关的反向代理路径。
    static var imHTTPSendURL: URL? { resolveHTTP("/upload/im/send-json") }
    static var imHTTPUploadAndSendURL: URL? { resolveHTTP("/upload/im/send") }
}
