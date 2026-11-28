import AVFoundation
import Observation
import SwiftUI
import UIKit

/// 连续麦克风取样写入器：
/// - 实时音频 tap 回调只做有界内存拷贝与音量计算，绝不在音频线程触碰磁盘；
/// - 独立串行后台写队列完成编码落盘与每 20 秒原子封口；
/// - 缓冲区过载时显式中断并报告故障，绝不静默丢帧。
private final class RecordingSegmentWriter: @unchecked Sendable {
    private let lock = NSLock()
    private let writeQueue = DispatchQueue(label: "ai.jiebo.personalRecording.writer", qos: .utility)
    private let folder: URL
    private var file: AVAudioFile?
    private var index: Int
    private var closed = false
    private var failed = false
    private var queuedBuffers: [AVAudioPCMBuffer] = []
    private var draining = false
    private let maxQueuedBuffers = 64
    private var lastLevelTick: TimeInterval = 0
    private var totalWrittenFrames: Int64 = 0
    let update: @Sendable (String?) -> Void
    let onLevel: @Sendable (Double) -> Void

    init(
        folder: URL,
        update: @escaping @Sendable (String?) -> Void,
        onLevel: @escaping @Sendable (Double) -> Void
    ) throws {
        self.folder = folder
        self.update = update
        self.onLevel = onLevel
        self.index = try RecordingOutbox.pieces(folder).count
    }

    /// 在 AVAudioEngine 实时回调中调用：只复制缓冲并入有界队列，绝不直接写文件。
    func append(_ buffer: AVAudioPCMBuffer) {
        let rms = Self.computeLevel(buffer)
        let now = ProcessInfo.processInfo.systemUptime
        guard let copy = Self.copyBuffer(buffer) else {
            markFailed("无法复制音频采样缓冲")
            return
        }

        var emitLevel = false
        var shouldKickDrain = false
        lock.lock()
        if closed || failed {
            lock.unlock()
            return
        }
        if queuedBuffers.count >= maxQueuedBuffers {
            failed = true
            queuedBuffers.removeAll(keepingCapacity: false)
            lock.unlock()
            update("磁盘写入跟不上，已停止以防静默丢音")
            return
        }
        queuedBuffers.append(copy)
        if !draining {
            draining = true
            shouldKickDrain = true
        }
        if now - lastLevelTick >= 0.08 {
            lastLevelTick = now
            emitLevel = true
        }
        lock.unlock()

        if emitLevel { onLevel(rms) }
        if shouldKickDrain {
            writeQueue.async { [weak self] in
                self?.drainLoop()
            }
        }
    }

    private func markClosed() {
        lock.lock()
        closed = true
        lock.unlock()
    }

    private func markFailed(_ message: String) {
        lock.lock()
        if failed {
            lock.unlock()
            return
        }
        failed = true
        queuedBuffers.removeAll(keepingCapacity: false)
        lock.unlock()
        update(message)
    }

    private func drainLoop() {
        while true {
            lock.lock()
            if failed || queuedBuffers.isEmpty {
                draining = false
                lock.unlock()
                return
            }
            let next = queuedBuffers.removeFirst()
            lock.unlock()

            do {
                try writeOneBuffer(next)
            } catch {
                markFailed(error.localizedDescription)
                return
            }
        }
    }

    private func writeOneBuffer(_ buffer: AVAudioPCMBuffer) throws {
        if file == nil {
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: buffer.format.sampleRate,
                AVNumberOfChannelsKey: buffer.format.channelCount,
                AVEncoderBitRateKey: 64_000,
            ]
            file = try AVAudioFile(
                forWriting: folder.appendingPathComponent("open.m4a"),
                settings: settings,
                commonFormat: buffer.format.commonFormat,
                interleaved: buffer.format.isInterleaved
            )
        }
        try file?.write(from: buffer)
        let scaled = Int64((Double(buffer.frameLength) * 24_000.0 / max(1, buffer.format.sampleRate)).rounded())
        lock.lock()
        totalWrittenFrames += scaled
        lock.unlock()

