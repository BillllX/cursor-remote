import Foundation
import os

/// Launch milestones only. Do not attach tenant ids, paths, message text, or other private values.
enum AppLaunchMetrics {
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "Jiebo",
        category: "Launch"
    )
    private static let signposter = OSSignposter(
        subsystem: Bundle.main.bundleIdentifier ?? "Jiebo",
        category: "Launch"
    )

    static func event(_ name: StaticString) {
        logger.notice("\(name, privacy: .public)")
        signposter.emitEvent(name)
    }
}
