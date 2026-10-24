import Foundation

enum DeviceRequestError: Error, Equatable, LocalizedError {
    case invalid(String)
    case permissionDenied(String)
    case unavailable(String)
    case busy
    case cancelled
    case timeout

    var errorDescription: String? {
        switch self {
        case .invalid(let message), .permissionDenied(let message), .unavailable(let message):
            return message
        case .busy:
            return "已有设备写入等待确认，请稍后再试。"
        case .cancelled:
            return "用户取消了设备写入。"
        case .timeout:
            return "设备操作超时。"
        }
    }
}

struct CalendarListRequest: Sendable, Equatable {
    let start: Date
    let end: Date
    let limit: Int
}

struct CalendarEventDraft: Sendable, Equatable {
    let eventIdentifier: String?
    let title: String
    let start: Date
    let end: Date
    let timeZone: TimeZone?
    let calendarId: String?
    let location: String?
    let notes: String?
}

struct RemindersListRequest: Sendable, Equatable {
    let completed: Bool?
    let limit: Int
}

struct ReminderDraft: Sendable, Equatable {
    let reminderIdentifier: String?
    let title: String
    let due: Date?
    let calendarId: String?
    let notes: String?
}

struct ContactsSearchRequest: Sendable, Equatable {
    let query: String
    let limit: Int
}

enum DeviceConfirmationStart: Equatable {
    case ready
    case busy
}

enum DeviceConfirmationOutcome: Equatable {
    case allowed
    case denied
}

enum DeviceWriteConfirmationPolicy {
    static func begin(hasPendingConfirmation: Bool) -> DeviceConfirmationStart {
        hasPendingConfirmation ? .busy : .ready
    }

    static func outcome(allowed: Bool) -> DeviceConfirmationOutcome {
        allowed ? .allowed : .denied
    }
}

enum DeviceRequestValidator {
    static let maximumRange: TimeInterval = 90 * 24 * 60 * 60

    static func calendarList(_ params: JSONValue) throws -> CalendarListRequest {
        let row = try object(params)
        let start = try date(row, "start")
        let end = try date(row, "end")
        try validateRange(start: start, end: end)
        return CalendarListRequest(start: start, end: end, limit: try limit(row, maximum: 50, fallback: 50))
    }

    static func calendarEvent(_ params: JSONValue) throws -> CalendarEventDraft {
        let row = try object(params)
        let title = try requiredText(row, "title", maximumLength: 200)
        let start = try date(row, "start")
        let end = try date(row, "end")
        try validateRange(start: start, end: end)
        let timeZone: TimeZone?
        if let identifier = try optionalText(row, "timeZone", maximumLength: 100) {
            guard let parsed = TimeZone(identifier: identifier) else {
                throw DeviceRequestError.invalid("timeZone 不是有效的 IANA 时区。")
            }
            timeZone = parsed
        } else {
            timeZone = nil
        }
        return CalendarEventDraft(
            eventIdentifier: try optionalText(row, "id", aliases: ["eventIdentifier", "externalId"], maximumLength: 512),
            title: title,
            start: start,
            end: end,
            timeZone: timeZone,
            calendarId: try optionalText(row, "calendarId", maximumLength: 512),
            location: try optionalText(row, "location", maximumLength: 500),
            notes: try optionalText(row, "notes", maximumLength: 4_000)
        )
    }

    static func remindersList(_ params: JSONValue) throws -> RemindersListRequest {
        let row = try object(params)
        var completed: Bool?
        if let raw = row["completed"] {
            guard let value = raw.bool else { throw DeviceRequestError.invalid("completed 必须是布尔值。") }
            completed = value
        }
        return RemindersListRequest(completed: completed, limit: try limit(row, maximum: 50, fallback: 50))
    }

    static func reminder(_ params: JSONValue) throws -> ReminderDraft {
        let row = try object(params)
        return ReminderDraft(
            reminderIdentifier: try optionalText(row, "id", aliases: ["reminderIdentifier", "externalId"], maximumLength: 512),
            title: try requiredText(row, "title", maximumLength: 200),
            due: try optionalDate(row, "due"),
            calendarId: try optionalText(row, "calendarId", aliases: ["listId"], maximumLength: 512),
            notes: try optionalText(row, "notes", maximumLength: 4_000)
        )
    }

    static func contactsSearch(_ params: JSONValue) throws -> ContactsSearchRequest {
        let row = try object(params)
        return ContactsSearchRequest(
            query: try requiredText(row, "query", maximumLength: 200),
            limit: try limit(row, maximum: 20, fallback: 20)
        )
    }

    static func validateRange(start: Date, end: Date) throws {
        guard end > start else { throw DeviceRequestError.invalid("end 必须晚于 start。") }
        guard end.timeIntervalSince(start) <= maximumRange else {
            throw DeviceRequestError.invalid("日期范围不能超过 90 天。")
        }
    }

    private static func object(_ value: JSONValue) throws -> [String: JSONValue] {
        guard let row = value.object else { throw DeviceRequestError.invalid("params 必须是对象。") }
        return row
    }

    private static func requiredText(
        _ row: [String: JSONValue],
        _ key: String,
        aliases: [String] = [],
        maximumLength: Int
    ) throws -> String {
        guard let value = try optionalText(row, key, aliases: aliases, maximumLength: maximumLength) else {
            throw DeviceRequestError.invalid("\(key) 不能为空。")
        }
        return value
    }

    private static func optionalText(
        _ row: [String: JSONValue],
        _ key: String,
        aliases: [String] = [],
        maximumLength: Int
    ) throws -> String? {
        let raw = ([key] + aliases).compactMap { row[$0] }.first
        guard let raw else { return nil }
        if case .null = raw { return nil }
        guard let string = raw.string else { throw DeviceRequestError.invalid("\(key) 必须是字符串。") }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.count <= maximumLength else {
            throw DeviceRequestError.invalid("\(key) 过长（最多 \(maximumLength) 个字符）。")
        }
        return trimmed
    }

    private static func date(_ row: [String: JSONValue], _ key: String) throws -> Date {
        guard let raw = row[key]?.string, let value = parseISO8601(raw) else {
            throw DeviceRequestError.invalid("\(key) 必须是带时区的 ISO 8601 日期。")
        }
        return value
    }

    private static func optionalDate(_ row: [String: JSONValue], _ key: String) throws -> Date? {
        guard let raw = row[key] else { return nil }
        if case .null = raw { return nil }
        guard let text = raw.string, let value = parseISO8601(text) else {
            throw DeviceRequestError.invalid("\(key) 必须是带时区的 ISO 8601 日期。")
        }
        return value
    }

    private static func limit(_ row: [String: JSONValue], maximum: Int, fallback: Int) throws -> Int {
        guard let raw = row["limit"] else { return fallback }
        guard let number = raw.number, number.isFinite, number.rounded() == number,
              number >= 1, number <= Double(maximum)
        else {
            throw DeviceRequestError.invalid("limit 必须是 1...\(maximum) 的整数。")
        }
        return Int(number)
    }

    private static func parseISO8601(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        let regular = ISO8601DateFormatter()
        regular.formatOptions = [.withInternetDateTime]
        return regular.date(from: text)
    }
}
