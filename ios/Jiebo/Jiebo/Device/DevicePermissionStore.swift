import Contacts
import EventKit
import Foundation
import Observation

struct DevicePermissionState: Sendable, Equatable, Identifiable {
    let id: String
    let title: String
    let purpose: String
    var status: String
    var updatedAt: Date

    var statusLabel: String {
        switch status {
        case "authorized": return "已允许"
        case "denied": return "已拒绝"
        case "restricted": return "受系统限制"
        case "limited": return "部分允许"
        case "write_only": return "仅写入"
        default: return "尚未请求"
        }
    }
}

struct DeviceAuditEntry: Codable, Sendable, Equatable, Identifiable {
    let id: UUID
    let op: String
    let status: String
    let at: Date
}

@Observable
@MainActor
final class DevicePermissionStore {
    private(set) var permissions: [DevicePermissionState] = []
    private(set) var audit: [DeviceAuditEntry] = []
    @ObservationIgnored var reportHandler: ((String?, [JSONValue]) -> Void)?

    private let auditKey = "jiebo.device.audit.v1"
    private let persistQueue = DispatchQueue(label: "ai.jiebo.device.audit.persist", qos: .utility)
    private var initialized = false

    init() {
        if let data = UserDefaults.standard.data(forKey: auditKey),
           let rows = try? JSONDecoder().decode([DeviceAuditEntry].self, from: data)
        {
            audit = Array(rows.prefix(50))
        }
        refresh(forceReport: false)
    }

    func refresh(reqId: String? = nil, forceReport: Bool = false) {
        let calendarStatus = Self.eventKitStatus(EKEventStore.authorizationStatus(for: .event))
        let remindersStatus = Self.eventKitStatus(EKEventStore.authorizationStatus(for: .reminder))
        let contactsStatus = Self.contactsStatus(CNContactStore.authorizationStatus(for: .contacts))
        if initialized,
           permissions.count == 3,
           permissions[0].status == calendarStatus,
           permissions[1].status == remindersStatus,
           permissions[2].status == contactsStatus
        {
            if forceReport {
                reportHandler?(reqId, grants)
            }
            return
        }
        let now = Date()
        permissions = [
            DevicePermissionState(
                id: "calendar",
                title: "日历",
                purpose: "按你的请求读取日历，确认后新建或修改事件。",
                status: calendarStatus,
                updatedAt: now
            ),
            DevicePermissionState(
                id: "reminders",
                title: "提醒事项",
                purpose: "按你的请求读取提醒，确认后新建或修改条目。",
                status: remindersStatus,
                updatedAt: now
            ),
            DevicePermissionState(
                id: "contacts",
                title: "通讯录",
                purpose: "仅在你要求时搜索匹配联系人，不保存联系人正文。",
                status: contactsStatus,
                updatedAt: now
            ),
        ]
        initialized = true
        reportHandler?(reqId, grants)
    }

    func record(op: String, status: String) {
        audit.insert(DeviceAuditEntry(id: UUID(), op: op, status: status, at: Date()), at: 0)
        if audit.count > 50 {
            audit.removeLast(audit.count - 50)
        }
        let snapshot = audit
        let key = auditKey
        // 使用串行后台队列严格保序写盘，避免并发 Task.detached 导致旧快照覆盖新快照。
        persistQueue.async {
            if let data = try? JSONEncoder().encode(snapshot) {
                UserDefaults.standard.set(data, forKey: key)
            }
        }
    }

    private static let isoFormatter = ISO8601DateFormatter()

    private static func isoString(_ date: Date) -> String {
        isoFormatter.string(from: date)
    }

    var grants: [JSONValue] {
        permissions.map { permission in
            .object([
                "permission": .string(permission.id),
                "status": .string(permission.status),
                "canRequest": .bool(permission.status == "not_determined"),
                "updatedAt": .string(Self.isoString(permission.updatedAt)),
            ])
        }
    }

    private static func eventKitStatus(_ status: EKAuthorizationStatus) -> String {
        switch status {
        case .fullAccess, .authorized: return "authorized"
        case .writeOnly: return "write_only"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unknown"
        }
    }

    private static func contactsStatus(_ status: CNAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .limited: return "limited"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unknown"
        }
    }
}
