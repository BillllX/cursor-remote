import Foundation
import Observation
import SwiftUI

private struct OpenPadDomainKey: EnvironmentKey {
    static let defaultValue: ((PadDomain) -> Void)? = nil
}

private struct AssistantSceneTokenKey: EnvironmentKey {
    static let defaultValue = ""
}

private struct AssistantVoicePresenterActiveKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// 旧设置/工作台入口直接操作所属 HomeShell，不通过跨窗口广播。
    var openPadDomain: ((PadDomain) -> Void)? {
        get { self[OpenPadDomainKey.self] }
        set { self[OpenPadDomainKey.self] = newValue }
    }

    var assistantSceneToken: String {
        get { self[AssistantSceneTokenKey.self] }
        set { self[AssistantSceneTokenKey.self] = newValue }
    }

    /// 只有当前业务域里唯一可见的助理 Composer 才能接收语音。
    var assistantVoicePresenterActive: Bool {
        get { self[AssistantVoicePresenterActiveKey.self] }
        set { self[AssistantVoicePresenterActiveKey.self] = newValue }
    }
}

struct AssistantVoiceDelivery {
    let sceneToken: String
    let capture: AssistantCaptureBridge.Capture
}

extension Notification.Name {
    static let assistantVoiceComposerRequested = Notification.Name("AssistantVoiceComposerRequested")
}

/// iPad 的三个正式业务域。状态只由当前 HomeShell 场景持有，不进入 ChatStore。
enum PadDomain: String, CaseIterable, Identifiable {
    case assistant
    case workbench
    case messages

    static let storageKey = "jiebo.padDomain"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .assistant: return "小驳"
        case .workbench: return "工作台"
        case .messages: return "消息"
        }
    }

    var symbol: String {
        switch self {
        case .assistant: return NavigationIconId.assistant.symbol
        case .workbench: return "rectangle.3.group"
        case .messages: return "bubble.left.and.bubble.right"
        }
    }
}

/// 小驳域首期导航。selection 与 section 分离，P1 可直接扩展成三栏。
enum PadAssistantSection: String, CaseIterable, Identifiable {
    case today
    case inbox
    case tasks
    case artifacts
    case memory

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: return "今日"
        case .inbox: return "收件箱"
        case .tasks: return "任务"
        case .artifacts: return "产物"
        case .memory: return "记忆"
        }
    }

    var symbol: String {
        switch self {
        case .today: return "sun.max"
        case .inbox: return "tray"
        case .tasks: return "checklist"
        case .artifacts: return "square.stack.3d.up"
        case .memory: return NavigationIconId.memory.symbol
        }
    }
}

struct PadPushDestination: Equatable {
    var domain: PadDomain
    var section: PadAssistantSection?
    var selection: PadSelection?
}

enum PadAssistantTargetResolution: Equatable {
    case delegation(String)
    case inboxItem(String)
    case task(String)
}

/// 对可选投影做一次集中归一化。nil 表示老网关不支持，空数组表示支持但暂无内容。
struct PadAssistantProjection {
    let inbox: [AssistantInboxItem]
    let dayThread: [DayThreadEvent]
    let dayThreadAvailable: Bool
    let draftCards: [DraftCard]
    let draftCardsAvailable: Bool
    let personalTasks: [PersonalTask]
    let personalTasksAvailable: Bool
    let artifacts: [Artifact]
    let artifactsAvailable: Bool

    init(state: AssistantState?) {
        inbox = state?.inbox ?? []
        dayThread = state?.dayThread ?? Self.fallbackDayThread(state)
        dayThreadAvailable = state?.dayThread != nil
        draftCards = Self.uniqueDraftCards(state?.draftCards ?? [])
        draftCardsAvailable = state?.draftCards != nil
        personalTasks = state?.personalTasks ?? Self.fallbackTasks(state)
        personalTasksAvailable = state?.personalTasks != nil
        artifacts = state?.artifacts ?? []
        artifactsAvailable = state?.artifacts != nil
    }

    func contains(_ transfer: PadSemanticTransfer) -> Bool {
        switch transfer.kind {
        case .task:
            return personalTasks.contains { $0.id == transfer.stableID }
        case .inbox:
            return inbox.contains { $0.id == transfer.stableID }
        case .draft:
            return draftCards.contains { $0.id == transfer.stableID }
        case .artifact:
            return artifacts.contains { $0.id == transfer.stableID }
        }
    }

