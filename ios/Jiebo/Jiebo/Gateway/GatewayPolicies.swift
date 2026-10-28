import Foundation
#if canImport(Network)
import Network
#endif

/// 网关当前路径属性。蜂窝和 Low Data Mode 只供业务降载，不阻断连接。
struct GatewayNetworkCost: Equatable, Sendable {
    var reachable: Bool
    var isExpensive: Bool
    var isConstrained: Bool
    var transport: GatewayNetworkTransport = .other

    static let unavailable = GatewayNetworkCost(
        reachable: false,
        isExpensive: false,
        isConstrained: false,
        transport: .unavailable
    )
    var shouldReduceBackgroundTraffic: Bool { isExpensive || isConstrained }
}

/// transport 只描述承载网络；费用与低数据模式仍由独立字段表达。
enum GatewayNetworkTransport: String, CaseIterable, Codable, Sendable {
    case wifi
    case cellular
    case wired
    case other
    case unavailable

    var title: String {
        switch self {
        case .wifi: return "Wi‑Fi"
        case .cellular: return "移动数据"
        case .wired: return "有线网络"
        case .other: return "其他网络"
        case .unavailable: return "无网络"
        }
    }

    /// 纯逻辑入口，供 Linux 契约测试验证优先级。
    static func classify(
        reachable: Bool,
        usesWiFi: Bool,
        usesCellular: Bool,
        usesWired: Bool
    ) -> GatewayNetworkTransport {
        guard reachable else { return .unavailable }
        if usesWiFi { return .wifi }
        if usesCellular { return .cellular }
        if usesWired { return .wired }
        return .other
    }
}

enum GatewayPathTransition: Equatable {
    case unchanged
    case reachabilityRestored
    case backgroundTrafficRestored
    case becameUnavailable

    static func classify(from previous: GatewayNetworkCost, to next: GatewayNetworkCost) -> GatewayPathTransition {
        if previous.reachable, !next.reachable { return .becameUnavailable }
        if !previous.reachable, next.reachable { return .reachabilityRestored }
        if previous.reachable, next.reachable,
           previous.shouldReduceBackgroundTraffic, !next.shouldReduceBackgroundTraffic {
            return .backgroundTrafficRestored
        }
        return .unchanged
    }
}

/// 大文件确认只是一张租约：租户、会话与待上传项任一变化都必须拒绝。
enum UploadConfirmationLeasePolicy {
    static func acceptsUpload(
        expectedTenant: String,
        expectedChatId: String,
        itemId: String,
        currentTenant: String,
        currentChatIds: Set<String>,
        currentUploadIds: Set<String>
    ) -> Bool {
        !expectedTenant.isEmpty
            && currentTenant == expectedTenant
            && currentChatIds.contains(expectedChatId)
            && currentUploadIds.contains(itemId)
    }

    static func idsToReject(
        activeId: String?,
        queuedIds: [String],
        continuationIds: Set<String>
    ) -> Set<String> {
        continuationIds
            .union(queuedIds)
            .union(activeId.map { [$0] } ?? [])
    }
}

enum ChatPageRevisionAction: Equatable {
    case accept
    case restartAtAuthoritativeRevision
    case awaitStoredState
}

/// pageRev 只能校验分页链，绝不能反向覆盖 stored_state 给出的权威 chatRev。
enum ChatPageRevisionPolicy {
    static func action(
        authoritativeRev: Int?,
        loadStartRev: Int?,
        pageRev: Int
    ) -> ChatPageRevisionAction {
        let mismatchesLoad = loadStartRev.map { $0 != pageRev } ?? false
        let mismatchesAuthoritative = authoritativeRev.map { $0 != pageRev } ?? false
        guard mismatchesLoad || mismatchesAuthoritative else { return .accept }
        return authoritativeRev == nil ? .awaitStoredState : .restartAtAuthoritativeRevision
    }
}

