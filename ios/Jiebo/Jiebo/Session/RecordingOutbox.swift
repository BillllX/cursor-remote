import AVFoundation
import CryptoKit
import Foundation
import Speech

/// 封口后的音频段是补转写与回听依据。每段文字单独原子落盘，断网、挂起或重试均复用既有结果。
enum RecordingOutbox {
    struct Piece: Codable, Sendable {
        let text: String
        let frames: Int
    }

    struct LocalChunkInfo: Sendable {
        let seq: Int
        let url: URL
        let startFrame: Int
        let frames: Int
        let bytes: Int
        let sha256: String
    }

    static func root(tenant: String) throws -> URL {
        let scope = GatewayConfig.recordingsUploadBaseURL.absoluteString + "|" + tenant
        let key = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        var url = base.appendingPathComponent("PersonalRecordings").appendingPathComponent(key)
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        var flags = URLResourceValues()
        flags.isExcludedFromBackup = true
        try url.setResourceValues(flags)
        return url
    }

    static func pieces(_ folder: URL) throws -> [URL] {
        guard FileManager.default.fileExists(atPath: folder.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "m4a" && Int($0.deletingPathExtension().lastPathComponent) != nil }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    static func metaURL(in folder: URL) -> URL {
        folder.appendingPathComponent("meta.json")
    }

    static func loadMeta(in folder: URL) -> LocalRecordingMeta? {
        guard let data = try? Data(contentsOf: metaURL(in: folder)) else { return nil }
        return try? JSONDecoder().decode(LocalRecordingMeta.self, from: data)
    }

    static func saveMeta(_ meta: LocalRecordingMeta, in folder: URL) {
        guard let data = try? JSONEncoder().encode(meta) else { return }
        try? data.write(to: metaURL(in: folder), options: .atomic)
    }

    static func transferError(in folder: URL) -> String? {
        let url = folder.appendingPathComponent("transfer_error.txt")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func setTransferError(_ message: String?, in folder: URL) {
        let url = folder.appendingPathComponent("transfer_error.txt")
        if let message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try? Data(message.utf8).write(to: url, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }

    static func sha256Hex(of fileURL: URL) throws -> (sha256: String, bytes: Int) {
        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        var hasher = SHA256()
        var total = 0
        while true {
            let chunk = try handle.read(upToCount: 64 * 1024) ?? Data()
            if chunk.isEmpty { break }
            total += chunk.count
            hasher.update(data: chunk)
        }
        let hex = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return (hex, total)
    }

    static func canonicalFrames(of audioURL: URL) -> Int {
        let cache = audioURL.deletingPathExtension().appendingPathExtension("json")
        if let data = try? Data(contentsOf: cache),
           let piece = try? JSONDecoder().decode(Piece.self, from: data),
           piece.frames > 0 {
            return piece.frames
        }
        guard let file = try? AVAudioFile(forReading: audioURL), file.processingFormat.sampleRate > 0 else {
            return 0
        }
        return max(1, Int((Double(file.length) * 24_000 / file.processingFormat.sampleRate).rounded()))
    }

    static func folderBytes(_ folder: URL) -> Int64 {
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return 0 }
        var total: Int64 = 0
        for item in items {
            if let size = try? item.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                total += Int64(size)
            }
        }
        return total
    }

    static func totalStorageBytes(tenant: String) -> (total: Int64, syncedReclaimable: Int64) {
        guard !tenant.isEmpty, let root = try? root(tenant: tenant),
              let dirs = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        else { return (0, 0) }
        var total: Int64 = 0
        var reclaimable: Int64 = 0
        for dir in dirs {
            guard UUID(uuidString: dir.lastPathComponent) != nil else { continue }
            let size = folderBytes(dir)
            total += size
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("accepted").path) {
                reclaimable += size
            }
        }
        return (total, reclaimable)
    }

    /// 枚举某个本机录音目录的所有已封口音频段及其规范 24kHz 时间轴偏移
    static func localTimeline(in folder: URL) -> [(seq: Int, url: URL, startFrame: Int, frames: Int)] {
        guard let urls = try? pieces(folder) else { return [] }
        var offset = 0
        var out: [(seq: Int, url: URL, startFrame: Int, frames: Int)] = []
        for (idx, url) in urls.enumerated() {
            let frames = max(1, canonicalFrames(of: url))
            out.append((seq: idx, url: url, startFrame: offset, frames: frames))
            offset += frames
        }
        return out
    }

