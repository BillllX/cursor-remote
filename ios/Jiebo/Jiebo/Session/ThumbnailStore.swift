import AVFoundation
import CryptoKit
import Foundation
import ImageIO
import Observation
import PDFKit
import SwiftUI
import UIKit
import WebKit

/// 请求、缓存键和离屏渲染共用不可变主题快照，排队时切换主题也不会串色。
struct CanvasThumbnailTheme {
    let palette: String
    let kind: String

    @MainActor
    static func capture() -> CanvasThumbnailTheme {
        let appearance = JieboTheme.shared.appearance
        let dark: Bool
        switch appearance {
        case .light: dark = false
        case .dark: dark = true
        case .system: dark = ThumbWebJob.hostWindow?.traitCollection.userInterfaceStyle == .dark
        }
        return CanvasThumbnailTheme(palette: JieboTheme.shared.palette.rawValue, kind: dark ? "dark" : "light")
    }

    // 单独升级画布缓存，清除旧版可能写错主题的截图，普通文件缓存保持不变。
    var cacheSuffix: String { "|canvas-v2:\(palette):\(kind)" }
}

/// 文件大卡的缩略图状态。none/failed 都显示原来的图标占位
enum ThumbState: Equatable {
    case none
    case delayed
    case loading
    case image(UIImage)
    /// markdown：前几行非空文本
    case text(String)
    case failed
}

/// 单张缩略图的隔离观察盒：同屏多张文件卡各自只订阅自己的 entry，不再因其他卡片出图而整批重绘。
@Observable
@MainActor
final class ThumbnailEntry {
    var state: ThumbState = .none
}

/// 文件卡片缩略图：read_file 带 reqId 走旁路（不进页签/内容层），按类型渲染成图或几行文字。
/// 键 tenant|chatId|path|sha；没有 sha 的是当前版本，会变，只放内存。
/// 失败按 3 秒、10 秒退避各重试一次，之后显示图标。
/// 限流：在途 read_file 最多 3 个、下载/解码最多 3 个、离屏 WebView 最多 2 个。
/// 排队按后进先出发：对话列表一次建好所有卡片，最后入队的是最新一轮，先出图。
/// 断线时队列原样留着，重连后卡片的触发键变化会再推一次；卡片消失时撤掉还没发出的。
@Observable
@MainActor
final class ThumbnailStore {
    static let shared = ThumbnailStore()

    /// 按 key 隔离的缩略图状态盒（不通过整张字典触发 SwiftUI 广播）
    @ObservationIgnored private var entries: [String: ThumbnailEntry] = [:]
    /// 仅在字典清理/换租户清空 entries 时递增，避免被删掉的 .none 空盒在后续加载时与卡片失联。
    private(set) var entriesEpoch = 0
    /// 在屏卡片对 key 的引用计数：淘汰与前台内存警告只回收离屏项，杜绝与 ThumbRequest 的「淘汰→重拉」死循环。
    @ObservationIgnored private var visibleKeyCounts: [String: Int] = [:]
    @ObservationIgnored private var memoryWarningObserver: NSObjectProtocol?

    private struct Pending {
        var key: String
        var kind: PreviewKind
        var path: String
        var chatId: String
        var tenant: String
        var bytes: Int?
        var sha: String?
        var canvasTheme: CanvasThumbnailTheme?
        /// 有 sha 的快照内容不变，才落盘
        var persist: Bool { sha != nil }
    }

    /// 准备阶段的产物：直接出结果，或交给离屏 WebView
    private enum Prepared {
        case done(ThumbState?)
        case web(ThumbWebJob.Source)
    }

    /// reqId → 已发出、等回包的请求
    @ObservationIgnored private var pending: [String: Pending] = [:]
    /// reqId → 对应超时清理任务，回包或重置时立刻取消，避免大量 20s 定时任务堆积
    @ObservationIgnored private var pendingTimeouts: [String: Task<Void, Never>] = [:]
    /// 还没发出的请求（从尾部取）
    @ObservationIgnored private var waiting: [Pending] = []
    /// 费用策略延后的可见卡片；卡片消失会从这里撤销，恢复时只处理这批已持有 job。
    @ObservationIgnored private var delayed: [String: Pending] = [:]
    /// 每个键已经失败的次数
    @ObservationIgnored private var failures: [String: Int] = [:]
    /// 回包已到、在等下载/解码名额的个数（也占在途名额，免得回包堆积）
    @ObservationIgnored private var awaitingRender = 0
    /// 正在查盘缓存的键 → 本次请求的 token
    @ObservationIgnored private var diskLoading: [String: UUID] = [:]
    @ObservationIgnored private var attempted: Set<String> = []
    /// 成功结果的写入顺序，超过张数或像素字节上限从旧的丢（只丢内存，盘上还在）
    @ObservationIgnored private var order: [String] = []
    @ObservationIgnored private var imageBytes: [String: Int] = [:]
    @ObservationIgnored private var totalImageBytes = 0
    /// 换租户/登出 +1，在途结果作废
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private weak var chatStore: ChatStore?
    private let renderGate = ThumbGate(limit: 3)
    private let webGate = ThumbGate(limit: 2)

