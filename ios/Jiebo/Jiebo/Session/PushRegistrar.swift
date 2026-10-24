import Foundation
import Observation
import UIKit
import UserNotifications

/// 通知 payload 里自定义字段 `cr` 的解析结果（见 docs/iphone-assistant-first.md §7.1.4）
struct PushTarget: Equatable, Sendable {
    var itemId: String?
    var kind: String?
    var chatId: String?
    var delegationId: String?
    /// 即时消息（kind = im / im_read）：会话号和那条消息的 seq
    var convId: String?
    var seq: Int?

    /// userInfo["cr"] 缺失或不是字典 → nil
    init?(userInfo: [AnyHashable: Any]) {
        guard let cr = userInfo["cr"] as? [String: Any] else { return nil }
        func text(_ key: String) -> String? {
            guard let value = cr[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        itemId = text("itemId")
        kind = text("kind")
        chatId = text("chatId")
        delegationId = text("delegationId")
        convId = text("convId")
        seq = (cr["seq"] as? NSNumber)?.intValue
    }

    /// 点开要去聊天主页的那个会话
    var isIm: Bool { kind == "im" && convId != nil }
    var isWorkspace: Bool {
        kind?.hasPrefix("workspace_agent") == true
            && kind != "workspace_agent_read"
            && chatId != nil
    }
}

/// 通知回调不在主 actor，用锁保存当前正在看的工作区线程。
final class WorkspaceViewingBeacon: @unchecked Sendable {
    static let shared = WorkspaceViewingBeacon()
    private let lock = NSLock()
    private var chatId: String?

    func set(_ value: String?) {
        lock.lock()
        chatId = value
        lock.unlock()
    }

    func current() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return chatId
    }
}

/// 点击通知后待消费的路由目标。iPhone 由 PhoneTabShell 统一 `consume()`。
@MainActor
@Observable
final class PushRouting {
    static let shared = PushRouting()

    var pending: PushTarget?

    /// 取出并清空
    func consume() -> PushTarget? {
        let target = pending
        pending = nil
        return target
    }
}

/// APNs：授权 → 注册 → 拿到 token → 连上网关且 assistant_state 到达后上报 push_subscribe。
/// iPhone 订阅助理和聊天两类；iPad 只订阅聊天（助理在桌面面板里看，不重复推）
@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()

    private weak var store: ChatStore?
    private weak var im: ImStore?
    private var started = false
    private var loopTask: Task<Void, Never>?
    /// 已向系统请求过授权（授权弹窗只在登录后第一次出现）
    private var authRequested = false
    private var deviceToken: String?
    /// 上一次成功发出的订阅指纹（租户 + token + 环境 + bundleId）；相同则不重复发
    private var reportedKey: String?
    /// 上一次设置的应用角标数
    private var appliedBadge: Int?
    /// 正在退订、马上登出：不再上报订阅、不再改角标
    private var signingOut = false
    private var lastAssistantRequest: Date?

    private init() {}

    private static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    // MARK: 生命周期

    private static var isPhone: Bool { UIDevice.current.userInterfaceIdiom == .phone }