/// 移动数据策略持久化在 App Group，主 App 与分享扩展读取同一份值。
enum MobileDataMode: String, CaseIterable, Sendable {
    case standard
    case dataSaver
    case unrestricted

    static let defaultsKey = "mobile-data-mode"
    static let appGroup = "group.ai.jiebo.ipad"

    var title: String {
        switch self {
        case .standard: return "标准"
        case .dataSaver: return "省流量"
        case .unrestricted: return "不限制"
        }
    }

    static func load(defaults: UserDefaults? = UserDefaults(suiteName: appGroup)) -> MobileDataMode {
        guard let raw = (defaults ?? .standard).string(forKey: defaultsKey),
              let value = MobileDataMode(rawValue: raw)
        else { return .standard }
        return value
    }

    func save(defaults: UserDefaults? = UserDefaults(suiteName: Self.appGroup)) {
        (defaults ?? .standard).set(rawValue, forKey: Self.defaultsKey)
    }
}

enum MobileMediaKind: Sendable {
    case avatar
    case imBodyImage
    case attachment
    case fileThumbnail(kind: String)
}

struct MobileUploadProfile: Equatable, Sendable {
    var maxPixel: Int
    var jpegQuality: Double
}

/// 纯策略层：缓存命中不调用这里；只有确认即将联网时才判断。
enum MobileMediaPolicy {
    static let smallImageBudget = 1024 * 1024
    static let largeShareRetryBudget = 5 * 1024 * 1024

    static func allowsAutomaticDownload(
        mode: MobileDataMode,
        cost: GatewayNetworkCost,
        kind: MobileMediaKind,
        bytes: Int? = nil
    ) -> Bool {
        guard cost.shouldReduceBackgroundTraffic, mode != .unrestricted else { return true }
        switch mode {
        case .unrestricted:
            return true
        case .dataSaver:
            // 头像通常是 512px 小图；正文媒体和文件卡片留给用户点按。
            return kind.isAvatar && bytes.map { $0 <= smallImageBudget } != false
        case .standard:
            switch kind {
            case .avatar, .imBodyImage:
                return bytes.map { $0 <= smallImageBudget } != false
            case .attachment:
                return false
            case .fileThumbnail(let kind):
                guard !["pdf", "video", "canvas"].contains(kind), let bytes else { return false }
                return bytes <= smallImageBudget
            }
        }
    }

    static func workbenchUpload(mode: MobileDataMode, cost: GatewayNetworkCost) -> MobileUploadProfile {
        if mode == .dataSaver, cost.shouldReduceBackgroundTraffic {
            return MobileUploadProfile(maxPixel: 1280, jpegQuality: 0.65)
        }
        return MobileUploadProfile(maxPixel: 1600, jpegQuality: 0.72)
    }

    static func imUpload(mode: MobileDataMode, cost: GatewayNetworkCost) -> MobileUploadProfile {
        MobileUploadProfile(
            maxPixel: 1280,
            jpegQuality: mode == .dataSaver && cost.shouldReduceBackgroundTraffic ? 0.65 : 0.8
        )
    }
}

private extension MobileMediaKind {
    var isAvatar: Bool {
        if case .avatar = self { return true }
        return false
    }
}

/// 网络路径来自 GatewayClient；expensive 也包含系统判定的个人热点，不只蜂窝网络。
@MainActor
enum MobileDataRuntime {
    static var networkCost = GatewayNetworkCost.unavailable
    static var mode: MobileDataMode { MobileDataMode.load() }
}

/// full-jitter 指数退避的纯逻辑；random 必须在 0...1 内，便于契约测试注入。
enum GatewayRetryPolicy {
    static let baseDelay: TimeInterval = 1
    static let maximumDelay: TimeInterval = 60
    static let stableResetAfter: TimeInterval = 60

    static func ceiling(failureCount: Int) -> TimeInterval {
        guard failureCount > 0 else { return 0 }
        // 先截断指数，避免极端失败次数造成移位或浮点溢出。
        let exponent = min(failureCount - 1, 6)
        return min(maximumDelay, baseDelay * pow(2, Double(exponent)))
    }