    static func recognize(_ url: URL) async throws -> Piece {
        let cache = url.deletingPathExtension().appendingPathExtension("json")
        if FileManager.default.fileExists(atPath: cache.path) {
            return try JSONDecoder().decode(Piece.self, from: Data(contentsOf: cache))
        }
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "zh-CN"))
        else { throw RecordingProblem("本机暂不支持中文转写，录音已保留在本机") }
        let module = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
        if let installation = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            try await installation.downloadAndInstall()
        }
        let file = try AVAudioFile(forReading: url)
        let frames = max(1, Int((Double(file.length) * 24_000 / file.processingFormat.sampleRate).rounded()))
        let analyzer = SpeechAnalyzer(modules: [module])
        let collector = Task {
            var words = ""
            for try await result in module.results { words += String(result.text.characters) }
            return words
        }
        defer { collector.cancel() }
        _ = try await analyzer.analyzeSequence(from: file)
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        let piece = Piece(text: try await collector.value, frames: frames)
        try JSONEncoder().encode(piece).write(to: cache, options: .atomic)
        return piece
    }

    static func submit(
        folder: URL,
        pieces: [Piece],
        meta: LocalRecordingMeta,
        token: String,
        partial: Bool
    ) async throws {
        let id = folder.lastPathComponent
        let endpoint = GatewayConfig.recordingsUploadBaseURL.appendingPathComponent("sessions")
        func send(_ method: String, _ url: URL, _ object: [String: Any]) async throws -> [String: Any] {
            var req = URLRequest(url: url)
            req.httpMethod = method
            req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.allowsCellularAccess = meta.networkPolicy.allowsCellular
            req.httpBody = try JSONSerialization.data(withJSONObject: object)
            let (data, response) = try await AppTrafficHTTP.data(for: req, category: "recordings")
            guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                let msg = RecordingAPI.parseServerError(data: data, statusCode: code)
                throw RecordingProblem("\(msg)，本机已保留待重试")
            }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        }

        let deviceKey = "jiebo.personalRecording.device"
        let device = await MainActor.run {
            if let existing = UserDefaults.standard.string(forKey: deviceKey) { return existing }
            let value = UUID().uuidString
            UserDefaults.standard.set(value, forKey: deviceKey)
            return value
        }

        let registration: [String: Any] = [
            "deviceId": device,
            "route": meta.routeDictionary(),
            "policySnapshot": meta.policySnapshotDictionary(),
        ]
        let authorization = try await send(
            "POST",
            endpoint.deletingLastPathComponent().appendingPathComponent("upload-grants"),
            registration
        )
        guard let grant = authorization["grant"] as? String else {
            throw RecordingProblem("未取得短期上传凭证")
        }
        guard let hash = authorization["policyHash"] as? String else {
            throw RecordingProblem("录音服务未返回策略校验值")
        }

        // 组装端侧逐字稿分段（若存在）
        var offset = 0
        var segments = [[String: Any]]()
        for (i, piece) in pieces.enumerated() {
            let trimmed = piece.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                segments.append([
                    "segmentId": "s-\(i)",
                    "startFrame": offset,
                    "endFrame": offset + piece.frames,
                    "text": trimmed,
                ])
            }
            offset += piece.frames
        }

        // 组装原音分段元数据（当用户开启原音同步时）
        var localChunks: [LocalChunkInfo] = []
        var chunkDecls = [[String: Any]]()
        var totalAudioBytes = 0
        if meta.syncAudio {
            let audioURLs = try Self.pieces(folder)
            var frameCursor = 0
            for (seq, url) in audioURLs.enumerated() {
                let (sha, bytes) = try sha256Hex(of: url)
                let frames = max(1, (seq < pieces.count ? pieces[seq].frames : canonicalFrames(of: url)))
                localChunks.append(LocalChunkInfo(
                    seq: seq,
                    url: url,
                    startFrame: frameCursor,
                    frames: frames,
                    bytes: bytes,
                    sha256: sha
                ))
                chunkDecls.append([
                    "seq": seq,
                    "epochId": "epoch-0",
                    "captureStartFrame": frameCursor,
                    "validFrameCount": frames,
                    "encoderDelayFrames": 0,
                    "paddingFrames": 0,
                    "bytes": bytes,
                    "sha256": sha,
                    "format": [
                        "codec": "aac_lc",
                        "container": "m4a",
                        "sampleRate": 24_000,
                        "channels": 1,
                        "bitrate": 64_000,
                    ] as [String: Any],
                ])
                totalAudioBytes += bytes
                frameCursor += frames
            }
            if offset == 0 { offset = frameCursor }
        }

        let hasTranscript = !segments.isEmpty
        if !hasTranscript && !(meta.syncAudio && meta.asrPolicy == .serverAllowed && !localChunks.isEmpty) {
            throw RecordingProblem("没有识别出可整理的文字，原音已保存在本机")
        }

        let sessionURL = endpoint.appendingPathComponent(id)
        let marker = folder.appendingPathComponent("stopped")
        let stopDate = (try? marker.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()

        let timelineEvents: [[String: Any]] = meta.events.map { evt in
            var dict: [String: Any] = [
                "eventId": evt.eventId,
                "type": evt.type,
                "startWallTime": evt.startWallTime,
                "canonicalFrame": evt.canonicalFrame,
            ]
            if let end = evt.endWallTime { dict["endWallTime"] = end }
            if let reason = evt.reason { dict["reason"] = reason }
            return dict
        }

        let missingRanges: [[String: Any]] = meta.missingRanges.map { range in
            [
                "startFrame": range.startFrame,
                "endFrame": range.endFrame,
                "reason": range.reason,
            ]
        }

        var manifest: [String: Any] = [
            "manifestVersion": 1,
            "sessionId": id,
            "generation": 1,
            "policyHash": hash,
            "startedAt": meta.startedAt,
            "stoppedAt": meta.stoppedAt ?? RecordingFormatting.isoString(from: stopDate),
            "completeCapture": !partial,
            "audioUploaded": meta.syncAudio,
            "expectedTotalFrames": offset,
            "expectedTotalBytes": meta.syncAudio ? totalAudioBytes : 0,
            "chunks": meta.syncAudio ? chunkDecls : [],
            "epochs": [],
            "timelineEvents": timelineEvents,
            "missingRanges": missingRanges,
        ]
        if !meta.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            manifest["title"] = meta.title.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // 记录本次提交期望完成的全部文件名，供后台回调精准判断 accepted
        var expectedFiles: [String] = []
        if meta.syncAudio {
            expectedFiles.append(contentsOf: localChunks.map { $0.url.lastPathComponent })
        }
        if hasTranscript {
            expectedFiles.append("transcript.body")
        }
        expectedFiles.append("manifest.body")
        let expectedURL = folder.appendingPathComponent("expected_uploads.json")
        try JSONEncoder().encode(expectedFiles).write(to: expectedURL, options: .atomic)
        setTransferError(nil, in: folder)

        let allowsCellular = meta.networkPolicy.allowsCellular

        // 1. 若开启原音同步，排队所有音频分片
        if meta.syncAudio {
            for chunk in localChunks {
                let headers: [String: String] = [
                    "Content-Type": "audio/mp4",
                    "X-Recording-Generation": "1",
                    "X-Chunk-SHA256": chunk.sha256,
                    "X-Capture-Start-Frame": String(chunk.startFrame),
                    "X-Valid-Frame-Count": String(chunk.frames),
                    "X-Epoch-Id": "epoch-0",
                ]
                let chunkURL = sessionURL.appendingPathComponent("chunks").appendingPathComponent(String(chunk.seq))
                await RecordingTransfers.shared.enqueue(
                    file: chunk.url,
                    url: chunkURL,
                    grant: grant,
                    headers: headers,
                    allowsCellular: allowsCellular
                )
            }
        }

        // 2. 若有端侧逐字稿，写文件并排队
        if hasTranscript {
            let transcript: [String: Any] = [
                "transcriptVersion": 1,
                "source": "on_device_speech_analyzer",
                "locale": "zh-CN",
                "timestampGranularity": "coarse",
                "segments": segments,
            ]
            let target = folder.appendingPathComponent("transcript.body")
            if !FileManager.default.fileExists(atPath: target.path) {
                try JSONSerialization.data(withJSONObject: transcript).write(to: target, options: .atomic)
            }
            await RecordingTransfers.shared.enqueue(
                file: target,
                url: sessionURL.appendingPathComponent("transcript"),
                grant: grant,
                headers: [
                    "Content-Type": "application/json",
                    "X-Recording-Generation": "1",
                ],
                allowsCellular: allowsCellular
            )
        }

        // 3. 写不可变清单并排队
        let manifestTarget = folder.appendingPathComponent("manifest.body")
        if !FileManager.default.fileExists(atPath: manifestTarget.path) {
            try JSONSerialization.data(withJSONObject: manifest).write(to: manifestTarget, options: .atomic)
        }
        await RecordingTransfers.shared.enqueue(
            file: manifestTarget,
            url: sessionURL.appendingPathComponent("manifest"),
            grant: grant,
            headers: ["Content-Type": "application/json"],
            allowsCellular: allowsCellular
        )
    }
}

