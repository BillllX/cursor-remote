import SwiftUI

@main
struct JieboApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = ChatStore()
    @State private var theme = JieboTheme.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .preferredColorScheme(theme.appearance.colorScheme)
                .onAppear {
                    store.start()
                    PushRegistrar.shared.start(store: store) // 幂等；仅 iPhone 生效
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.appBecameActive() }
        }
    }
}