    /// 同一审批只保留最新行动卡；没有 approval source 的卡按自身 id 去重。
    private static func uniqueDraftCards(_ rows: [DraftCard]) -> [DraftCard] {
        var seen = Set<String>()
        return rows
            .sorted { $0.createdAt > $1.createdAt }
            .filter { row in
                let key = row.sources.first(where: { $0.kind == "approval" })
                    .map { "approval:\($0.id)" } ?? "draft:\(row.id)"
                return seen.insert(key).inserted
            }
    }

    /// 老网关没有统一投影时，只在这里由既有事实源生成今日时间线，避免各页各自猜测。
    private static func fallbackDayThread(_ state: AssistantState?) -> [DayThreadEvent] {
        guard let state else { return [] }
        var rows: [DayThreadEvent] = []
        if let brief = state.brief, !brief.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            rows.append(DayThreadEvent(
                id: "brief:\(brief.day)",
                kind: "brief",
                title: "今日简报",
                body: brief.text,
                at: 0,
                priority: "normal",
                taskId: nil,
                draftCardId: nil,
                sources: [TaskSourceRef(kind: "brief", id: brief.day)],
                receipt: nil
            ))
        }
        rows += state.inbox
            .filter { !$0.read }
            .prefix(20)
            .map { item in
                DayThreadEvent(
                    id: "inbox:\(item.id)",
                    kind: "inbox",
                    title: item.title,
                    body: item.body.nilIfEmpty,
                    at: item.createdAt,
                    priority: item.kind == "approval" ? "high" : "normal",
                    taskId: item.delegationId.map { "delegation:\($0)" },
                    draftCardId: nil,
                    sources: [TaskSourceRef(kind: "inbox", id: item.id)],
                    receipt: nil
                )
            }
        return rows.sorted { lhs, rhs in
            if lhs.kind == "brief" { return true }
            if rhs.kind == "brief" { return false }
            return lhs.at > rhs.at
        }
    }

    /// 兼容老网关：任务页仍使用 todo/日程/委派真数据；支持统一投影后自动切回服务端排序。
    private static func fallbackTasks(_ state: AssistantState?) -> [PersonalTask] {
        guard let state else { return [] }
        let todos = state.todos.map { todo in
            PersonalTask(
                id: "todo:\(todo.id)",
                kind: "todo",
                title: todo.text,
                phase: todo.done ? "completed" : (TodoDue.overdue(todo.due) ? "needs_me" : "planned"),
                status: todo.done ? "done" : "open",
                priority: TodoDue.overdue(todo.due) ? "high" : "normal",
                attention: TodoDue.overdue(todo.due) ? "已逾期" : nil,
                detail: todo.quote,
                due: todo.due,
                dueAt: TodoDue.parse(todo.due)?.date.timeIntervalSince1970.mapMillis,
                createdAt: todo.createdAt,
                updatedAt: todo.doneAt,
                sources: [TaskSourceRef(kind: "todo", id: todo.id)],
                receipt: todo.doneAt.map {
                    TaskReceipt(id: "receipt:todo:\(todo.id)", status: "done", at: $0, summary: todo.text)
                },
                actions: [
                    PersonalTaskAction(
                        label: todo.done ? "重新打开" : "完成",
                        op: todo.done ? "todo_undo" : "todo_done",
                        id: todo.id,
                        delegationId: nil,
                        chatId: nil,
                        callId: nil,
                        allow: nil,
                        enabled: nil
                    ),
                ]
            )
        }
        let delegations = state.delegations.map { row in
            let phase: String = row.status == "done" ? "completed"
                : row.status == "running" ? "in_progress"
                : row.status == "awaiting" || row.status == "failed" ? "needs_me"
                : "planned"
            return PersonalTask(
                id: "delegation:\(row.id)",
                kind: "delegation",
                title: row.title.nilIfEmpty ?? "委派",
                phase: phase,
                status: row.status,
                priority: phase == "needs_me" ? "high" : "normal",
                attention: row.status == "awaiting" ? "等待你批准" : nil,
                detail: row.result,
                due: nil,
                dueAt: nil,
                createdAt: row.createdAt,
                updatedAt: row.endedAt,
                sources: [TaskSourceRef(kind: "delegation", id: row.id)],
                receipt: row.endedAt.map {
                    TaskReceipt(id: "receipt:delegation:\(row.id)", status: row.status, at: $0, summary: row.result)
                },
                actions: row.status == "running" || row.status == "awaiting"
                    ? [PersonalTaskAction(
                        label: "取消",
                        op: "delegation_cancel",
                        id: nil,
                        delegationId: row.id,
                        chatId: nil,
                        callId: nil,
                        allow: nil,
                        enabled: nil
                    )]
                    : []
            )
        }
        let schedules = state.schedules.map { schedule in
            let failed = schedule.pausedReason != nil
                || schedule.failCount > 0
                || ["failed", "interrupted"].contains(schedule.lastStatus ?? "")
            return PersonalTask(
                id: "schedule:\(schedule.id)",
                kind: "schedule",
                title: schedule.title.nilIfEmpty ?? "日程",
                phase: failed ? "needs_me" : "planned",
                status: schedule.enabled ? (schedule.lastStatus ?? "scheduled") : "paused",
                priority: failed ? "high" : "normal",
                attention: failed ? (schedule.pausedReason?.nilIfEmpty ?? "最近运行失败") : nil,
                detail: schedule.prompt.nilIfEmpty ?? schedule.cron.nilIfEmpty,
                due: nil,
                dueAt: schedule.nextAt,
                createdAt: schedule.nextAt ?? 0,
                updatedAt: nil,
                sources: [TaskSourceRef(kind: "schedule", id: schedule.id)],
                receipt: nil,
                actions: [
                    PersonalTaskAction(
                        label: schedule.enabled ? "暂停" : "启用",
                        op: "schedule_set",
                        id: schedule.id,
                        delegationId: nil,
                        chatId: nil,
                        callId: nil,
                        allow: nil,
                        enabled: !schedule.enabled
                    ),
                ]
            )
        }
        return (todos + schedules + delegations).sorted {
            let order = ["needs_me": 0, "in_progress": 1, "planned": 2, "completed": 3]
            return (order[$0.phase] ?? 4, -($0.updatedAt ?? $0.createdAt))
                < (order[$1.phase] ?? 4, -($1.updatedAt ?? $1.createdAt))
        }
    }
}

