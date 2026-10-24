import EventKit
import Foundation

actor AppleEventKitService {
    private let store = EKEventStore()

    func listEvents(_ request: CalendarListRequest) async throws -> JSONValue {
        try await requireAccess(to: .event)
        let predicate = store.predicateForEvents(withStart: request.start, end: request.end, calendars: nil)
        let events = Array(store.events(matching: predicate).prefix(request.limit))
        return .object(["events": .array(events.map(Self.eventJSON))])
    }

    func upsertEvent(_ draft: CalendarEventDraft) async throws -> String {
        try await requireAccess(to: .event)
        let event: EKEvent
        if let identifier = draft.eventIdentifier {
            guard let existing = store.event(withIdentifier: identifier) else {
                throw DeviceRequestError.invalid("找不到要更新的日历事件。")
            }
            event = existing
        } else {
            event = EKEvent(eventStore: store)
        }
        event.title = draft.title
        event.startDate = draft.start
        event.endDate = draft.end
        event.timeZone = draft.timeZone
        event.location = draft.location
        event.notes = draft.notes
        if draft.eventIdentifier == nil || draft.calendarId != nil {
            event.calendar = try eventCalendar(identifier: draft.calendarId)
        }
        do {
            try store.save(event, span: .thisEvent, commit: true)
        } catch {
            throw DeviceRequestError.unavailable("保存日历事件失败：\(error.localizedDescription)")
        }
        guard let identifier = event.eventIdentifier, !identifier.isEmpty else {
            throw DeviceRequestError.unavailable("日历已保存，但系统没有返回事件标识。")
        }
        return identifier
    }

    func listReminders(_ request: RemindersListRequest) async throws -> JSONValue {
        try await requireAccess(to: .reminder)
        let predicate = store.predicateForReminders(in: nil)
        let reminders = try await fetchReminders(matching: predicate)
            .filter { request.completed == nil || $0.isCompleted == request.completed }
            .prefix(request.limit)
        return .object(["reminders": .array(reminders.map(Self.reminderJSON))])
    }

    func upsertReminder(_ draft: ReminderDraft) async throws -> String {
        try await requireAccess(to: .reminder)
        let reminder: EKReminder
        if let identifier = draft.reminderIdentifier {
            guard let existing = store.calendarItem(withIdentifier: identifier) as? EKReminder else {
                throw DeviceRequestError.invalid("找不到要更新的提醒事项。")
            }
            reminder = existing
        } else {
            reminder = EKReminder(eventStore: store)
        }
        reminder.title = draft.title
        reminder.notes = draft.notes
        if draft.reminderIdentifier == nil || draft.calendarId != nil {
            reminder.calendar = try reminderCalendar(identifier: draft.calendarId)
        }
        if let due = draft.due {
            reminder.dueDateComponents = Calendar(identifier: .gregorian).dateComponents(
                in: TimeZone.current,
                from: due
            )
        } else {
            reminder.dueDateComponents = nil
        }
        do {
            try store.save(reminder, commit: true)
        } catch {
            throw DeviceRequestError.unavailable("保存提醒事项失败：\(error.localizedDescription)")
        }
        let identifier = reminder.calendarItemIdentifier
        guard !identifier.isEmpty else {
            throw DeviceRequestError.unavailable("提醒事项已保存，但系统没有返回标识。")
        }
        return identifier
    }

    private func requireAccess(to entity: EKEntityType) async throws {
        let current = EKEventStore.authorizationStatus(for: entity)
        switch current {
        case .fullAccess, .authorized:
            return
        case .denied, .restricted:
            throw DeviceRequestError.permissionDenied(entity == .event ? "日历权限已被拒绝。" : "提醒事项权限已被拒绝。")
        case .notDetermined, .writeOnly:
            break
        @unknown default:
            throw DeviceRequestError.unavailable("无法识别 EventKit 权限状态。")
        }
        do {
            let granted: Bool
            switch entity {
            case .event:
                granted = try await store.requestFullAccessToEvents()
            case .reminder:
                granted = try await store.requestFullAccessToReminders()
            @unknown default:
                throw DeviceRequestError.unavailable("不支持的 EventKit 实体。")
            }
            guard granted else {
                throw DeviceRequestError.permissionDenied(entity == .event ? "没有日历访问权限。" : "没有提醒事项访问权限。")
            }
        } catch let error as DeviceRequestError {
            throw error
        } catch {
            let updated = EKEventStore.authorizationStatus(for: entity)
            if updated == .denied || updated == .restricted {
                throw DeviceRequestError.permissionDenied(entity == .event ? "日历权限已被拒绝。" : "提醒事项权限已被拒绝。")
            }
            throw DeviceRequestError.unavailable("请求系统权限失败：\(error.localizedDescription)")
        }
    }

    private func eventCalendar(identifier: String?) throws -> EKCalendar {
        if let identifier {
            guard let calendar = store.calendar(withIdentifier: identifier), calendar.allowsContentModifications else {
                throw DeviceRequestError.invalid("calendarId 对应的日历不存在或不可写。")
            }
            return calendar
        }
        guard let calendar = store.defaultCalendarForNewEvents else {
            throw DeviceRequestError.unavailable("没有可写的默认日历。")
        }
        return calendar
    }

    private func reminderCalendar(identifier: String?) throws -> EKCalendar {
        if let identifier {
            guard let calendar = store.calendar(withIdentifier: identifier),
                  calendar.type != .birthday,
                  calendar.allowsContentModifications
            else {
                throw DeviceRequestError.invalid("calendarId 对应的提醒列表不存在或不可写。")
            }
            return calendar
        }
        guard let calendar = store.defaultCalendarForNewReminders() else {
            throw DeviceRequestError.unavailable("没有可写的默认提醒列表。")
        }
        return calendar
    }

    private func fetchReminders(matching predicate: NSPredicate) async throws -> [EKReminder] {
        await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                continuation.resume(returning: reminders ?? [])
            }
        }
    }

    private static func eventJSON(_ event: EKEvent) -> JSONValue {
        var row: [String: JSONValue] = [
            "id": .string(event.eventIdentifier ?? ""),
            "title": .string(event.title ?? ""),
            "start": .string(iso(event.startDate)),
            "end": .string(iso(event.endDate)),
            "allDay": .bool(event.isAllDay),
            "calendar": .string(event.calendar?.title ?? ""),
            "location": .string(event.location ?? ""),
        ]
        return .object(row)
    }

    private static func reminderJSON(_ reminder: EKReminder) -> JSONValue {
        var row: [String: JSONValue] = [
            "id": .string(reminder.calendarItemIdentifier),
            "title": .string(reminder.title ?? ""),
            "completed": .bool(reminder.isCompleted),
            "calendar": .string(reminder.calendar?.title ?? ""),
            "due": .null,
        ]
        if let components = reminder.dueDateComponents,
           let due = Calendar(identifier: .gregorian).date(from: components)
        {
            row["due"] = .string(iso(due))
        }
        return .object(row)
    }

    private static func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
