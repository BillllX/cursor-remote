import Foundation
import Observation

enum WidgetDeepLink: Equatable, Sendable {
    case today
    case inbox
    case todo(String)

    init?(url: URL) {
        guard url.scheme?.lowercased() == "jiebo",
              url.host?.lowercased() == "assistant"
        else { return nil }

        switch url.path {
        case "/today":
            self = .today
        case "/inbox":
            self = .inbox
        case "/todo":
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let id = components.queryItems?.first(where: { $0.name == "id" })?.value?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                  !id.isEmpty
            else { return nil }
            self = .todo(String(id.prefix(80)))
        default:
            return nil
        }
    }
}

struct WidgetDeepLinkDelivery: Equatable, Sendable {
    let route: WidgetDeepLink
    let sceneToken: String
}

/// URL 交给实际收到它的 scene 消费，避免 iPad 多窗口把 Widget 入口开到别的窗口。
@MainActor
@Observable
final class WidgetDeepLinkRouting {
    static let shared = WidgetDeepLinkRouting()

    var pending: WidgetDeepLinkDelivery?

    func open(_ url: URL, sceneToken: String) {
        guard let route = WidgetDeepLink(url: url) else { return }
        pending = WidgetDeepLinkDelivery(route: route, sceneToken: sceneToken)
    }

    func consume(for sceneToken: String) -> WidgetDeepLink? {
        guard pending?.sceneToken == sceneToken else { return nil }
        defer { pending = nil }
        return pending?.route
    }
}