private extension TimeInterval {
    var mapMillis: Double { self * 1000 }
}

@Observable
@MainActor
final class PadRouter {
    var domain: PadDomain = .assistant
    var assistantSection: PadAssistantSection = .today
    var inspectorNavigation = PadInspectorNavigation()
    var selection: PadSelection? {
        get { inspectorNavigation.selection }
        set { inspectorNavigation.selection = newValue }
    }
    var inspectorPresented = false
    var inspectorMode: PadInspectorMode {
        get { inspectorNavigation.mode }
        set { inspectorNavigation.mode = newValue }
    }
    var delegationDetail: DelegationRef?
    var pendingVoiceCapture: AssistantCaptureBridge.Capture?
    var searchPresented = false
    var searchQuery = ""
    var sidebarToggleRequest = 0
    var layoutMode = PadLayoutMode.regular
    var dropFeedback: String?
    var activeSemanticDragKind: PadSemanticTransfer.Kind?
    var bootstrapped = false
    private(set) var sectionHistory: [PadAssistantSection] = [.today]
    private(set) var sectionHistoryIndex = 0

    /// 新键优先；第一次升级时把旧双主页平滑映射。全新安装默认进入小驳。
    static func migratedDomain(padRawValue: String?, legacyRawValue: String?) -> PadDomain {
        if let padRawValue, let saved = PadDomain(rawValue: padRawValue) {
            return saved
        }
        switch legacyRawValue {
        case HomeMode.workbench.rawValue: return .workbench
        case HomeMode.chat.rawValue: return .messages
        default: return .assistant
        }
    }

    /// 推送 payload 到 iPad 业务域的纯映射，供壳消费前后共同使用。
    static func destination(for target: PushTarget) -> PadPushDestination {
        if target.isIm {
            return PadPushDestination(domain: .messages, section: nil, selection: nil)
        }
        if target.isWorkspace {
            return PadPushDestination(domain: .messages, section: nil, selection: nil)
        }
        switch target.kind {
        case "approval":
            return PadPushDestination(
                domain: .assistant,
                section: .inbox,
                selection: target.itemId.map(PadSelection.inboxItem)
                    ?? target.delegationId.map(PadSelection.delegation)
            )
        case "delegation":
            return PadPushDestination(
                domain: .assistant,
                section: .tasks,
                selection: target.delegationId.map(PadSelection.delegation)
            )
        case "inbox":
            return PadPushDestination(
                domain: .assistant,
                section: .inbox,
                selection: target.itemId.map(PadSelection.inboxItem)
            )
        case "reminder":
            return PadPushDestination(
                domain: .assistant,
                section: .tasks,
                selection: target.itemId.map(PadSelection.task)
            )
        case "brief":
            return PadPushDestination(domain: .assistant, section: .today, selection: .brief)
        default:
            return PadPushDestination(domain: .assistant, section: .today, selection: .assistantChat)
        }
    }