struct RecordingProblem: LocalizedError {
    let errorDescription: String?
    init(_ text: String) { errorDescription = text }
}

/// 后台会话只携带短期授权。各段与清单分别签收；失败落盘错误原因并通知主界面展示与重试。
final class RecordingTransfers: NSObject, URLSessionTaskDelegate, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = RecordingTransfers()
    static let identifier = "ai.jiebo.personal-recordings.v1"
    private var completion: (() -> Void)?
    private let bufferLock = NSLock()
    private var responseBuffers: [Int: Data] = [:]

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        config.waitsForConnectivity = true
        config.httpMaximumConnectionsPerHost = 2
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()

    @MainActor func attach(_ callback: @escaping () -> Void) {
        completion = callback
        _ = session
    }

    @MainActor func enqueue(
        file: URL,
        url: URL,
        grant: String,
        headers: [String: String],
        allowsCellular: Bool
    ) async {
        guard !FileManager.default.fileExists(atPath: file.appendingPathExtension("ok").path) else { return }
        let tasks = await session.allTasks
        guard !tasks.contains(where: { $0.taskDescription == file.path }) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.allowsCellularAccess = allowsCellular
        for (k, v) in headers {
            request.setValue(v, forHTTPHeaderField: k)
        }
        request.setValue("Bearer " + grant, forHTTPHeaderField: "Authorization")
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = file.path
        task.resume()
    }

    /// 取消某个本地录音目录的所有在途后台上传（用于用户删除录音或强制重新授权重传）
    @MainActor func cancelTasks(in folder: URL) async {
        let prefix = folder.standardizedFileURL.path + "/"
        let tasks = await session.allTasks
        for task in tasks {
            if let desc = task.taskDescription,
               URL(fileURLWithPath: desc).standardizedFileURL.path.hasPrefix(prefix) {
                task.cancel()
            }
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        bufferLock.lock()
        var current = responseBuffers[dataTask.taskIdentifier] ?? Data()
        if current.count < 8192 {
            current.append(data.prefix(8192 - current.count))
            responseBuffers[dataTask.taskIdentifier] = current
        }
        bufferLock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        bufferLock.lock()
        let responseBody = responseBuffers.removeValue(forKey: task.taskIdentifier) ?? Data()
        bufferLock.unlock()

        let meter = AppTrafficMeter.shared
        meter.record(direction: .outbound, bytes: Int(clamping: task.countOfBytesSent), category: "recordings", transport: meter.currentTransport())
        meter.record(direction: .inbound, bytes: Int(clamping: task.countOfBytesReceived), category: "recordings", transport: meter.currentTransport())

        guard let path = task.taskDescription else { return }
        let file = URL(fileURLWithPath: path)
        let folder = file.deletingLastPathComponent()
        guard FileManager.default.fileExists(atPath: folder.path) else { return }

        if let error {
            // 主动取消不视为传输故障
            if (error as NSError).code == NSURLErrorCancelled { return }
            let message = "网络传输中断：\(error.localizedDescription)"
            RecordingOutbox.setTransferError(message, in: folder)
            Task { @MainActor in PersonalRecording.shared.didFailTransfer(folder, message: message) }
            return
        }

        guard let http = task.response as? HTTPURLResponse else {
            let message = "未收到服务端有效响应"
            RecordingOutbox.setTransferError(message, in: folder)
            Task { @MainActor in PersonalRecording.shared.didFailTransfer(folder, message: message) }
            return
        }

        guard 200..<300 ~= http.statusCode else {
            let message = RecordingAPI.parseServerError(data: responseBody, statusCode: http.statusCode)
            RecordingOutbox.setTransferError(message, in: folder)
            Task { @MainActor in PersonalRecording.shared.didFailTransfer(folder, message: message) }
            return
        }

        do {
            try Data().write(to: file.appendingPathExtension("ok"), options: .atomic)
            let expectedNames: [String]
            let expectedURL = folder.appendingPathComponent("expected_uploads.json")
            if let data = try? Data(contentsOf: expectedURL),
               let decoded = try? JSONDecoder().decode([String].self, from: data),
               !decoded.isEmpty {
                expectedNames = decoded
            } else {
                expectedNames = ["manifest.body", "transcript.body"]
            }

            let allDone = expectedNames.allSatisfy { name in
                FileManager.default.fileExists(atPath: folder.appendingPathComponent(name + ".ok").path)
            }
            if allDone {
                RecordingOutbox.setTransferError(nil, in: folder)
                try Data().write(to: folder.appendingPathComponent("accepted"), options: .atomic)
                Task { @MainActor in PersonalRecording.shared.didSynchronize(folder) }
            }
        } catch {
            // 回执落盘失败时保留文件，下次前台检查将幂等重传。
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            let callback = self.completion
            self.completion = nil
            callback?()
        }
    }
}
