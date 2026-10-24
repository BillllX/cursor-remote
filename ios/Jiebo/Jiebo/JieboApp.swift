import SwiftUI

@main
struct JieboApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = ChatStore()
    @State private var im = ImStore()
    @State private var deviceBridge = DeviceBridgeCoordinator()
    @State private var theme = JieboTheme.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(im)
                .environment(deviceBridge)
                .preferredColorScheme(theme.appearance.colorScheme)
                .onAppear {
                    im.attach(store, uploader: ImHTTPUploader())
                    store.imSink = im
                    deviceBridge.install(on: store)
                    store.start()
                    im.start() // store.start 之后：租户 id 已从本机读出，先把聊天缓存画出来
                    PushRegistrar.shared.start(store: store, im: im) // 幂等
                    Task { await AssistantCaptureDrain.run(store: store) }
                }
                .onChange(of: store.unlocked) { _, unlocked in
                    if unlocked { deviceBridge.permissionStore.refresh(forceReport: true) }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                store.appBecameActive()
                im.setAppActive(true)
                deviceBridge.permissionStore.refresh(forceReport: store.unlocked)
                Task { await AssistantCaptureDrain.run(store: store) }
            case .background:
                im.setAppActive(false)
            default:
                break // inactive（下拉通知中心、来电横幅）不算离开前台
            }
        }
    }
}