        if let length = file?.length, Double(length) >= buffer.format.sampleRate * 20 {
            try sealOnWriteQueue()
            update(nil)
        }
    }

    private func sealOnWriteQueue() throws {
        guard file != nil else { return }
        file = nil
        let src = folder.appendingPathComponent("open.m4a")
        guard FileManager.default.fileExists(atPath: src.path) else { return }
        let name = String(format: "%06d.m4a", index)
        try FileManager.default.moveItem(at: src, to: folder.appendingPathComponent(name))
        index += 1
    }

    /// 停止采集后异步冲刷队列并封口当前段，避免截断尾音且不阻塞主线程。
    func finishAsync() async throws {
        markClosed()

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            writeQueue.async {
                var finishError: Error?
                while true {
                    self.lock.lock()
                    if self.failed || self.queuedBuffers.isEmpty {
                        self.queuedBuffers.removeAll(keepingCapacity: false)
                        self.draining = false
                        self.lock.unlock()
                        break
                    }
                    let next = self.queuedBuffers.removeFirst()
                    self.lock.unlock()
                    do {
                        try self.writeOneBuffer(next)
                    } catch {
                        finishError = error
                        // 写入失败立即置 failed 并清空剩余缓冲，防止后续排队 drainLoop 重新打开 open.m4a
                        self.lock.lock()
                        self.failed = true
                        self.queuedBuffers.removeAll(keepingCapacity: false)
                        self.draining = false
                        self.lock.unlock()
                        break
                    }
                }
                do {
                    try self.sealOnWriteQueue()
                } catch {
                    if finishError == nil { finishError = error }
                }
                if let finishError {
                    continuation.resume(throwing: finishError)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    var writtenCanonicalFrames: Int {
        lock.lock()
        defer { lock.unlock() }
        return Int(totalWrittenFrames)
    }

    private static func copyBuffer(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: source.frameLength) else {
            return nil
        }
        copy.frameLength = source.frameLength
        let frames = Int(source.frameLength)
        let channels = Int(source.format.channelCount)
        if let srcFloat = source.floatChannelData, let dstFloat = copy.floatChannelData {
            if source.format.isInterleaved {
                memcpy(dstFloat[0], srcFloat[0], frames * channels * MemoryLayout<Float>.size)
            } else {
                for ch in 0..<channels {
                    memcpy(dstFloat[ch], srcFloat[ch], frames * MemoryLayout<Float>.size)
                }
            }
            return copy
        }
        if let srcInt16 = source.int16ChannelData, let dstInt16 = copy.int16ChannelData {
            if source.format.isInterleaved {
                memcpy(dstInt16[0], srcInt16[0], frames * channels * MemoryLayout<Int16>.size)
            } else {
                for ch in 0..<channels {
                    memcpy(dstInt16[ch], srcInt16[ch], frames * MemoryLayout<Int16>.size)
                }
            }
            return copy
        }
        if let srcInt32 = source.int32ChannelData, let dstInt32 = copy.int32ChannelData {
            if source.format.isInterleaved {
                memcpy(dstInt32[0], srcInt32[0], frames * channels * MemoryLayout<Int32>.size)
            } else {
                for ch in 0..<channels {
                    memcpy(dstInt32[ch], srcInt32[ch], frames * channels * MemoryLayout<Int32>.size)
                }
            }
            return copy
        }
        return nil
    }

    private static func computeLevel(_ buffer: AVAudioPCMBuffer) -> Double {
        let count = Int(buffer.frameLength)
        guard count > 0 else { return 0 }
        if let ptr = buffer.floatChannelData?[0] {
            var sum: Float = 0
            let step = max(1, count / 128)
            var samples = 0
            var idx = 0
            while idx < count {
                let v = ptr[idx]
                sum += v * v
                samples += 1
                idx += step
            }
            let rms = sqrt(sum / Float(max(1, samples)))
            // 映射到 0...1 的视觉电平
            let db = 20 * log10(max(rms, 1e-5))
            return min(1, max(0, Double((db + 52) / 46)))
        }
        return 0
    }
}

// MARK: - 原音时间戳回听播放器（受 AudioSessionCoordinator 租约保护）

@MainActor @Observable
final class RecordingAudioPlayer: NSObject, AVAudioPlayerDelegate {
    static let shared = RecordingAudioPlayer()

    private(set) var activeSessionId: String?
    private(set) var isPlaying = false
    private(set) var currentSeconds: Double = 0
    private(set) var totalSeconds: Double = 0
    private(set) var statusMessage: String?

    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var lease: AudioSessionLeaseToken?
    @ObservationIgnored private var timeline: [(seq: Int, url: URL, startFrame: Int, frames: Int)] = []
    @ObservationIgnored private var currentPieceIndex: Int = 0
    @ObservationIgnored private var progressTask: Task<Void, Never>?
    @ObservationIgnored private var playGeneration = 0
    @ObservationIgnored private var leaseReady = false

    private override init() {
        super.init()
    }

    func stop() {
        playGeneration &+= 1
        leaseReady = false
        progressTask?.cancel()
        progressTask = nil
        player?.stop()
        player = nil
        isPlaying = false
        activeSessionId = nil
        timeline = []
        currentPieceIndex = 0
        currentSeconds = 0
        totalSeconds = 0
        if let lease {
            self.lease = nil
            AudioSessionCoordinator.shared.release(lease)
        }
    }

    func togglePause() {
        guard let player else { return }
        if player.isPlaying {
            player.pause()
            isPlaying = false
            progressTask?.cancel()
            progressTask = nil
        } else {
            player.play()
            isPlaying = true
            startProgressTicker()
        }
    }

    /// 跳到指定规范帧（24kHz）回听。优先播本机保留原音；本机已清理且服务端有原音时按需拉取缓存段播放。
    func play(
        sessionId: String,
        targetFrame: Int,
        tenant: String,
        token: String,
        remoteAudioAvailable: Bool
    ) async {
        playGeneration &+= 1
        let generation = playGeneration
        statusMessage = nil
        let coordinator = AudioSessionCoordinator.shared
        if lease == nil {
            switch coordinator.acquire(for: .playback) {
            case .rejected(let reason):
                statusMessage = reason
                return
            case .granted(let tokenLease):
                lease = tokenLease
                leaseReady = false
                do {
                    try await coordinator.configureAndActivate(
                        token: tokenLease,
                        category: .playback,
                        mode: .spokenAudio,
                        options: []
                    )
                    guard lease == tokenLease else { return }
                    leaseReady = true
                } catch {
                    if lease == tokenLease {
                        lease = nil
                        leaseReady = false
                        coordinator.release(tokenLease)
                    }
                    guard playGeneration == generation else { return }
                    stop()
                    statusMessage = "音频播放准备失败：\(error.localizedDescription)"
                    return
                }
            }
        } else if !leaseReady {
            // 上一次点击的会话激活仍在排队中：等其完成后再检查代次与租约是否依然有效
            await coordinator.waitForPendingSessionOps()
            guard playGeneration == generation, lease != nil, leaseReady else { return }
        }
        guard playGeneration == generation else { return }

        // 后台扫描分段目录并读取时长元数据，避免长录音上百段在主线程逐个打开 AVAudioFile
        let localItems = await Task.detached(priority: .userInitiated) { () -> [(seq: Int, url: URL, startFrame: Int, frames: Int)] in
            guard let root = try? RecordingOutbox.root(tenant: tenant) else { return [] }
            let localFolder = root.appendingPathComponent(sessionId)
            return RecordingOutbox.localTimeline(in: localFolder)
        }.value
        guard playGeneration == generation else { return }
        if !localItems.isEmpty {
            playLocalTimeline(sessionId: sessionId, items: localItems, targetFrame: targetFrame)
            return
        }

        if remoteAudioAvailable, !token.isEmpty {
            // 服务端分片默认每段约 20 秒（480,000 帧），估算并尝试下载对应段回听
            let estimatedSeq = max(0, targetFrame / (20 * 24_000))
            do {
                let fileURL = try await RecordingAPI.fetchRemoteChunk(token: token, sessionId: sessionId, seq: estimatedSeq)
                guard playGeneration == generation else { return }
                let frames = await Task.detached(priority: .userInitiated) {
                    max(1, RecordingOutbox.canonicalFrames(of: fileURL))
                }.value
                guard playGeneration == generation else { return }
                let startFrame = estimatedSeq * frames
                let localOffset = max(0, Double(targetFrame - startFrame) / RecordingFormatting.canonicalSampleRate)
                let single = [(seq: estimatedSeq, url: fileURL, startFrame: startFrame, frames: frames)]
                playLocalTimeline(sessionId: sessionId, items: single, targetFrame: startFrame + Int(localOffset * 24_000))
            } catch {
                guard playGeneration == generation else { return }
                stop()
                statusMessage = "无法拉取云端原音：\(error.localizedDescription)"
            }
            return
        }

        stop()
        statusMessage = "本机未保留该条原音副本，且服务端未开启原音同步"
    }

    private func playLocalTimeline(
        sessionId: String,
        items: [(seq: Int, url: URL, startFrame: Int, frames: Int)],
        targetFrame: Int
    ) {
        timeline = items
        activeSessionId = sessionId
        let last = items.last!
        totalSeconds = Double(last.startFrame + last.frames) / RecordingFormatting.canonicalSampleRate

        let idx = items.lastIndex(where: { $0.startFrame <= targetFrame }) ?? 0
        let piece = items[idx]
        let offsetSeconds = max(0, Double(targetFrame - piece.startFrame) / RecordingFormatting.canonicalSampleRate)
        startPiece(at: idx, offset: offsetSeconds)
    }

    private func startPiece(at index: Int, offset: TimeInterval) {
        guard timeline.indices.contains(index) else {
            stop()
            return
        }
        currentPieceIndex = index
        let piece = timeline[index]
        do {
            let avPlayer = try AVAudioPlayer(contentsOf: piece.url)
            avPlayer.delegate = self
            avPlayer.prepareToPlay()
            avPlayer.currentTime = min(offset, max(0, avPlayer.duration - 0.05))
            avPlayer.play()
            player = avPlayer
            isPlaying = true
            currentSeconds = Double(piece.startFrame) / RecordingFormatting.canonicalSampleRate + avPlayer.currentTime
            startProgressTicker()
        } catch {
            stop()
            statusMessage = "音频文件无法播放：\(error.localizedDescription)"
        }
    }

    private func startProgressTicker() {
        progressTask?.cancel()
        progressTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, let player = self.player, self.timeline.indices.contains(self.currentPieceIndex) else {
                    return
                }
                let piece = self.timeline[self.currentPieceIndex]
                self.currentSeconds = Double(piece.startFrame) / RecordingFormatting.canonicalSampleRate + player.currentTime
                self.isPlaying = player.isPlaying
            }
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let finishedPlayer = player
        Task { @MainActor [weak self] in
            // 仅处理当前活跃播放器的完成回调，防止旧实例晚到回调误停或误推进新播放
            guard let self, self.player === finishedPlayer else { return }
            let nextIndex = self.currentPieceIndex + 1
            if self.timeline.indices.contains(nextIndex) {
                self.startPiece(at: nextIndex, offset: 0)
            } else {
                self.stop()
            }
        }
    }
}

