import Foundation
import Observation
#if canImport(UserNotifications)
import UserNotifications
#endif

/// ImStore 经这层借用 ChatStore 的那条 WebSocket 和登录凭据
@MainActor
protocol ImTransport: AnyObject {
    /// 当前登录的租户 id，没登录时为空
    var imTenantId: String { get }
    /// HTTP 上传用的口令
    var imToken: String { get }
    /// 已登录且连接就绪：这时发出的 im_send 才真的出了门（断线时不进发件箱）
    var imLinkOpen: Bool { get }
    /// 蜂窝 / Low Data Mode 只延后非可见会话补齐，不影响实时消息和当前会话。
    var imNetworkCost: GatewayNetworkCost { get }
    func imSend(_ message: ClientMessage)
}

/// POST /upload/im：返回 blob（sha256 hex）
protocol ImBlobUploader: Sendable {
    func upload(file: URL, kind: String, mime: String, token: String, progress: @escaping @Sendable (Double) -> Void) async throws -> String
}

/// 聊天主页列表的一行
struct ImDirectoryRow: Identifiable, Hashable {
    var user: ImUser
    var conv: ImConvRow?
    var id: String { user.id }
}

/// 进度回调跨线程时用它弱引用 store
final class ImWeakStore: @unchecked Sendable {
    weak var value: ImStore?
    init(_ value: ImStore) { self.value = value }
}

/// 平台用户之间即时消息的数据层（docs/im.md、docs/im-ios.md）。
/// 网关下行由 ChatStore 转进 handle(_:)；连上（含重连）后拉联系人、分页拉全会话列表，再按本地最大 seq 补缺。
@MainActor
@Observable
final class ImStore {
    static let sendTimeout: Duration = .seconds(15)
    static let readDelay: Duration = .milliseconds(600)
    /// 置顶、免打扰、拉黑等设置发出去后等网关 im_update 确认的时间；超时就撤回本地改动
    static let confirmTimeout: Duration = .seconds(10)
    /// 每个会话最多记这么多条「只在本机删掉」的 seq（比本机缓存的 300 条窗口大一些）
    static let hiddenLimit = 500
    /// AppDelegate 收到 im_read 静默推送（别的设备读过）时发；userInfo["convId"]
    static let readElsewhere = Notification.Name("ai.jiebo.im.readElsewhere")
    /// 票据剩不到这么久（毫秒）就重新拉列表换票
    static let ticketMargin: Double = 10 * 60_000

    @ObservationIgnored weak var transport: ImTransport?
    @ObservationIgnored var uploader: ImBlobUploader?

    /// 网关支持 im 且连接就绪
    private(set) var online = false
    /// 内存和缓存属于哪个租户
    private(set) var tenant = ""
    var me: ImMe?
    var users: [String: ImUser] = [:]
    var avatarTicket: ImTicket?
    var convs: [String: ImConvRow] = [:]
    var tickets: [String: ImTicket] = [:]
    var blocked: Set<String> = []
    var timelines: [String: [ImLocalMessage]] = [:]
    /// Collab 运行图是网关规范化服务数据；界面只读，审批和执行仍留在既有安全边界。
    var collabRuns: [String: [CollabRunSnapshot]] = [:]
    /// false = 前面没有更早的了；nil = 还不知道，按还有处理
    var olderMore: [String: Bool] = [:]
    var loadingOlder: Set<String> = []
    var loadingLatest: Set<String> = []
    var drafts: [String: String] = [:]
    /// 只在本机删掉（隐藏）的消息
    var hidden: [String: Set<Int>] = [:]
    /// 引用回复：会话号 → 被引用的 seq
    var replyTo: [String: Int] = [:]
    /// 收到的语音在本机听过；不做对方可见回执
    var heardVoice: [String: Set<Int>] = [:]
    /// 本机 SFSpeech 转写结果：会话号 → seq → 文字
    var voiceText: [String: [Int: String]] = [:]
    var listLoaded = false
    var contactsLoaded = false
    /// 本机 conv 文件已经并进 timelines。在这之前不能 catchUp，也不能把半截时间线写回磁盘
    private var timelinesReady = false
    private var deferredTimelineSaves = Set<String>()

    // MARK: 界面状态

    /// 打开的会话（对方租户 id）。手机的导航栈和 iPad 的分栏都从它派生
    var selectedPeer: String?
    /// 聊天主页在前面（工作台主页时为 false）
    var homeVisible = false {
        didSet { if homeVisible { scheduleRead(visibleConvId) } }
    }
    private(set) var appActive = true
    /// 聊天页出现时设、消失时清
    var visibleConvId: String? {
        didSet {
            ImViewingBeacon.shared.set(viewingConvId)
            scheduleRead(visibleConvId)
        }
    }
    var toast = ""

    @ObservationIgnored private var listPaging = false
    @ObservationIgnored private var listSeen: Set<String> = []
    @ObservationIgnored private var listTouched: Set<String> = []
    /// 当前这页 im_list 发出之后收到过实时更新（im_message / im_ack / im_update）或本机刚改过的会话：
    /// 这页里它们的行是网关在更新之前算的，状态字段不能用
    @ObservationIgnored private var liveSinceListRequest: Set<String> = []
    /// 这一轮列表里有行因为上面的原因被跳过：拉完再对一次账
    @ObservationIgnored private var listSkipped = false
    /// 正在跑的是「跳过之后的复查」：复查里再跳过也不再追加，免得消息不断时一直拉
    @ObservationIgnored private var listRechecking = false
    @ObservationIgnored private var sendTimers: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var uploadTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var uploadGenerations: [String: Int] = [:]
    @ObservationIgnored private var uploadGenerationSeed = 0
    @ObservationIgnored private var readTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var stateSaveTask: Task<Void, Never>?
    @ObservationIgnored private var timelineSaveTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var ticketTask: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var lastListSuccessAt = Date.distantPast
    @ObservationIgnored private var lastTicketRequestAt = Date.distantPast
    @ObservationIgnored private var deferredCatchUp: Set<String> = []
    @ObservationIgnored private var lifecycleRefreshTask: Task<Void, Never>?
    @ObservationIgnored private var sentPresence: Bool?
    @ObservationIgnored private var loadEpoch = 0
    @ObservationIgnored private var pinyinCache: [String: ImPinyin] = [:]
    /// 别的设备读过（静默推送）或翻页期间来了新请求：会话列表要再对一次账
    @ObservationIgnored private var listStale = false
    @ObservationIgnored private var readObserver: NSObjectProtocol?
    /// 乐观改了本地、等网关确认的设置：key → 超时任务和撤回动作
    @ObservationIgnored private var pendingConfirms: [String: (task: Task<Void, Never>, rollback: () -> Void)] = [:]
    @ObservationIgnored private var durableReplayTask: Task<Void, Never>?

    init() {}

    var meId: String { me?.id ?? tenant }

    var totalUnread: Int { convs.values.reduce(0) { $0 + $1.unread } }

    /// 正停在这个会话、聊天主页在前面、App 在前台
    func isViewing(_ convId: String) -> Bool {
        homeVisible && appActive && visibleConvId == convId
    }

    private var viewingConvId: String? {
        guard let visibleConvId, isViewing(visibleConvId) else { return nil }
        return visibleConvId
    }

    func convId(with peer: String) -> String {
        ImConv.dm(meId, peer)
    }

    func user(_ id: String) -> ImUser {
        if id == me?.id, let me { return me.user }
        return users[id] ?? ImUser(id: id, nickname: id, avatar: nil)
    }

    // MARK: 生命周期

