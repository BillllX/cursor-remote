import Foundation
import UIKit
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
    private var scheduledTask: Task<Void, Never>?
    private var lastUnlocked: Bool?
    private var backgroundObserver: NSObjectProtocol?
    /// 只在 fileQueue 上访问：记录最近一次已落盘的指纹、写入时间与共享 UserDefaults，避免高频刷新反复读盘与建 suite IPC。
    nonisolated(unsafe) private var lastFingerprint: String?
    nonisolated(unsafe) private var lastWrittenAt: Date?
    nonisolated(unsafe) private var cachedDefaults: UserDefaults?

    private init() {
        // App 即将切后台时立刻冲刷挂起的防抖快照，避免 250ms 窗口内被挂起导致 Widget 停留在旧状态
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.flushPendingIfNeeded()
            }
        }
    }

    func attach(_ store: ChatStore) {
        guard self.store !== store else { return }
        self.store = store
        refresh(from: store)
    }

    func refreshAttachedStore() {
        guard let store else { return }
        refresh(from: store)
    }

    private func flushPendingIfNeeded() {
        guard scheduledTask != nil, let store else { return }
        scheduledTask?.cancel()
        scheduledTask = nil
        flushRefresh(from: store)
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
        let shouldFlushImmediately = lastUnlocked == nil || lastUnlocked != store.unlocked
        lastUnlocked = store.unlocked
        scheduledTask?.cancel()
        if shouldFlushImmediately {
            scheduledTask = nil
            flushRefresh(from: store)
            return
        }
        // 合并冷启动/重连瞬间的连续状态刷新，避免 1 秒内多次全量解析 todos 与跨进程写 Widget 快照
        scheduledTask = Task { @MainActor [weak self, weak store] in
            try? await Task.sleep(for: .milliseconds(250))
            guard let self, let store, !Task.isCancelled else { return }
            self.scheduledTask = nil
            self.flushRefresh(from: store)
        }
    }

    private func flushRefresh(from store: ChatStore) {
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
        fileQueue.async { [weak self] in
            guard let self else { return }
            if !input.unlocked {
                self.lastFingerprint = nil
                self.lastWrittenAt = nil
            }
            let defaults = self.cachedDefaults ?? {
                let created = UserDefaults(suiteName: appGroup)
                self.cachedDefaults = created
                return created
            }()
            let snapshot = Self.buildSnapshot(from: input, defaults: defaults, privacyModeKey: privacyModeKey)
            guard let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: appGroup
            ) else { return }

            let now = Date()
            if self.lastFingerprint == nil {
                if let previous = WidgetSnapshotStore.load(from: container) {
                    self.lastFingerprint = previous.contentFingerprint
                    self.lastWrittenAt = previous.updatedAt
                }
            }
            let stillFresh = self.lastWrittenAt.map { now.timeIntervalSince($0) < 15 * 60 } ?? false
            guard self.lastFingerprint != snapshot.contentFingerprint || !stillFresh else { return }

            do {
                try WidgetSnapshotStore.save(snapshot, to: container)
                self.lastFingerprint = snapshot.contentFingerprint
                self.lastWrittenAt = snapshot.updatedAt
                WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
            } catch {
                print("[Widget] 快照写入失败：\(error.localizedDescription)")
            }
        }
    }

    nonisolated private static func buildSnapshot(
        from input: SnapshotInput,
        defaults: UserDefaults?,
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
