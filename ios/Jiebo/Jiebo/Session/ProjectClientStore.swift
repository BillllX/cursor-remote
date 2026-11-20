import Foundation
import Observation

/// 项目只保存在内存，不进入个人 ChatCache / AppBootstrapCache。
@Observable @MainActor
final class ProjectClientStore {
    var items: [JSONValue] = []
    var invitations: [JSONValue] = []
    var selected: JSONValue?
    var files: [JSONValue] = []
    var chats: [JSONValue] = []
    var messages: [JSONValue] = []
    var notice = ""
    var online = false
    @ObservationIgnored var sendFrame: ((JSONValue) -> Void)?
    @ObservationIgnored private var pending: [String: CheckedContinuation<JSONValue, Error>] = [:]

    @ObservationIgnored private var projectID: String?
    @ObservationIgnored private var selection = UUID()

    private func clearSelection(_ next: String? = nil) {
        selection = UUID()
        projectID = next
        selected = nil
        files = []
        chats = []
        messages = []
    }

    func reset() {
        for promise in pending.values { promise.resume(throwing: failure("连接或账号已变化")) }
        pending.removeAll()
        items = []; invitations = []; clearSelection()
        online = false
    }
    private func failure(_ text: String) -> NSError {
        NSError(domain: "JieboProjects", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
    func request(_ action: String, project: String? = nil, payload: [String: JSONValue] = [:]) async throws -> JSONValue {
        guard online, let sendFrame else { throw failure("共享项目离线，未保存到项目") }
        let epoch = selection
        if let project, project != projectID, action != "project_unsubscribe" {
            throw failure("项目已切换或关闭")
        }
        let id = UUID().uuidString.lowercased()
        var frame: [String: JSONValue] = ["type": .string("project_request"), "protocol": .number(1), "requestId": .string(id), "action": .string(action), "payload": .object(payload)]
        if let project { frame["workspaceId"] = .string(project) }
        let result: JSONValue = try await withCheckedThrowingContinuation { promise in
            pending[id] = promise
            sendFrame(.object(frame))
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(30))
                guard let self, let expired = self.pending.removeValue(forKey: id) else { return }
                expired.resume(throwing: self.failure("请求超时，请刷新确认后重试"))
            }
        }
        if project != nil, action != "project_unsubscribe", selection != epoch {
            throw failure("项目已切换或关闭")
        }
        return result
    }
    func saveFile(project: String, path: String, text: String, revision: Int) async throws {
        let epoch = selection
        guard projectID == project else { throw failure("项目已切换或关闭") }
        guard let token = KeychainStore.token(), var url = URLComponents(url: GatewayConfig.url, resolvingAgainstBaseURL: false) else { throw failure("尚未登录") }
        url.scheme = url.scheme == "wss" ? "https" : "http"
        url.path = url.path.replacingOccurrences(of: "/bridge", with: "/upload/projects/" + project)
        url.query = nil
        guard let endpoint = url.url else { throw failure("上传地址不合法") }
        var upload = URLRequest(url: endpoint)
        upload.httpMethod = "POST"
        upload.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        upload.setValue("1", forHTTPHeaderField: "X-Jiebo-Project-Protocol")
        upload.httpBody = Data(text.utf8)
        let (bytes, response) = try await AppTrafficHTTP.data(for: upload, category: "projects")
        guard selection == epoch else { throw failure("项目已切换或关闭") }
        let result = try JSONValue.parse(bytes)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let uploadId = result["data"]?["uploadId"]?.string else { throw failure(result["error"]?["message"]?.string ?? "项目上传失败") }
        _ = try await request("project_commit", project: project, payload: ["operationId": .string(UUID().uuidString.lowercased()), "expectedRevision": .number(Double(revision)), "changes": .array([.object(["kind": .string("put"), "path": .string(path), "uploadId": .string(uploadId)])])])
        try await open(project)
        notice = "已保存到共享项目"
    }
    func handle(_ value: JSONValue) {
        let type = value["type"]?.string ?? ""
        if type == "project_result", let id = value["requestId"]?.string, let promise = pending.removeValue(forKey: id) {
            if value["ok"]?.bool == true { promise.resume(returning: value["data"] ?? .null) }
            else { promise.resume(throwing: failure(value["error"]?["message"]?.string ?? "项目操作失败")) }
        } else if type == "project_access_revoked", let projectID, value["workspaceId"]?.string == projectID {
            clearSelection()
            notice = "项目权限已变化，请刷新"
        } else if type == "project_event" { notice = "项目有更新，请刷新；未保存草稿不会自动覆盖" }
    }
    func refresh() async throws {
        items = try await request("project_list")["items"]?.array ?? []
        invitations = try await request("project_inbox")["items"]?.array ?? []
    }
    func open(_ id: String) async throws {
        if projectID != id {
            let previous = projectID
            clearSelection(id)
            if let previous { _ = try? await request("project_unsubscribe", project: previous) }
            guard projectID == id else { throw failure("项目已切换或关闭") }
        }
        let snapshot = try await request("project_snapshot", project: id)
        let tree = try await request("project_tree", project: id)
        _ = try await request("project_subscribe", project: id, payload: ["afterEventSeq": snapshot["eventSeq"] ?? .number(0)])
        selected = snapshot["summary"]
        chats = snapshot["chatSummaries"]?.array ?? []
        files = tree["items"]?.array ?? []
    }
}
