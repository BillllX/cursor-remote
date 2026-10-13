import SwiftUI

@main
struct JieboApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = ChatStore()
    @State private var im = ImStore()
    @State private var theme = JieboTheme.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(im)
                .preferredColorScheme(theme.appearance.colorScheme)
                .onAppear {
                    im.attach(store, uploader: ImHTTPUploader())
                    store.imSink = im
                    store.start()
                    im.start() // store.start 之后：租户 id 已从本机读出，先把聊天缓存画出来
                    PushRegistrar.shared.start(store: store, im: im) // 幂等
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                store.appBecameActive()
                im.setAppActive(true)
            case .background:
                im.setAppActive(false)
            default:
                break // inactive（下拉通知中心、来电横幅）不算离开前台
            }
        }
    }
}
