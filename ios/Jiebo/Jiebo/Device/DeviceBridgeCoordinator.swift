import Foundation
import Observation

struct DeviceWriteConfirmation: Identifiable, Sendable, Equatable {
    let id: String
    let action: String
    let title: String
    let time: String?
    let calendar: String
    let details: [String]
    let consequence: String

    var accessibilitySummary: String {
        ([action, title] + [time, calendar].compactMap { $0 } + details + [consequence]).joined(separator: "，")
    }
}

@Observable
@MainActor
final class DeviceBridgeCoordinator {
    let permissionStore = DevicePermissionStore()
    private(set) var confirmation: DeviceWriteConfirmation?

    @ObservationIgnored private let eventKit = AppleEventKitService()
    @ObservationIgnored private let contacts = AppleContactsService()
    @ObservationIgnored private var confirmationContinuation: CheckedContinuation<Bool, Never>?
    @ObservationIgnored private var hasConfirmationPresenter = false

    func install(on store: ChatStore) {
        store.deviceInvokeHandler = { [weak self, weak store] invoke in
            Task { @MainActor [weak self, weak store] in
                guard let self, let store else { return }
                await self.process(invoke, store: store)
            }
        }
        permissionStore.reportHandler = { [weak store] reqId, grants in
            store?.send(.devicePermissionReport(reqId: reqId, grants: grants))
        }
        permissionStore.refresh(forceReport: true)
    }

    func setConfirmationPresenter(active: Bool) {
        hasConfirmationPresenter = active
        if !active, confirmationContinuation != nil {
            resolveConfirmation(allowed: false)
        }
    }

    func resolveConfirmation(allowed: Bool) {
        guard let continuation = confirmationContinuation else { return }
        confirmationContinuation = nil
        confirmation = nil
        continuation.resume(returning: allowed)
    }

    private func process(_ invoke: DeviceInvoke, store: ChatStore) async {
        guard !invoke.reqId.isEmpty, !invoke.op.isEmpty else {
            finish(invoke, status: "error", error: "device_invoke 缺少 reqId 或 op。", store: store)
            return
        }
        // timeoutMs 在收到消息时换成单调时钟的绝对截止点；确认弹窗耗时也计入。
        let deadline = ContinuousClock.now.advanced(
            by: .milliseconds(max(0, invoke.timeoutMs))
        )
        do {
            let output = try await execute(invoke, deadline: deadline)
            permissionStore.refresh(reqId: invoke.reqId)
            finish(
                invoke,
                status: "ok",
                result: output.result,
                externalId: output.externalId,
                store: store
            )
        } catch let error as DeviceRequestError {
            permissionStore.refresh(reqId: invoke.reqId)
            let status: String
            switch error {
            case .permissionDenied: status = "denied"
            case .cancelled: status = "cancelled"
            case .busy: status = "busy"
            case .unavailable: status = "unavailable"
            case .timeout: status = "timeout"
            case .invalid: status = "error"
            }
            finish(invoke, status: status, error: error.localizedDescription, store: store)
        } catch {
            permissionStore.refresh(reqId: invoke.reqId)
            finish(invoke, status: "error", error: "设备操作失败：\(error.localizedDescription)", store: store)
        }
    }

    private func execute(
        _ invoke: DeviceInvoke,
        deadline: ContinuousClock.Instant
    ) async throws -> (result: JSONValue?, externalId: String?) {
        try ensureBeforeDeadline(deadline)
        switch invoke.op {
        case "calendar_events_list":
            return (try await eventKit.listEvents(DeviceRequestValidator.calendarList(invoke.params)), nil)
        case "calendar_event_upsert":
            let draft = try DeviceRequestValidator.calendarEvent(invoke.params)
            try await confirmWrite(invoke: invoke, draft: confirmation(for: draft), deadline: deadline)
            // EventKit 写入前必须再查一次；过期请求绝不落盘。
            try ensureBeforeDeadline(deadline)
            let identifier = try await eventKit.upsertEvent(draft)
            return (.object(["id": .string(identifier)]), identifier)
        case "reminders_list":
            return (try await eventKit.listReminders(DeviceRequestValidator.remindersList(invoke.params)), nil)
        case "reminders_upsert":
            let draft = try DeviceRequestValidator.reminder(invoke.params)
            try await confirmWrite(invoke: invoke, draft: confirmation(for: draft), deadline: deadline)
            // EventKit 写入前必须再查一次；过期请求绝不落盘。
            try ensureBeforeDeadline(deadline)
            let identifier = try await eventKit.upsertReminder(draft)
            return (.object(["id": .string(identifier)]), identifier)
        case "contacts_search":
            return (try await contacts.search(DeviceRequestValidator.contactsSearch(invoke.params)), nil)
        default:
            throw DeviceRequestError.invalid("不支持的设备操作：\(invoke.op)")
        }
    }

