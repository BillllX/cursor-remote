import UIKit
import UserNotifications

/// APNs 注册回调 + 通知展示/点击。业务逻辑都在 PushRegistrar / PushRouting 里
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
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

    // MARK: UNUserNotificationCenterDelegate（回调不在主 actor 上，全部 nonisolated）

    /// 前台也展示横幅 + 声音（iPhone 前台时用户可能正在别的会话里）
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
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