    static func delay(failureCount: Int, random: Double) -> TimeInterval {
        ceiling(failureCount: failureCount) * min(max(random, 0), 1)
    }
}

/// 多 Scene 只把全局前台的 0→1 边沿交给 Store。
struct SceneActivityChange: Equatable {
    var anyActive: Bool
    var becameActive: Bool
}

struct SceneActivityPolicy {
    private(set) var activeTokens: Set<String> = []

    mutating func update(token: String, isActive: Bool) -> SceneActivityChange {
        let wasActive = !activeTokens.isEmpty
        if isActive { activeTokens.insert(token) } else { activeTokens.remove(token) }
        let anyActive = !activeTokens.isEmpty
        return SceneActivityChange(anyActive: anyActive, becameActive: !wasActive && anyActive)
    }

    mutating func remove(token: String) -> SceneActivityChange {
        update(token: token, isActive: false)
    }
}

/// 自动刷新共享的新鲜度判定；手动刷新不调用此闸门。
enum RefreshFreshnessPolicy {
    static let assistantForegroundWindow: TimeInterval = 20
    static let imLifecycleWindow: TimeInterval = 20

    static func shouldRefresh(lastSuccess: Date, now: Date, window: TimeInterval) -> Bool {
        now.timeIntervalSince(lastSuccess) >= window
    }
}

enum GatewayTrafficDirection: String, Codable, Sendable {
    case inbound
    case outbound
}

struct GatewayTrafficKey: Hashable, Codable, Sendable {
    var direction: GatewayTrafficDirection
    var type: String
}

struct GatewayTrafficCount: Equatable, Codable, Sendable {
    var bytes = 0
    var messages = 0
}

/// 只保留消息类型、UTF-8 字节数和次数，不保留正文。
struct GatewayTrafficAccumulator: Equatable, Sendable {
    private(set) var counts: [GatewayTrafficKey: GatewayTrafficCount] = [:]

    mutating func record(direction: GatewayTrafficDirection, type: String, utf8Bytes: Int) {
        let key = GatewayTrafficKey(direction: direction, type: type.isEmpty ? "unknown" : type)
        counts[key, default: GatewayTrafficCount()].bytes += max(utf8Bytes, 0)
        counts[key, default: GatewayTrafficCount()].messages += 1
    }
}

struct AppTrafficKey: Hashable, Codable, Sendable {
    var transport: GatewayNetworkTransport
    var direction: GatewayTrafficDirection
    var category: String
}

struct AppTrafficTotalKey: Hashable, Codable, Sendable {
    var transport: GatewayNetworkTransport
    var direction: GatewayTrafficDirection
}

/// 可序列化的单进程增量桶。文件永远只由创建它的进程覆盖，避免两个进程整表互相吃掉计数。
struct AppTrafficBucket: Codable, Equatable, Sendable {
    var epoch: String
    var owner: String
    var updatedAt: Date
    var counts: [AppTrafficKey: GatewayTrafficCount]
}

/// 纯逻辑 epoch 判定；进程每次记账前都用磁盘 epoch 复验，避免扩展跨 reset 写回旧桶。
enum AppTrafficEpochPolicy {
    static func needsSwitch(current: String, persisted: String) -> Bool {
        current != persisted
    }
}

struct AppTrafficSnapshot: Equatable, Sendable {
    var startedAt: Date
    var totals: [AppTrafficTotalKey: GatewayTrafficCount]
    var categories: [AppTrafficKey: GatewayTrafficCount]

