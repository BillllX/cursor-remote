import Foundation

@main
struct PhoneNavigationStateTests {
    static func main() {
        var first = PhoneNavigationState<String>()
        let second = PhoneNavigationState<String>()
        precondition(first.selectedTab == .assistant && !first.visitedWorkspace)
        first.path = ["settings", "memory", "item"]
        first.select(.workspace)
        precondition(first.visitedWorkspace)
        first.select(.assistant)
        precondition(first.path == ["settings", "memory", "item"], "Space switching must preserve the back stack")
        precondition(second.path.isEmpty && !second.visitedWorkspace, "Windows must be independent")
        let pendingRevision = first.revision
        first.path.removeLast() // Native swipe-back also supersedes a pending deep link.
        precondition(first.revision != pendingRevision)
        first.open(["inbox", "notice-1"])
        first.open(["inbox", "notice-1"])
        precondition(first.path == ["inbox", "notice-1"], "Repeated links must not pile up destinations")
        let revision = first.revision
        first.select(.messages)
        precondition(first.selectedTab == .assistant && first.revision == revision)
        first.invalidatePendingNavigation()
        precondition(first.revision != revision, "Explicit workspace selection must win over a late response")
        first.open([])
        precondition(first.path.isEmpty, "Voice capture must explicitly return to the composer")

        var cache = PhoneThreadHistory()
        cache.visit("boot")
        precondition(cache.ids.isEmpty)
        cache.visit("a")
        cache.visit("b")
        cache.visit("a")
        precondition(cache.ids == ["b", "a"])
        precondition(cache.displaying("c") == ["a", "c"])
        precondition(cache.ids == ["b", "a"], "Rendering must not mutate navigation state")
        for index in 0..<1000 {
            cache.visit("chat-\(index)")
            precondition(cache.ids.count <= 2 && Set(cache.ids).count == cache.ids.count)
        }
        cache.trim(to: "chat-999")
        precondition(cache.ids == ["chat-999"], "Memory pressure should release hidden threads")
        print("Phone navigation: independent windows, back stack, stale routes, bounded thread retention — passed")
    }
}
