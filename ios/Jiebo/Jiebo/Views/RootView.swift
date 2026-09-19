import SwiftUI

struct RootView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        Group {
            if store.unlocked {
                WorkbenchView()
            } else {
                LoginView()
            }
        }
        .background(JieboColor.paper.ignoresSafeArea())
        .tint(JieboColor.pine)
    }
}

struct WorkbenchView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 380)
        } detail: {
            ThreadView()
        }
        .navigationSplitViewStyle(.balanced)
        .background(JieboColor.paper)
    }
}
