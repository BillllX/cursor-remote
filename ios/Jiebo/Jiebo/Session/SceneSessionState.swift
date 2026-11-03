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
/// 同一个窗口里可以有多块对话同时挂着。按视图分别记租约，一块卸下时不能把这个窗口的租约整段清掉。
@Observable
@MainActor
final class SceneEditingOwnership {
    static let shared = SceneEditingOwnership()

    private(set) var revision: UInt64 = 0
    /// resource → sceneToken → viewId → 这一块的租约
    @ObservationIgnored private var holds: [String: [String: [String: SceneEditorHold]]] = [:]
    @ObservationIgnored private var nextOrder: UInt64 = 0

    private init() {}

    func claim(resource: String, sceneToken: String, viewId: String, active: Bool) {
        guard !resource.isEmpty, !sceneToken.isEmpty, !viewId.isEmpty else { return }
        nextOrder &+= 1
        holds[resource, default: [:]][sceneToken, default: [:]][viewId] = SceneEditorHold(
            active: active,
            order: nextOrder
        )
        revision &+= 1
    }

    func release(resource: String, sceneToken: String, viewId: String) {
        holds[resource]?[sceneToken]?[viewId] = nil
        if holds[resource]?[sceneToken]?.isEmpty == true {
            holds[resource]?[sceneToken] = nil
        }
        if holds[resource]?.isEmpty == true { holds[resource] = nil }
        revision &+= 1
    }

    func hasClaimant(resource: String) -> Bool {
        _ = revision
        return holds[resource]?.isEmpty == false
    }

    func isOwner(resource: String, sceneToken: String) -> Bool {
        _ = revision
        return SceneEditorElection.owner(in: scenes(for: resource)) == sceneToken
    }

    private func scenes(for resource: String) -> [SceneEditorCandidate] {
        guard let scenes = holds[resource] else { return [] }
        return scenes.map { token, views in
            let latest = views.values.max { $0.order < $1.order }
            return SceneEditorCandidate(
                sceneToken: token,
                active: views.values.contains(where: \.active),
                order: latest?.order ?? 0
            )
        }
    }
}

private struct SceneEditorHold {
    var active: Bool
    var order: UInt64
}

@MainActor
final class SceneActivityRegistry {
    static let shared = SceneActivityRegistry()
    private var policy = SceneActivityPolicy()
    private init() {}

    @discardableResult
    func update(token: String, isActive: Bool) -> SceneActivityChange {
        policy.update(token: token, isActive: isActive)
    }

    @discardableResult
    func remove(token: String) -> SceneActivityChange {
        policy.remove(token: token)
    }
}
