import Foundation
#if canImport(Network)
import Network
#endif

/// 网关当前路径属性。蜂窝和 Low Data Mode 只供业务降载，不阻断连接。
struct GatewayNetworkCost: Equatable, Sendable {
    var reachable: Bool
    var isExpensive: Bool
    var isConstrained: Bool

    static let unavailable = GatewayNetworkCost(reachable: false, isExpensive: false, isConstrained: false)
    var shouldReduceBackgroundTraffic: Bool { isExpensive || isConstrained }
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

enum GatewayTrafficDirection: String, Sendable {
    case inbound
    case outbound
}

struct GatewayTrafficKey: Hashable, Sendable {
    var direction: GatewayTrafficDirection
    var type: String
}

struct GatewayTrafficCount: Equatable, Sendable {
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
    private let lock = NSLock()
    private var accumulator = GatewayTrafficAccumulator()

    func record(direction: GatewayTrafficDirection, data: Data) {
        let type = GatewayWireType.extract(from: data)
        lock.lock()
        accumulator.record(direction: direction, type: type, utf8Bytes: data.count)
        lock.unlock()
    }

    func snapshot() -> GatewayTrafficAccumulator {
        lock.lock()
        defer { lock.unlock() }
        return accumulator
    }
}

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
                    isConstrained: path.isConstrained
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
