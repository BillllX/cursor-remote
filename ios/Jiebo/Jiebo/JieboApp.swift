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
                im.start()
                PushRegistrar.shared.start(store: store, im: im)
                updateActivity(scenePhase)
                Task { await AssistantCaptureDrain.run(store: store) }
            }
            .onDisappear {
                let anyActive = SceneActivityRegistry.shared.remove(token: scene.token)
                im.setAppActive(anyActive)
            }
            .onChange(of: scenePhase) { _, phase in
                updateActivity(phase)
            }
            .onChange(of: store.unlocked) { _, unlocked in
                if unlocked { deviceBridge.permissionStore.refresh(forceReport: true) }
            }
    }

    private func updateActivity(_ phase: ScenePhase) {
        let active = phase == .active
        let anyActive = SceneActivityRegistry.shared.update(token: scene.token, isActive: active)
        im.setAppActive(anyActive)
        guard active else { return }
        store.appBecameActive()
        deviceBridge.permissionStore.refresh(forceReport: store.unlocked)
        Task { await AssistantCaptureDrain.run(store: store) }
    }
}