// MARK: - 个人长录音核心状态管理器

@MainActor @Observable
final class PersonalRecording {
    static let shared = PersonalRecording()
    @ObservationIgnored private var recoveringAccounts: Set<String> = []

    // 当前录制状态
    private(set) var recording = false
    private(set) var starting = false
    private(set) var folder: URL?
    private(set) var preview = ""
    private(set) var status = ""
    private(set) var warningBanner = ""
    private(set) var elapsedSeconds: Double = 0
    private(set) var audioLevel: Double = 0
    private(set) var activeMeta: LocalRecordingMeta?

    // 本次录音启动前的临时标题与归属（开录后锁定）
    var draftTitle = ""
    var draftRouteKind: RecordingRouteKind = .personal
    var draftWorkspaceKey = ""
    var draftWorkspaceDisplayName = ""

    // 租户设置与服务端能力
    private(set) var settings = PersonalRecordingSettings()
    private(set) var loadedSettingsTenant = ""
    private(set) var capabilities: RecordingCapabilitiesDTO?

    // 本机与服务端历史汇总
    private(set) var localRecords: [LocalRecordingSummary] = []
    private(set) var remoteSessions: [RecordingSessionStatusDTO] = []
    private(set) var loadingHistory = false
    private(set) var historyError: String?
    private(set) var localTotalBytes: Int64 = 0
    private(set) var localReclaimableBytes: Int64 = 0

    private var engine: AVAudioEngine?
    private var writer: RecordingSegmentWriter?
    private var lease: AudioSessionLeaseToken?
    private var observers: [NSObjectProtocol] = []
    private var processing = Set<URL>()
    private var tenant = ""
    private var partial = false
    private var previewCount = 0
    private var accumulatedSecondsBeforeResume: Double = 0
    @ObservationIgnored private var snapshotTask: Task<Void, Never>?
    @ObservationIgnored private var snapshotGeneration = 0
    /// 后台封口中的写入器任务：暂停不阻塞主线程，续录/停止/删除前按序等待其完成。
    @ObservationIgnored private var pendingSealTask: Task<Void, Never>?
    @ObservationIgnored private var lastSealFailedFolder: URL?
    private var segmentResumeDate: Date?
    private var timerTask: Task<Void, Never>?
    private var grace: UIBackgroundTaskIdentifier = .invalid