    private static let memoryLimit = 200
    /// 内存位图总预算上限 64MB，避免大量高像素缩略图堆积触发系统回收抖动
    private static let memoryBytesLimit = 64 * 1024 * 1024
    private static let maxTrackedEntries = 512
    private static let maxInFlight = 3
    /// 只是兜底：可见卡片数本来就受 12 轮窗口限制
    private static let maxWaiting = 240
    private static let retryDelays: [Double] = [3, 10]

    private init() {
        memoryWarningObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.evictMemoryCache()
            }
        }
    }

    func retain(key: String) {
        visibleKeyCounts[key, default: 0] += 1
    }

    func release(key: String) {
        guard let count = visibleKeyCounts[key] else { return }
        if count <= 1 {
            visibleKeyCounts.removeValue(forKey: key)
        } else {
            visibleKeyCounts[key] = count - 1
        }
    }

    static func renderable(_ kind: PreviewKind) -> Bool {
        switch kind {
        case .image, .svg, .pdf, .video, .html, .canvas, .markdown: return true
        case .text, .binary, .audio: return false
        }
    }

    private func entry(for key: String) -> ThumbnailEntry {
        if let existing = entries[key] { return existing }
        let created = ThumbnailEntry()
        entries[key] = created
        return created
    }

    private func currentState(for key: String) -> ThumbState {
        entries[key]?.state ?? .none
    }

    private func setState(_ state: ThumbState, for key: String) {
        if state == .none {
            if let existing = entries[key], existing.state != .none {
                existing.state = .none
            }
            return
        }
        let target = entry(for: key)
        if target.state != state {
            target.state = state
        }
    }

    private static func imageCost(_ state: ThumbState) -> Int {
        guard case .image(let image) = state else { return 0 }
        if let cg = image.cgImage {
            return cg.bytesPerRow * cg.height
        }
        let pixels = max(1, Int(image.size.width * image.scale)) * max(1, Int(image.size.height * image.scale))
        return pixels * 4
    }

    private func evictMemoryCache() {
        let inBackground = UIApplication.shared.applicationState == .background
        let keys = order
        for key in keys where inBackground || visibleKeyCounts[key, default: 0] == 0 {
            forget(key)
        }
        pruneIdleEntries()
    }

    private func pruneIdleEntries() {
        guard entries.count > Self.maxTrackedEntries else { return }
        var removedAny = false
        for (key, box) in entries
        where box.state == .none && !attempted.contains(key) && visibleKeyCounts[key, default: 0] == 0 {
            entries.removeValue(forKey: key)
            removedAny = true
        }
        if removedAny { entriesEpoch &+= 1 }
    }

    func thumbnail(for file: TurnFile, chatId: String, store: ChatStore) -> ThumbState {
        let _ = entriesEpoch
        guard Self.renderable(file.kind) else { return ThumbState.none }
        return entry(for: cacheKey(for: file, chatId: chatId, store: store).key).state
    }

    func request(file: TurnFile, chatId: String, store: ChatStore, userInitiated: Bool = false) {
        let sourceChatId = file.sourceChatId ?? chatId
        guard Self.renderable(file.kind),
              store.connected,
              store.gatewayFeatures.contains("read_req_id"),
              !store.tenantId.isEmpty,
              !sourceChatId.isEmpty, sourceChatId != "boot"
        else { return }
        let canvasTheme = file.kind == .canvas ? CanvasThumbnailTheme.capture() : nil
        let (key, sha) = cacheKey(for: file, chatId: chatId, store: store, canvasTheme: canvasTheme)
        chatStore = store
        guard !attempted.contains(key) else {
            // 重连、能力到齐时卡片会再来一次：顺手把断线期间留着的队列推出去
            pump()
            return
        }
        attempted.insert(key)
        let job = Pending(
            key: key,
            kind: file.kind,
            path: file.path,
            chatId: sourceChatId,
            tenant: store.tenantId,
            bytes: file.size.map { Int($0) },
            sha: sha,
            canvasTheme: canvasTheme
        )
        // 读盘期间也算 loading：骨架要 0.3 秒后才淡入，命中缓存时看不到它
        setState(.loading, for: key)
        guard job.persist else {
            scheduleNetwork(job, userInitiated: userInitiated)
            return
        }
        let epochAtStart = epoch
        let token = UUID()
        diskLoading[key] = token
        Task {
            let cached = await ThumbDisk.load(tenant: job.tenant, key: job.key)
            // 读盘期间卡片消失被撤、又重新请求（新 token）或换了租户：这一趟作废
            guard self.epoch == epochAtStart, self.diskLoading[job.key] == token else { return }
            self.diskLoading[job.key] = nil
            if let cached {
                self.commit(cached, for: job.key)
            } else {
                self.scheduleNetwork(job, userInitiated: userInitiated)
            }
        }
    }

    /// 用户点按延迟占位后，仅放行这一次，不改变持久策略。
    func loadOnce(file: TurnFile, chatId: String, store: ChatStore) {
        let key = cacheKey(for: file, chatId: chatId, store: store).key
        guard currentState(for: key) == .delayed else { return }
        forget(key)
        request(file: file, chatId: chatId, store: store, userInitiated: true)
    }

    /// 用户手动重试（长按菜单「重新生成预览」）：清掉失败记录重新来
    func retry(file: TurnFile, chatId: String, store: ChatStore) {
        let key = cacheKey(for: file, chatId: chatId, store: store).key
        guard currentState(for: key) == .failed else { return }
        forget(key)
        request(file: file, chatId: chatId, store: store)
    }

    /// 卡片消失：还没发出的请求撤掉，退回未请求
    func cancel(file: TurnFile, chatId: String, store: ChatStore) {
        cancel(key: cacheKey(for: file, chatId: chatId, store: store).key)
    }

    /// 使用卡片实际请求过的键，切换主题后也能取消旧主题的排队任务。
    func cancel(key: String) {
        if diskLoading.removeValue(forKey: key) != nil {
            forget(key)
        } else if let index = waiting.firstIndex(where: { $0.key == key }) {
            waiting.remove(at: index)
            forget(key)
        } else if delayed.removeValue(forKey: key) != nil {
            forget(key)
        } else {
            let reqIds = pending.compactMap { $0.value.key == key ? $0.key : nil }
            if !reqIds.isEmpty {
                for reqId in reqIds {
                    pending[reqId] = nil
                    pendingTimeouts.removeValue(forKey: reqId)?.cancel()
                }
                forget(key)
                pump()
            }
        }
    }

    /// 当前版本没有 sha，文件变化后必须丢掉同路径的内存结果和在途请求。
    func invalidateCurrent(chatId: String, path: String, store: ChatStore) {
        let prefix = "\(store.tenantId)|\(chatId)|\(path)|size:"
        let keys = Set(
            entries.keys.filter { $0.hasPrefix(prefix) }
                + attempted.filter { $0.hasPrefix(prefix) }
                + waiting.filter { $0.chatId == chatId && $0.path == path && $0.sha == nil }.map(\.key)
                + pending.values.filter { $0.chatId == chatId && $0.path == path && $0.sha == nil }.map(\.key)
        )
        waiting.removeAll { keys.contains($0.key) }
        let reqIds = pending.compactMap { keys.contains($0.value.key) ? $0.key : nil }
        for reqId in reqIds {
            pending[reqId] = nil
            pendingTimeouts.removeValue(forKey: reqId)?.cancel()
        }
        for key in keys { forget(key) }
        pump()
    }

    /// ChatStore 收到 reqId 以 thumb: 开头的 file_content 时转交
    func handleReply(reqId: String, path: String, kind: String?, content: String?, url: String?, media: MediaTicket?, error: String?) {
        pendingTimeouts.removeValue(forKey: reqId)?.cancel()
        guard let job = pending.removeValue(forKey: reqId) else { return }
        if error != nil {
            fail(job)
            pump()
            return
        }
        let resolved = url.flatMap { GatewayConfig.resolveHTTP($0) }
        let epochAtStart = epoch
        awaitingRender += 1
        Task {
            await self.renderGate.acquire()
            self.awaitingRender -= 1
            self.pump()
            guard self.epoch == epochAtStart else {
                self.renderGate.release()
                return
            }
            let prepared = await self.prepare(job, content: content, url: resolved, media: media)
            self.renderGate.release()
            var result: ThumbState?
            switch prepared {
            case .done(let state):
                result = state
            case .web(let source):
                await self.webGate.acquire()
                var image: UIImage?
                if self.epoch == epochAtStart {
                    image = await ThumbWebJob(source: source).run()
                }
                self.webGate.release()
                result = image.map { ThumbState.image($0) }
            }
            guard self.epoch == epochAtStart else { return }
            guard let result else {
                self.fail(job)
                return
            }
            self.failures[job.key] = nil
            self.commit(result, for: job.key)
            if job.persist { ThumbDisk.save(result, tenant: job.tenant, key: job.key, epoch: epochAtStart) }
        }
    }

    /// 换账号/登出：内存全清；盘上按同一条串行队列删（tenant 空 = 登出，删所有租户的 thumbs）
    func reset(tenant: String) {
        epoch += 1
        for box in entries.values where box.state != .none {
            box.state = .none
        }
        if !entries.isEmpty {
            entries.removeAll()
            entriesEpoch &+= 1
        }
        visibleKeyCounts.removeAll()
        for task in pendingTimeouts.values { task.cancel() }
        pendingTimeouts = [:]
        pending = [:]
        waiting = []
        delayed = [:]
        diskLoading = [:]
        attempted = []
        failures = [:]
        order = []
        imageBytes = [:]
        totalImageBytes = 0
        ThumbDisk.clear(tenant: tenant, epoch: epoch)
    }

    // MARK: 内部

    func cacheKey(for file: TurnFile, chatId: String, store: ChatStore, canvasTheme: CanvasThumbnailTheme? = nil) -> (key: String, sha: String?) {
        let chatId = file.sourceChatId ?? chatId
        let sha = store.gatewayFeatures.contains("read_sha") ? file.sha : nil
        let themeKey = file.kind == .canvas
            ? (canvasTheme ?? CanvasThumbnailTheme.capture()).cacheSuffix
            : ""
        if let sha { return ("\(store.tenantId)|\(chatId)|\(file.path)|\(sha)\(themeKey)", sha) }
        // 没有 sha 时，同样大小的改写也得换键：把差异指纹和增删行数一起算进去
        let size = file.size.map { String(Int($0)) } ?? "-"
        let edit = "\(file.diffSha ?? "-"):\(file.added ?? -1):\(file.removed ?? -1)"
        return ("\(store.tenantId)|\(chatId)|\(file.path)|size:\(size)|\(edit)\(themeKey)", nil)
    }

    private func enqueue(_ job: Pending) {
        delayed[job.key] = nil
        waiting.removeAll { $0.key == job.key }
        waiting.append(job)
        while waiting.count > Self.maxWaiting {
            // 丢掉的是最早入队、最靠上的卡片；标失败，不让它重新入队把别人挤掉
            setState(.failed, for: waiting.removeFirst().key)
        }
        pump()
    }

    private func scheduleNetwork(_ job: Pending, userInitiated: Bool) {
        let allowed = userInitiated || MobileMediaPolicy.allowsAutomaticDownload(
            mode: MobileDataRuntime.mode,
            cost: MobileDataRuntime.networkCost,
            kind: .fileThumbnail(kind: job.kind.rawValue),
            bytes: job.bytes
        )
        guard allowed else {
            setState(.delayed, for: job.key)
            delayed[job.key] = job
            return
        }
        enqueue(job)
    }

    /// 路径费用恢复后让仍可见的延后 job 再走一次“磁盘缓存优先、未命中才联网”。
    func backgroundTrafficRestored() {
        guard let store = chatStore,
              store.connected,
              !store.client.networkCost.shouldReduceBackgroundTraffic
        else { return }
        let jobs = delayed.values.filter {
            $0.tenant == store.tenantId && attempted.contains($0.key) && currentState(for: $0.key) == .delayed
        }
        for job in jobs {
            delayed[job.key] = nil
            guard job.persist else {
                scheduleNetwork(job, userInitiated: false)
                continue
            }
            let epochAtStart = epoch
            let token = UUID()
            diskLoading[job.key] = token
            setState(.loading, for: job.key)
            Task {
                let cached = await ThumbDisk.load(tenant: job.tenant, key: job.key)
                guard self.epoch == epochAtStart, self.diskLoading[job.key] == token,
                      self.attempted.contains(job.key) else { return }
                self.diskLoading[job.key] = nil
                if let cached {
                    self.commit(cached, for: job.key)
                } else {
                    self.scheduleNetwork(job, userInitiated: false)
                }
            }
        }
    }

    private func pump() {
        // 断线时不发，也不丢：等重连
        guard let store = chatStore, store.connected else { return }
        while pending.count + awaitingRender < Self.maxInFlight, let job = waiting.popLast() {
            guard store.tenantId == job.tenant else {
                forget(job.key)
                continue
            }
            sendRead(job, store: store)
        }
    }

    private func sendRead(_ job: Pending, store: ChatStore) {
        let reqId = "thumb:" + UUID().uuidString
        pending[reqId] = job
        store.sendThumbnailRead(path: job.path, chatId: job.chatId, sha: job.sha, reqId: reqId)
        let epochAtStart = epoch
        pendingTimeouts[reqId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard let self, !Task.isCancelled, self.epoch == epochAtStart else { return }
            self.pendingTimeouts[reqId] = nil
            guard self.pending.removeValue(forKey: reqId) != nil else { return }
            self.fail(job)
            self.pump()
        }
    }

    private func forget(_ key: String) {
        setState(.none, for: key)
        delayed[key] = nil
        attempted.remove(key)
        failures[key] = nil
        order.removeAll { $0 == key }
        if let bytes = imageBytes.removeValue(forKey: key) {
            totalImageBytes = max(0, totalImageBytes - bytes)
        }
    }

    /// 超过张数或像素字节上限从最早的丢（只丢内存）；被丢的卡片若还在屏上，状态回到 .none，ThumbRequest 会再请求一次（盘上有就直接读回）
    private func commit(_ state: ThumbState, for key: String) {
        setState(state, for: key)
        if let previous = imageBytes.removeValue(forKey: key) {
            totalImageBytes = max(0, totalImageBytes - previous)
        }
        let cost = Self.imageCost(state)
        if cost > 0 {
            imageBytes[key] = cost
            totalImageBytes += cost
        }
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > Self.memoryLimit || (totalImageBytes > Self.memoryBytesLimit && order.count > 1) {
            // 只淘汰最旧的离屏项，不把当前仍在屏上的卡片置回 .none 引起重拉死循环
            guard let victimIndex = order.firstIndex(where: { $0 != key && visibleKeyCounts[$0, default: 0] == 0 }) else {
                break
            }
            forget(order.remove(at: victimIndex))
        }
        pruneIdleEntries()
    }

    /// 失败先保持骨架，退避后自己重排；次数用完才落到 .failed（图标占位）
    private func fail(_ job: Pending) {
        let count = failures[job.key, default: 0]
        guard count < Self.retryDelays.count else {
            setState(.failed, for: job.key)
            return
        }
        failures[job.key] = count + 1
        let epochAtStart = epoch
        let delay = Self.retryDelays[count]
        Task {
            try? await Task.sleep(for: .seconds(delay))
            // 期间被撤（卡片消失）或换了租户：不再重排
            guard self.epoch == epochAtStart, self.attempted.contains(job.key),
                  self.currentState(for: job.key) == .loading
            else { return }
            self.enqueue(job)
        }
    }

    /// 下载与解码（占 renderGate）；网页类只拉文本，截图在 webGate 里做
    private func prepare(_ job: Pending, content: String?, url: URL?, media: MediaTicket?) async -> Prepared {
        switch job.kind {
        case .image:
            guard let url, let data = await ThumbRender.fetch(url) else { return .done(nil) }
            let image = await Task.detached(priority: .utility) { ThumbRender.downsample(data, maxPixel: 640) }.value
            return .done(image.map { ThumbState.image($0) })
        case .pdf:
            guard let url, let data = await ThumbRender.fetch(url) else { return .done(nil) }
            let image = await Task.detached(priority: .utility) { ThumbRender.pdfThumbnail(data) }.value
            return .done(image.map { ThumbState.image($0) })
        case .video:
            guard let url, let image = await ThumbRender.videoFrame(url) else { return .done(nil) }
            return .done(.image(image))
        case .markdown:
            guard let text = await ThumbRender.text(content: content, url: url) else { return .done(nil) }
            let preview = await Task.detached(priority: .utility) {
                ThumbRender.markdownPreview(text)
            }.value
            guard let preview else { return .done(nil) }
            return .done(.text(preview))
        case .html:
            guard let text = await ThumbRender.text(content: content, url: url) else { return .done(nil) }
            let chatId = job.chatId
            let path = job.path
            // 后台一次性完成 rewriteHtml 与 lockDown，既不阻塞主线程也不占用离屏 WebView 的 3s 渲染预算
            let html = await Task.detached(priority: .utility) {
                let rewritten = rewriteHtml(source: text, fromFile: path) { resolved in
                    mediaSrc(path: resolved, chatId: chatId, media: media)
                        .flatMap { GatewayConfig.resolveHTTP($0)?.absoluteString } ?? ""
                }
                return ThumbRender.lockDown(rewritten)
            }.value
            return .web(.html(html))
        case .svg:
            let data: Data?
            if let content, !content.isEmpty {
                data = Data(content.utf8)
            } else if let url {
                data = await ThumbRender.fetch(url, limit: 8 * 1024 * 1024)
            } else {
                data = nil
            }
            guard let data, !data.isEmpty else { return .done(nil) }
            let html = await Task.detached(priority: .utility) {
                ThumbRender.lockDown(ThumbRender.svgDocument(data: data))
            }.value
            return .web(.html(html))
        case .canvas:
            guard GatewayConfig.canvasRuntimeURL != nil,
                  let text = await ThumbRender.text(content: content, url: url),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return .done(nil) }
            guard let theme = job.canvasTheme else { return .done(nil) }
            return .web(.canvas(source: text, path: job.path, chatId: job.chatId, theme: theme))
        case .text, .binary, .audio:
            return .done(nil)
        }
    }
}

