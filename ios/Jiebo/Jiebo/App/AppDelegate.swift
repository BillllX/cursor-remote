import UIKit
import UserNotifications

/// APNs 注册回调 + 通知展示/点击。业务逻辑都在 PushRegistrar / PushRouting 里
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        ImPickTemp.sweep()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            PushRegistrar.shared.didRegister(deviceToken: deviceToken)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in
            PushRegistrar.shared.didFail(error: error)
        }
    }

    /// 静默推送：别的设备读过某个聊天会话（cr.kind = im_read）→ 清掉这个会话的通知
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let target = PushTarget(userInfo: userInfo), target.kind == "im_read", let convId = target.convId else {
            completionHandler(.noData)
            return
        }
        // 本机列表里这个会话的未读也过期了：交给 ImStore 标脏，在线就立刻按 im_list 对账
        NotificationCenter.default.post(name: ImStore.readElsewhere, object: nil, userInfo: ["convId": convId])
        ImNotifications.clear(convId: convId) {
            DispatchQueue.main.async { completionHandler(.newData) }
        }
    }

    // MARK: UNUserNotificationCenterDelegate（回调不在主 actor 上，全部 nonisolated）

    /// 前台也展示横幅 + 声音（iPhone 前台时用户可能正在别的会话里）；正停在那个聊天会话时不弹
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let target = PushTarget(userInfo: notification.request.content.userInfo)
        if let target, target.kind == "im_read" || (target.isIm && target.convId == ImViewingBeacon.shared.current()) {
            completionHandler([])
            return
        }
        completionHandler([.banner, .sound, .list])
    }

    /// 点击通知：解析 cr 放进 PushRouting.pending，由壳 bootstrapped 后消费
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // 先在回调线程取出可 Sendable 的值，再跳主 actor
        let target = PushTarget(userInfo: response.notification.request.content.userInfo)
        let identifier = response.notification.request.identifier
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [identifier])
        if let target {
            Task { @MainActor in
                PushRouting.shared.pending = target
            }
        }
        completionHandler()
    }
}
