import Foundation

struct SceneEditorCandidate: Equatable {
    let sceneToken: String
    let active: Bool
    let order: UInt64
}

/// 纯计算策略：最近激活的前台场景拥有编辑权；全在后台时只保留最近租约，不产生第二个 owner。
enum SceneEditorElection {
    static func owner(in candidates: [SceneEditorCandidate]) -> String? {
        let active = candidates.filter(\.active)
        return (active.isEmpty ? candidates : active)
            .max { lhs, rhs in lhs.order < rhs.order }?
            .sceneToken
    }
}

/// scene-local 预览只保存页签键；文件内容可由共享 Store 规范化缓存。
struct ScenePreviewState: Equatable {
    private(set) var keys: [String] = []
    private(set) var selected: String?
    /// 当前窗口把预览铺满所在区域。没有选中页签时保持关闭。
    private(set) var fullscreen = false

    mutating func open(_ key: String, limit: Int = 8) {
        guard !key.isEmpty else { return }
        if !keys.contains(key) { keys.append(key) }
        if keys.count > max(1, limit) { keys.removeFirst(keys.count - max(1, limit)) }
        selected = key
    }

    mutating func select(_ key: String) {
        guard keys.contains(key) else { return }
        selected = key
    }

    mutating func dismiss() {
        selected = nil
        fullscreen = false
    }

    mutating func close(_ key: String) {
        keys.removeAll { $0 == key }
        if selected == key {
            selected = nil
            fullscreen = false
        }
    }

    mutating func setFullscreen(_ on: Bool) {
        fullscreen = on && selected != nil
    }
}
