import SwiftUI
import UIKit

@main
struct JieboApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = ChatStore()
    @State private var im = ImStore()
    @State private var deviceBridge = DeviceBridgeCoordinator()
    @State private var theme = JieboTheme.shared
    var body: some Scene {
        WindowGroup {
            JieboSceneRoot()
                .environment(store)
                .environment(im)
                .environment(deviceBridge)
                .preferredColorScheme(theme.appearance.colorScheme)
        }
        .commands {
            if UIDevice.current.userInterfaceIdiom == .pad {
                PadAppCommands()
            }
        }
    }
}

/// WindowGroup 每个窗口各建一份 scene state；网络 Store 仍由 App 共享。
private struct JieboSceneRoot: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(DeviceBridgeCoordinator.self) private var deviceBridge
    @Environment(\.scenePhase) private var scenePhase
    @State private var scene = SceneSessionState()

    var body: some View {
        RootView()
            .environment(\.sceneSessionState, scene)
            .onAppear {
                im.attach(store, uploader: ImHTTPUploader())
                store.imSink = im
                deviceBridge.install(on: store)
                store.start()
                WidgetSnapshotBridge.shared.attach(store)
                im.start()
                PushRegistrar.shared.start(store: store, im: im)
                updateActivity(scenePhase)
                Task { await AssistantCaptureDrain.run(store: store) }
            }
            .onDisappear {
                let change = SceneActivityRegistry.shared.remove(token: scene.token)
                im.setAppActive(change.anyActive)
            }
            .onChange(of: scenePhase) { _, phase in
                updateActivity(phase)
            }
            .onChange(of: store.unlocked) { _, unlocked in
                if unlocked { deviceBridge.permissionStore.refresh(forceReport: true) }
            }
            .onOpenURL { url in
                WidgetDeepLinkRouting.shared.open(url, sceneToken: scene.token)
            }
    }

    private func updateActivity(_ phase: ScenePhase) {
        let active = phase == .active
        let change = SceneActivityRegistry.shared.update(token: scene.token, isActive: active)
        im.setAppActive(change.anyActive)
        WidgetSnapshotBridge.shared.refresh(from: store)
        if phase == .background {
            AppTrafficMeter.shared.flush()
        }
        guard change.becameActive else { return }
        store.appBecameActive()
        // 普通回前台只重读本机权限；登录解锁的 onChange 仍会强制上报。
        deviceBridge.permissionStore.refresh(forceReport: false)
        Task { await AssistantCaptureDrain.run(store: store) }
    }
}