    func ensureSettingsLoaded(tenant account: String) {
        guard !account.isEmpty else { return }
        if loadedSettingsTenant != account {
            settings = PersonalRecordingSettings.load(tenant: account)
            loadedSettingsTenant = account
            if folder == nil {
                syncDraftFromSettings()
            }
            refreshLocalSnapshot(tenant: account)
        }
    }

    func updateSettings(_ next: PersonalRecordingSettings, tenant account: String) {
        var copy = next
        copy.configured = true
        settings = copy
        loadedSettingsTenant = account
        copy.save(tenant: account)
        if folder == nil {
            syncDraftFromSettings()
        }
    }

    func syncDraftFromSettings() {
        draftRouteKind = settings.defaultRouteKind
        draftWorkspaceKey = settings.defaultWorkspaceKey
        draftWorkspaceDisplayName = settings.defaultWorkspaceDisplayName
    }

    func leaveAccount() {
        RecordingAudioPlayer.shared.stop()
        if let activeFolder = folder {
            pause(reason: "账号切换")
            // 将 stopped 标记写入并入 pendingSealTask 链，确保重登后 recover() 先等封口与标记落盘再扫描
            let previousSeal = pendingSealTask
            pendingSealTask = Task { @MainActor in
                await previousSeal?.value
                await Task.detached(priority: .utility) {
                    try? Data([1]).write(to: activeFolder.appendingPathComponent("stopped"), options: .atomic)
                }.value
            }
        }
        folder = nil
        activeMeta = nil
        tenant = ""
        loadedSettingsTenant = ""
        snapshotGeneration &+= 1
        snapshotTask?.cancel()
        snapshotTask = nil
        localTotalBytes = 0
        localReclaimableBytes = 0
        preview = ""
        status = ""
        warningBanner = ""
        elapsedSeconds = 0
        audioLevel = 0
        localRecords = []
        remoteSessions = []
        capabilities = nil
    }

    func clearSyncedCopies(store: ChatStore) {
        guard store.unlocked, !store.tenantId.isEmpty else { return }
        let account = store.tenantId
        let activeFolder = folder
        let activeProcessing = processing
        Task { @MainActor [weak self] in
            guard let self else { return }
            // 第一步：后台仅扫描待删的已同步目录列表，不删除
            let scanResult: Result<[URL], Error> = await Task.detached(priority: .utility) {
                do {
                    let root = try RecordingOutbox.root(tenant: account)
                    let dirs = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
                    let candidates = dirs.filter { dir in
                        dir != activeFolder
                            && !activeProcessing.contains(dir)
                            && FileManager.default.fileExists(atPath: dir.appendingPathComponent("accepted").path)
                    }
                    return .success(candidates)
                } catch {
                    return .failure(error)
                }
            }.value
            guard self.loadedSettingsTenant == account else { return }
            let targets: [URL]
            switch scanResult {
            case .success(let list):
                targets = list
            case .failure(let error):
                self.status = error.localizedDescription
                return
            }
            guard !targets.isEmpty else {
                self.preview = ""
                self.status = "暂无可清理的已同步副本"
                self.refreshLocalSnapshot(tenant: account)
                return
            }
            // 第二步：回到主线程先停止正在播放待删目录的播放器，再在后台真正删除目录
            let targetIds = Set(targets.map(\.lastPathComponent))
            if let playingId = RecordingAudioPlayer.shared.activeSessionId, targetIds.contains(playingId) {
                RecordingAudioPlayer.shared.stop()
            }
            let deleteResult: Result<Int, Error> = await Task.detached(priority: .utility) {
                do {
                    var removed = 0
                    for dir in targets {
                        try FileManager.default.removeItem(at: dir)
                        removed += 1
                    }
                    return .success(removed)
                } catch {
                    return .failure(error)
                }
            }.value
            guard self.loadedSettingsTenant == account else { return }
            switch deleteResult {
            case .success(let removed):
                self.preview = ""
                self.status = removed > 0 ? "已清理 \(removed) 条已同步的本机副本" : "暂无可清理的已同步副本"
                self.refreshLocalSnapshot(tenant: account)
            case .failure(let error):
                self.status = error.localizedDescription
                self.refreshLocalSnapshot(tenant: account)
            }
        }
    }

    func didSynchronize(_ dir: URL) {
        if folder == nil {
            status = "已同步到私有空间，正在整理并交付可乐"
        }
        if !loadedSettingsTenant.isEmpty {
            refreshLocalSnapshot(tenant: loadedSettingsTenant)
        }
    }

    func didFailTransfer(_ dir: URL, message: String) {
        status = "同步失败：\(message)"
        if !loadedSettingsTenant.isEmpty {
            refreshLocalSnapshot(tenant: loadedSettingsTenant)
        }
    }

    /// 刷新本机目录扫描与占用统计
    func refreshLocalSnapshot(tenant account: String) {
        guard !account.isEmpty, account == loadedSettingsTenant else { return }
        snapshotGeneration &+= 1
        guard snapshotTask == nil else { return }
        snapshotTask = Task {
            while !Task.isCancelled {
                let generation = snapshotGeneration
                let account = loadedSettingsTenant
                let activeFolder = folder
                let activeRecording = recording
                let snapshot = await Task.detached(priority: .utility) {
                    Self.scanSnapshot(account: account, folder: activeFolder, recording: activeRecording)
                }.value
                guard !Task.isCancelled else { return }
                guard generation == snapshotGeneration else { continue }
                if loadedSettingsTenant == account {
                    if localRecords != snapshot.items { localRecords = snapshot.items }
                    if localTotalBytes != snapshot.total { localTotalBytes = snapshot.total }
                    if localReclaimableBytes != snapshot.reclaimable { localReclaimableBytes = snapshot.reclaimable }
                }
                snapshotTask = nil
                return
            }
        }
    }