    /// 幂等
    func start(store: ChatStore, im: ImStore) {
        self.store = store
        self.im = im
        guard !started else { return }
        started = true
        loopTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.syncIfPossible()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// 条件满足就同步一次：请求授权 / 注册远程通知 / 上报订阅 / 更新角标。可重复调用
    func syncIfPossible() {
        guard started, !signingOut, let store else { return }
        guard store.unlocked else {
            // 未登录或已登出：下次登录重新上报
            reportedKey = nil
            return
        }
        requestAuthorizationIfNeeded()
        // iPad 没有助理首页去要 assistant_state：这里补要（最多 30 秒一次），订阅上报靠它
        if store.connected, store.assistantState == nil,
           lastAssistantRequest.map({ Date().timeIntervalSince($0) > 30 }) ?? true {
            lastAssistantRequest = Date()
            store.requestAssistant()
        }
        reportIfPossible(store: store)
        // 前台角标按这台设备订阅的类别算，和网关推送里的 aps.badge 同一个口径（apnsBadgeFor）：
        // iPhone 订阅助理 + 聊天 = 聊天未读 + 助理待处理（两边都到齐才设合计，免得闪一下半截数）；
        // iPad 只订阅聊天 = 只算聊天未读（助理在面板里看，变化不推给它，角标就不算它）。
        // 工作区列表未加载时不重算，避免把推送刚带来的工作区角标抹掉。
        guard store.workspaceAgentsLoaded else { return }
        let imLoaded = im?.listLoaded == true
        if Self.isPhone {
            if imLoaded {
                guard store.assistantState != nil else { return }
                applyBadge((im?.totalUnread ?? 0) + store.assistantBadgeCount + store.workspaceUnreadCount)
            }
        } else {
            guard imLoaded else { return }
            applyBadge((im?.totalUnread ?? 0) + store.workspaceUnreadCount)
        }
    }

    // MARK: 系统回调（由 AppDelegate 转交）

    func didRegister(deviceToken data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        guard !hex.isEmpty else { return }
        deviceToken = hex
        syncIfPossible()
    }

    func didFail(error: Error) {
        // 模拟器、未签 Push 能力、无网络等都会走到这里；不打扰用户，只记日志
        print("[Push] registerForRemoteNotifications failed: \(error.localizedDescription)")
    }

    /// 退订最多等网关回包这么久，超时照样登出（换账号时网关也会把同一 token 从别的租户摘掉）
    static let unsubscribeTimeout: Duration = .seconds(3)

    /// 登出前调用并 await：等到 push_unsubscribe 的 assistant_result（或超时 / 断线）再 logout。
    /// ChatStore.logout() 之后 unlocked 为 false，op 会被丢弃，所以必须先于 logout；
    /// 等待期间 signingOut 挡住同步循环，免得又把订阅报上去
    func unsubscribe(store: ChatStore) async {
        signingOut = true
        defer { signingOut = false }
        if let token = deviceToken, store.unlocked {
            let ok = await store.assistantOpReply("push_unsubscribe", args: [
                "kind": .string("apns"),
                "token": .string(token),
            ], timeout: Self.unsubscribeTimeout)
            if !ok { print("[Push] push_unsubscribe 没有确认，照常登出") }
        }
        reportedKey = nil
        applyBadge(0)
    }

    // MARK: 内部

    private func requestAuthorizationIfNeeded() {
        guard !authRequested else { return }
        authRequested = true
        Task { @MainActor in
            let center = UNUserNotificationCenter.current()
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            // 拒绝授权不报错、不挡用 App
            if granted {
                // 授权前设置角标会静默失败：授权后让下一轮同步重新设置
                self.appliedBadge = nil
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    private func reportIfPossible(store: ChatStore) {
        guard store.connected, store.assistantState != nil, let token = deviceToken else { return }
        guard let bundleId = Bundle.main.bundleIdentifier, !bundleId.isEmpty else { return }
        let environment = Self.environment
        let assistant = Self.isPhone
        let key = [store.tenantId, token, environment, bundleId, assistant ? "assistant+im+workspace" : "im+workspace"].joined(separator: "|")
        guard key != reportedKey else { return }
        reportedKey = key
        store.assistantOp("push_subscribe", args: [
            "kind": .string("apns"),
            "token": .string(token),
            "bundleId": .string(bundleId),
            "environment": .string(environment),
            "im": .bool(true),
            "assistant": .bool(assistant),
            "workspace": .bool(true),
        ])
    }

    private func applyBadge(_ count: Int) {
        guard appliedBadge != count else { return }
        appliedBadge = count
        Task { @MainActor in
            try? await UNUserNotificationCenter.current().setBadgeCount(count)
        }
    }
}