/// 计数信号量：名额满了按先来后到排队，释放时直接把名额交给下一个
@MainActor
private final class ThumbGate {
    private let limit: Int
    private var active = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(limit: Int) {
        self.limit = limit
    }

    func acquire() async {
        if active < limit {
            active += 1
            return
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiters.append(continuation)
        }
    }

    func release() {
        if waiters.isEmpty {
            active -= 1
        } else {
            waiters.removeFirst().resume()
        }
    }
}

// MARK: - 离屏 WebView 截图

/// 挂在 key window 最底层（不透明、被根视图整屏盖住、不接触摸）才会真正渲染；截完即移除。
/// 不能用 alpha 压低来藏：截图会带上这层透明度，深色卡片上只剩一点影子。
/// html/svg 沙箱对齐 SandboxWebView：loadHTMLString(baseURL: nil)、无 JS bridge、只放行首屏 about:blank。
/// canvas 对齐 CanvasWebView：加载 /canvas-runtime，canvas:ready 后推 canvas:load，canvas:loaded 后截图。
@MainActor
private final class ThumbWebJob: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    enum Source {
        case html(String)
        case canvas(source: String, path: String, chatId: String, theme: CanvasThumbnailTheme)
    }

    private let source: Source
    private var webView: WKWebView?
    private var continuation: CheckedContinuation<UIImage?, Never>?
    private var committed = false
    private var capturing = false
    private var loaded = false
    private var seq = 0
    private var timers: [Task<Void, Never>] = []

    /// 16:10，和卡片预览区同比例；视口窄一些，缩到卡片里正文还认得出
    private static let size = CGSize(width: 480, height: 300)

    init(source: Source) {
        self.source = source
    }

    private var isCanvas: Bool {
        if case .canvas = source { return true }
        return false
    }

    func run() async -> UIImage? {
        await withCheckedContinuation { (continuation: CheckedContinuation<UIImage?, Never>) in
            self.continuation = continuation
            self.start()
        }
    }

    private func start() {
        guard let window = Self.hostWindow else {
            finish(nil)
            return
        }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        var runtimeURL: URL?
        if isCanvas {
            guard let url = GatewayConfig.canvasRuntimeURL else {
                finish(nil)
                return
            }
            runtimeURL = url
            config.userContentController.addUserScript(WKUserScript(
                source: Self.canvasBridge,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
            config.userContentController.add(self, name: "canvas")
        } else {
            // html/svg 只截静态渲染：文件里的脚本一律不跑（只有 canvas 运行时需要 JS）
            config.defaultWebpagePreferences.allowsContentJavaScript = false
        }
        let webView = WKWebView(frame: CGRect(origin: .zero, size: Self.size), configuration: config)
        webView.navigationDelegate = self
        webView.isUserInteractionEnabled = false
        webView.accessibilityElementsHidden = true
        switch JieboTheme.shared.appearance {
        case .light: webView.overrideUserInterfaceStyle = .light
        case .dark: webView.overrideUserInterfaceStyle = .dark
        case .system: webView.overrideUserInterfaceStyle = .unspecified
        }
        // 没写背景的页面按浏览器默认白底黑字渲染；垫 App 底色会在深色模式下变成黑底黑字
        webView.isOpaque = true
        webView.backgroundColor = .white
        webView.scrollView.backgroundColor = .white
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // 放在窗口正中：弹 sheet 时根视图会缩小、露出窗口四周，正中始终被盖住
        webView.center = CGPoint(x: window.bounds.midX, y: window.bounds.midY)
        window.insertSubview(webView, at: 0)
        self.webView = webView

        switch source {
        case .html(let html):
            // prepare 阶段已在后台完成 lockDown，这里直接交由 WebView 渲染并完整保留 3s 超时预算
            webView.loadHTMLString(html, baseURL: nil)
            schedule(after: 3) { [weak self] in self?.finish(nil) }
        case .canvas:
            if let runtimeURL { webView.load(URLRequest(url: runtimeURL)) }
            schedule(after: 15) { [weak self] in self?.finish(nil) }
        }
    }

    private func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) {
        timers.append(Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            action()
        })
    }

    /// 等布局/首帧稳定再截
    private func capture(after delay: Double) {
        guard !capturing else { return }
        capturing = true
        schedule(after: delay) { [weak self] in
            guard let self, let webView = self.webView else { return }
            let config = WKSnapshotConfiguration()
            config.snapshotWidth = NSNumber(value: Self.size.width)
            config.afterScreenUpdates = true
            webView.takeSnapshot(with: config) { [weak self] image, _ in
                guard let self else { return }
                guard let image else {
                    self.finish(nil)
                    return
                }
                // 压平白底与 preparingForDisplay 放后台线程执行，避免截图完成瞬间卡主线程
                self.timers.append(Task { @MainActor [weak self] in
                    let processed = await Task.detached(priority: .utility) {
                        Self.flattened(image)
                    }.value
                    guard let self, !Task.isCancelled else { return }
                    self.finish(processed)
                })
            }
        }
    }

    /// 截图压到白底上存成不透明图并规整到 640px 上限：与图片缩略图及磁盘回读分辨率对齐，避免 3x 下单张 5MB+ 占满内存
    nonisolated private static func flattened(_ image: UIImage) -> UIImage {
        let pixelWidth = image.size.width * image.scale
        let pixelHeight = image.size.height * image.scale
        let maxEdge = max(pixelWidth, pixelHeight)
        let targetSize: CGSize
        let targetScale: CGFloat
        if maxEdge > 640 {
            let ratio = 640.0 / maxEdge
            targetSize = CGSize(width: max(1, floor(pixelWidth * ratio)), height: max(1, floor(pixelHeight * ratio)))
            targetScale = 1
        } else {
            targetSize = image.size
            targetScale = image.scale
        }
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = targetScale
        let rendered = UIGraphicsImageRenderer(size: targetSize, format: format).image { _ in
            UIColor.white.setFill()
            UIRectFill(CGRect(origin: .zero, size: targetSize))
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
        return rendered.preparingForDisplay() ?? rendered
    }

    private func finish(_ image: UIImage?) {
        for timer in timers { timer.cancel() }
        timers = []
        if let webView {
            webView.stopLoading()
            webView.navigationDelegate = nil
            if isCanvas {
                webView.configuration.userContentController.removeScriptMessageHandler(forName: "canvas")
            }
            webView.removeFromSuperview()
            self.webView = nil
        }
        continuation?.resume(returning: image)
        continuation = nil
    }

    // MARK: canvas 协议

    private func sendLoad() {
        guard !loaded, let webView, case .canvas(let text, let path, let chatId, let theme) = source,
              webView.window != nil
        else { return }
        seq += 1
        let payload: [String: Any] = [
            "type": "canvas:load",
            "seq": seq,
            "source": text,
            "path": path,
            "chatId": chatId,
            "palette": theme.palette,
            "theme": theme.kind,
        ]
        webView.callAsyncJavaScript(
            "window.postMessage(payload, '*')",
            arguments: ["payload": payload],
            in: nil,
            in: .page
        ) { _ in }
        // loaded 丢了就 250ms 后重发；运行时按 identity 去重，只回 loaded 不重编译
        schedule(after: 0.25) { [weak self] in self?.sendLoad() }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "canvas", let dict = message.body as? [String: Any],
              let type = dict["type"] as? String
        else { return }
        switch type {
        case "canvas:ready":
            sendLoad()
        case "canvas:loaded":
            // 同一个任务只推同一份源码，任何一次 loaded 都算数
            guard !loaded else { return }
            loaded = true
            capture(after: 0.3)
        case "canvas:error":
            // message 为 null 表示编译成功清错，只有真错误才放弃
            if dict["message"] is String { finish(nil) }
        default:
            break
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let mainFrame = navigationAction.targetFrame?.isMainFrame == true
        if isCanvas {
            // 运行时首屏（含重定向）放行，之后主框不许跳走
            return mainFrame && committed ? .cancel : .allow
        }
        guard mainFrame else { return .cancel }
        let url = navigationAction.request.url?.absoluteString ?? ""
        if !committed, url.hasPrefix("about:blank") { return .allow }
        return .cancel
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        committed = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !isCanvas else { return }
        capture(after: 0.15)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(nil)
    }

    private func report(_ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        guard !committed else { return }
        finish(nil)
    }

    private static var hostWindow: UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.first
    }

    private static let canvasBridge = """
    window.addEventListener('message', function(e) {
      var d = e.data;
      if (d && typeof d.type === 'string' && d.type.indexOf('canvas:') === 0 && d.type !== 'canvas:load') {
        window.webkit.messageHandlers.canvas.postMessage(d);
      }
    });
    """
}

