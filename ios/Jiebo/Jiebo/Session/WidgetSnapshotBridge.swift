import Foundation
import WidgetKit

/// 把业务状态收敛为最小 Widget 快照；不接触钥匙串、网络客户端或消息正文。
@MainActor
final class WidgetSnapshotBridge {
    static let shared = WidgetSnapshotBridge()
    static let appGroup = "group.ai.jiebo.ipad"
    static let widgetKind = "JieboAssistantWidget"
    static let privacyModeKey = "widgetPrivacyMode"

    private weak var store: ChatStore?

    private init() {}

    func attach(_ store: ChatStore) {
        self.store = store
        refresh(from: store)
    }

    func refreshAttachedStore() {
        guard let store else { return }
        refresh(from: store)
    }

    func refresh(from store: ChatStore) {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroup
        ) else { return }

        let snapshot = makeSnapshot(from: store)
        let previous = WidgetSnapshotStore.load(from: container)
        let stillFresh = previous.map { Date().timeIntervalSince($0.updatedAt) < 15 * 60 } ?? false
        guard previous?.contentFingerprint != snapshot.contentFingerprint || !stillFresh else { return }

        do {
            try WidgetSnapshotStore.save(snapshot, to: container)
            WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
        } catch {
            print("[Widget] 快照写入失败：\(error.localizedDescription)")
        }
    }

    private func makeSnapshot(from store: ChatStore, now: Date = Date()) -> WidgetSnapshot {
        guard store.unlocked else { return .loggedOut(now: now) }

        let state = store.assistantState
        let unread = state?.unreadInbox ?? 0
        let openTodos = state?.todos.filter { !$0.done } ?? []
        let attention = unread + (state?.approvals.count ?? 0)
        let isWorking = state?.delegations.contains { $0.status == "running" } == true
            || state?.runs.contains { $0.endedAt == nil && ["running", "queued"].contains($0.status) } == true

        let status: WidgetSnapshot.AssistantStatus
        let statusText: String
        if !store.connected || store.linkOffline {
            status = .offline
            statusText = "离线，显示上次摘要"
        } else if state == nil || !store.assistantNetworkConfirmed {
            status = .syncing
            statusText = "正在同步"
        } else if isWorking {
            status = .working
            statusText = "\(store.assistantName) 正在处理"
        } else if attention > 0 {
            status = .needsAttention
            statusText = "有 \(attention) 项待处理"
        } else {
            status = .available
            statusText = "\(store.assistantName) 随时在"
        }

        let highlight: WidgetSnapshot.Highlight?
        if let todo = openTodos.first {
            highlight = .init(kind: .todo, id: todo.id, summary: todo.text)
        } else if let item = state?.inbox.filter({ !$0.read }).max(by: { $0.createdAt < $1.createdAt }) {
            highlight = .init(kind: .inbox, id: item.id, summary: item.title)
        } else {
            highlight = nil
        }

        let defaults = UserDefaults(suiteName: Self.appGroup)
        return WidgetSnapshot(
            loginState: .loggedIn,
            assistantStatus: status,
            statusText: statusText,
            unreadCount: unread,
            todoCount: openTodos.count,
            highlight: highlight,
            updatedAt: now,
            staleAfter: now.addingTimeInterval(WidgetSnapshot.staleInterval),
            privacyMode: defaults?.bool(forKey: Self.privacyModeKey) ?? false
        )
    }
}
