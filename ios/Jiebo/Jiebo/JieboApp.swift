import SwiftUI

@main
struct JieboApp: App {
    @State private var store = ChatStore()
    @State private var theme = JieboTheme.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .preferredColorScheme(theme.appearance.colorScheme)
                .onAppear { store.start() }
        }
    }
}