    func attach(_ transport: ImTransport, uploader: ImBlobUploader?) {
        self.transport = transport
        self.uploader = uploader
        guard readObserver == nil else { return }
        readObserver = NotificationCenter.default.addObserver(forName: Self.readElsewhere, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.noteReadElsewhere() }
        }
    }

    /// 别的设备读过某个会话：本机的未读已经不准了。在线且在前台就马上拉列表，否则等回前台 / 重连时拉
    func noteReadElsewhere() {
        listStale = true
        if online, appActive { refreshList() }
    }

    /// 冷启动：先把上次的缓存画出来，不等网络
    func start() {
        prepare(tenant: transport?.imTenantId ?? "")
    }

    /// 连上（含重连）且网关支持 im：拉联系人、分页拉全会话、按本地最大 seq 补缺
    func connectionReady(features: Set<String>) {
        guard features.contains("im") else {
            online = false
            return
        }
        prepare(tenant: transport?.imTenantId ?? "")
        online = true
        // 网关把 caps 含 im 的连接默认当成前台
        sentPresence = true
        if !appActive { sendPresence(false) }
        send(.imContacts)
        listPaging = false
        refreshList(respectingFreshness: true)
        startTicketWatch()
        replayDurableOutbox()
    }

    /// 断线：取消上传与确认计时；在途消息退回可重放状态，重连后仍沿用同一个 clientId。
    func connectionLost() {
        online = false
        listPaging = false
        resetListGuards()
        loadingOlder = []
        loadingLatest = []
        ticketTask?.cancel()
        ticketTask = nil
        lifecycleRefreshTask?.cancel()
        lifecycleRefreshTask = nil
        durableReplayTask?.cancel()
        durableReplayTask = nil
        cancelAllUploadTasks()
        for task in sendTimers.values { task.cancel() }
        sendTimers = [:]
        // 断线前没等到确认的设置算没成；重连后拉列表会把真实状态带回来
        rollbackPending()
        for (convId, items) in timelines where items.contains(where: { $0.state == .sending }) {
            timelines[convId] = items.map { item in
                var next = item
                if next.state == .sending {
                    next.state = .failed
                    next.progress = nil
                    if let metadata = next.durableOutbox {
                        next.durableOutbox = ImDurableOutboxPolicy.afterConnectionLoss(
                            metadata,
                            now: Self.nowMs
                        )
                    }
                }
                return next
            }
            saveTimelineSoon(convId)
        }
    }

    /// 蜂窝、Low Data 或热点恢复普通 Wi‑Fi：只续跑明确延后的会话，不重拉列表、不扫描全局。
    func backgroundTrafficRestored() {
        guard online, transport?.imNetworkCost.shouldReduceBackgroundTraffic == false else { return }
        let pending = deferredCatchUp
        for convId in pending {
            catchUp(convId: convId)
        }
    }

    /// 换账号：清内存和旧租户的缓存
    func resetTenant() {
        let old = tenant.isEmpty ? (ImShareBridge.load()?.tenant ?? "") : tenant
        ImShareBackgroundQueue.shared.cancel(tenant: old)
        ImShareBridge.clear()
        clearMemory()
        tenant = ""
        if !old.isEmpty { ImCache.clear(tenant: old) }
    }

    /// 退出登录：所有租户的聊天缓存都删掉
    func logout() {
        let old = tenant.isEmpty ? (ImShareBridge.load()?.tenant ?? "") : tenant
        ImShareBackgroundQueue.shared.cancel(tenant: old)
        clearMemory()
        tenant = ""
        ImCache.clearAll()
        ImShareBridge.clear()
    }

    /// App 进出前台
    func setAppActive(_ active: Bool) {
        guard appActive != active else { return }
        appActive = active
        ImViewingBeacon.shared.set(viewingConvId)
        sendPresence(active)
        if active {
            // 在后台时别的设备可能读过、对方可能撤回过：每次回前台都对一次列表
            listStale = true
            refreshList(respectingFreshness: true)
            scheduleRead(visibleConvId)
            refreshTicketsIfNeeded()
        } else {
            lifecycleRefreshTask?.cancel()
            lifecycleRefreshTask = nil
        }
    }

    func setHomeVisible(_ visible: Bool) {
        guard homeVisible != visible else { return }
        homeVisible = visible
        ImViewingBeacon.shared.set(viewingConvId)
    }

    private func prepare(tenant next: String) {
        guard next != tenant else { return }
        clearMemory()
        tenant = next
        guard !next.isEmpty else { return }
        loadEpoch += 1
        let epoch = loadEpoch
        timelinesReady = false
        Task { [weak self] in
            let snapshot = await ImCache.loadState(tenant: next)
            guard let self, self.loadEpoch == epoch, self.tenant == next else { return }
            if let snapshot { self.apply(snapshot) }
            let timelines = await ImCache.loadTimelines(tenant: next)
            guard self.loadEpoch == epoch, self.tenant == next else { return }
            self.applyTimelines(timelines)
            self.timelinesReady = true
            let pending = self.deferredTimelineSaves
            self.deferredTimelineSaves = []
            for convId in pending { self.saveTimelineSoon(convId) }
            if self.listLoaded, self.online { self.catchUp() }
        }
    }

    private func apply(_ snapshot: ImCache.Snapshot) {
        let now = Self.nowMs
        if !contactsLoaded {
            if me == nil { me = snapshot.me }
            for user in snapshot.users where users[user.id] == nil { users[user.id] = user }
        }
        if !listLoaded {
            for row in snapshot.convs where convs[row.convId] == nil {
                convs[row.convId] = row
                if let ticket = row.ticket, ticket.exp > now, tickets[row.convId] == nil { tickets[row.convId] = ticket }
            }
            if blocked.isEmpty { blocked = Set(snapshot.blocked) }
        }
        for (key, text) in snapshot.drafts where drafts[key] == nil { drafts[key] = text }
        for (key, seqs) in snapshot.hidden { hidden[key, default: []].formUnion(seqs) }
        for (key, seqs) in snapshot.heardVoice { heardVoice[key, default: []].formUnion(seqs) }
        for (convId, rows) in snapshot.voiceText {
            for (seq, text) in rows {
                if let number = Int(seq), voiceText[convId]?[number] == nil {
                    voiceText[convId, default: [:]][number] = text
                }
            }
        }
        for convId in Array(hidden.keys) { pruneHidden(convId) }
        // 没发出去的图还要用 outbox 里的文件；其余（删掉的待发消息、旧版本留下的）清掉
        ImCache.sweepOutbox(tenant: tenant, keep: pendingOutboxFiles())
        if online { replayDurableOutbox() }
    }

    /// 磁盘时间线后到：和这段时间已经进内存的消息合并。合并前不能落盘，否则会把还没读到的记录覆盖掉
    private func applyTimelines(_ cached: [String: [ImLocalMessage]]) {
        for (convId, items) in cached {
            let merged = ImTimeline.merge(items, timelines[convId] ?? [], me: meId)
            timelines[convId] = merged.filter { ($0.seq ?? Int.max) > hideBefore(convId) }
        }
    }

    private func clearMemory() {
        loadEpoch += 1
        for task in sendTimers.values { task.cancel() }
        cancelAllUploadTasks()
        for task in readTasks.values { task.cancel() }
        for task in timelineSaveTasks.values { task.cancel() }
        for entry in pendingConfirms.values { entry.task.cancel() }
        pendingConfirms = [:]
        listStale = false
        resetListGuards()
        sendTimers = [:]
        readTasks = [:]
        timelineSaveTasks = [:]
        stateSaveTask?.cancel()
        durableReplayTask?.cancel()
        durableReplayTask = nil
        ticketTask?.cancel()
        ticketTask = nil
        lifecycleRefreshTask?.cancel()
        lifecycleRefreshTask = nil
        listPaging = false
        listSeen = []
        listTouched = []
        sentPresence = nil
        pinyinCache = [:]
        online = false
        me = nil
        users = [:]
        avatarTicket = nil
        convs = [:]
        tickets = [:]
        blocked = []
        timelines = [:]
        collabRuns = [:]
        olderMore = [:]
        loadingOlder = []
        loadingLatest = []
        drafts = [:]
        hidden = [:]
        replyTo = [:]
        heardVoice = [:]
        voiceText = [:]
        listLoaded = false
        contactsLoaded = false
        timelinesReady = false
        deferredTimelineSaves = []
        deferredCatchUp = []
        lastListSuccessAt = .distantPast
        lastTicketRequestAt = .distantPast
        selectedPeer = nil
        visibleConvId = nil
    }

    // MARK: 收

    func handle(_ event: ImEvent) {
        switch event {
        case .contacts(let nextMe, let list, let ticket):
            me = nextMe
            users = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            if let ticket { avatarTicket = ticket }
            contactsLoaded = true
            saveStateSoon()
        case .list(let rows, let blockedIds, let more, let cursor):
            for row in rows {
                upsert(row)
                listSeen.insert(row.convId)
            }
            blocked = Set(blockedIds)
            if more, let cursor {
                // 下一页由网关在这之后算：之前到过的实时更新它都已经包含了
                liveSinceListRequest = []
                send(.imList(cursor: cursor, limit: 100))
                return
            }
            // 列表里没有了的会话（对方不可见、全被拒收）从本机去掉；翻页期间新来的保留
            if listPaging {
                for id in Array(convs.keys) where !listSeen.contains(id) && !listTouched.contains(id) {
                    convs[id] = nil
                }
            }
            listPaging = false
            listSeen = []
            listTouched = []
            listLoaded = true
            lastListSuccessAt = Date()
            catchUp()
            scheduleRead(visibleConvId)
            saveStateSoon()
            // 有行因为实时更新被跳过（只复查一次），或翻页期间又有要对账的事（别的设备读过、回前台）：再拉一遍
            let recheck = listSkipped && !listRechecking
            liveSinceListRequest = []
            listSkipped = false
            listRechecking = recheck
            if recheck {
                refreshList()
            } else if listStale {
                refreshList(respectingFreshness: true)
            }
        case .history(let convId, let messages, let more, let ticket, let before, let after):
            if let ticket { tickets[convId] = ticket }
            let floor = hideBefore(convId)
            let incoming = messages.filter { $0.seq > floor }.map(ImLocalMessage.init)
            timelines[convId] = ImTimeline.merge(timelines[convId] ?? [], incoming, me: meId)
            if let after {
                if more, let last = messages.last?.seq, last > after {
                    send(.imHistory(convId: convId, before: nil, after: last, limit: 50))
                }
            } else {
                olderMore[convId] = more
                if before != nil {
                    loadingOlder.remove(convId)
                } else {
                    loadingLatest.remove(convId)
                }
            }
            if let last = messages.last { bumpLast(convId, last) }
            if messages.contains(where: { $0.kind == "collab" }) { syncCollab(convId: convId) }
            saveTimelineSoon(convId)
            scheduleRead(convId)
        case .ack(let clientId, let convId, let seq, let at, let rejected):
            sendTimers.removeValue(forKey: clientId)?.cancel()
            cancelUploadTask(clientId: clientId)
            var items = timelines[convId] ?? []
            guard let index = items.firstIndex(where: { $0.clientId == clientId && $0.from == meId }) else { return }
            var item = items.remove(at: index)
            item.seq = seq
            item.at = at
            item.rejected = rejected
            item.state = .sent
            item.progress = nil
            item.durableOutbox = nil
            timelines[convId] = ImTimeline.merge(items, [item], me: meId)
            var conv = ensureConv(convId)
            if seq >= (conv.last?.seq ?? 0), let message = item.message { conv.last = message }
            conv.maxSeq = max(conv.maxSeq, seq)
            convs[convId] = conv
            saveTimelineSoon(convId)
            saveStateSoon()
        case .message(let message, let ticket, let unread):
            let convId = message.convId
            if let ticket { tickets[convId] = ticket }
            guard message.seq > hideBefore(convId) else { return }
            timelines[convId] = ImTimeline.merge(timelines[convId] ?? [], [ImLocalMessage(message)], me: meId)
            var conv = ensureConv(convId)
            if message.seq >= (conv.last?.seq ?? 0) { conv.last = message }
            conv.maxSeq = max(conv.maxSeq, message.seq)
            // 未读只认网关给的权威值（seq 里有自己发的、拒收的、撤回的，本地推算会错）。
            // 正停在这个会话时下面的 scheduleRead 马上就会读掉，先按 0 显示免得角标闪一下
            if let unread { conv.unread = isViewing(convId) ? 0 : unread }
            convs[convId] = conv
            saveTimelineSoon(convId)
            saveStateSoon()
            scheduleRead(convId)
            if message.kind == "collab" { syncCollab(convId: convId) }
        case .update(let update):
            apply(update)
        case .error(let clientId, let code, let text):
            if let clientId {
                sendTimers.removeValue(forKey: clientId)?.cancel()
                cancelUploadTask(clientId: clientId)
                if code == "rate_limited" {
                    rateLimitDurableOutbox(clientId: clientId)
                } else {
                    failDurableOutbox(
                        clientId: clientId,
                        permanent: ImDurableOutboxPolicy.isPermanent(errorCode: code)
                    )
                }
            } else {
                // 不带 clientId 的错误认不出是哪个请求：在途的翻页都放开，允许再拉；没确认的设置撤回
                loadingOlder = []
                loadingLatest = []
                // 列表在途也同样放开并标脏（照 connectionLost 的做法）：否则 refreshList 会被
                // listPaging 挡住，这个会话里列表再也拉不动、listLoaded 永远上不来
                listPaging = false
                resetListGuards()
                listStale = true
                rollbackPending()
            }
            if code == "no_cap" { online = false }
            showToast(text.nilIfEmpty ?? Self.errorText(code))
        case .collabState(let page):
            var byId = Dictionary(
                uniqueKeysWithValues: (collabRuns[page.convId] ?? []).map { ($0.runId, $0) }
            )
            for id in page.removedRunIds { byId[id] = nil }
            for run in page.runs where run.version >= (byId[run.runId]?.version ?? -1) {
                byId[run.runId] = run
            }
            collabRuns[page.convId] = byId.values.sorted {
                ($0.createdAt ?? 0, $0.runId) > ($1.createdAt ?? 0, $1.runId)
            }
            if page.more, let cursor = page.cursor {
                syncCollab(convId: page.convId, cursor: cursor)
            }
        }
    }

    func syncCollab(convId: String, cursor: String? = nil) {
        guard online, !convId.isEmpty else { return }
        let known = (collabRuns[convId] ?? []).map { (runId: $0.runId, version: $0.version) }
        send(.collabSync(convId: convId, known: known, cursor: cursor))
    }

    private func apply(_ update: ImUpdate) {
        switch update.what {
        case "recall":
            guard let convId = update.convId, let seq = update.seq else { return }
            noteLive(convId)
            if var items = timelines[convId], let index = items.firstIndex(where: { $0.seq == seq }) {
                items[index].recalled = true
                items[index].body = nil
                timelines[convId] = items
                saveTimelineSoon(convId)
            }
            if var conv = convs[convId] {
                if conv.last?.seq == seq {
                    conv.last?.recalled = true
                    conv.last?.body = nil
                }
                // 撤回的那条不再算未读
                if let unread = update.unread { conv.unread = unread }
                convs[convId] = conv
            }
        case "read":
            guard let convId = update.convId, let seq = update.seq, var conv = convs[convId] else { return }
            noteLive(convId)
            conv.readSeq = max(conv.readSeq, seq)
            if let unread = update.unread {
                conv.unread = unread
            } else if conv.readSeq >= conv.maxSeq {
                conv.unread = 0
            }
            convs[convId] = conv
            if conv.unread == 0 { ImNotifications.clear(convId: convId) }
        case "settings":
            guard let convId = update.convId else { return }
            for key in ["pin", "mute", "hide"] { confirm("\(key):\(convId)") }
            var conv = ensureConv(convId)
            if let pin = update.pin { conv.pin = pin }
            if let mute = update.mute { conv.mute = mute }
            if let hideBefore = update.hideBefore { conv.hideBefore = max(conv.hideBefore, hideBefore) }
            if let unread = update.unread { conv.unread = unread }
            convs[convId] = conv
            applyHideBefore(convId)
        case "prefs":
            confirm("preview")
            confirm("nickname")
            if let next = update.me { me = next }
        case "profile":
            guard let user = update.user else { break }
            if user.id == me?.id {
                me?.nickname = user.nickname
                me?.avatar = user.avatar
            } else {
                users[user.id] = user
            }
            if let ticket = update.avatarTicket { avatarTicket = ticket }
        case "block":
            for key in Array(pendingConfirms.keys) where key.hasPrefix("block:") { confirm(key) }
            blocked = Set(update.blocked ?? [])
        default:
            break
        }
        saveStateSoon()
    }

    private func upsert(_ row: ImConvRow) {
        var next = row
        if let old = convs[row.convId] {
            if liveSinceListRequest.contains(row.convId) {
                // 这页发出后该会话收到过实时更新（撤回、置顶、免打扰不改 maxSeq，所以不能拿 maxSeq 比新旧）：
                // 行里的最后一条、未读、已读线、置顶、免打扰都可能比本地旧，整段保留本地，拉完再对一次账
                next = old
                listSkipped = true
            }
            next.hideBefore = max(old.hideBefore, row.hideBefore)
        }
        convs[row.convId] = next
        if let ticket = row.ticket { tickets[row.convId] = ticket }
        applyHideBefore(row.convId)
    }

    /// 实时更新或本机改动落到了这个会话：在途的列表页不能再覆盖它
    private func noteLive(_ convId: String) {
        if listPaging { liveSinceListRequest.insert(convId) }
    }

    private func resetListGuards() {
        liveSinceListRequest = []
        listSkipped = false
        listRechecking = false
    }

    @discardableResult
    private func ensureConv(_ convId: String) -> ImConvRow {
        listTouched.insert(convId)
        noteLive(convId)
        if let conv = convs[convId] { return conv }
        let row = ImConvRow(
            convId: convId,
            kind: convId.hasPrefix("grp~") ? "group" : "dm",
            peer: ImConv.peer(of: convId, me: meId) ?? "",
            title: nil,
            memberCount: 0,
            activityAt: 0,
            last: nil,
            unread: 0,
            readSeq: 0,
            maxSeq: 0,
            pin: false,
            mute: false,
            hideBefore: 0,
            ticket: tickets[convId]
        )
        convs[convId] = row
        return row
    }

    private func bumpLast(_ convId: String, _ message: ImMessage) {
        guard var conv = convs[convId] else { return }
        if message.seq >= (conv.last?.seq ?? 0) { conv.last = message }
        conv.maxSeq = max(conv.maxSeq, message.seq)
        convs[convId] = conv
    }

    func hideBefore(_ convId: String) -> Int {
        convs[convId]?.hideBefore ?? 0
    }

    /// 清空聊天记录之后：之前的消息从本机去掉，已读线推到它，最后一条也跟着清
    private func applyHideBefore(_ convId: String) {
        guard var conv = convs[convId], conv.hideBefore > 0 else { return }
        let floor = conv.hideBefore
        if let items = timelines[convId], items.contains(where: { ($0.seq ?? Int.max) <= floor }) {
            timelines[convId] = items.filter { ($0.seq ?? Int.max) > floor }
            saveTimelineSoon(convId)
        }
        if let last = conv.last, last.seq <= floor { conv.last = nil }
        conv.readSeq = max(conv.readSeq, floor)
        // 未读以网关下发的为准（settings 带 unread）；这里只处理确定为 0 的情况
        if conv.readSeq >= conv.maxSeq { conv.unread = 0 }
        convs[convId] = conv
        pruneHidden(convId)
    }

    /// 本机删掉的 seq：清空线以下的不用再记；每个会话只留最新的 hiddenLimit 条
    private func pruneHidden(_ convId: String) {
        guard var gone = hidden[convId] else { return }
        let floor = hideBefore(convId)
        if floor > 0 { gone = gone.filter { $0 > floor } }
        if gone.count > Self.hiddenLimit {
            gone = Set(gone.sorted(by: >).prefix(Self.hiddenLimit))
        }
        hidden[convId] = gone.isEmpty ? nil : gone
    }

    /// 还没发出去的附件在 outbox 里的文件名
    private func pendingOutboxFiles() -> Set<String> {
        var names = Set<String>()
        for items in timelines.values {
            for item in items where item.seq == nil {
                guard let outgoing = item.outgoing else { continue }
                names.insert(outgoing.file)
                names.insert(outgoing.thumbFile)
            }
            for item in items where item.seq == nil {
                if let upload = item.upload { names.insert(upload.file) }
            }
        }
        return names
    }

    /// 列表拉全后：有缓存的会话按本地最大 seq 往后补；落后太多就丢掉本地，打开时重拉最新一页。
    /// 时间线还在读磁盘时不能跑：local seq 会是 0，接着把还没读进来的记录从磁盘删掉
    private func catchUp() {
        guard timelinesReady else { return }
        for (convId, items) in timelines {
            guard let conv = convs[convId] else { continue }
            let local = ImTimeline.maxSeq(items)
            guard conv.maxSeq > local else { continue }
            if transport?.imNetworkCost.shouldReduceBackgroundTraffic == true, convId != visibleConvId {
                deferredCatchUp.insert(convId)
                continue
            }
            catchUp(convId: convId, items: items, conv: conv, local: local)
        }
        if let open = visibleConvId, timelines[open]?.contains(where: { $0.seq != nil }) != true {
            requestLatest(open)
        }
    }

    /// 受限路径下进入会话时再补该会话；未读、撤回和已读权威值仍由列表/实时事件照常对账。
    private func catchUp(convId: String) {
        guard timelinesReady, let conv = convs[convId] else { return }
        let items = timelines[convId] ?? []
        let local = ImTimeline.maxSeq(items)
        guard conv.maxSeq > local else {
            deferredCatchUp.remove(convId)
            return
        }
        deferredCatchUp.remove(convId)
        catchUp(convId: convId, items: items, conv: conv, local: local)
    }

    private func catchUp(convId: String, items: [ImLocalMessage], conv: ImConvRow, local: Int) {
        if local == 0 || conv.maxSeq - local > ImTimeline.cacheLimit {
            timelines[convId] = items.filter { $0.seq == nil }
            olderMore[convId] = nil
            saveTimelineSoon(convId)
            if convId == visibleConvId { requestLatest(convId) }
        } else {
            send(.imHistory(convId: convId, before: nil, after: local, limit: 50))
        }
    }

    // MARK: 拉

    func refreshList(respectingFreshness: Bool = false) {
        guard online, !listPaging else { return }
        if respectingFreshness,
           !RefreshFreshnessPolicy.shouldRefresh(
               lastSuccess: lastListSuccessAt,
               now: Date(),
               window: RefreshFreshnessPolicy.imLifecycleWindow
           ) {
            listStale = true
            scheduleLifecycleRefresh()
            return
        }
        lifecycleRefreshTask?.cancel()
        lifecycleRefreshTask = nil
        listStale = false
        listPaging = true
        listSeen = []
        listTouched = []
        liveSinceListRequest = []
        send(.imList(cursor: nil, limit: 100))
    }

    private func scheduleLifecycleRefresh() {
        guard lifecycleRefreshTask == nil else { return }
        let elapsed = Date().timeIntervalSince(lastListSuccessAt)
        let wait = max(RefreshFreshnessPolicy.imLifecycleWindow - elapsed, 0)
        lifecycleRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self, !Task.isCancelled else { return }
            self.lifecycleRefreshTask = nil
            guard self.appActive else { return }
            self.refreshList(respectingFreshness: true)
        }
    }

    /// 聊天页出现：没有任何消息就拉最新一页
    func open(convId: String) {
        visibleConvId = convId
        catchUp(convId: convId)
        if timelines[convId]?.contains(where: { $0.seq != nil }) != true, convs[convId] != nil {
            requestLatest(convId)
        } else if convs[convId] == nil {
            // 没聊过：没什么可拉的
            olderMore[convId] = false
        }
    }

    func close(convId: String) {
        if visibleConvId == convId { visibleConvId = nil }
    }

    func requestLatest(_ convId: String) {
        guard online, !loadingLatest.contains(convId) else { return }
        loadingLatest.insert(convId)
        send(.imHistory(convId: convId, before: nil, after: nil, limit: 30))
    }

    /// 上滑到顶：拉更早的一页
    func loadOlder(_ convId: String) {
        guard online, olderMore[convId] != false, !loadingOlder.contains(convId), !loadingLatest.contains(convId) else { return }
        guard let first = ImTimeline.minSeq(timelines[convId] ?? []) else {
            if convs[convId] != nil { requestLatest(convId) }
            return
        }
        guard first > hideBefore(convId) + 1 else {
            olderMore[convId] = false
            return
        }
        loadingOlder.insert(convId)
        send(.imHistory(convId: convId, before: first, after: nil, limit: 30))
    }

    /// 本机能显示的消息（去掉只在本机删掉的）
    func visibleMessages(_ convId: String) -> [ImLocalMessage] {
        let items = timelines[convId] ?? []
        guard let gone = hidden[convId], !gone.isEmpty else { return items }
        return items.filter { item in
            guard let seq = item.seq else { return true }
            return !gone.contains(seq)
        }
    }

    // MARK: 已读

    /// 聊天页可见且在前台：对最新 seq 发 im_read（节流，一会儿内只发一次）
    func scheduleRead(_ convId: String?) {
        guard let convId, isViewing(convId), let conv = convs[convId] else { return }
        guard conv.maxSeq > conv.readSeq || conv.unread > 0 else {
            ImNotifications.clear(convId: convId)
            return
        }
        guard readTasks[convId] == nil else { return }
        readTasks[convId] = Task { [weak self] in
            try? await Task.sleep(for: ImStore.readDelay)
            guard let self, !Task.isCancelled else { return }
            self.readTasks[convId] = nil
            self.commitRead(convId)
        }
    }

    private func commitRead(_ convId: String) {
        guard isViewing(convId), online, var conv = convs[convId], conv.maxSeq > 0 else { return }
        send(.imRead(convId: convId, seq: conv.maxSeq))
        noteLive(convId)
        conv.readSeq = max(conv.readSeq, conv.maxSeq)
        conv.unread = 0
        convs[convId] = conv
        ImNotifications.clear(convId: convId)
        saveStateSoon()
    }

    // MARK: 发

    /// 文字。断线时直接记失败（像微信的红感叹号，等用户点了再发）
    @discardableResult
    func sendText(_ text: String, to peer: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard trimmed.utf8.count <= 8192 else {
            showToast("这条太长了，拆成几条再发")
            return false
        }
        let convId = convId(with: peer)
        let item = ImLocalMessage(
            pending: ImFormat.newClientId(),
            convId: convId,
            from: meId,
            at: Self.nowMs,
            kind: "text",
            body: .text(trimmed),
            replyTo: replyTo.removeValue(forKey: convId),
            outgoing: nil
        )
        append(item)
        transmit(clientId: item.clientId, convId: convId, peer: peer)
        return true
    }

    /// 图片已经压好放在 outbox：每张先传缩略图和原图两个 blob，再发 im_send
    func sendImages(_ images: [ImOutgoingImage], to peer: String) {
        let convId = convId(with: peer)
        var reply = replyTo.removeValue(forKey: convId)
        for image in images {
            let item = ImLocalMessage(
                pending: ImFormat.newClientId(),
                convId: convId,
                from: meId,
                at: Self.nowMs,
                kind: "image",
                body: nil,
                replyTo: reply,
                outgoing: image
            )
            reply = nil
            append(item)
            uploadAndSend(clientId: item.clientId, convId: convId, peer: peer)
        }
    }

    /// 录好的 m4a 已放进 outbox。
    func sendVoice(file: String, durationMs: Int, waveform: [Double], to peer: String) {
        let upload = ImOutgoingUpload(
            file: file, uploadKind: "voice", mime: "audio/mp4", name: nil,
            size: nil, durationMs: min(max(durationMs, 1), 60_000), waveform: Array(waveform.prefix(100)),
            linkURL: nil, linkTitle: nil, linkDesc: nil, blob: nil
        )
        appendUpload(kind: "voice", upload: upload, to: peer)
    }

    /// 文件选择器给的文件已拷进 outbox。
    func sendFile(file: String, name: String, size: Double, mime: String, to peer: String) {
        let upload = ImOutgoingUpload(
            file: file, uploadKind: "file", mime: mime, name: name, size: size, durationMs: nil, waveform: nil,
            linkURL: nil, linkTitle: nil, linkDesc: nil, blob: nil
        )
        appendUpload(kind: "file", upload: upload, to: peer)
    }

    func sendLink(url: URL, title: String?, desc: String?, iconFile: String? = nil, to peer: String) {
        if let iconFile {
            let upload = ImOutgoingUpload(
                file: iconFile, uploadKind: "icon", mime: "image/png", name: nil, size: nil, durationMs: nil, waveform: nil,
                linkURL: url.absoluteString, linkTitle: title, linkDesc: desc, blob: nil
            )
            appendUpload(
                kind: "link", upload: upload,
                body: .link(url: url.absoluteString, title: title, desc: desc, icon: nil),
                to: peer
            )
        } else {
            appendBody(kind: "link", body: .link(url: url.absoluteString, title: title, desc: desc, icon: nil), to: peer)
        }
    }

    func sendLocation(lat: Double, lng: Double, name: String, address: String, to peer: String) {
        appendBody(kind: "location", body: .location(lat: lat, lng: lng, name: name, address: address), to: peer)
    }

    private func appendBody(kind: String, body: ImBody, to peer: String) {
        let convId = convId(with: peer)
        let item = ImLocalMessage(
            pending: ImFormat.newClientId(), convId: convId, from: meId, at: Self.nowMs,
            kind: kind, body: body, replyTo: replyTo.removeValue(forKey: convId), outgoing: nil
        )
        append(item)
        transmit(clientId: item.clientId, convId: convId, peer: peer)
    }

    private func appendUpload(kind: String, upload: ImOutgoingUpload, body: ImBody? = nil, to peer: String) {
        let convId = convId(with: peer)
        var item = ImLocalMessage(
            pending: ImFormat.newClientId(), convId: convId, from: meId, at: Self.nowMs,
            kind: kind, body: body, replyTo: replyTo.removeValue(forKey: convId), outgoing: nil
        )
        item.upload = upload
        append(item)
        uploadAndSendAttachment(clientId: item.clientId, convId: convId, peer: peer)
    }

    /// 失败的手动重发：同一个 clientId（网关去重，不会发成两条）
    func resend(_ item: ImLocalMessage) {
        guard item.seq == nil, item.state == .failed else { return }
        let peer = ImConv.peer(of: item.convId, me: meId) ?? ""
        guard !peer.isEmpty else { return }
        cancelUploadTask(clientId: item.clientId)
        mutatePending(item.clientId, item.convId) {
            $0.durableOutbox = ImDurableOutboxMetadata(stableID: item.clientId, now: Self.nowMs)
        }
        if item.kind == "image", let outgoing = item.outgoing, outgoing.blob == nil || outgoing.thumb == nil {
            uploadAndSend(clientId: item.clientId, convId: item.convId, peer: peer)
            return
        }
        if let upload = item.upload, upload.blob == nil {
            uploadAndSendAttachment(clientId: item.clientId, convId: item.convId, peer: peer)
            return
        }
        transmit(clientId: item.clientId, convId: item.convId, peer: peer)
    }

    private func append(_ item: ImLocalMessage) {
        timelines[item.convId] = ImTimeline.merge(timelines[item.convId] ?? [], [item], me: meId)
        saveTimelineSoon(item.convId)
    }

    private func transmit(clientId: String, convId: String, peer: String, countAttempt: Bool = true) {
        guard let item = find(clientId, convId) else { return }
        var body = item.body
        if item.kind == "image", let outgoing = item.outgoing, let blob = outgoing.blob, let thumb = outgoing.thumb {
            body = .image(blob: blob, thumb: thumb, w: outgoing.w, h: outgoing.h, original: outgoing.original)
        }
        if let upload = item.upload, let blob = upload.blob {
            if item.kind == "voice" {
                body = .voice(blob: blob, durationMs: upload.durationMs ?? 1, waveform: upload.waveform ?? [])
            } else if item.kind == "file" {
                body = .file(blob: blob, name: upload.name ?? "文件", size: upload.size ?? 0, mime: upload.mime)
            } else if item.kind == "link", let url = upload.linkURL {
                body = .link(url: url, title: upload.linkTitle, desc: upload.linkDesc, icon: blob)
            }
        }
        // 上传完成后回写权威本地 body；链接最初已有无 icon 的 body，也必须替换才能立即显示图标。
        if let body, item.body != body {
            mutatePending(clientId, convId) { $0.body = body }
            saveTimelineSoon(convId)
        }
        guard let body else {
            failDurableOutbox(clientId: clientId, permanent: true)
            return
        }
        guard online, let transport, transport.imLinkOpen else {
            setState(clientId, convId, .failed)
            scheduleDurableReplay()
            return
        }
        if countAttempt { beginDurableAttempt(clientId: clientId, convId: convId) }
        setState(clientId, convId, .sending)
        transport.imSend(.imSend(clientId: clientId, to: peer, convId: nil, kind: item.kind, body: body, replyTo: item.replyTo))
        armSendTimeout(clientId, convId)
    }

    private func uploadAndSend(clientId: String, convId: String, peer: String) {
        guard let item = find(clientId, convId), let start = item.outgoing else { return }
        guard online, let uploader, let token = transport?.imToken.nilIfEmpty, let dir = ImCache.outboxDir(tenant: tenant) else {
            setState(clientId, convId, .failed)
            scheduleDurableReplay()
            return
        }
        beginDurableAttempt(clientId: clientId, convId: convId)
        setState(clientId, convId, .sending)
        setProgress(clientId, convId, 0)
        let tenantAtStart = tenant
        let generation = beginUploadTask(clientId: clientId)
        let box = ImWeakStore(self)
        let report: @Sendable (Double) -> Void = { fraction in
            Task { @MainActor in
                guard let store = box.value,
                      store.uploadIsCurrent(clientId: clientId, generation: generation, tenant: tenantAtStart)
                else { return }
                store.setProgress(clientId, convId, fraction)
            }
        }
        uploadTasks[clientId] = Task { [weak self] in
            var outgoing = start
            do {
                if outgoing.thumb == nil {
                    outgoing.thumb = try await uploader.upload(
                        file: dir.appendingPathComponent(outgoing.thumbFile), kind: "thumb", mime: "image/jpeg", token: token, progress: { _ in }
                    )
                }
                if outgoing.blob == nil {
                    outgoing.blob = try await uploader.upload(
                        file: dir.appendingPathComponent(outgoing.file), kind: "image", mime: outgoing.mime, token: token, progress: report
                    )
                }
            } catch {
                guard let self,
                      !Task.isCancelled,
                      self.uploadIsCurrent(clientId: clientId, generation: generation, tenant: tenantAtStart)
                else { return }
                self.setOutgoing(clientId, convId, outgoing)
                self.finishUploadTask(clientId: clientId, generation: generation)
                self.failDurableOutbox(clientId: clientId, permanent: false)
                self.showToast((error as? LocalizedError)?.errorDescription ?? "图片没传上去，点红色感叹号重发")
                return
            }
            guard let self,
                  !Task.isCancelled,
                  self.uploadIsCurrent(clientId: clientId, generation: generation, tenant: tenantAtStart)
            else { return }
            self.setOutgoing(clientId, convId, outgoing)
            if let blob = outgoing.blob { ImCache.adopt(tenant: tenantAtStart, file: dir.appendingPathComponent(outgoing.file), blob: blob) }
            if let thumb = outgoing.thumb { ImCache.adopt(tenant: tenantAtStart, file: dir.appendingPathComponent(outgoing.thumbFile), blob: thumb) }
            self.finishUploadTask(clientId: clientId, generation: generation)
            self.transmit(clientId: clientId, convId: convId, peer: peer, countAttempt: false)
        }
    }

    private func uploadAndSendAttachment(clientId: String, convId: String, peer: String) {
        guard let item = find(clientId, convId), let start = item.upload else { return }
        guard online, let uploader, let token = transport?.imToken.nilIfEmpty, let dir = ImCache.outboxDir(tenant: tenant) else {
            setState(clientId, convId, .failed)
            scheduleDurableReplay()
            return
        }
        beginDurableAttempt(clientId: clientId, convId: convId)
        setState(clientId, convId, .sending)
        setProgress(clientId, convId, 0)
        let tenantAtStart = tenant
        let generation = beginUploadTask(clientId: clientId)
        let box = ImWeakStore(self)
        uploadTasks[clientId] = Task { [weak self] in
            var upload = start
            do {
                if upload.blob == nil {
                    upload.blob = try await uploader.upload(
                        file: dir.appendingPathComponent(upload.file), kind: upload.uploadKind, mime: upload.mime, token: token,
                        progress: { value in
                            Task { @MainActor in
                                guard let store = box.value,
                                      store.uploadIsCurrent(
                                          clientId: clientId,
                                          generation: generation,
                                          tenant: tenantAtStart
                                      )
                                else { return }
                                store.setProgress(clientId, convId, value)
                            }
                        }
                    )
                }
            } catch {
                guard let self,
                      !Task.isCancelled,
                      self.uploadIsCurrent(clientId: clientId, generation: generation, tenant: tenantAtStart)
                else { return }
                self.setUpload(clientId, convId, upload)
                self.finishUploadTask(clientId: clientId, generation: generation)
                self.failDurableOutbox(clientId: clientId, permanent: false)
                self.showToast((error as? LocalizedError)?.errorDescription ?? "附件没传上去，点红色感叹号重发")
                return
            }
            guard let self,
                  !Task.isCancelled,
                  self.uploadIsCurrent(clientId: clientId, generation: generation, tenant: tenantAtStart)
            else { return }
            self.setUpload(clientId, convId, upload)
            if let blob = upload.blob { ImCache.adopt(tenant: tenantAtStart, file: dir.appendingPathComponent(upload.file), blob: blob) }
            self.finishUploadTask(clientId: clientId, generation: generation)
            self.transmit(clientId: clientId, convId: convId, peer: peer, countAttempt: false)
        }
    }

    private func armSendTimeout(_ clientId: String, _ convId: String) {
        sendTimers[clientId]?.cancel()
        sendTimers[clientId] = Task { [weak self] in
            try? await Task.sleep(for: ImStore.sendTimeout)
            guard let self, !Task.isCancelled else { return }
            self.sendTimers[clientId] = nil
            if self.find(clientId, convId)?.state == .sending {
                self.failDurableOutbox(clientId: clientId, permanent: false)
            }
        }
    }

    private func find(_ clientId: String, _ convId: String) -> ImLocalMessage? {
        timelines[convId]?.first { $0.seq == nil && $0.clientId == clientId }
    }

    private func mutatePending(_ clientId: String, _ convId: String, _ change: (inout ImLocalMessage) -> Void) {
        guard var items = timelines[convId], let index = items.firstIndex(where: { $0.seq == nil && $0.clientId == clientId }) else { return }
        change(&items[index])
        timelines[convId] = items
    }

    private func setState(_ clientId: String, _ convId: String, _ state: ImSendState) {
        mutatePending(clientId, convId) { item in
            item.state = state
            if state != .sending { item.progress = nil }
        }
        if state != .sending { saveTimelineSoon(convId) }
    }

    private func beginDurableAttempt(clientId: String, convId: String) {
        mutatePending(clientId, convId) { item in
            let metadata = item.durableOutbox
                ?? ImDurableOutboxMetadata(stableID: clientId, now: Self.nowMs)
            item.durableOutbox = ImDurableOutboxPolicy.beginAttempt(metadata, now: Self.nowMs)
        }
        saveTimelineSoon(convId)
    }

    private func failDurableOutbox(clientId: String, permanent: Bool) {
        for (convId, items) in timelines
        where items.contains(where: { $0.seq == nil && $0.clientId == clientId }) {
            mutatePending(clientId, convId) { item in
                var metadata = item.durableOutbox
                    ?? ImDurableOutboxMetadata(stableID: clientId, now: Self.nowMs)
                if permanent {
                    metadata.status = .permanentFailure
                    metadata.nextAttemptAt = 0
                } else {
                    metadata = ImDurableOutboxPolicy.afterTransientFailure(
                        metadata,
                        now: Self.nowMs
                    )
                }
                item.durableOutbox = metadata
                item.state = .failed
                item.progress = nil
            }
            saveTimelineSoon(convId)
        }
        scheduleDurableReplay()
    }

    private func rateLimitDurableOutbox(clientId: String) {
        for (convId, items) in timelines
        where items.contains(where: { $0.seq == nil && $0.clientId == clientId }) {
            mutatePending(clientId, convId) { item in
                let metadata = item.durableOutbox
                    ?? ImDurableOutboxMetadata(stableID: clientId, now: Self.nowMs)
                item.durableOutbox = ImDurableOutboxPolicy.afterRateLimited(
                    metadata,
                    now: Self.nowMs
                )
                item.state = .failed
                item.progress = nil
            }
            saveTimelineSoon(convId)
        }
        scheduleDurableReplay()
    }

    /// 每次最多发固定数量；后续按最早退避时间再唤醒，避免重连瞬间打满网关。
    private func replayDurableOutbox() {
        guard online, transport?.imLinkOpen == true else { return }
        durableReplayTask?.cancel()
        durableReplayTask = nil
        let now = Self.nowMs
        let candidates = timelines
            .flatMap { convId, items in items.map { (convId, $0) } }
            .filter { _, item in
                guard item.seq == nil, let metadata = item.durableOutbox else { return false }
                return ImDurableOutboxPolicy.mayReplay(metadata, now: now)
            }
            .sorted { $0.1.at < $1.1.at }
            .prefix(ImDurableOutboxPolicy.replayBatchLimit)

        for (convId, item) in candidates {
            guard let peer = ImConv.peer(of: convId, me: meId), !peer.isEmpty else {
                failDurableOutbox(clientId: item.clientId, permanent: true)
                continue
            }
            if item.kind == "image", let outgoing = item.outgoing,
               outgoing.blob == nil || outgoing.thumb == nil {
                uploadAndSend(clientId: item.clientId, convId: convId, peer: peer)
            } else if let upload = item.upload, upload.blob == nil {
                uploadAndSendAttachment(clientId: item.clientId, convId: convId, peer: peer)
            } else {
                transmit(clientId: item.clientId, convId: convId, peer: peer)
            }
        }
        scheduleDurableReplay()
    }

    private func scheduleDurableReplay() {
        guard online, transport?.imLinkOpen == true else { return }
        let now = Self.nowMs
        let wait = timelines.values
            .flatMap { $0 }
            .compactMap { item -> Int64? in
                guard item.seq == nil, let metadata = item.durableOutbox else { return nil }
                return ImDurableOutboxPolicy.scheduledDelay(metadata, now: now)
            }
            .min()
        guard let wait else { return }
        durableReplayTask?.cancel()
        let tenantAtSchedule = tenant
        durableReplayTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(wait))
            guard let self, !Task.isCancelled, self.tenant == tenantAtSchedule else { return }
            self.replayDurableOutbox()
        }
    }

    private func beginUploadTask(clientId: String) -> Int {
        cancelUploadTask(clientId: clientId)
        uploadGenerationSeed &+= 1
        uploadGenerations[clientId] = uploadGenerationSeed
        return uploadGenerationSeed
    }

    private func uploadIsCurrent(clientId: String, generation: Int, tenant: String) -> Bool {
        ImUploadLeasePolicy.acceptsCompletion(
            expectedGeneration: generation,
            expectedTenant: tenant,
            currentGeneration: uploadGenerations[clientId],
            currentTenant: self.tenant
        )
    }

    private func finishUploadTask(clientId: String, generation: Int) {
        guard uploadGenerations[clientId] == generation else { return }
        uploadTasks[clientId] = nil
        uploadGenerations[clientId] = nil
    }

    private func cancelUploadTask(clientId: String) {
        uploadTasks.removeValue(forKey: clientId)?.cancel()
        uploadGenerations[clientId] = nil
    }

    private func cancelAllUploadTasks() {
        for task in uploadTasks.values { task.cancel() }
        uploadTasks = [:]
        uploadGenerations = [:]
    }

    func setProgress(_ clientId: String, _ convId: String, _ fraction: Double) {
        mutatePending(clientId, convId) { item in
            guard item.state == .sending else { return }
            item.progress = min(max(fraction, 0), 1)
        }
    }

    private func setOutgoing(_ clientId: String, _ convId: String, _ outgoing: ImOutgoingImage) {
        mutatePending(clientId, convId) { $0.outgoing = outgoing }
        saveTimelineSoon(convId)
    }

    private func setUpload(_ clientId: String, _ convId: String, _ upload: ImOutgoingUpload) {
        mutatePending(clientId, convId) { $0.upload = upload }
        saveTimelineSoon(convId)
    }

    // MARK: 操作

    /// 撤回：只能撤回自己发的、2 分钟内的
    func canRecall(_ item: ImLocalMessage) -> Bool {
        guard item.seq != nil, item.from == meId, !item.recalled else { return false }
        return Self.nowMs - item.at < 120_000
    }

    func recall(_ item: ImLocalMessage) {
        guard let seq = item.seq, canRecall(item) else { return }
        send(.imRecall(convId: item.convId, seq: seq))
    }

    /// 删除：只在本机隐藏（没发出去的直接扔掉，连 outbox 里的图一起）
    func deleteLocally(_ item: ImLocalMessage) {
        if let seq = item.seq {
            hidden[item.convId, default: []].insert(seq)
            pruneHidden(item.convId)
            saveStateSoon()
        } else {
            sendTimers.removeValue(forKey: item.clientId)?.cancel()
            timelines[item.convId]?.removeAll { $0.seq == nil && $0.clientId == item.clientId }
            if let outgoing = item.outgoing {
                ImCache.removeOutbox(tenant: tenant, files: [outgoing.file, outgoing.thumbFile])
            }
            if let upload = item.upload {
                ImCache.removeOutbox(tenant: tenant, files: [upload.file])
            }
            saveTimelineSoon(item.convId)
        }
    }

    /// 设置类操作要网关在线：断线时不改本地也不发（发了会被静默丢掉），直接提示
    var canChangeSettings: Bool {
        online && transport?.imLinkOpen == true
    }

    private func requireOnline() -> Bool {
        guard canChangeSettings else {
            showToast("未连接，连上服务器后再试")
            return false
        }
        return true
    }

    /// 清空聊天记录 = hideBefore 推到可见的最大 seq（只对自己生效）。会删掉本机消息，等网关确认后再清
    func clearHistory(_ convId: String) {
        let top = max(convs[convId]?.maxSeq ?? 0, ImTimeline.maxSeq(timelines[convId] ?? []))
        guard top > 0, requireOnline() else { return }
        expectConfirm("hide:\(convId)") {}
        send(.imSettings(convId: convId, pin: nil, mute: nil, hideBefore: top))
    }

    /// 置顶：先改本地（列表马上重排），网关不确认就撤回
    func setPin(_ convId: String, _ on: Bool) {
        guard requireOnline() else { return }
        var conv = ensureConv(convId)
        let old = conv.pin
        conv.pin = on
        convs[convId] = conv
        expectConfirm("pin:\(convId)") { [weak self] in self?.convs[convId]?.pin = old }
        send(.imSettings(convId: convId, pin: on, mute: nil, hideBefore: nil))
        saveStateSoon()
    }

    func setMute(_ convId: String, _ on: Bool) {
        guard requireOnline() else { return }
        var conv = ensureConv(convId)
        let old = conv.mute
        conv.mute = on
        convs[convId] = conv
        expectConfirm("mute:\(convId)") { [weak self] in self?.convs[convId]?.mute = old }
        send(.imSettings(convId: convId, pin: nil, mute: on, hideBefore: nil))
        saveStateSoon()
    }

    func setBlocked(_ peer: String, _ on: Bool) {
        guard requireOnline() else { return }
        let old = blocked.contains(peer)
        if on { blocked.insert(peer) } else { blocked.remove(peer) }
        expectConfirm("block:\(peer)") { [weak self] in
            if old { self?.blocked.insert(peer) } else { self?.blocked.remove(peer) }
        }
        send(.imBlock(tenantId: peer, on: on))
        saveStateSoon()
    }

    /// 昵称以网关回的 prefs 为准：不先改本地
    func setNickname(_ nickname: String) {
        let trimmed = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 32 else {
            showToast("昵称要 1 到 32 个字")
            return
        }
        guard requireOnline() else { return }
        expectConfirm("nickname") {}
        send(.imProfile(nickname: trimmed, avatar: nil, notifyPreview: nil))
    }

    func setNotifyPreview(_ on: Bool) {
        guard requireOnline() else { return }
        let old = me?.notifyPreview
        me?.notifyPreview = on
        expectConfirm("preview") { [weak self] in
            if let old { self?.me?.notifyPreview = old }
        }
        send(.imProfile(nickname: nil, avatar: nil, notifyPreview: on))
    }

    // MARK: 设置的确认与撤回

    /// 发出设置后等网关的 im_update：到了就 confirm；超时就撤回本地改动并提示
    private func expectConfirm(_ key: String, rollback: @escaping () -> Void) {
        pendingConfirms[key]?.task.cancel()
        let task = Task { [weak self] in
            try? await Task.sleep(for: ImStore.confirmTimeout)
            guard let self, !Task.isCancelled, let entry = self.pendingConfirms.removeValue(forKey: key) else { return }
            entry.rollback()
            self.saveStateSoon()
            self.showToast("没保存上，网络好了再试一次")
        }
        pendingConfirms[key] = (task: task, rollback: rollback)
    }

    private func confirm(_ key: String) {
        pendingConfirms.removeValue(forKey: key)?.task.cancel()
    }

    /// 断线或出错：没确认的全部撤回（真实状态等下次拉列表带回来）
    private func rollbackPending() {
        guard !pendingConfirms.isEmpty else { return }
        let entries = pendingConfirms.values
        pendingConfirms = [:]
        for entry in entries {
            entry.task.cancel()
            entry.rollback()
        }
        saveStateSoon()
    }

    /// 头像已压成 512px 方图放在 outbox：传成 kind=avatar 再改资料
    func uploadAvatar(file: String) {
        guard online, let uploader, let token = transport?.imToken.nilIfEmpty, let dir = ImCache.outboxDir(tenant: tenant) else {
            showToast("还没连上服务器，等连上再换头像")
            return
        }
        let url = dir.appendingPathComponent(file)
        let tenantAtStart = tenant
        showToast("正在上传头像…")
        Task { [weak self] in
            do {
                let blob = try await uploader.upload(file: url, kind: "avatar", mime: "image/jpeg", token: token, progress: { _ in })
                guard let self, self.tenant == tenantAtStart else { return }
                ImCache.adopt(tenant: tenantAtStart, file: url, blob: blob)
                self.send(.imProfile(nickname: nil, avatar: blob, notifyPreview: nil))
                self.showToast("头像已更新")
            } catch {
                guard let self, self.tenant == tenantAtStart else { return }
                self.showToast((error as? LocalizedError)?.errorDescription ?? "头像没传上去，再试一次")
            }
        }
    }

    /// 工作区头像走同一条 512px JPEG / 5MB 上传链，但资料写回 workspace_agent_profile。
    func uploadWorkspaceAvatar(file: String, path: String) {
        guard online, let uploader, let token = transport?.imToken.nilIfEmpty, let dir = ImCache.outboxDir(tenant: tenant) else {
            showToast("还没连上服务器，等连上再换头像")
            return
        }
        let url = dir.appendingPathComponent(file)
        let tenantAtStart = tenant
        showToast("正在上传头像…")
        Task { [weak self] in
            do {
                let blob = try await uploader.upload(file: url, kind: "avatar", mime: "image/jpeg", token: token, progress: { _ in })
                guard let self, self.tenant == tenantAtStart else { return }
                ImCache.adopt(tenant: tenantAtStart, file: url, blob: blob)
                self.send(.workspaceAgentProfile(path: path, displayName: nil, avatar: blob))
                self.showToast("头像已更新")
            } catch {
                guard let self, self.tenant == tenantAtStart else { return }
                self.showToast((error as? LocalizedError)?.errorDescription ?? "头像没传上去，再试一次")
            }
        }
    }

    func setDraft(_ text: String, convId: String) {
        guard drafts[convId] ?? "" != text else { return }
        drafts[convId] = text.isEmpty ? nil : text
        saveStateSoon()
    }

    // MARK: 附件地址

    func mediaURL(convId: String, blob: String) -> URL? {
        guard let ticket = tickets[convId], ticket.exp > Self.nowMs + 30_000 else {
            refreshTicketsSoon()
            return nil
        }
        return GatewayConfig.imMediaURL(scope: convId, blob: blob, ticket: ticket)
    }

    func avatarURL(_ blob: String) -> URL? {
        guard let ticket = avatarTicket, ticket.exp > Self.nowMs + 30_000 else {
            refreshTicketsSoon()
            return nil
        }
        return GatewayConfig.imMediaURL(scope: "avatars", blob: blob, ticket: ticket)
    }

    func isVoiceHeard(_ item: ImLocalMessage) -> Bool {
        guard item.from != meId, let seq = item.seq else { return true }
        return heardVoice[item.convId]?.contains(seq) == true
    }

    func markVoiceHeard(_ item: ImLocalMessage) {
        guard item.from != meId, let seq = item.seq else { return }
        heardVoice[item.convId, default: []].insert(seq)
        saveStateSoon()
    }

    func setVoiceText(_ text: String, for item: ImLocalMessage) {
        guard let seq = item.seq else { return }
        voiceText[item.convId, default: [:]][seq] = text
        saveStateSoon()
    }

    func voiceTranscript(_ item: ImLocalMessage) -> String? {
        guard let seq = item.seq else { return nil }
        return voiceText[item.convId]?[seq]
    }

    /// 票据快过期（或已过期）：重新拉联系人和列表换票。一分钟内最多一次
    func refreshTicketsIfNeeded(force: Bool = false) {
        guard online, Date().timeIntervalSince(lastTicketRequestAt) > 60 else { return }
        let deadline = Self.nowMs + Self.ticketMargin
        let soonest = (Array(tickets.values) + [avatarTicket].compactMap { $0 }).map(\.exp).min() ?? .infinity
        guard force || soonest < deadline else { return }
        // 票据请求没有独立 ack，单独按发出时间限流；列表新鲜度只在完整 im_list 成功后更新。
        lastTicketRequestAt = Date()
        send(.imContacts)
        refreshList()
    }

    private func refreshTicketsSoon() {
        Task { @MainActor [weak self] in self?.refreshTicketsIfNeeded(force: true) }
    }

    private func startTicketWatch() {
        ticketTask?.cancel()
        ticketTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { return }
                self?.refreshTicketsIfNeeded()
            }
        }
    }

    // MARK: 联系人目录

    /// 聊过的：置顶优先，再按最后一条时间倒序；没聊过的按拼音排在下面
    func directory(query: String) -> (chatted: [ImDirectoryRow], others: [ImDirectoryRow]) {
        let myId = meId
        var chatted: [ImDirectoryRow] = []
        var taken = Set<String>()
        for conv in convs.values where !conv.peer.isEmpty && conv.peer != myId {
            let pending = timelines[conv.convId]?.contains(where: { $0.seq == nil }) == true
            guard conv.last != nil || pending, !taken.contains(conv.peer) else { continue }
            let person = user(conv.peer)
            taken.insert(conv.peer)
            guard matches(person, query) else { continue }
            chatted.append(ImDirectoryRow(user: person, conv: conv))
        }
        chatted.sort { a, b in
            let pinA = a.conv?.pin ?? false
            let pinB = b.conv?.pin ?? false
            if pinA != pinB { return pinA }
            let atA = lastActivity(a.conv)
            let atB = lastActivity(b.conv)
            if atA != atB { return atA > atB }
            return a.user.id < b.user.id
        }
        let others = users.values
            .filter { $0.id != myId && !taken.contains($0.id) && matches($0, query) }
            .sorted { a, b in
                let keyA = pinyin(a.nickname).full
                let keyB = pinyin(b.nickname).full
                if keyA != keyB { return keyA < keyB }
                return a.id < b.id
            }
            .map { ImDirectoryRow(user: $0, conv: convs[convId(with: $0.id)]) }
        return (chatted, others)
    }

    /// 协作群使用既有 IM 会话投影；iOS 只提供运行图读取入口，不开放 collab_op。
    func groupConversations(query: String) -> [ImConvRow] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return convs.values
            .filter { row in
                guard row.kind == "group" else { return false }
                return needle.isEmpty || (row.title ?? "协作群").localizedCaseInsensitiveContains(needle)
            }
            .sorted { lhs, rhs in
                if lhs.pin != rhs.pin { return lhs.pin }
                let left = max(lhs.activityAt, lastActivity(lhs))
                let right = max(rhs.activityAt, lastActivity(rhs))
                if left != right { return left > right }
                return lhs.convId < rhs.convId
            }
    }

    func lastActivity(_ conv: ImConvRow?) -> Double {
        guard let conv else { return 0 }
        let pendingAt = timelines[conv.convId]?.last(where: { $0.seq == nil })?.at ?? 0
        return max(conv.last?.at ?? 0, pendingAt)
    }

    private func matches(_ person: ImUser, _ query: String) -> Bool {
        ImPinyin.matches(nickname: person.nickname, key: pinyin(person.nickname), query: query)
    }

    private func pinyin(_ name: String) -> ImPinyin {
        if let hit = pinyinCache[name] { return hit }
        let key = ImPinyin(name)
        pinyinCache[name] = key
        return key
    }

    // MARK: 杂项

    private func send(_ message: ClientMessage) {
        guard online else { return }
        transport?.imSend(message)
    }

    private func sendPresence(_ foreground: Bool) {
        guard online, sentPresence != foreground else { return }
        sentPresence = foreground
        send(.imPresence(foreground: foreground))
    }

    func showToast(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, !Task.isCancelled, self.toast == text else { return }
            self.toast = ""
        }
    }

    static func errorText(_ code: String) -> String {
        switch code {
        case "not_visible": return "找不到这个人"
        case "rate_limited": return "发得太快了，稍等一会儿再发"
        case "too_large": return "内容太大，发不出去"
        case "recall_expired": return "超过 2 分钟，撤回不了了"
        case "not_found": return "消息不存在"
        case "no_cap": return "服务器没开聊天功能"
        default: return "出错了，稍后再试"
        }
    }

    static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    // MARK: 本机缓存

    private func saveStateSoon() {
        stateSaveTask?.cancel()
        stateSaveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard let self, !Task.isCancelled else { return }
            self.persistState()
        }
    }

    private func persistState() {
        guard !tenant.isEmpty else { return }
        var object: [String: JSONValue] = [
            "v": .number(1),
            "users": .array(users.values.sorted { $0.id < $1.id }.map { $0.json() }),
            "convs": .array(convs.values.sorted { $0.convId < $1.convId }.map { $0.json() }),
            "blocked": .array(blocked.sorted().map(JSONValue.string)),
            "drafts": .object(drafts.filter { !$0.value.isEmpty }.mapValues(JSONValue.string)),
            "hidden": .object(hidden.mapValues { seqs in .array(seqs.sorted().map { .number(Double($0)) }) }),
            "heardVoice": .object(heardVoice.mapValues { seqs in .array(seqs.sorted().map { .number(Double($0)) }) }),
            "voiceText": .object(voiceText.mapValues { rows in
                .object(Dictionary<String, JSONValue>(uniqueKeysWithValues: rows.map { (String($0.key), .string($0.value)) }))
            }),
        ]
        if let me { object["me"] = me.json() }
        ImCache.saveState(tenant: tenant, state: .object(object))
        writeShareDirectory()
    }

    /// 分享扩展不启动主 App，只读 App Group 里这份小快照；最近会话排前，其余联系人按昵称。
    private func writeShareDirectory() {
        guard let send = GatewayConfig.imHTTPSendURL?.absoluteString,
              let upload = GatewayConfig.imHTTPUploadAndSendURL?.absoluteString
        else { return }
        let people = users.values.map { user in
            ImShareBridge.Person(id: user.id, nickname: user.nickname, recentAt: lastActivity(convs[convId(with: user.id)]))
        }.sorted {
            if $0.recentAt != $1.recentAt { return $0.recentAt > $1.recentAt }
            return $0.nickname.localizedStandardCompare($1.nickname) == .orderedAscending
        }
        ImShareBridge.save(.init(
            tenant: tenant,
            sendURL: send,
            uploadSendURL: upload,
            assistantIngestURL: GatewayConfig.assistantIngestURL?.absoluteString,
            assistantUploadURL: GatewayConfig.assistantUploadURL?.absoluteString,
            people: people
        ))
    }

    private func saveTimelineSoon(_ convId: String) {
        guard timelinesReady else {
            deferredTimelineSaves.insert(convId)
            return
        }
        timelineSaveTasks[convId]?.cancel()
        timelineSaveTasks[convId] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard let self, !Task.isCancelled else { return }
            self.timelineSaveTasks[convId] = nil
            guard !self.tenant.isEmpty else { return }
            guard self.timelinesReady else {
                self.deferredTimelineSaves.insert(convId)
                return
            }
            ImCache.saveTimeline(tenant: self.tenant, convId: convId, items: self.timelines[convId] ?? [])
        }
    }
}

/// 正停在哪个会话（前台、聊天主页、聊天页都满足）。通知回调不在主线程，靠它同步读
final class ImViewingBeacon: @unchecked Sendable {
    static let shared = ImViewingBeacon()
    private let lock = NSLock()
    private var convId: String?

    func set(_ value: String?) {
        lock.lock()
        convId = value
        lock.unlock()
    }

    func current() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return convId
    }
}

/// 通知中心里某个会话的通知（thread-id = im-<会话号>）
enum ImNotifications {
    static func threadId(_ convId: String) -> String { "im-\(convId)" }

    static func clear(convId: String, done: (@Sendable () -> Void)? = nil) {
        #if canImport(UserNotifications)
        let thread = threadId(convId)
        UNUserNotificationCenter.current().getDeliveredNotifications { notes in
            let ids = notes.filter { $0.request.content.threadIdentifier == thread }.map(\.request.identifier)
            if !ids.isEmpty { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids) }
            done?()
        }
        #else
        done?()
        #endif
    }
}
