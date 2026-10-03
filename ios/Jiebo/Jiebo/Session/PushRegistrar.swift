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
    }
}

/// 点击通知后待消费的路由目标。壳（PhoneShell）等 bootstrapped 后 `consume()` 取走
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

/// iPhone APNs：授权 → 注册 → 拿到 token → 连上网关且 assistant_state 到达后上报 push_subscribe
@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()

    private weak var store: ChatStore?
    private var started = false
    private var loopTask: Task<Void, Never>?
    /// 已向系统请求过授权（授权弹窗只在登录后第一次出现）
    private var authRequested = false
    private var deviceToken: String?
    /// 上一次成功发出的订阅指纹（租户 + token + 环境 + bundleId）；相同则不重复发
    private var reportedKey: String?
    /// 上一次设置的应用角标数
    private var appliedBadge: Int?

    private init() {}

    private static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    // MARK: 生命周期

    /// 幂等。仅 iPhone 工作（iPad 不注册 APNs，避免与桌面助理面板重复）
    func start(store: ChatStore) {
        guard UIDevice.current.userInterfaceIdiom == .phone else { return }
        self.store = store
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
        guard started, let store else { return }
        guard store.unlocked else {
            // 未登录或已登出：下次登录重新上报
            reportedKey = nil
            return
        }
        requestAuthorizationIfNeeded()
        reportIfPossible(store: store)
        if store.assistantState != nil {
            applyBadge(store.assistantBadgeCount)
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

    /// 登出前调用（ChatStore.logout() 之后 unlocked 为 false，op 会被丢弃，所以必须先于 logout）
    func unsubscribe(store: ChatStore) {
        guard UIDevice.current.userInterfaceIdiom == .phone else { return }
        if let token = deviceToken, store.unlocked {
            store.assistantOp("push_unsubscribe", args: [
                "kind": .string("apns"),
                "token": .string(token),
            ])
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
        let key = [store.tenantId, token, environment, bundleId].joined(separator: "|")
        guard key != reportedKey else { return }
        reportedKey = key
        store.assistantOp("push_subscribe", args: [
            "kind": .string("apns"),
            "token": .string(token),
            "bundleId": .string(bundleId),
            "environment": .string(environment),
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
