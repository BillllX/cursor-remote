import Foundation

enum PhoneTab: Hashable {
    case assistant
    case workspace
    case messages // Reserved; the product currently hides this space.
}

/// Scene-local navigation. Switching spaces preserves the assistant's back stack.
/// Explicit destinations replace it; pending asynchronous routes use revision to avoid stealing focus.
struct PhoneNavigationState<Route: Hashable> {
    private(set) var selectedTab: PhoneTab = .assistant
    private(set) var visitedWorkspace = false
    private(set) var revision: UInt64 = 0
    var path: [Route] = [] { didSet { revision &+= 1 } }

    mutating func select(_ tab: PhoneTab) {
        guard tab != .messages, tab != selectedTab else { return }
        selectedTab = tab
        visitedWorkspace = visitedWorkspace || tab == .workspace
        revision &+= 1
    }

    mutating func invalidatePendingNavigation() { revision &+= 1 }

    mutating func open(_ routes: [Route]) {
        select(.assistant)
        path = routes
    }
}

/// At most two warm workspace threads, plus the independent assistant thread.
/// Retaining identity preserves the actual scroll view, expanded messages, and composer.
struct PhoneThreadHistory {
    private(set) var ids: [String] = []
    let capacity: Int

    init(capacity: Int = 2) { self.capacity = max(1, capacity) }

    mutating func visit(_ id: String) {
        guard !id.isEmpty, id != "boot" else { return }
        ids.removeAll { $0 == id }
        ids.append(id)
        ids = Array(ids.suffix(capacity))
    }

    func displaying(_ id: String) -> [String] {
        var next = self
        next.visit(id)
        return next.ids
    }

    mutating func trim(to id: String) {
        ids = ids.filter { $0 == id }
    }
}

#if DEBUG
/// In-process integration probes used only by --phone-navigation-smoke.
@MainActor
enum PhoneNavigationDiagnostics {
    static var mounted: [String: String] = [:]
    static var editors: [String: String] = [:]
}
#endif