    static func merge(
        startedAt: Date,
        epoch: String? = nil,
        buckets: [AppTrafficBucket]
    ) -> AppTrafficSnapshot {
        var totals: [AppTrafficTotalKey: GatewayTrafficCount] = [:]
        var categories: [AppTrafficKey: GatewayTrafficCount] = [:]
        for bucket in buckets where epoch == nil || bucket.epoch == epoch {
            for (key, value) in bucket.counts {
                categories[key, default: GatewayTrafficCount()].bytes += max(value.bytes, 0)
                categories[key, default: GatewayTrafficCount()].messages += max(value.messages, 0)
                let totalKey = AppTrafficTotalKey(transport: key.transport, direction: key.direction)
                totals[totalKey, default: GatewayTrafficCount()].bytes += max(value.bytes, 0)
                totals[totalKey, default: GatewayTrafficCount()].messages += max(value.messages, 0)
            }
        }
        return AppTrafficSnapshot(startedAt: startedAt, totals: totals, categories: categories)
    }

    func bytes(_ transport: GatewayNetworkTransport, _ direction: GatewayTrafficDirection) -> Int {
        totals[AppTrafficTotalKey(transport: transport, direction: direction)]?.bytes ?? 0
    }

    func total(_ transport: GatewayNetworkTransport) -> Int {
        bytes(transport, .inbound) + bytes(transport, .outbound)
    }

    var otherTotal: Int {
        [.wired, .other, .unavailable].reduce(0) { $0 + total($1) }
    }

    func topCategories(limit: Int) -> [(key: AppTrafficKey, count: GatewayTrafficCount)] {
        categories
            .filter { $0.value.bytes > 0 }
            .sorted {
                if $0.value.bytes != $1.value.bytes { return $0.value.bytes > $1.value.bytes }
                return $0.key.category < $1.key.category
            }
            .prefix(max(limit, 0))
            .map { (key: $0.key, count: $0.value) }
    }
}

enum AppTrafficFormat {
    static func bytes(_ value: Int) -> String {
        let bytes = max(value, 0)
        if bytes < 1024 { return "\(bytes) B" }
        let units = ["KB", "MB", "GB", "TB"]
        var amount = Double(bytes)
        var unit = -1
        repeat {
            amount /= 1024
            unit += 1
        } while amount >= 1024 && unit < units.count - 1
        let digits = amount >= 100 ? 0 : (amount >= 10 ? 1 : 2)
        return String(format: "%.\(digits)f %@", amount, units[unit])
    }
}

/// 从顶层 JSON 的 type 字段取分类；不构建正文对象，也不保存 payload。
enum GatewayWireType {
    private static func isWhitespace(_ byte: UInt8) -> Bool {
        byte == 0x20 || byte == 0x0A || byte == 0x0D || byte == 0x09
    }

    static func extract(from data: Data) -> String {
        data.withUnsafeBytes { rawBuffer in
            let bytes = rawBuffer.bindMemory(to: UInt8.self)
            var index = 0
            var depth = 0
            while index < bytes.count {
                switch bytes[index] {
                case 0x7B: // {
                    depth += 1
                    index += 1
                case 0x7D: // }
                    depth -= 1
                    index += 1
                case 0x22: // "
                    let start = index + 1
                    index = start
                    while index < bytes.count, bytes[index] != 0x22 {
                        // JSON 字符串里的转义字符连同下一字节一起跳过。
                        index += bytes[index] == 0x5C ? 2 : 1
                    }
                    guard index < bytes.count else { return "unknown" }
                    let end = index
                    index += 1
                    guard depth == 1,
                          end - start == 4,
                          bytes[start] == 0x74,
                          bytes[start + 1] == 0x79,
                          bytes[start + 2] == 0x70,
                          bytes[start + 3] == 0x65
                    else { continue }
                    while index < bytes.count, isWhitespace(bytes[index]) {
                        index += 1
                    }
                    guard index < bytes.count, bytes[index] == 0x3A else { continue } // :
                    index += 1
                    while index < bytes.count, isWhitespace(bytes[index]) {
                        index += 1
                    }
                    guard index < bytes.count, bytes[index] == 0x22 else { return "unknown" }
                    let valueStart = index + 1
                    index = valueStart
                    while index < bytes.count, bytes[index] != 0x22 {
                        index += bytes[index] == 0x5C ? 2 : 1
                    }
                    guard index < bytes.count else { return "unknown" }
                    return String(decoding: bytes[valueStart ..< index], as: UTF8.self)
                default:
                    index += 1
                }
            }
            return "unknown"
        }
    }
}