    nonisolated private static func scanSnapshot(account: String, folder: URL?, recording: Bool)
        -> (items: [LocalRecordingSummary], total: Int64, reclaimable: Int64) {
        guard let root = try? RecordingOutbox.root(tenant: account) else { return ([], 0, 0) }
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey])) ?? []
        var items: [LocalRecordingSummary] = []
        var totalBytes: Int64 = 0
        var reclaimableBytes: Int64 = 0

        for dir in dirs {
            guard UUID(uuidString: dir.lastPathComponent) != nil else { continue }
            let meta = RecordingOutbox.loadMeta(in: dir)
            let pieces = (try? RecordingOutbox.pieces(dir)) ?? []
            let totalFrames = pieces.reduce(0) { $0 + RecordingOutbox.canonicalFrames(of: $1) }
            let bytes = RecordingOutbox.folderBytes(dir)
            let accepted = FileManager.default.fileExists(atPath: dir.appendingPathComponent("accepted").path)
            totalBytes += bytes
            if accepted { reclaimableBytes += bytes }
            let stopped = FileManager.default.fileExists(atPath: dir.appendingPathComponent("stopped").path)
            let transferErr = RecordingOutbox.transferError(in: dir)

            let phase: LocalTransferPhase
            if dir == folder {
                phase = recording ? .recording : .paused
            } else if accepted {
                phase = .accepted
            } else if transferErr != nil {
                phase = .failed
            } else if FileManager.default.fileExists(atPath: dir.appendingPathComponent("manifest.body").path) {
                phase = .uploading
            } else if stopped {
                phase = .preparing
            } else {
                phase = .paused
            }

            let created = (try? dir.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()
            let startedAt = meta?.startedAt ?? RecordingFormatting.isoString(from: created)
            let title = (meta?.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
                ? meta!.title
                : "本机录音 \(RecordingFormatting.shortDateTime(startedAt))"

            items.append(LocalRecordingSummary(
                sessionId: dir.lastPathComponent,
                folder: dir,
                title: title,
                startedAt: startedAt,
                routeDisplayName: meta?.routeDisplayName ?? "个人助理",
                routeKind: meta?.routeKind ?? .personal,
                workspaceKey: meta?.workspaceKey,
                syncAudio: meta?.syncAudio ?? false,
                partial: meta?.partial ?? false,
                pieceCount: pieces.count,
                totalBytes: bytes,
                estimatedSeconds: Double(totalFrames) / RecordingFormatting.canonicalSampleRate,
                phase: phase,
                transferError: transferErr
            ))
        }

        items.sort { $0.startedAt > $1.startedAt }
        return (items, totalBytes, reclaimableBytes)
    }

    /// 刷新服务端历史会话与能力信息
    func refreshRemoteHistory(store: ChatStore) async {
        guard store.unlocked, !store.tenantId.isEmpty, !store.tokenDraft.isEmpty else { return }
        ensureSettingsLoaded(tenant: store.tenantId)
        refreshLocalSnapshot(tenant: store.tenantId)
        loadingHistory = true
        historyError = nil
        defer { loadingHistory = false }

        do {
            async let pageTask = RecordingAPI.listSessions(token: store.tokenDraft, limit: 50)
            async let capTask = try? RecordingAPI.fetchCapabilities(token: store.tokenDraft)
            let page = try await pageTask
            let cap = await capTask
            remoteSessions = page.items
            if let cap { capabilities = cap }
        } catch {
            historyError = error.localizedDescription
        }
    }

    /// 检查磁盘空间与电量预检（不足 200MB 拒录；低于 500MB 或低电量给出温和提示）
    private func runPreflightChecks() throws {
        warningBanner = ""
        if let home = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
           let avail = home.volumeAvailableCapacityForImportantUsage {
            if avail < 200 * 1024 * 1024 {
                throw RecordingProblem("手机可用空间不足 200MB，请先清理空间后再开始长录音")
            }
            if avail < 500 * 1024 * 1024 {
                warningBanner = "手机剩余空间偏低（约 \(RecordingFormatting.formatBytes(avail))），长录音中途可能因空间不足暂停"
            }
        }
        UIDevice.current.isBatteryMonitoringEnabled = true
        let level = UIDevice.current.batteryLevel
        let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        if (level >= 0 && level < 0.15) || lowPower {
            let note = lowPower ? "当前处于低电量模式，建议接通电源以确保长录音与转写稳定" : "当前电量偏低（\(Int(level * 100))%），长录音建议接通电源"
            warningBanner = warningBanner.isEmpty ? note : warningBanner + "；" + note
        }
    }

    func start(store: ChatStore) async {
        guard !recording, !starting, store.unlocked, !store.tenantId.isEmpty else { return }
        ensureSettingsLoaded(tenant: store.tenantId)
        let account = store.tenantId
        starting = true
        defer { starting = false }

        // 若上一次暂停触发的异步封口尚未收尾，先等它完成再续录，确保不与 open.m4a 冲突
        await awaitPendingSeal()

        do {
            try runPreflightChecks()
            guard await AVAudioApplication.requestRecordPermission() else {
                throw RecordingProblem("请在系统「设置 › 接驳」中允许麦克风权限")
            }
            guard store.unlocked, store.tenantId == account else {
                throw RecordingProblem("登录状态已变化")
            }
            if draftRouteKind == .workspace, draftWorkspaceKey.isEmpty {
                throw RecordingProblem("已选择项目工作区归属，请先指定目标工作区")
            }

            RecordingAudioPlayer.shared.stop()
            let coordinator = AudioSessionCoordinator.shared
            switch coordinator.acquire(for: .longRecording) {
            case .rejected(let reason):
                throw RecordingProblem(reason)
            case .granted(let token):
                lease = token
                ImVoicePlayer.shared.stop()
                await ImVoicePlayer.shared.waitForAudioSession()
                try await coordinator.configureAndActivate(
                    token: token,
                    category: .record,
                    mode: .default,
                    options: [.allowBluetoothHFP]
                )
            }
            guard store.unlocked, store.tenantId == account else {
                throw RecordingProblem("登录状态已变化")
            }

            if folder == nil {
                let sessionId = UUID().uuidString
                let dir = try RecordingOutbox.root(tenant: account).appendingPathComponent(sessionId)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let meta = LocalRecordingMeta(
                    sessionId: sessionId,
                    title: draftTitle.trimmingCharacters(in: .whitespacesAndNewlines),
                    startedAt: RecordingFormatting.isoString(from: Date()),
                    stoppedAt: nil,
                    routeKind: draftRouteKind,
                    workspaceKey: draftRouteKind == .workspace ? draftWorkspaceKey : nil,
                    workspaceDisplayName: draftRouteKind == .workspace ? draftWorkspaceDisplayName : nil,
                    networkPolicy: settings.networkPolicy,
                    asrPolicy: settings.asrPolicy,
                    syncAudio: settings.syncAudio,
                    rawRetentionDays: settings.rawRetentionDays,
                    textRetentionDays: settings.textRetentionDays,
                    memoryPolicy: settings.memoryPolicy,
                    partial: false,
                    events: [],
                    missingRanges: []
                )
                RecordingOutbox.saveMeta(meta, in: dir)
                folder = dir
                activeMeta = meta
                tenant = account
                partial = false
                previewCount = 0
                preview = ""
                accumulatedSecondsBeforeResume = 0
                elapsedSeconds = 0
            } else if let dir = folder, var meta = activeMeta {
                let currentFrames = Int((accumulatedSecondsBeforeResume * RecordingFormatting.canonicalSampleRate).rounded())
                meta.events.append(LocalRecordingEvent(
                    eventId: "evt-\(meta.events.count + 1)",
                    type: "resume",
                    startWallTime: RecordingFormatting.isoString(from: Date()),
                    endWallTime: nil,
                    canonicalFrame: currentFrames,
                    reason: nil
                ))
                activeMeta = meta
                RecordingOutbox.saveMeta(meta, in: dir)
            }

            guard let dir = folder, tenant == account else {
                throw RecordingProblem("请返回录音所属账号")
            }

            let engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw RecordingProblem("麦克风输入暂不可用")
            }

            let sink = try RecordingSegmentWriter(
                folder: dir,
                update: { [weak self] problem in
                    Task { @MainActor in
                        guard let self, self.folder == dir else { return }
                        if let problem {
                            self.recordInterruption(reason: problem, isError: true)
                            self.pause(reason: problem)
                            self.status = "录音写入中断：\(problem)"
                        } else {
                            await self.process(dir, store: store)
                        }
                    }
                },
                onLevel: { [weak self] level in
                    Task { @MainActor in
                        guard let self, self.recording else { return }
                        self.audioLevel = level
                    }
                }
            )
            input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
                sink.append(buffer)
            }
            self.engine = engine
            writer = sink
            try engine.start()
            recording = true
            segmentResumeDate = Date()
            startClockTicker()
            status = "正在录音，约每 20 秒更新本机转写"
            JieboHaptic.impact(.medium)
            refreshLocalSnapshot(tenant: account)

            for name in [
                AVAudioSession.interruptionNotification,
                AVAudioSession.routeChangeNotification,
                Notification.Name.AVAudioEngineConfigurationChange,
            ] {
                let observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                    var reasonText = "音频输入已中断"
                    if name == AVAudioSession.routeChangeNotification {
                        let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                        guard reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue ||
                              reason == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue else { return }
                        reasonText = "音频输入设备已切换"
                    } else if name == AVAudioSession.interruptionNotification {
                        reasonText = "系统来电或语音中断"
                    }
                    Task { @MainActor in
                        guard let self, self.recording, self.folder == dir else { return }
                        self.recordInterruption(reason: reasonText, isError: false)
                        self.pause(reason: reasonText)
                        self.status = "\(reasonText)，已安全保存现有录音，可继续或停止整理"
                    }
                }
                observers.append(observer)
            }
        } catch {
            pause()
            status = error.localizedDescription
        }
    }

    private func recordInterruption(reason: String, isError: Bool) {
        partial = true
        guard let dir = folder, var meta = activeMeta else { return }
        let frame = Int((elapsedSeconds * RecordingFormatting.canonicalSampleRate).rounded())
        meta.partial = true
        meta.events.append(LocalRecordingEvent(
            eventId: "evt-\(meta.events.count + 1)",
            type: isError ? "recovery_gap" : "interruption",
            startWallTime: RecordingFormatting.isoString(from: Date()),
            endWallTime: nil,
            canonicalFrame: frame,
            reason: reason
        ))
        meta.missingRanges.append(LocalRecordingMissingRange(
            startFrame: frame,
            endFrame: frame,
            reason: reason
        ))
        activeMeta = meta
        RecordingOutbox.saveMeta(meta, in: dir)
    }

    private func startClockTicker() {
        timerTask?.cancel()
        timerTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, self.recording, let resumed = self.segmentResumeDate else { return }
                self.elapsedSeconds = self.accumulatedSecondsBeforeResume + Date().timeIntervalSince(resumed)
            }
        }
    }

    func pause(reason: String? = nil) {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        timerTask?.cancel()
        timerTask = nil

        if let resumed = segmentResumeDate {
            accumulatedSecondsBeforeResume += Date().timeIntervalSince(resumed)
            elapsedSeconds = accumulatedSecondsBeforeResume
            segmentResumeDate = nil
        }

        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine = nil
        recording = false
        audioLevel = 0
        status = reason == nil ? "已暂停，不收音" : "已暂停（\(reason!)）"

        // 异步冲刷编码队列并封口，避免点击暂停/停止时在主线程同步阻塞等待磁盘 I/O
        let activeWriter = writer
        writer = nil
        let targetDir = folder
        let accountSnapshot = tenant
        if let activeWriter {
            let previousSeal = pendingSealTask
            pendingSealTask = Task { @MainActor [weak self] in
                await previousSeal?.value
                do {
                    try await activeWriter.finishAsync()
                } catch {
                    guard let self else { return }
                    if let dir = targetDir {
                        self.lastSealFailedFolder = dir
                    }
                    // 仅在仍属于同一账号和同一录音目录时写入失败状态，防止切账号后污染新账号 UI
                    if self.tenant == accountSnapshot && self.folder == targetDir {
                        self.partial = true
                        self.status = "封口当前音频段异常：\(error.localizedDescription)"
                        if let dir = targetDir, var meta = self.activeMeta {
                            meta.partial = true
                            self.activeMeta = meta
                            RecordingOutbox.saveMeta(meta, in: dir)
                        }
                    }
                }
                if let self, !accountSnapshot.isEmpty, self.loadedSettingsTenant == accountSnapshot {
                    self.refreshLocalSnapshot(tenant: accountSnapshot)
                }
            }
        }

        if let dir = folder, var meta = activeMeta {
            if reason == nil {
                meta.events.append(LocalRecordingEvent(
                    eventId: "evt-\(meta.events.count + 1)",
                    type: "pause",
                    startWallTime: RecordingFormatting.isoString(from: Date()),
                    endWallTime: nil,
                    canonicalFrame: Int((elapsedSeconds * RecordingFormatting.canonicalSampleRate).rounded()),
                    reason: nil
                ))
            }
            meta.partial = partial
            activeMeta = meta
            RecordingOutbox.saveMeta(meta, in: dir)
        }

        if let lease {
            self.lease = nil
            AudioSessionCoordinator.shared.release(lease)
        }
        if activeWriter == nil, !tenant.isEmpty {
            refreshLocalSnapshot(tenant: tenant)
        }
    }

    private func awaitPendingSeal() async {
        while let task = pendingSealTask {
            await task.value
            if pendingSealTask == task {
                pendingSealTask = nil
            }
        }
    }

    private func finishGrace() {
        guard grace != .invalid else { return }
        UIApplication.shared.endBackgroundTask(grace)
        grace = .invalid
    }

    func stop(store: ChatStore) async {
        guard let dir = folder, !starting else { return }
        let metaSnapshot = activeMeta
        let partialSnapshot = partial
        finishGrace()
        grace = UIApplication.shared.beginBackgroundTask(withName: "录音封口与同步") { [weak self] in
            Task { @MainActor in self?.finishGrace() }
        }
        pause()
        // 立刻脱离活动目录，防止等待封口期间 leaveAccount() 对同一目录重复写入 partial=1 覆盖 stopped
        folder = nil
        activeMeta = nil
        draftTitle = ""
        accumulatedSecondsBeforeResume = 0
        elapsedSeconds = 0
        await awaitPendingSeal()
        let sealFailed = (lastSealFailedFolder == dir)
        if sealFailed { lastSealFailedFolder = nil }
        JieboHaptic.notification(.success)

        do {
            let finalPartial = partial || partialSnapshot || sealFailed
            if var meta = metaSnapshot {
                meta.stoppedAt = RecordingFormatting.isoString(from: Date())
                meta.partial = finalPartial
                RecordingOutbox.saveMeta(meta, in: dir)
            }
            try Data([finalPartial ? 1 : 0]).write(to: dir.appendingPathComponent("stopped"), options: .atomic)
            status = "已保存本机，正在本机补全转写并自动同步"
            refreshLocalSnapshot(tenant: store.tenantId)
            await process(dir, store: store)
        } catch {
            status = error.localizedDescription
        }
    }

    /// 手动重试某条本机录音的同步（重新申请 grant，重排尚未 .ok 的文件）
    func retryLocalUpload(sessionId: String, store: ChatStore) async {
        guard store.unlocked, !store.tenantId.isEmpty else { return }
        guard let root = try? RecordingOutbox.root(tenant: store.tenantId) else { return }
        let dir = root.appendingPathComponent(sessionId)
        guard FileManager.default.fileExists(atPath: dir.path) else { return }
        await RecordingTransfers.shared.cancelTasks(in: dir)
        RecordingOutbox.setTransferError(nil, in: dir)
        status = "正在重新排队同步…"
        refreshLocalSnapshot(tenant: store.tenantId)
        await process(dir, store: store)
    }

    /// 删除一条本机录音副本（并取消在途后台上传）
    func deleteLocalCopy(sessionId: String, tenant account: String) async {
        guard !account.isEmpty, let root = try? RecordingOutbox.root(tenant: account) else { return }
        let dir = root.appendingPathComponent(sessionId)
        if dir == folder {
            pause(reason: "用户删除")
            await awaitPendingSeal()
            folder = nil
            activeMeta = nil
            accumulatedSecondsBeforeResume = 0
            elapsedSeconds = 0
        }
        if RecordingAudioPlayer.shared.activeSessionId == sessionId {
            RecordingAudioPlayer.shared.stop()
        }
        await RecordingTransfers.shared.cancelTasks(in: dir)
        await Task.detached(priority: .utility) {
            try? FileManager.default.removeItem(at: dir)
        }.value
        refreshLocalSnapshot(tenant: account)
    }

    func recover(store: ChatStore) async {
        guard store.unlocked, !store.tenantId.isEmpty else { return }
        ensureSettingsLoaded(tenant: store.tenantId)
        let account = store.tenantId
        guard recoveringAccounts.insert(account).inserted else { return }
        defer { recoveringAccounts.remove(account) }
        // 先等待上一轮异步封口及切账号 stopped 落盘完成，防止把正在封口的录音误判为崩溃残留
        await awaitPendingSeal()
        guard account == store.tenantId, store.unlocked else { return }
        do {
            let directories = try await Task.detached(priority: .utility) {
                let root = try RecordingOutbox.root(tenant: account)
                return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            }.value
            guard account == store.tenantId, store.unlocked else { return }
            var recoveredAny = false
            for dir in directories {
                guard account == store.tenantId, store.unlocked else { return }
                guard UUID(uuidString: dir.lastPathComponent) != nil,
                      dir != folder,
                      !FileManager.default.fileExists(atPath: dir.appendingPathComponent("accepted").path)
                else { continue }
                recoveredAny = true
                let marker = dir.appendingPathComponent("stopped")
                if !FileManager.default.fileExists(atPath: marker.path) {
                    // 上次崩溃/强杀残留，封口 open.m4a 并标记为部分内容
                    let openFile = dir.appendingPathComponent("open.m4a")
                    if FileManager.default.fileExists(atPath: openFile.path) {
                        let nextSeq = (try? RecordingOutbox.pieces(dir).count) ?? 0
                        let sealed = dir.appendingPathComponent(String(format: "%06d.m4a", nextSeq))
                        try? FileManager.default.moveItem(at: openFile, to: sealed)
                    }
                    if var meta = RecordingOutbox.loadMeta(in: dir) {
                        meta.partial = true
                        meta.stoppedAt = RecordingFormatting.isoString(from: Date())
                        RecordingOutbox.saveMeta(meta, in: dir)
                    }
                    try Data([1]).write(to: marker, options: .atomic)
                }
                await process(dir, store: store)
            }
            if recoveredAny {
                refreshLocalSnapshot(tenant: account)
            }
        } catch {
            status = error.localizedDescription
        }
    }

    private func process(_ dir: URL, store: ChatStore) async {
        guard !processing.contains(dir), store.unlocked,
              let root = try? RecordingOutbox.root(tenant: store.tenantId),
              dir.deletingLastPathComponent().standardizedFileURL.path == root.standardizedFileURL.path
        else { return }
        let account = store.tenantId
        processing.insert(dir)
        defer {
            processing.remove(dir)
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("stopped").path) {
                finishGrace()
            }
            refreshLocalSnapshot(tenant: account)
        }

        do {
            if !FileManager.default.fileExists(atPath: dir.appendingPathComponent("stopped").path) {
                while dir == folder {
                    let urls = try RecordingOutbox.pieces(dir)
                    guard urls.indices.contains(previewCount) else { break }
                    let piece = try await RecordingOutbox.recognize(urls[previewCount])
                    guard account == store.tenantId, store.unlocked else { return }
                    if dir == folder {
                        preview = String((preview + piece.text).suffix(600))
                        previewCount += 1
                    }
                }
                if !FileManager.default.fileExists(atPath: dir.appendingPathComponent("stopped").path) { return }
            }

            let meta = RecordingOutbox.loadMeta(in: dir) ?? LocalRecordingMeta(
                sessionId: dir.lastPathComponent,
                title: "",
                startedAt: RecordingFormatting.isoString(from: Date()),
                stoppedAt: nil,
                routeKind: .personal,
                workspaceKey: nil,
                workspaceDisplayName: nil,
                networkPolicy: settings.networkPolicy,
                asrPolicy: settings.asrPolicy,
                syncAudio: settings.syncAudio,
                rawRetentionDays: settings.rawRetentionDays,
                textRetentionDays: settings.textRetentionDays,
                memoryPolicy: settings.memoryPolicy,
                partial: false,
                events: [],
                missingRanges: []
            )

            var pieces: [RecordingOutbox.Piece] = []
            while true {
                let urls = try RecordingOutbox.pieces(dir)
                for url in urls.dropFirst(pieces.count) {
                    do {
                        let piece = try await RecordingOutbox.recognize(url)
                        guard account == store.tenantId, store.unlocked else { return }
                        pieces.append(piece)
                        if dir == folder { preview = pieces.suffix(4).map(\.text).joined() }
                    } catch {
                        if meta.syncAudio && meta.asrPolicy == .serverAllowed {
                            // 用户已明确授权原音同步 + 云端转写时，允许无端侧文字继续上送原音
                            let frames = RecordingOutbox.canonicalFrames(of: url)
                            pieces.append(RecordingOutbox.Piece(text: "", frames: frames))
                        } else {
                            throw error
                        }
                    }
                }
                if try RecordingOutbox.pieces(dir).count == pieces.count { break }
            }

            let marker = dir.appendingPathComponent("stopped")
            guard FileManager.default.fileExists(atPath: marker.path) else { return }
            let isPartial = (try? Data(contentsOf: marker).first == 1) ?? meta.partial
            try await RecordingOutbox.submit(
                folder: dir,
                pieces: pieces,
                meta: meta,
                token: store.tokenDraft,
                partial: isPartial
            )
            status = meta.syncAudio ? "原音与逐字稿已进入后台上传队列" : "逐字稿已进入后台上传队列（原音保留本机）"
        } catch {
            RecordingOutbox.setTransferError(error.localizedDescription, in: dir)
            status = error.localizedDescription
        }
    }
}