    private func confirmWrite(
        invoke: DeviceInvoke,
        draft: DeviceWriteConfirmation,
        deadline: ContinuousClock.Instant
    ) async throws {
        try ensureBeforeDeadline(deadline)
        guard invoke.approval?.requiresConfirmation == true else {
            throw DeviceRequestError.invalid("写入请求缺少 requiresConfirmation，已拒绝执行。")
        }
        guard hasConfirmationPresenter else {
            throw DeviceRequestError.unavailable("当前界面无法显示设备写入确认。")
        }
        guard DeviceWriteConfirmationPolicy.begin(
            hasPendingConfirmation: confirmationContinuation != nil || confirmation != nil
        ) == .ready else {
            throw DeviceRequestError.busy
        }
        let allowed = await withCheckedContinuation { continuation in
            confirmationContinuation = continuation
            confirmation = draft
        }
        // 用户点下允许时可能已经越过网关给出的绝对截止点。
        try ensureBeforeDeadline(deadline)
        guard DeviceWriteConfirmationPolicy.outcome(allowed: allowed) == .allowed else {
            throw DeviceRequestError.cancelled
        }
    }

    private func ensureBeforeDeadline(_ deadline: ContinuousClock.Instant) throws {
        guard ContinuousClock.now < deadline else {
            throw DeviceRequestError.timeout
        }
    }

    private func finish(
        _ invoke: DeviceInvoke,
        status: String,
        result: JSONValue? = nil,
        error: String? = nil,
        externalId: String? = nil,
        store: ChatStore
    ) {
        permissionStore.record(op: invoke.op, status: status)
        store.send(.deviceResult(
            reqId: invoke.reqId,
            op: invoke.op,
            status: status,
            result: result,
            error: error,
            externalId: externalId
        ))
    }

    private func confirmation(for draft: CalendarEventDraft) -> DeviceWriteConfirmation {
        let time = "\(Self.displayDate(draft.start)) 至 \(Self.displayDate(draft.end))"
        var details: [String] = []
        if let location = draft.location { details.append("地点：\(Self.summary(location))") }
        if let notes = draft.notes { details.append("备注摘要：\(Self.summary(notes))") }
        return DeviceWriteConfirmation(
            id: UUID().uuidString,
            action: draft.eventIdentifier == nil ? "新建日历事件" : "修改日历事件",
            title: draft.title,
            time: time,
            calendar: draft.calendarId.map { "日历：\($0)" } ?? "日历：系统默认日历",
            details: details,
            consequence: "允许后将请求日历权限并立即保存到 Apple 日历。"
        )
    }

    private func confirmation(for draft: ReminderDraft) -> DeviceWriteConfirmation {
        var details: [String] = []
        if let notes = draft.notes { details.append("备注摘要：\(Self.summary(notes))") }
        return DeviceWriteConfirmation(
            id: UUID().uuidString,
            action: draft.reminderIdentifier == nil ? "新建提醒事项" : "修改提醒事项",
            title: draft.title,
            time: draft.due.map { "到期：\(Self.displayDate($0))" },
            calendar: draft.calendarId.map { "列表：\($0)" } ?? "列表：系统默认提醒列表",
            details: details,
            consequence: "允许后将请求提醒事项权限并立即保存。"
        )
    }

    private static func displayDate(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }

    private static func summary(_ text: String) -> String {
        let oneLine = text.replacingOccurrences(of: "\n", with: " ")
        return String(oneLine.prefix(120))
    }
}
