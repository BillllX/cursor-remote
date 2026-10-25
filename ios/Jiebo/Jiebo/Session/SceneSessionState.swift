import Foundation
import Observation
import SwiftUI

/// 每个 WindowGroup 实例各自持有；共享 ChatStore 只保留连接、账户和服务端规范化数据。
@Observable
@MainActor
final class SceneSessionState {
    let token = UUID().uuidString
    var chatDestination: ChatDestination?
    var workbenchChatId: String?
    /// 仅保存本窗口的页签键；页签内容仍是 ChatStore 中的规范化服务数据。
    private var preview = ScenePreviewState()
    var previewKey: String? { preview.selected }
    var previewKeys: [String] { preview.keys }
    var previewFullscreen: Bool { preview.fullscreen }
    private var drafts: [String: String] = [:]

    func draft(for chatId: String, fallback: @autoclosure () -> String) -> String {
        if let value = drafts[chatId] { return value }
        let value = fallback()
        drafts[chatId] = value
        return value
    }

    func saveDraft(_ text: String, for chatId: String) {
        drafts[chatId] = text
    }

    func clearDraft(for chatId: String) {
        drafts[chatId] = ""
    }

    func presentPreview(from store: ChatStore) {
        guard let path = store.previewActivePath else { return }
        preview.open(path)
    }

    func dismissPreview() {
        preview.dismiss()
    }

    func setPreviewFullscreen(_ on: Bool) {
        preview.setFullscreen(on)
    }

    func previewTab(in store: ChatStore) -> PreviewTab? {
        guard let previewKey else { return nil }
        return store.previewTabs.first { $0.path == previewKey }
    }

    func previewTabs(in store: ChatStore) -> [PreviewTab] {
        previewKeys.compactMap { path in store.previewTabs.first { $0.path == path } }
    }

    func selectPreview(_ path: String, in store: ChatStore) {
        guard store.previewTabs.contains(where: { $0.path == path }) else { return }
        preview.select(path)
    }

    func closePreview(_ path: String) {
        preview.close(path)
    }
}

private struct SceneSessionStateKey: EnvironmentKey {
    static let defaultValue: SceneSessionState? = nil
}

extension EnvironmentValues {
    var sceneSessionState: SceneSessionState? {
        get { self[SceneSessionStateKey.self] }
        set { self[SceneSessionStateKey.self] = newValue }
    }
}

/// 同一实体同时只给一个前台场景编辑租约；其它窗口仍可读，切回即可明确接管。
@Observable
@MainActor
final class SceneEditingOwnership {
    static let shared = SceneEditingOwnership()

    private(set) var revision: UInt64 = 0
    @ObservationIgnored private var candidates: [String: [String: SceneEditorCandidate]] = [:]
    @ObservationIgnored private var nextOrder: UInt64 = 0

    private init() {}

    func claim(resource: String, sceneToken: String, active: Bool) {
        guard !resource.isEmpty, !sceneToken.isEmpty else { return }
        nextOrder &+= 1
        candidates[resource, default: [:]][sceneToken] = SceneEditorCandidate(
            sceneToken: sceneToken,
            active: active,
            order: nextOrder
        )
        revision &+= 1
    }

    func release(resource: String, sceneToken: String) {
        candidates[resource]?[sceneToken] = nil
        if candidates[resource]?.isEmpty == true { candidates[resource] = nil }
        revision &+= 1
    }

    func isOwner(resource: String, sceneToken: String) -> Bool {
        _ = revision
        let rows = candidates[resource].map { Array($0.values) } ?? []
        return SceneEditorElection.owner(in: rows) == sceneToken
    }
}

@MainActor
final class SceneActivityRegistry {
    static let shared = SceneActivityRegistry()
    private var active: Set<String> = []
    private init() {}

    @discardableResult
    func update(token: String, isActive: Bool) -> Bool {
        if isActive { active.insert(token) } else { active.remove(token) }
        return !active.isEmpty
    }

    @discardableResult
    func remove(token: String) -> Bool {
        active.remove(token)
        return !active.isEmpty
    }
}
