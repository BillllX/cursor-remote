import SwiftUI

@main
struct JieboApp: App {
    @State private var store = ChatStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .preferredColorScheme(.light)
                .onAppear { store.start() }
        }
    }
}