final class GatewayTrafficMeter: @unchecked Sendable {
    func record(direction: GatewayTrafficDirection, data: Data) {
        let type = GatewayWireType.extract(from: data)
        AppTrafficMeter.shared.record(
            direction: direction,
            bytes: data.count,
            category: "WS · \(type)"
        )
    }
}

#if os(iOS)
/// App 级 payload 统计器。只保存类别、方向、字节和次数；不保存 URL、正文、token 或租户。
final class AppTrafficMeter: @unchecked Sendable {
    static let shared = AppTrafficMeter()
    static let changedNotification = Notification.Name("ai.jiebo.traffic.changed")

    private struct Epoch: Codable {
        var id: String
        var startedAt: Date
    }

    private let lock = NSLock()
    private let ioQueue = DispatchQueue(label: "ai.jiebo.traffic-store", qos: .utility)
    private let processID: String
    private var transport: GatewayNetworkTransport = .unavailable
    private var bucket: AppTrafficBucket
    private var pendingWrite: DispatchWorkItem?
    private var notifyScheduled = false
    private let directory: URL?
    #if canImport(Network)
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "ai.jiebo.traffic-path")
    #endif

    private init() {
        let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: MobileDataMode.appGroup
        )
        let directory = container?.appendingPathComponent("traffic-v1", isDirectory: true)
        let processID = (Bundle.main.bundleIdentifier ?? ProcessInfo.processInfo.processName)
            .replacingOccurrences(of: "/", with: "_")
        self.directory = directory
        self.processID = processID
        let epoch = Self.loadOrCreateEpoch(directory: directory)
        if let directory,
           let data = try? Data(contentsOf: Self.bucketURL(directory: directory, owner: processID, epoch: epoch.id)),
           let saved = try? JSONDecoder().decode(AppTrafficBucket.self, from: data),
           saved.epoch == epoch.id {
            self.bucket = saved
        } else {
            self.bucket = AppTrafficBucket(epoch: epoch.id, owner: processID, updatedAt: Date(), counts: [:])
        }
        #if canImport(Network)
        monitor.pathUpdateHandler = { [weak self] path in
            self?.setTransport(Self.transport(path))
        }
        monitor.start(queue: monitorQueue)
        #endif
    }

    func setTransport(_ value: GatewayNetworkTransport) {
        lock.lock()
        transport = value
        lock.unlock()
    }

    func currentTransport() -> GatewayNetworkTransport {
        lock.lock()
        defer { lock.unlock() }
        return transport
    }

    func record(
        direction: GatewayTrafficDirection,
        bytes: Int,
        category: String,
        transport explicitTransport: GatewayNetworkTransport? = nil
    ) {
        guard bytes > 0 else { return }
        let safeCategory = category.isEmpty ? "其他" : String(category.prefix(80))
        var staleBucket: AppTrafficBucket?
        lock.lock()
        // epoch 读取与本进程桶切换放在同一临界区；否则 reset 发布新 epoch 后，
        // 一个较早读到旧值、较晚拿到锁的 record 可能把桶切回旧 epoch。
        let persistedEpoch = Self.loadOrCreateEpoch(directory: directory)
        if AppTrafficEpochPolicy.needsSwitch(current: bucket.epoch, persisted: persistedEpoch.id) {
            staleBucket = bucket
            bucket = AppTrafficBucket(
                epoch: persistedEpoch.id,
                owner: processID,
                updatedAt: Date(),
                counts: [:]
            )
        }
        let key = AppTrafficKey(
            transport: explicitTransport ?? transport,
            direction: direction,
            category: safeCategory
        )
        bucket.counts[key, default: GatewayTrafficCount()].bytes += bytes
        bucket.counts[key, default: GatewayTrafficCount()].messages += 1
        bucket.updatedAt = Date()
        scheduleWriteLocked()
        let shouldNotify = !notifyScheduled
        notifyScheduled = true
        lock.unlock()
        if let staleBucket {
            // 旧 epoch 桶保留用于后续清理，但 snapshot 只合并当前 epoch。
            ioQueue.async { [weak self] in self?.write(staleBucket) }
        }
        if shouldNotify {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.lock.lock()
                self?.notifyScheduled = false
                self?.lock.unlock()
                NotificationCenter.default.post(name: Self.changedNotification, object: nil)
            }
        }
    }

    func snapshot() -> AppTrafficSnapshot {
        let epoch = Self.loadOrCreateEpoch(directory: directory)
        var buckets = Self.readBuckets(directory: directory, epoch: epoch.id)
        lock.lock()
        let local = bucket
        lock.unlock()
        if local.epoch == epoch.id {
            buckets.removeAll { $0.owner == processID }
            buckets.append(local)
        }
        return AppTrafficSnapshot.merge(startedAt: epoch.startedAt, epoch: epoch.id, buckets: buckets)
    }

    func reset() {
        let epoch = Epoch(id: UUID().uuidString.lowercased(), startedAt: Date())
        lock.lock()
        // 与 record 的「读 epoch + 切桶」共用本进程锁；跨进程部分再交给文件协调器。
        Self.replaceEpoch(epoch, directory: directory)
        pendingWrite?.cancel()
        pendingWrite = nil
        bucket = AppTrafficBucket(epoch: epoch.id, owner: processID, updatedAt: Date(), counts: [:])
        lock.unlock()
        flush()
        NotificationCenter.default.post(name: Self.changedNotification, object: nil)
    }

    /// 立即把当前计数落盘；调用方只能触发写入，无法取得或修改桶内容。
    func flush() {
        lock.lock()
        pendingWrite?.cancel()
        pendingWrite = nil
        let value = bucket
        lock.unlock()
        ioQueue.sync { write(value) }
    }

    private func scheduleWriteLocked() {
        // 固定窗口：首条未落盘记录后最多一秒写入，后续帧不重置计时，避免 debounce 饥饿。
        guard pendingWrite == nil else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let value = self.bucket
            self.pendingWrite = nil
            self.lock.unlock()
            self.write(value)
        }
        pendingWrite = item
        ioQueue.asyncAfter(deadline: .now() + 1, execute: item)
    }

    private func write(_ value: AppTrafficBucket) {
        guard let directory else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        Self.atomicWrite(value, to: Self.bucketURL(directory: directory, owner: processID, epoch: value.epoch))
    }

    private static func loadOrCreateEpoch(directory: URL?) -> Epoch {
        let fallback = Epoch(id: "memory", startedAt: Date())
        guard let directory else { return fallback }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinatedError: NSError?
        var result: Epoch?
        let epochURL = directory.appendingPathComponent("epoch.json")
        coordinator.coordinate(
            writingItemAt: epochURL,
            options: [],
            error: &coordinatedError
        ) { coordinatedURL in
            if let data = try? Data(contentsOf: coordinatedURL),
               let value = try? JSONDecoder().decode(Epoch.self, from: data) {
                result = value
                return
            }
            let value = Epoch(id: UUID().uuidString.lowercased(), startedAt: Date())
            atomicWrite(value, to: coordinatedURL)
            result = value
        }
        return result ?? fallback
    }

    /// reset 与首次创建共用文件协调区，避免 App/扩展同时创建时后写覆盖先写。
    private static func replaceEpoch(_ value: Epoch, directory: URL?) {
        guard let directory else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinatedError: NSError?
        let epochURL = directory.appendingPathComponent("epoch.json")
        coordinator.coordinate(
            writingItemAt: epochURL,
            options: .forReplacing,
            error: &coordinatedError
        ) { coordinatedURL in
            atomicWrite(value, to: coordinatedURL)
        }
    }

    private static func bucketURL(directory: URL, owner: String, epoch: String) -> URL {
        directory.appendingPathComponent("bucket-\(owner)-\(epoch).json")
    }

    private static func readBuckets(directory: URL?, epoch: String) -> [AppTrafficBucket] {
        guard let directory,
              let files = try? FileManager.default.contentsOfDirectory(
                  at: directory,
                  includingPropertiesForKeys: nil
              )
        else { return [] }
        return files.compactMap { file in
            guard file.lastPathComponent.hasPrefix("bucket-"),
                  let data = try? Data(contentsOf: file),
                  let value = try? JSONDecoder().decode(AppTrafficBucket.self, from: data),
                  value.epoch == epoch
            else { return nil }
            return value
        }
    }

    private static func atomicWrite<T: Encodable>(_ value: T, to url: URL) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    #if canImport(Network)
    fileprivate static func transport(_ path: NWPath) -> GatewayNetworkTransport {
        GatewayNetworkTransport.classify(
            reachable: path.status == .satisfied,
            usesWiFi: path.usesInterfaceType(.wifi),
            usesCellular: path.usesInterfaceType(.cellular),
            usesWired: path.usesInterfaceType(.wiredEthernet)
        )
    }
    #endif
}

