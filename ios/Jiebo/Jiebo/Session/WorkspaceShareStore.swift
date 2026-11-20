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
    @ObservationIgnored private var pending: [String: CheckedContinuation<JSONValue, Error>] = [:]
    @ObservationIgnored private var listVersion = UUID()

    func reset() {
        listVersion = UUID()
        items = []
        sendFrame = nil
        let requests = pending.values
        pending.removeAll()
        for request in requests { request.resume(throwing: WorkspaceShareFailure(message: "共享连接已断开")) }
    }

    func request(_ action: String, workspace: String? = nil, fields: [String: JSONValue] = [:]) async throws -> JSONValue {
        guard let sendFrame else { throw WorkspaceShareFailure(message: "共享连接已断开") }
        let id = UUID().uuidString.lowercased()
        var frame = fields
        frame["type"] = .string("workspace_share")
        frame["requestId"] = .string(id)
        frame["action"] = .string(action)
        if let workspace { frame["workspace"] = .string(workspace) }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            sendFrame(.object(frame))
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(12))
                self?.pending.removeValue(forKey: id)?.resume(throwing: WorkspaceShareFailure(message: "共享请求超时，请重试"))
            }
        }
    }

    func refresh() async {
        let version = UUID()
        listVersion = version
        guard let result = try? await request("list"), version == listVersion else { return }
        items = result["items"]?.array?.compactMap { row in
            guard let id = row["id"]?.string, let name = row["name"]?.string, let owner = row["ownerName"]?.string else { return nil }
            return SharedWorkspaceRow(id: id, name: name, ownerName: owner)
        } ?? []
    }

    func handle(_ frame: JSONValue) {
        if frame["type"]?.string == "workspace_share_changed" {
            Task { await refresh() }
        } else if frame["type"]?.string == "workspace_share_result",
                  let id = frame["requestId"]?.string, let request = pending.removeValue(forKey: id) {
            if frame["ok"]?.bool == true { request.resume(returning: frame["data"] ?? .null) }
            else {
                request.resume(throwing: WorkspaceShareFailure(message: frame["error"]?.string ?? "共享操作未完成", code: frame["code"]?.string))
            }
        }
    }
}
