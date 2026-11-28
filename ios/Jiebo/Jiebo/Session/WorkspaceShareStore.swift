import Foundation
import Observation

struct SharedWorkspaceRow: Identifiable, Equatable {
    let id: String
    let name: String
    let ownerName: String
}

struct WorkspaceShareFailure: LocalizedError {
    let message: String
    var code: String? = nil
    var errorDescription: String? { message }
}

/// 接收方只缓存工作区列表，不把文件和授权写入个人会话缓存。
@Observable @MainActor
final class WorkspaceShareStore {
    private(set) var items: [SharedWorkspaceRow] = []
    @ObservationIgnored var sendFrame: ((JSONValue) -> Void)?
    @ObservationIgnored private var pending: [String: (continuation: CheckedContinuation<JSONValue, Error>, timeout: Task<Void, Never>)] = [:]
    @ObservationIgnored private var listVersion = UUID()

    func reset() {
        listVersion = UUID()
        if !items.isEmpty { items = [] }
        sendFrame = nil
        let requests = pending.values
        pending.removeAll()
        for entry in requests {
            entry.timeout.cancel()
            entry.continuation.resume(throwing: WorkspaceShareFailure(message: "共享连接已断开"))
        }
    }

    func request(_ action: String, workspace: String? = nil, fields: [String: JSONValue] = [:]) async throws -> JSONValue {
        guard let sendFrame else { throw WorkspaceShareFailure(message: "共享连接已断开") }
        let id = UUID().uuidString.lowercased()
        var frame = fields
        frame["type"] = .string("workspace_share")
        frame["requestId"] = .string(id)
        frame["action"] = .string(action)
        if let workspace { frame["workspace"] = .string(workspace) }
        let timeoutSeconds = action == "ask" ? 100 : 12
        return try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeoutSeconds))
                guard !Task.isCancelled else { return }
                self?.pending.removeValue(forKey: id)?.continuation.resume(
                    throwing: WorkspaceShareFailure(message: "共享请求超时，请重试")
                )
            }
            pending[id] = (continuation, timeoutTask)
            sendFrame(.object(frame))
        }
    }

    func refresh() async {
        let version = UUID()
        listVersion = version
        guard let result = try? await request("list"), version == listVersion else { return }
        let next = result["items"]?.array?.compactMap { row -> SharedWorkspaceRow? in
            guard let id = row["id"]?.string, let name = row["name"]?.string, let owner = row["ownerName"]?.string else { return nil }
            return SharedWorkspaceRow(id: id, name: name, ownerName: owner)
        } ?? []
        if next != items { items = next }
    }

    func handle(_ frame: JSONValue) {
        if frame["type"]?.string == "workspace_share_changed" {
            Task { await refresh() }
        } else if frame["type"]?.string == "workspace_share_result",
                  let id = frame["requestId"]?.string,
                  let entry = pending.removeValue(forKey: id) {
            entry.timeout.cancel()
            if frame["ok"]?.bool == true {
                entry.continuation.resume(returning: frame["data"] ?? .null)
            } else {
                entry.continuation.resume(
                    throwing: WorkspaceShareFailure(
                        message: frame["error"]?.string ?? "共享操作未完成",
                        code: frame["code"]?.string
                    )
                )
            }
        }
    }
}