/// 每个 async 调用持有独立 delegate/session，直到 task 完成后才恢复 continuation。
/// transport 固化为任务创建时的 NWPath；URLSessionTaskMetrics 没有稳定公开的逐接口字节拆分，
/// 因此切网中的单个 task 只能归到开始时网络，不能伪装成逐包精确。
private final class AppTrafficTaskDelegate: NSObject, URLSessionDataDelegate, URLSessionDownloadDelegate, @unchecked Sendable {
    typealias DataResult = Result<(Data, URLResponse), Error>
    typealias DownloadResult = Result<(URL, URLResponse), Error>

    private let category: String
    private let transport: GatewayNetworkTransport
    private let progressDelegate: URLSessionTaskDelegate?
    private var data = Data()
    private var downloadedFile: URL?
    private var fileError: Error?
    private var metrics: URLSessionTaskMetrics?
    private var dataCompletion: ((DataResult) -> Void)?
    private var downloadCompletion: ((DownloadResult) -> Void)?
    private var completed = false
    var session: URLSession?

    init(
        category: String,
        transport: GatewayNetworkTransport,
        progressDelegate: URLSessionTaskDelegate? = nil,
        dataCompletion: ((DataResult) -> Void)? = nil,
        downloadCompletion: ((DownloadResult) -> Void)? = nil
    ) {
        self.category = category
        self.transport = transport
        self.progressDelegate = progressDelegate
        self.dataCompletion = dataCompletion
        self.downloadCompletion = downloadCompletion
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        self.data.append(data)
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        let target = FileManager.default.temporaryDirectory
            .appendingPathComponent("jiebo-traffic-\(UUID().uuidString)")
        do {
            try FileManager.default.moveItem(at: location, to: target)
            downloadedFile = target
        } catch {
            fileError = error
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        progressDelegate?.urlSession?(
            session,
            task: task,
            didSendBodyData: bytesSent,
            totalBytesSent: totalBytesSent,
            totalBytesExpectedToSend: totalBytesExpectedToSend
        )
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didFinishCollecting metrics: URLSessionTaskMetrics
    ) {
        self.metrics = metrics
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !completed else { return }
        completed = true

        // metrics 明确全部来自本地缓存时不算网络流量；其余情况以 task 的实际成功/失败字节计数。
        let transactions = metrics?.transactionMetrics ?? []
        let localCacheOnly = !transactions.isEmpty
            && transactions.allSatisfy { $0.resourceFetchType == .localCache }
        if !localCacheOnly {
            AppTrafficMeter.shared.record(
                direction: .outbound,
                bytes: Int(clamping: task.countOfBytesSent),
                category: category,
                transport: transport
            )
            AppTrafficMeter.shared.record(
                direction: .inbound,
                bytes: Int(clamping: task.countOfBytesReceived),
                category: category,
                transport: transport
            )
        }

        let response = task.response
        let finalError = error ?? fileError
        if let finalError {
            dataCompletion?(.failure(finalError))
            downloadCompletion?(.failure(finalError))
        } else if let response {
            dataCompletion?(.success((data, response)))
            if let downloadedFile {
                downloadCompletion?(.success((downloadedFile, response)))
            } else if downloadCompletion != nil {
                downloadCompletion?(.failure(URLError(.cannotCreateFile)))
            }
        } else {
            let missing = URLError(.badServerResponse)
            dataCompletion?(.failure(missing))
            downloadCompletion?(.failure(missing))
        }
        dataCompletion = nil
        downloadCompletion = nil
        session.finishTasksAndInvalidate()
        self.session = nil
    }
}

/// URLSession payload 的统一计量入口；重试、重定向及失败均在 task 完成时只计一次实际字节。
enum AppTrafficHTTP {
    static func data(for request: URLRequest, category: String) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            let delegate = AppTrafficTaskDelegate(
                category: category,
                transport: AppTrafficMeter.shared.currentTransport(),
                dataCompletion: { continuation.resume(with: $0) }
            )
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: queue)
            delegate.session = session
            session.dataTask(with: request).resume()
        }
    }

    static func data(from url: URL, category: String) async throws -> (Data, URLResponse) {
        try await data(for: URLRequest(url: url), category: category)
    }

    static func upload(
        for request: URLRequest,
        fromFile file: URL,
        category: String,
        delegate progressDelegate: URLSessionTaskDelegate? = nil
    ) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            let delegate = AppTrafficTaskDelegate(
                category: category,
                transport: AppTrafficMeter.shared.currentTransport(),
                progressDelegate: progressDelegate,
                dataCompletion: { continuation.resume(with: $0) }
            )
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: queue)
            delegate.session = session
            session.uploadTask(with: request, fromFile: file).resume()
        }
    }

    static func download(from url: URL, category: String) async throws -> (URL, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            let delegate = AppTrafficTaskDelegate(
                category: category,
                transport: AppTrafficMeter.shared.currentTransport(),
                downloadCompletion: { continuation.resume(with: $0) }
            )
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: queue)
            delegate.session = session
            session.downloadTask(with: URLRequest(url: url)).resume()
        }
    }
}
#else
/// Linux 契约库不启动网络监控或落盘；纯逻辑类型仍可完整测试。
final class AppTrafficMeter: @unchecked Sendable {
    static let shared = AppTrafficMeter()
    private init() {}
    func record(direction: GatewayTrafficDirection, bytes: Int, category: String, transport: GatewayNetworkTransport? = nil) {}
    func snapshot() -> AppTrafficSnapshot { AppTrafficSnapshot(startedAt: Date(), totals: [:], categories: [:]) }
}
#endif

#if canImport(Network)
/// NWPathMonitor 的回调先串到主 actor，GatewayClient 的状态迁移因此不会并发 open。
final class GatewayPathObserver: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "ai.jiebo.gateway-path")
    var onChange: (@Sendable (GatewayNetworkCost) -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            self?.onChange?(
                GatewayNetworkCost(
                    reachable: path.status == .satisfied,
                    isExpensive: path.isExpensive,
                    isConstrained: path.isConstrained,
                    transport: GatewayNetworkTransport.classify(
                        reachable: path.status == .satisfied,
                        usesWiFi: path.usesInterfaceType(.wifi),
                        usesCellular: path.usesInterfaceType(.cellular),
                        usesWired: path.usesInterfaceType(.wiredEthernet)
                    )
                )
            )
        }
        monitor.start(queue: queue)
    }

    func cancel() {
        monitor.cancel()
    }
}
#endif
