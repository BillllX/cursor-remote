import Foundation
import WidgetKit

/// 把业务状态收敛为最小 Widget 快照；不接触钥匙串、网络客户端或消息正文。
@MainActor
final class WidgetSnapshotBridge {
    static let shared = WidgetSnapshotBridge()
    static let appGroup = "group.ai.jiebo.ipad"
    static let widgetKind = "JieboAssistantWidget"
    static let privacyModeKey = "widgetPrivacyMode"

    private let fileQueue = DispatchQueue(label: "ai.jiebo.widget-snapshot", qos: .utility)
    private weak var store: ChatStore?

    private init() {}

    func attach(_ store: ChatStore) {
        guard self.store !== store else { return }
        self.store = store
        refresh(from: store)
    }

    func refreshAttachedStore() {
        guard let store else { return }
        refresh(from: store)
    }

    private struct SnapshotInput {
        let unlocked: Bool
        let connected: Bool
        let linkOffline: Bool
        let assistantNetworkConfirmed: Bool
        let assistantName: String
        let assistantState: AssistantState?
        let now: Date
    }

    func refresh(from store: ChatStore) {
        let input = SnapshotInput(
            unlocked: store.unlocked,
            connected: store.connected,
            linkOffline: store.linkOffline,
            assistantNetworkConfirmed: store.assistantNetworkConfirmed,
            assistantName: store.assistantName,
            assistantState: store.assistantState,
            now: Date()
        )
        let appGroup = Self.appGroup
        let widgetKind = Self.widgetKind
        let privacyModeKey = Self.privacyModeKey
        // 串行后台队列构造快照并写盘，避免主线程触发 TodoDue 解析与 App Group UserDefaults 跨进程 IPC。
        fileQueue.async {
            let snapshot = Self.buildSnapshot(from: input, appGroup: appGroup, privacyModeKey: privacyModeKey)
            guard let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: appGroup
            ) else { return }

            let previous = WidgetSnapshotStore.load(from: container)
            let stillFresh = previous.map { Date().timeIntervalSince($0.updatedAt) < 15 * 60 } ?? false
            guard previous?.contentFingerprint != snapshot.contentFingerprint || !stillFresh else { return }

            do {
                try WidgetSnapshotStore.save(snapshot, to: container)
                WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
            } catch {
                print("[Widget] 快照写入失败：\(error.localizedDescription)")
            }
        }
    }

    nonisolated private static func buildSnapshot(
        from input: SnapshotInput,
        appGroup: String,
        privacyModeKey: String
    ) -> WidgetSnapshot {
        let now = input.now
        guard input.unlocked else { return .loggedOut(now: now) }

        let state = input.assistantState
        let unread = state?.unreadInbox ?? 0
        let reminders = (state?.todos ?? []).filter {
            guard !$0.done, let due = TodoDue.parse($0.due) else { return false }
            return due.timed && due.date > now
        }
        let attention = unread + (state?.approvals.count ?? 0)
        let isWorking = state?.delegations.contains { $0.status == "running" } == true
            || state?.runs.contains { $0.endedAt == nil && ["running", "queued"].contains($0.status) } == true

        let status: WidgetSnapshot.AssistantStatus
        let statusText: String
        if !input.connected || input.linkOffline {
            status = .offline
            statusText = "离线，显示上次摘要"
        } else if state == nil || !input.assistantNetworkConfirmed {
            status = .syncing
            statusText = "正在同步"
        } else if isWorking {
            status = .working
            statusText = "\(input.assistantName) 正在处理"
        } else if attention > 0 {
            status = .needsAttention
            statusText = "有 \(attention) 项待处理"
        } else {
            status = .available
            statusText = "\(input.assistantName) 随时在"
        }

        let highlight: WidgetSnapshot.Highlight?
        if let todo = reminders.first {
            highlight = .init(kind: .todo, id: todo.id, summary: todo.text)
        } else if let item = state?.inbox.filter({ !$0.read }).max(by: { $0.createdAt < $1.createdAt }) {
            highlight = .init(kind: .inbox, id: item.id, summary: item.title)
        } else {
            highlight = nil
        }

        let defaults = UserDefaults(suiteName: appGroup)
        return WidgetSnapshot(
            loginState: .loggedIn,
            assistantStatus: status,
            statusText: statusText,
            unreadCount: unread,
            todoCount: reminders.count,
            highlight: highlight,
            updatedAt: now,
            staleAfter: now.addingTimeInterval(WidgetSnapshot.staleInterval),
            privacyMode: defaults?.bool(forKey: privacyModeKey) ?? false
        )
    }
}
