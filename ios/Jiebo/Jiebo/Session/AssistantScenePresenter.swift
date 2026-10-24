import Foundation

/// 场景选举输入。算法不依赖 UIKit/SwiftUI，可由 Linux Swift 契约直接测试。
struct AssistantSceneCandidate: Equatable {
    let token: String
    let active: Bool
    let order: UInt64
}

enum AssistantSceneElection {
    /// 优先最近激活的前台场景；都不活跃时退回最近登记的场景，始终至多选出一个。
    static func presenter(in candidates: [AssistantSceneCandidate]) -> String? {
        let active = candidates.filter(\.active)
        return (active.isEmpty ? candidates : active)
            .max { lhs, rhs in lhs.order < rhs.order }?
            .token
    }
}

/// App Intent/Share 的全局入口只在这里选一个承载场景，业务路由仍保存在各自 scene-local Router。
@MainActor
final class AssistantScenePresenter {
    static let shared = AssistantScenePresenter()

    private var candidates: [String: AssistantSceneCandidate] = [:]
    private var nextOrder: UInt64 = 0

    private init() {}

    func register(token: String, active: Bool) {
        nextOrder &+= 1
        candidates[token] = AssistantSceneCandidate(token: token, active: active, order: nextOrder)
    }

    func update(token: String, active: Bool) {
        guard candidates[token] != nil else {
            register(token: token, active: active)
            return
        }
        nextOrder &+= 1
        candidates[token] = AssistantSceneCandidate(token: token, active: active, order: nextOrder)
    }

    func unregister(token: String) {
        candidates.removeValue(forKey: token)
    }

    func isPresenter(token: String) -> Bool {
        AssistantSceneElection.presenter(in: Array(candidates.values)) == token
    }
}