    /// 只解析需要实体定位的目标；nil 表示新状态里仍未出现，调用方负责有界刷新后降级。
    static func resolveAssistantTarget(
        _ target: PushTarget,
        state: AssistantState?
    ) -> PadAssistantTargetResolution? {
        if let delegationId = target.delegationId,
           state?.delegations.contains(where: { $0.id == delegationId }) == true {
            return .delegation(delegationId)
        }
        guard let itemId = target.itemId else { return nil }
        if state?.inbox.contains(where: { $0.id == itemId }) == true {
            return .inboxItem(itemId)
        }
        let tasks = PadAssistantProjection(state: state).personalTasks
        if let task = tasks.first(where: {
            $0.id == itemId || $0.id == "todo:\(itemId)"
                || $0.id == "schedule:\(itemId)" || $0.id == "delegation:\(itemId)"
                || $0.sources.contains(where: { $0.id == itemId })
        }) {
            return .task(task.id)
        }
        return nil
    }

    func openDomain(_ next: PadDomain) {
        domain = next
        if next == .assistant, selection == nil {
            assistantSection = .today
            selection = .assistantChat
        }
    }

    func openAssistant(section: PadAssistantSection = .today, selection next: PadSelection? = .assistantChat) {
        domain = .assistant
        setAssistantSection(section)
        selection = next
        inspectorMode = .detail
        inspectorPresented = next?.hasInspectorDetail == true
    }

    func select(_ next: PadSelection?) {
        inspectorNavigation.select(next)
        inspectorPresented = next?.hasInspectorDetail == true
    }

    func openDelegation(_ id: String) {
        domain = .assistant
        setAssistantSection(.tasks)
        selection = .delegation(id)
        inspectorMode = .detail
        inspectorPresented = true
    }

    func openPreview(returningTo returnSelection: PadSelection? = nil) {
        inspectorNavigation.openPreview(returningTo: returnSelection)
        inspectorPresented = true
    }

    func restoreAfterPreview() {
        guard case let .preview(returnTo) = inspectorNavigation.mode else { return }
        inspectorNavigation.restoreAfterPreview()
        inspectorPresented = returnTo?.hasInspectorDetail == true
    }

    /// 用户主动关闭 Inspector：清掉预览模式，但不因 returnTo 再把 Inspector 弹回来。
    func dismissInspector() {
        inspectorNavigation.restoreAfterPreview()
        inspectorPresented = false
    }

    func route(_ target: PushTarget, presentSelection: Bool = true) {
        let destination = Self.destination(for: target)
        domain = destination.domain
        if let section = destination.section { setAssistantSection(section) }
        selection = presentSelection ? destination.selection : nil
        inspectorMode = .detail
        inspectorPresented = presentSelection && destination.selection?.hasInspectorDetail == true
    }

    func queueVoice(_ capture: AssistantCaptureBridge.Capture) {
        pendingVoiceCapture = capture
        openAssistant()
    }

    func takePendingVoice() -> AssistantCaptureBridge.Capture? {
        defer { pendingVoiceCapture = nil }
        return pendingVoiceCapture
    }

    func presentSearch() {
        searchPresented = true
    }

    func toggleSidebar() {
        sidebarToggleRequest &+= 1
    }

    func beginSemanticDrag(_ kind: PadSemanticTransfer.Kind) {
        activeSemanticDragKind = kind
    }

    func endSemanticDrag(_ kind: PadSemanticTransfer.Kind) {
        if activeSemanticDragKind == kind { activeSemanticDragKind = nil }
    }

    func navigateSectionHistory(by delta: Int) {
        let next = sectionHistoryIndex + delta
        guard sectionHistory.indices.contains(next) else { return }
        sectionHistoryIndex = next
        domain = .assistant
        assistantSection = sectionHistory[next]
        selection = assistantSection == .today ? .assistantChat : nil
        inspectorPresented = false
    }

    private func setAssistantSection(_ section: PadAssistantSection) {
        guard assistantSection != section else { return }
        assistantSection = section
        if sectionHistory.indices.contains(sectionHistoryIndex),
           sectionHistory[sectionHistoryIndex] == section {
            return
        }
        if sectionHistoryIndex + 1 < sectionHistory.count {
            sectionHistory.removeSubrange((sectionHistoryIndex + 1)...)
        }
        sectionHistory.append(section)
        if sectionHistory.count > 30 {
            sectionHistory.removeFirst(sectionHistory.count - 30)
        }
        sectionHistoryIndex = sectionHistory.count - 1
    }
}