// MARK: - 下载与解码（不在主线程）

private enum ThumbRender {
    static func fetch(_ url: URL, limit: Int = 32 * 1024 * 1024) async -> Data? {
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        guard let (data, response) = try? await AppTrafficHTTP.data(for: request, category: "文件缩略图下载"),
              (200 ..< 300).contains((response as? HTTPURLResponse)?.statusCode ?? 0),
              data.count <= limit
        else { return nil }
        return data
    }

    /// 文本类：content 优先，没有再按 url 拉
    static func text(content: String?, url: URL?) async -> String? {
        if let content, !content.isEmpty { return content }
        guard let url, let data = await fetch(url, limit: 8 * 1024 * 1024) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    nonisolated static func prepareForDisplay(_ image: UIImage) -> UIImage {
        image.preparingForDisplay() ?? image
    }

    nonisolated static func downsample(_ data: Data, maxPixel: Int) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return prepareForDisplay(UIImage(cgImage: image))
    }

    nonisolated static func pdfThumbnail(_ data: Data) -> UIImage? {
        guard let page = PDFDocument(data: data)?.page(at: 0) else { return nil }
        return prepareForDisplay(page.thumbnail(of: CGSize(width: 640, height: 900), for: .mediaBox))
    }

    nonisolated static func videoFrame(_ url: URL) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 640, height: 640)
        guard let (image, _) = try? await generator.image(at: .zero) else { return nil }
        return prepareForDisplay(UIImage(cgImage: image))
    }

    /// 前 6 行非空文本，去掉标题的 #、代码围栏和分隔线；单遍按行早停，避免大 Markdown 全量 split 分配
    nonisolated static func markdownPreview(_ text: String) -> String? {
        var lines: [String] = []
        lines.reserveCapacity(6)
        var index = text.startIndex
        while index < text.endIndex && lines.count < 6 {
            var lineEnd = index
            while lineEnd < text.endIndex && !text[lineEnd].isNewline {
                lineEnd = text.index(after: lineEnd)
            }
            var line = text[index ..< lineEnd].trimmingCharacters(in: .whitespaces)
            index = lineEnd < text.endIndex ? text.index(after: lineEnd) : text.endIndex
            if line.hasPrefix("```") || line.hasPrefix("~~~") || line == "---" || line == "***" { continue }
            while line.hasPrefix("#") { line.removeFirst() }
            line = line.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            lines.append(String(line.prefix(160)))
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// 同 MeasuredSVGImage：把受控下载好的 SVG data 编码为 base64 注入 <img>，不执行内嵌脚本；
    /// 统一使用中性浅底，保证带 sha 的磁盘缩略图跨主题/明暗切换保持一致
    nonisolated static func svgDocument(data: Data) -> String {
        let b64 = data.base64EncodedString()
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>html{color-scheme:light}html,body{margin:0;height:100%;background:#FAFAFA}
        body{display:flex;align-items:center;justify-content:center}
        img{max-width:100%;max-height:100%;object-fit:contain}</style></head>
        <body><img src="data:image/svg+xml;base64,\(b64)"></body></html>
        """
    }

    /// 在 rewriteHtml 的 CSP 之外再叠一条：多条 CSP 同时生效取交集。
    /// 禁脚本、联网、子框架和插件；img/style/font 不限，静态渲染照常
    private static let lockDownMeta = "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">"
    private static let headTagRegex = try! NSRegularExpression(pattern: #"<head(?:\s[^>]*)?>"#, options: [.caseInsensitive])
    private static let htmlTagRegex = try! NSRegularExpression(pattern: #"<html[^>]*>"#, options: [.caseInsensitive])

    nonisolated static func lockDown(_ html: String) -> String {
        var result = html
        let nsRange = NSRange(result.startIndex ..< result.endIndex, in: result)
        if let match = headTagRegex.firstMatch(in: result, options: [], range: nsRange),
           let range = Range(match.range, in: result) {
            result.insert(contentsOf: lockDownMeta, at: range.upperBound)
            return result
        }
        if let match = htmlTagRegex.firstMatch(in: result, options: [], range: nsRange),
           let range = Range(match.range, in: result) {
            result.insert(contentsOf: "<head>\(lockDownMeta)</head>", at: range.upperBound)
            return result
        }
        return "<!doctype html><html><head><meta charset=\"utf-8\">\(lockDownMeta)</head><body>\(result)</body></html>"
    }
}

// MARK: - 磁盘缓存

/// Caches/JieboCache/<租户>/thumbs/：ChatCache.clear(tenant:) / clearAll() 删租户目录时一起清掉。
/// 只存有 sha 的快照缩略图；超过 50MB 按修改时间从旧删。
/// 读、写、修剪、清理全排在同一条串行队列上：reset 之前排的写先落盘再被 clear 删掉，
/// 之后才执行的旧 epoch 写入直接跳过，不会把已退出租户的目录写回来。
private enum ThumbDisk {
    static let maxBytes = 50 * 1024 * 1024
    private static let queue = DispatchQueue(label: "ai.jiebo.thumbs", qos: .utility)
    /// 以下只在 queue 上读写
    private static var writes = 0
    /// 最近一次 clear 时的 ThumbnailStore.epoch
    private static var currentEpoch = 0

    /// tenant 为空（登出）：删所有租户下的 thumbs
    static func clear(tenant: String, epoch: Int) {
        queue.async {
            currentEpoch = epoch
            let fm = FileManager.default
            let tenantDirs: [URL]
            if tenant.isEmpty {
                guard let root = rootDir,
                      let names = try? fm.contentsOfDirectory(atPath: root.path)
                else { return }
                tenantDirs = names.map { root.appendingPathComponent($0, isDirectory: true) }
            } else {
                guard let dir = thumbsDir(tenant)?.deletingLastPathComponent() else { return }
                tenantDirs = [dir]
            }
            for dir in tenantDirs {
                try? fm.removeItem(at: dir.appendingPathComponent("thumbs", isDirectory: true))
                // ChatCache 已先删掉租户目录时，别留下只剩空壳的目录
                if let rest = try? fm.contentsOfDirectory(atPath: dir.path), rest.isEmpty {
                    try? fm.removeItem(at: dir)
                }
            }
        }
    }

    static func load(tenant: String, key: String) async -> ThumbState? {
        await withCheckedContinuation { (continuation: CheckedContinuation<ThumbState?, Never>) in
            queue.async {
                continuation.resume(returning: read(tenant: tenant, key: key))
            }
        }
    }

    static func save(_ state: ThumbState, tenant: String, key: String, epoch: Int) {
        queue.async {
            guard epoch == currentEpoch, let dir = thumbsDir(tenant) else { return }
            let data: Data?
            let ext: String
            switch state {
            case .image(let image):
                // JPEG 没有 alpha，透明区会变黑：带透明的存 PNG
                if hasAlpha(image) {
                    data = image.pngData()
                    ext = "png"
                } else {
                    data = image.jpegData(compressionQuality: 0.8)
                    ext = "jpg"
                }
            case .text(let text):
                data = Data(text.utf8)
                ext = "txt"
            default:
                return
            }
            guard let data else { return }
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try data.write(to: dir.appendingPathComponent(fileName(key)).appendingPathExtension(ext), options: .atomic)
            } catch {
                return
            }
            writes += 1
            if writes % 8 == 1 { prune(dir) }
        }
    }

    private static func read(tenant: String, key: String) -> ThumbState? {
        guard let dir = thumbsDir(tenant) else { return nil }
        let base = dir.appendingPathComponent(fileName(key))
        for ext in ["png", "jpg"] {
            let url = base.appendingPathExtension(ext)
            if let data = try? Data(contentsOf: url),
               let image = ThumbRender.downsample(data, maxPixel: 640)
                ?? UIImage(data: data).map(ThumbRender.prepareForDisplay) {
                touch(url)
                return .image(image)
            }
        }
        let txt = base.appendingPathExtension("txt")
        if let text = try? String(contentsOf: txt, encoding: .utf8), !text.isEmpty {
            touch(txt)
            return .text(text)
        }
        return nil
    }

    private static func hasAlpha(_ image: UIImage) -> Bool {
        guard let info = image.cgImage?.alphaInfo else { return false }
        switch info {
        case .none, .noneSkipFirst, .noneSkipLast: return false
        default: return true
        }
    }

    private static func touch(_ url: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
    }

    private static func prune(_ dir: URL) {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let urls = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
        var entries: [(url: URL, date: Date, bytes: Int)] = urls.compactMap { url in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url: url, date: values.contentModificationDate ?? .distantPast, bytes: values.fileSize ?? 0)
        }
        var total = entries.reduce(0) { $0 + $1.bytes }
        guard total > maxBytes else { return }
        entries.sort { $0.date < $1.date }
        for entry in entries where total > maxBytes {
            try? fm.removeItem(at: entry.url)
            total -= entry.bytes
        }
    }

    /// v4：SVG 缩略图改为受控 base64 + 固定浅底，避免之前带 prefers-color-scheme 的旧快照命中黑底
    private static func fileName(_ key: String) -> String {
        SHA256.hash(data: Data("v4|\(key)".utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// 目录名必须和 ChatCache.tenantDir 一致（同一套 safeName），清缓存才删得到
    private static var rootDir: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("JieboCache", isDirectory: true)
    }

    private static func thumbsDir(_ tenant: String) -> URL? {
        guard !tenant.isEmpty else { return nil }
        return rootDir?
            .appendingPathComponent(safeName(tenant), isDirectory: true)
            .appendingPathComponent("thumbs", isDirectory: true)
    }

    private static func safeName(_ raw: String) -> String {
        var kept = String()
        kept.reserveCapacity(min(raw.utf8.count, 80))
        var count = 0
        for ch in raw {
            if count >= 80 { break }
            if ch.isASCII && (ch.isLetter || ch.isNumber || ch == "-" || ch == "_") {
                kept.append(ch)
            } else {
                kept.append("_")
            }
            count += 1
        }
        if kept == raw { return raw }
        return kept + "-" + fnv1a(Data(raw.utf8))
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
}
