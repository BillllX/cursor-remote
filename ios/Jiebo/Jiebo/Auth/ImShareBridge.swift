import Foundation
import Darwin

// iOS 27 的 Swift 把同名的 `struct flock` 盖住了 C 函数 `flock(2)`。
@_silgen_name("flock")
private func posixFlock(_ fd: Int32, _ operation: Int32) -> Int32

enum ImShareBridge {
    static let appGroup = "group.ai.jiebo.ipad"
    static let snapshotName = "im-share-directory.json"

    struct Person: Codable, Hashable, Identifiable {
        var id: String
        var nickname: String
        var recentAt: Double
    }

    struct Snapshot: Codable {
        var tenant: String
        var sendURL: String
        var uploadSendURL: String
        var assistantIngestURL: String?
        var assistantUploadURL: String?
        var people: [Person]
    }

    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    static func save(_ snapshot: Snapshot) {
        guard let file = container?.appendingPathComponent(snapshotName),
              let data = try? JSONEncoder().encode(snapshot)
        else { return }
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func load() -> Snapshot? {
        guard let file = container?.appendingPathComponent(snapshotName),
              let data = try? Data(contentsOf: file)
        else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    static func clear() {
        guard let file = container?.appendingPathComponent(snapshotName) else { return }
        try? FileManager.default.removeItem(at: file)
    }

    /// Apple 地图分享链接常见的 ll / coordinate 参数；统一按 WGS-84 发给网关。
    static func appleMapLocation(_ url: URL) -> (lat: Double, lng: Double, name: String)? {
        guard url.host?.lowercased().hasSuffix("maps.apple.com") == true,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        let values = Dictionary(uniqueKeysWithValues: (parts.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        let raw = values["ll"] ?? values["coordinate"] ?? ""
        let pair = raw.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard pair.count == 2, (-90 ... 90).contains(pair[0]), (-180 ... 180).contains(pair[1]) else { return nil }
        return (pair[0], pair[1], values["q"] ?? values["name"] ?? "地图位置")
    }
}

/// 每次分享批次使用独立的 background URLSession identifier。
/// 扩展只创建当前批次；主 App 只在系统 handleEvents 回调时按 identifier 接管。
final class ImShareBackgroundQueue: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    static let shared = ImShareBackgroundQueue()
    static let sessionPrefix = "ai.jiebo.ipad.im-share."
    static let changedNotification = Notification.Name("ImShareBackgroundQueueChanged")
    private static let startingClaimGrace: TimeInterval = 60
    private static let orphanRunningTimeout: TimeInterval = 15 * 60

    enum Mode: String, Codable { case json, upload }
    enum State: String, Codable { case queued, running, failed }

    struct Job: Codable, Identifiable {
        var id: String
        var order: Double
        var sessionIdentifier: String?
        var tenant: String?
        var clientId: String
        var mode: Mode
        var endpoint: String
        var uploadKind: String?
        var mime: String
        var message: String?
        var metadataHeader: String?
        var bodyFile: String
        var state: State
        var attempts: Int
        var lastError: String?
        var runningAt: Double?
        var taskToken: String?
        /// 被限流（429）后不早于这个时间再发；用 task.earliestBeginDate 交给系统等，不需要进程常驻。
        var notBefore: Double?
    }

    private struct TaskIdentity {
        var id: String
        var token: String?
    }

    private struct StartingClaim: Codable {
        var token: String
        var createdAt: Double
    }

    private final class SessionState {
        let identifier: String
        let session: URLSession
        var reconciling = false
        var reconcileAgain = false
        var reconcileID: UUID?
        var registrationCallbacks: [(Result<Void, Error>) -> Void] = []
        var backgroundCompletions: [() -> Void] = []
        var backgroundEventsFinished = false
        var backgroundDeadline: UUID?
        var invalidating = false

        init(identifier: String, session: URLSession) {
            self.identifier = identifier
            self.session = session
        }
    }

    private let lock = NSLock()
    private var sessions: [String: SessionState] = [:]
    private let isShareExtension = Bundle.main.bundleIdentifier == "ai.jiebo.ipad.share"

    private override init() {
        super.init()
    }

    static func makeSessionIdentifier() -> String {
        sessionPrefix + UUID().uuidString.lowercased()
    }

    static func isValidSessionIdentifier(_ identifier: String) -> Bool {
        guard identifier.hasPrefix(sessionPrefix) else { return false }
        let suffix = String(identifier.dropFirst(sessionPrefix.count))
        return UUID(uuidString: suffix) != nil
    }

    @discardableResult
    func enqueueJSON(
        _ message: [String: Any], snapshot: ImShareBridge.Snapshot,
        sessionIdentifier: String, order: Int
    ) throws -> String {
        guard JSONSerialization.isValidJSONObject(message),
              let clientId = message["clientId"] as? String
        else { throw QueueError.invalidMessage }
        return try enqueue(
            mode: .json, endpoint: snapshot.sendURL, uploadKind: nil,
            mime: "application/json", message: nil, metadataHeader: nil,
            bodyData: try JSONSerialization.data(withJSONObject: message), sourceFile: nil,
            tenant: snapshot.tenant, clientId: clientId,
            sessionIdentifier: sessionIdentifier, order: order
        )
    }

    @discardableResult
    func enqueueUpload(
        _ file: URL, uploadKind: String, mime: String,
        message: [String: Any], snapshot: ImShareBridge.Snapshot,
        sessionIdentifier: String, order: Int
    ) throws -> String {
        guard JSONSerialization.isValidJSONObject(message),
              let clientId = message["clientId"] as? String
        else { throw QueueError.invalidMessage }
        let encoded = try JSONSerialization.data(withJSONObject: message).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return try enqueue(
            mode: .upload, endpoint: snapshot.uploadSendURL, uploadKind: uploadKind,
            mime: mime, message: encoded, metadataHeader: "X-Jiebo-IM", bodyData: nil, sourceFile: file,
            tenant: snapshot.tenant, clientId: clientId,
            sessionIdentifier: sessionIdentifier, order: order
        )
    }

    @discardableResult
    func enqueueAssistantJSON(
        _ capture: [String: Any], snapshot: ImShareBridge.Snapshot,
        sessionIdentifier: String, order: Int
    ) throws -> String {
        guard let endpoint = snapshot.assistantIngestURL,
              JSONSerialization.isValidJSONObject(capture),
              let clientId = capture["clientId"] as? String
        else { throw QueueError.invalidMessage }
        return try enqueue(
            mode: .json, endpoint: endpoint, uploadKind: nil,
            mime: "application/json", message: nil, metadataHeader: nil,
            bodyData: try JSONSerialization.data(withJSONObject: capture), sourceFile: nil,
            tenant: snapshot.tenant, clientId: clientId,
            sessionIdentifier: sessionIdentifier, order: order
        )
    }

    @discardableResult
    func enqueueAssistantUpload(
        _ file: URL, mime: String, metadata: [String: Any],
        snapshot: ImShareBridge.Snapshot, sessionIdentifier: String, order: Int
    ) throws -> String {
        guard let endpoint = snapshot.assistantUploadURL,
              JSONSerialization.isValidJSONObject(metadata),
              let clientId = metadata["clientId"] as? String
        else { throw QueueError.invalidMessage }
        let encoded = try JSONSerialization.data(withJSONObject: metadata).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return try enqueue(
            mode: .upload, endpoint: endpoint, uploadKind: nil,
            mime: mime, message: encoded, metadataHeader: "X-Jiebo-Assistant",
            bodyData: nil, sourceFile: file,
            tenant: snapshot.tenant, clientId: clientId,
            sessionIdentifier: sessionIdentifier, order: order
        )
    }

    /// 扩展在关闭前等待本批第一条 task 已创建并 resume，不能只把 job 写盘就报告成功。
    func activateBatch(
        _ identifier: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        guard isShareExtension, Self.isValidSessionIdentifier(identifier),
              batchHasPendingJobs(identifier) == true
        else {
            completion(.failure(QueueError.invalidSession))
            return
        }
        guard let state = sessionState(identifier: identifier, create: true) else {
            completion(.failure(QueueError.invalidSession))
            return
        }
        lock.lock()
        state.registrationCallbacks.append(completion)
        lock.unlock()
        reconcile(identifier)
    }

    /// 普通启动不调用；系统只会把某个动态 identifier 的事件交给主 App。
    func handleEvents(identifier: String, completion: @escaping () -> Void) {
        guard !isShareExtension, Self.isValidSessionIdentifier(identifier),
              let state = sessionState(identifier: identifier, create: true)
        else {
            completion()
            return
        }
        lock.lock()
        state.backgroundCompletions.append(completion)
        state.backgroundEventsFinished = false
        let deadline = UUID()
        state.backgroundDeadline = deadline
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 25) { [weak self] in
            self?.finishBackgroundEvents(identifier, deadline: deadline)
        }
        reconcile(identifier)
    }

    /// 换账号时删除旧租户 job，并尽力取消本进程已经接管的 task。
    /// 已交给系统 daemon 的请求可能已到服务器，不能保证撤回；删除后绝不会用新 token 重发。
    func cancel(tenant: String) {
        guard !tenant.isEmpty else { return }
        var removedIds = Set<String>()
        var affectedSessions = Set<String>()
        try? withJobsLock {
            try isolateLegacyQueueLocked()
            for job in try readJobsLocked() where job.tenant == tenant || job.tenant == nil {
                try removeJobLocked(job)
                removedIds.insert(job.id)
                if let identifier = job.sessionIdentifier { affectedSessions.insert(identifier) }
            }
        }
        lock.lock()
        let current = sessions.values.filter { affectedSessions.contains($0.identifier) }
        lock.unlock()
        for state in current {
            state.session.getAllTasks { [weak self] tasks in
                guard let self else { return }
                for task in tasks where self.taskIdentity(task.taskDescription).map({ removedIds.contains($0.id) }) == true {
                    task.cancel()
                }
                self.reconcile(state.identifier)
            }
        }
        if !removedIds.isEmpty { notifyChanged() }
    }

    func failureSummary() -> String? {
        let failed = (jobsSnapshot() ?? []).filter { $0.state == .failed }
        let quarantined = quarantinedJobCount()
        guard !failed.isEmpty || quarantined > 0 else { return nil }
        if quarantined > 0 {
            return "有 \(failed.count) 条分享发送失败，另有 \(quarantined) 条旧版或损坏任务已隔离"
        }
        return "有 \(failed.count) 条分享发送失败，请重新分享"
    }

    func discardFailed() {
        var changed = false
        try? withJobsLock {
            try isolateLegacyQueueLocked()
            for job in try readJobsLocked() where job.state == .failed {
                try removeJobLocked(job)
                changed = true
            }
        }
        if changed { notifyChanged() }
    }

    /// 批次尚未启动时 enqueue 中途失败，回收已经写入的 job/body；running 批次绝不在这里撤销。
    func discardUnstartedBatch(_ identifier: String) {
        var changed = false
        try? withJobsLock {
            let jobs = try readJobsLocked().filter { $0.sessionIdentifier == identifier }
            guard !jobs.contains(where: { $0.state == .running || claimExistsLocked($0.id) }) else { return }
            for job in jobs {
                try removeJobLocked(job)
                changed = true
            }
        }
        if changed { notifyChanged() }
    }

    private func enqueue(
        mode: Mode, endpoint: String, uploadKind: String?, mime: String,
        message: String?, metadataHeader: String?, bodyData: Data?, sourceFile: URL?,
        tenant: String, clientId: String, sessionIdentifier: String, order: Int
    ) throws -> String {
        guard Self.isValidSessionIdentifier(sessionIdentifier),
              URL(string: endpoint) != nil,
              let outbox = outboxURL
        else { throw QueueError.invalidEndpoint }
        try FileManager.default.createDirectory(at: outbox, withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased()
        let relative = "share-\(id).body"
        let target = outbox.appendingPathComponent(relative)
        if let bodyData {
            try bodyData.write(to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } else if let sourceFile {
            try FileManager.default.copyItem(at: sourceFile, to: target)
        } else {
            throw QueueError.invalidMessage
        }
        let job = Job(
            id: id, order: Double(order), sessionIdentifier: sessionIdentifier,
            tenant: tenant, clientId: clientId, mode: mode, endpoint: endpoint,
            uploadKind: uploadKind, mime: mime, message: message, metadataHeader: metadataHeader, bodyFile: relative,
            state: .queued, attempts: 0, lastError: nil, runningAt: nil, taskToken: nil
        )
        do {
            try withJobsLock {
                try isolateLegacyQueueLocked()
                try writeJobLocked(job)
            }
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw error
        }
        notifyChanged()
        return id
    }

    private func sessionState(identifier: String, create: Bool) -> SessionState? {
        guard Self.isValidSessionIdentifier(identifier) else { return nil }
        lock.lock()
        defer { lock.unlock() }
        if let state = sessions[identifier] { return state }
        guard create else { return nil }
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.sharedContainerIdentifier = ImShareBridge.appGroup
        config.sessionSendsLaunchEvents = true
        config.waitsForConnectivity = true
        // 用户点“发送”的首轮允许蜂窝/低数据路径；大媒体失败后的自动重试另行收紧。
        config.allowsExpensiveNetworkAccess = true
        config.allowsConstrainedNetworkAccess = true
        config.httpMaximumConnectionsPerHost = 1
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.name = "\(identifier).delegate"
        let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        let state = SessionState(identifier: identifier, session: session)
        sessions[identifier] = state
        return state
    }

    private func reconcile(_ identifier: String) {
        guard let state = sessionState(identifier: identifier, create: false) else { return }
        lock.lock()
        guard !state.reconciling else {
            state.reconcileAgain = true
            lock.unlock()
            return
        }
        state.reconciling = true
        let reconcileID = UUID()
        state.reconcileID = reconcileID
        lock.unlock()

        state.session.getAllTasks { [weak self, weak state] tasks in
            guard let self, let state else { return }
            let taskRows = tasks.map { ($0, self.taskIdentity($0.taskDescription)) }
            let active = Set(taskRows.compactMap { $0.1?.id })
            let systemHasTask = !tasks.isEmpty
            let deliveringEvents: Bool = {
                self.lock.lock()
                defer { self.lock.unlock() }
                return !state.backgroundCompletions.isEmpty
            }()

            let plan = try? self.withJobsLock { () -> (Job?, Bool, TimeInterval?) in
                try self.isolateLegacyQueueLocked()
                var jobs = try self.readJobsLocked().filter { $0.sessionIdentifier == identifier }
                let now = Date().timeIntervalSince1970
                var reserved = false
                var retryAfter: TimeInterval?
                for index in jobs.indices {
                    if active.contains(jobs[index].id) {
                        self.removeClaimLocked(jobs[index].id)
                        let identity = taskRows.compactMap { $0.1 }.first {
                            $0.id == jobs[index].id
                                && (jobs[index].taskToken == nil || $0.token == jobs[index].taskToken)
                        }
                        jobs[index].state = .running
                        jobs[index].runningAt = now
                        jobs[index].taskToken = identity?.token ?? jobs[index].taskToken
                        try self.writeJobLocked(jobs[index])
                        continue
                    }
                    if jobs[index].state == .running {
                        if jobs[index].runningAt == nil {
                            jobs[index].runningAt = now
                            try self.writeJobLocked(jobs[index])
                        }
                        let remaining = Self.orphanRunningTimeout - (now - (jobs[index].runningAt ?? now))
                        if deliveringEvents || remaining > 0 {
                            reserved = true
                            let delay = deliveringEvents ? min(max(remaining, 1), 30) : remaining
                            retryAfter = min(retryAfter ?? delay, delay)
                            continue
                        }
                        jobs[index].state = .queued
                        jobs[index].runningAt = nil
                        jobs[index].taskToken = nil
                        self.removeClaimLocked(jobs[index].id)
                        try self.writeJobLocked(jobs[index])
                    }
                    if self.claimExistsLocked(jobs[index].id) {
                        let remaining = Self.startingClaimGrace
                            - Date().timeIntervalSince(self.claimDateLocked(jobs[index].id) ?? .distantPast)
                        if remaining > 0 {
                            reserved = true
                            retryAfter = min(retryAfter ?? remaining, remaining)
                            continue
                        }
                        self.removeClaimLocked(jobs[index].id)
                    }
                }
                let next = (systemHasTask || reserved) ? nil : jobs.first {
                    $0.state == .queued && !self.claimExistsLocked($0.id)
                }
                return (next, systemHasTask || active.count > 0, retryAfter)
            }

            guard let plan else {
                self.finishReconcile(state, id: reconcileID)
                DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [weak self] in
                    self?.reconcile(identifier)
                }
                return
            }

            // 只恢复本 session 中可识别的 suspended task；损坏/未知 task 不取消，避免误杀合法请求。
            for (task, identity) in taskRows where identity != nil && task.state == .suspended {
                task.resume()
            }
            let again = self.finishReconcile(state, id: reconcileID)
            if let next = plan.0 {
                if self.start(next, in: state.session) {
                    self.finishRegistration(identifier, result: .success(()))
                    self.finishBackgroundEventsIfReady(identifier, chainEstablished: true)
                } else {
                    self.reconcile(identifier)
                }
            } else if again {
                self.reconcile(identifier)
            } else if let retryAfter = plan.2 {
                DispatchQueue.global().asyncAfter(deadline: .now() + max(0.05, retryAfter)) { [weak self] in
                    self?.reconcile(identifier)
                }
            } else {
                if plan.1 {
                    self.finishRegistration(identifier, result: .success(()))
                } else if self.batchHasPendingJobs(identifier) == false {
                    self.finishRegistration(
                        identifier,
                        result: .failure(QueueError.sessionEnded("后台任务未能启动，请检查登录状态后重试"))
                    )
                }
                self.finishBackgroundEventsIfReady(identifier, chainEstablished: plan.1)
                self.retireSessionIfTerminal(identifier)
            }
        }
    }

    @discardableResult
    private func finishReconcile(_ state: SessionState, id: UUID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard state.reconcileID == id else { return false }
        let again = state.reconcileAgain
        state.reconcileAgain = false
        state.reconciling = false
        state.reconcileID = nil
        return again
    }

    @discardableResult
    private func start(_ candidate: Job, in session: URLSession) -> Bool {
        guard let identifier = candidate.sessionIdentifier,
              identifier == session.configuration.identifier
        else { return false }
        guard let jobTenant = candidate.tenant,
              jobTenant == ImShareBridge.load()?.tenant
        else {
            fail(candidate.id, token: nil, reason: "登录账号已变化，旧分享任务已停止", retry: false)
            return false
        }
        // 只把当前登录的令牌发给当前网关：任务里存的地址和现在的网关不是同一个源就停掉
        guard let current = ImShareBridge.load(),
              Self.sameOrigin(candidate.endpoint, current.sendURL)
        else {
            fail(candidate.id, token: nil, reason: "网关地址已变化，旧分享任务已停止", retry: false)
            return false
        }
        guard let authToken = KeychainStore.token(),
              let body = outboxURL?.appendingPathComponent(candidate.bodyFile),
              FileManager.default.fileExists(atPath: body.path)
        else {
            fail(candidate.id, token: nil, reason: "登录状态已失效或待发文件丢失", retry: false)
            return false
        }
        var endpoint = candidate.endpoint
        if candidate.mode == .upload {
            guard var parts = URLComponents(string: endpoint) else {
                fail(candidate.id, token: nil, reason: "发送地址无效", retry: false)
                return false
            }
            if let uploadKind = candidate.uploadKind {
                parts.queryItems = [
                    URLQueryItem(name: "kind", value: uploadKind),
                    URLQueryItem(name: "mime", value: candidate.mime),
                ]
            }
            guard let value = parts.url?.absoluteString else {
                fail(candidate.id, token: nil, reason: "发送地址无效", retry: false)
                return false
            }
            endpoint = value
        }
        guard let url = URL(string: endpoint) else {
            fail(candidate.id, token: nil, reason: "发送地址无效", retry: false)
            return false
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue(candidate.mime, forHTTPHeaderField: "Content-Type")
        if let message = candidate.message {
            request.setValue(message, forHTTPHeaderField: candidate.metadataHeader ?? "X-Jiebo-IM")
        }
        let bodyBytes = (try? body.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if candidate.attempts > 0, bodyBytes > 5 * 1024 * 1024 {
            // 首轮是用户主动分享；大媒体重试不在 Low Data Mode 下反复唤醒后台会话。
            request.allowsConstrainedNetworkAccess = false
        }
        let attemptToken = UUID().uuidString.lowercased()
        let started = (try? withJobsLock { () -> Bool in
            guard var job = try readJobLocked(candidate.id),
                  job.sessionIdentifier == identifier, job.state == .queued,
                  createClaimLocked(candidate.id, token: attemptToken)
            else { return false }
            let task = session.uploadTask(with: request, fromFile: body)
            if let notBefore = job.notBefore, notBefore > Date().timeIntervalSince1970 {
                task.earliestBeginDate = Date(timeIntervalSince1970: notBefore)
            }
            task.taskDescription = "\(candidate.id)|\(attemptToken)"
            task.resume()
            job.state = .running
            job.attempts += 1
            job.runningAt = Date().timeIntervalSince1970
            job.taskToken = attemptToken
            do {
                try writeJobLocked(job)
                removeClaimLocked(candidate.id)
            } catch {}
            return true
        }) ?? false
        if started { notifyChanged() }
        return started
    }

    private static func sameOrigin(_ lhs: String, _ rhs: String) -> Bool {
        guard let a = URLComponents(string: lhs), let b = URLComponents(string: rhs),
              let schemeA = a.scheme?.lowercased(), let hostA = a.host?.lowercased()
        else { return false }
        func port(_ c: URLComponents, _ scheme: String) -> Int { c.port ?? (scheme == "https" ? 443 : 80) }
        return schemeA == b.scheme?.lowercased() && hostA == b.host?.lowercased()
            && port(a, schemeA) == port(b, schemeA)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let identifier = session.configuration.identifier,
              Self.isValidSessionIdentifier(identifier)
        else { return }
        guard let identity = taskIdentity(task.taskDescription) else {
            // 未识别 task 不在运行中取消；等它自然结束后重新对账，不能永久挡住本批后续 job。
            reconcile(identifier)
            return
        }
        let status = (task.response as? HTTPURLResponse)?.statusCode
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            let another = tasks.contains {
                $0.taskIdentifier != task.taskIdentifier
                    && self.taskIdentity($0.taskDescription)?.id == identity.id
            }
            guard !another else {
                self.reconcile(identifier)
                return
            }
            if error == nil, let status, (200 ..< 300).contains(status) {
                self.complete(identity.id, token: identity.token)
            } else {
                let reason = error?.localizedDescription ?? "服务器返回 \(status ?? 0)"
                let retry = error != nil || status == 408 || status == 429 || status.map { $0 >= 500 } == true
                // 限流：按 Retry-After（缺省 60 秒，再加 5 秒余量）往后排，不立刻重试；间隔拉长了，所以重试上限放宽到 6 次
                var notBefore: Double?
                if status == 429 {
                    let header = (task.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After")
                    let wait = min(max(header.flatMap(Double.init) ?? 60, 5), 300) + 5
                    notBefore = Date().timeIntervalSince1970 + wait
                }
                self.fail(identity.id, token: identity.token, reason: reason, retry: retry, notBefore: notBefore)
            }
            self.reconcile(identifier)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let identifier = session.configuration.identifier,
              let state = sessionState(identifier: identifier, create: false)
        else { return }
        lock.lock()
        state.backgroundEventsFinished = true
        lock.unlock()
        reconcile(identifier)
    }

    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        guard let identifier = session.configuration.identifier else { return }
        lock.lock()
        guard let state = sessions[identifier], state.session === session else {
            lock.unlock()
            return
        }
        sessions.removeValue(forKey: identifier)
        let registrations = state.registrationCallbacks
        let completions = state.backgroundCompletions
        let shouldFailBatch = !state.invalidating
        lock.unlock()
        let reason = error?.localizedDescription ?? "后台发送会话已结束"
        if shouldFailBatch {
            failBatch(identifier, reason: reason)
        }
        DispatchQueue.main.async {
            registrations.forEach { $0(.failure(QueueError.sessionEnded(reason))) }
            completions.forEach { $0() }
        }
    }

    private func complete(_ id: String, token: String?) {
        var changed = false
        try? withJobsLock {
            guard let job = try readJobLocked(id) else { return }
            guard job.taskToken == token || (job.taskToken == nil && claimTokenLocked(id) == token) else { return }
            try removeJobLocked(job)
            changed = true
        }
        if changed { notifyChanged() }
    }

    private func fail(_ id: String, token: String?, reason: String, retry: Bool, notBefore: Double? = nil) {
        var changed = false
        try? withJobsLock {
            guard var job = try readJobLocked(id) else { return }
            if let token {
                guard job.taskToken == token || claimTokenLocked(id) == token else { return }
            } else {
                guard job.taskToken == nil, claimTokenLocked(id) == nil else { return }
            }
            job.lastError = reason
            // 限流导致的重试间隔拉长了，次数放宽到 6；其他失败仍是 3 次
            job.notBefore = notBefore
            job.state = retry && job.attempts < (notBefore == nil ? 3 : 6) ? .queued : .failed
            job.runningAt = nil
            job.taskToken = nil
            try writeJobLocked(job)
            removeClaimLocked(id)
            changed = true
        }
        if changed { notifyChanged() }
    }

    private func failBatch(_ identifier: String, reason: String) {
        var changed = false
        try? withJobsLock {
            for var job in try readJobsLocked()
            where job.sessionIdentifier == identifier && job.state != .failed {
                job.state = .failed
                job.lastError = reason
                job.runningAt = nil
                job.taskToken = nil
                try writeJobLocked(job)
                removeClaimLocked(job.id)
                changed = true
            }
        }
        if changed { notifyChanged() }
    }

    private func finishRegistration(_ identifier: String, result: Result<Void, Error>) {
        guard let state = sessionState(identifier: identifier, create: false) else { return }
        lock.lock()
        let callbacks = state.registrationCallbacks
        state.registrationCallbacks = []
        lock.unlock()
        DispatchQueue.main.async { callbacks.forEach { $0(result) } }
    }

    private func finishBackgroundEventsIfReady(_ identifier: String, chainEstablished: Bool = false) {
        guard let pending = batchHasPendingJobs(identifier),
              let state = sessionState(identifier: identifier, create: false)
        else { return }
        lock.lock()
        guard state.backgroundEventsFinished, !state.reconciling,
              chainEstablished || !pending
        else {
            lock.unlock()
            return
        }
        let completions = state.backgroundCompletions
        state.backgroundCompletions = []
        state.backgroundEventsFinished = false
        state.backgroundDeadline = nil
        lock.unlock()
        DispatchQueue.main.async { completions.forEach { $0() } }
    }

    /// 兜底只归还系统 completion，不改 job、不重排 task，后续 daemon 唤醒仍按持久状态继续。
    private func finishBackgroundEvents(_ identifier: String, deadline: UUID) {
        guard let state = sessionState(identifier: identifier, create: false) else { return }
        lock.lock()
        guard state.backgroundDeadline == deadline else {
            lock.unlock()
            return
        }
        let completions = state.backgroundCompletions
        state.backgroundCompletions = []
        state.backgroundEventsFinished = false
        state.backgroundDeadline = nil
        lock.unlock()
        DispatchQueue.main.async { completions.forEach { $0() } }
    }

    private func retireSessionIfTerminal(_ identifier: String) {
        guard batchHasPendingJobs(identifier) == false,
              let state = sessionState(identifier: identifier, create: false)
        else { return }
        lock.lock()
        guard state.backgroundCompletions.isEmpty, !state.invalidating else {
            lock.unlock()
            return
        }
        state.invalidating = true
        lock.unlock()
        state.session.finishTasksAndInvalidate()
    }

    private func taskIdentity(_ description: String?) -> TaskIdentity? {
        guard let description, !description.isEmpty else { return nil }
        let parts = description.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
        return TaskIdentity(
            id: String(parts[0]),
            token: parts.count == 2 && !parts[1].isEmpty ? String(parts[1]) : nil
        )
    }

    private var legacyQueueFile: URL? {
        ImShareBridge.container?.appendingPathComponent("share-jobs.json")
    }

    private var jobsDirectory: URL? {
        ImShareBridge.container?.appendingPathComponent("share-jobs", isDirectory: true)
    }

    private var outboxURL: URL? {
        ImShareBridge.container?.appendingPathComponent("share-outbox", isDirectory: true)
    }

    private func withJobsLock<T>(_ body: () throws -> T) throws -> T {
        guard let container = ImShareBridge.container, let jobsDirectory else { throw QueueError.noContainer }
        try FileManager.default.createDirectory(at: jobsDirectory, withIntermediateDirectories: true)
        let file = container.appendingPathComponent("share-jobs.lock")
        let descriptor = file.path.withCString { Darwin.open($0, O_CREAT | O_RDWR, mode_t(0o600)) }
        guard descriptor >= 0 else { throw QueueError.storage }
        defer { Darwin.close(descriptor) }
        guard posixFlock(descriptor, LOCK_EX) == 0 else { throw QueueError.storage }
        defer { _ = posixFlock(descriptor, LOCK_UN) }
        return try body()
    }

    private func jobsSnapshot() -> [Job]? {
        try? withJobsLock {
            try isolateLegacyQueueLocked()
            return try readJobsLocked()
        }
    }

    private func batchHasPendingJobs(_ identifier: String) -> Bool? {
        jobsSnapshot()?.contains {
            $0.sessionIdentifier == identifier && ($0.state == .queued || $0.state == .running)
        }
    }

    private func quarantinedJobCount() -> Int {
        (try? withJobsLock {
            guard let jobsDirectory else { throw QueueError.noContainer }
            return try FileManager.default.contentsOfDirectory(atPath: jobsDirectory.path)
                .filter { $0.hasPrefix("quarantine-") }.count
        }) ?? 0
    }

    private func jobURL(_ id: String) -> URL? {
        jobsDirectory?.appendingPathComponent("job-\(id).json")
    }

    private func claimURL(_ id: String) -> URL? {
        jobsDirectory?.appendingPathComponent("claim-\(id)")
    }

    private func readJobsLocked() throws -> [Job] {
        guard let jobsDirectory else { throw QueueError.noContainer }
        let files = try FileManager.default.contentsOfDirectory(
            at: jobsDirectory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]
        )
        var jobs: [Job] = []
        for file in files {
            let name = file.lastPathComponent
            guard name.hasPrefix("job-"), name.hasSuffix(".json") else { continue }
            let data = try Data(contentsOf: file)
            guard let job = try? JSONDecoder().decode(Job.self, from: data),
                  name == "job-\(job.id).json",
                  let identifier = job.sessionIdentifier,
                  Self.isValidSessionIdentifier(identifier)
            else {
                try quarantineJobLocked(file)
                continue
            }
            jobs.append(job)
        }
        return jobs.sorted {
            if $0.sessionIdentifier == $1.sessionIdentifier, $0.order != $1.order {
                return $0.order < $1.order
            }
            if $0.sessionIdentifier != $1.sessionIdentifier {
                return ($0.sessionIdentifier ?? "") < ($1.sessionIdentifier ?? "")
            }
            return $0.id < $1.id
        }
    }

    private func readJobLocked(_ id: String) throws -> Job? {
        guard let file = jobURL(id), FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try JSONDecoder().decode(Job.self, from: Data(contentsOf: file))
    }

    private func writeJobLocked(_ job: Job) throws {
        guard let file = jobURL(job.id) else { throw QueueError.noContainer }
        try JSONEncoder().encode(job).write(
            to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }

    private func quarantineJobLocked(_ file: URL) throws {
        guard let jobsDirectory else { throw QueueError.noContainer }
        let target = jobsDirectory.appendingPathComponent(
            "quarantine-\(UUID().uuidString.lowercased())-\(file.lastPathComponent)"
        )
        try FileManager.default.moveItem(at: file, to: target)
    }

    /// 固定 identifier 版本没有批次归属，不能安全接到任意新 session；整体幂等隔离。
    private func isolateLegacyQueueLocked() throws {
        if let owner = ImShareBridge.container?.appendingPathComponent("share-session-owner"),
           FileManager.default.fileExists(atPath: owner.path) {
            try? FileManager.default.removeItem(at: owner)
        }
        guard let legacyQueueFile, FileManager.default.fileExists(atPath: legacyQueueFile.path),
              let jobsDirectory
        else { return }
        let target = jobsDirectory.appendingPathComponent("quarantine-legacy-share-jobs.json")
        if FileManager.default.fileExists(atPath: target.path) {
            try FileManager.default.removeItem(at: legacyQueueFile)
        } else {
            try FileManager.default.moveItem(at: legacyQueueFile, to: target)
        }
    }

    private func createClaimLocked(_ id: String, token: String) -> Bool {
        guard let file = claimURL(id) else { return false }
        let descriptor = file.path.withCString {
            Darwin.open($0, O_WRONLY | O_CREAT | O_EXCL, mode_t(0o600))
        }
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }
        guard let bytes = try? JSONEncoder().encode(
            StartingClaim(token: token, createdAt: Date().timeIntervalSince1970)
        ) else { return false }
        let written = bytes.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
        return written == bytes.count
    }

    private func claimExistsLocked(_ id: String) -> Bool {
        guard let file = claimURL(id) else { return false }
        return FileManager.default.fileExists(atPath: file.path)
    }

    private func claimDateLocked(_ id: String) -> Date? {
        guard let file = claimURL(id) else { return nil }
        if let data = try? Data(contentsOf: file),
           let claim = try? JSONDecoder().decode(StartingClaim.self, from: data) {
            return Date(timeIntervalSince1970: claim.createdAt)
        }
        return try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    }

    private func claimTokenLocked(_ id: String) -> String? {
        guard let file = claimURL(id),
              let data = try? Data(contentsOf: file),
              let claim = try? JSONDecoder().decode(StartingClaim.self, from: data)
        else { return nil }
        return claim.token
    }

    private func removeClaimLocked(_ id: String) {
        if let file = claimURL(id) { try? FileManager.default.removeItem(at: file) }
    }

    private func removeJobLocked(_ job: Job) throws {
        if let file = jobURL(job.id), FileManager.default.fileExists(atPath: file.path) {
            try FileManager.default.removeItem(at: file)
        }
        removeClaimLocked(job.id)
        let stillUsed = try? readJobsLocked().contains { $0.bodyFile == job.bodyFile }
        let hasQuarantine = (try? FileManager.default.contentsOfDirectory(atPath: jobsDirectory?.path ?? "")
            .contains { $0.hasPrefix("quarantine-") }) ?? true
        if stillUsed == false, !hasQuarantine,
           let body = outboxURL?.appendingPathComponent(job.bodyFile) {
            try? FileManager.default.removeItem(at: body)
        }
    }

    private func notifyChanged() {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.changedNotification, object: nil)
        }
    }

    enum QueueError: LocalizedError {
        case noContainer, invalidEndpoint, invalidMessage, invalidSession, storage
        case sessionEnded(String)

        var errorDescription: String? {
            switch self {
            case .noContainer: return "共享存储不可用，请打开主 App 重试"
            case .invalidEndpoint: return "发送地址无效"
            case .invalidMessage: return "分享内容无效"
            case .invalidSession: return "后台发送批次无效，请重试"
            case .storage: return "共享发送队列暂时不可用，请稍后重试"
            case .sessionEnded(let reason): return reason
            }
        }
    }
}
