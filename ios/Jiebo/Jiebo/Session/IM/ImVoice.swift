import AVFoundation
import Foundation
import Observation
import Speech
import UIKit

/// IM 语音只负责录成 m4a，不安装 AVAudioEngine tap，因此不会和 VoiceDictation 共用状态或回调。
@MainActor
@Observable
final class ImVoiceRecorder {
    private(set) var recording = false
    private(set) var cancelling = false
    private(set) var level: Double = 0
    private(set) var seconds: Double = 0
    /// 录音被系统停掉了（满 60 秒，或来电等中断）；界面据此自动收尾发送，不等手指松开。
    private(set) var autoStopped = false
    private var endedAt: Date?
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var samples: [Double] = []
    private var startedAt = Date()
    private var file: URL?

    func start() async -> String? {
        guard !recording else { return nil }
        ImVoicePlayer.shared.stop()
        if AVAudioApplication.shared.recordPermission == .undetermined {
            let granted = await AVAudioApplication.requestRecordPermission()
            return granted ? "麦克风权限已开启，请再次按住说话" : "没有麦克风权限，到「设置 › 接驳」里打开"
        }
        guard AVAudioApplication.shared.recordPermission == .granted else {
            return "没有麦克风权限，到「设置 › 接驳」里打开"
        }
        do {
            let session = AVAudioSession.sharedInstance()
            // spokenAudio 是播放语音模式；录音使用 measurement，避免真机上出现类别/模式不兼容。
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true)
            let target = FileManager.default.temporaryDirectory.appendingPathComponent("im-voice-\(UUID().uuidString.lowercased()).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 24_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            let recorder = try AVAudioRecorder(url: target, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.record(forDuration: 60) else { throw CocoaError(.fileWriteUnknown) }
            self.recorder = recorder
            file = target
            startedAt = Date()
            endedAt = nil
            autoStopped = false
            samples = []
            seconds = 0
            cancelling = false
            recording = true
            timer = .scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
            return nil
        } catch {
            stopSession()
            return "开不了麦克风：\(error.localizedDescription)"
        }
    }

    func setCancelling(_ value: Bool) {
        if recording { cancelling = value }
    }

    /// 返回录音文件、时长和最多 100 点波形；取消或不足 1 秒返回 nil。
    func finish(cancel: Bool) -> (URL, Int, [Double])? {
        guard recording, let file else { return nil }
        recorder?.stop()
        // 时长以录音文件本身为准：来电、挂起时主线程 Timer 可能很久不跑，用时钟算会把短录音算成 60 秒。
        // 读不出来才退回按停止时刻 / 松手时刻估算。
        let fallback = (endedAt ?? Date()).timeIntervalSince(startedAt)
        let duration = min(60, max(0, Self.fileDuration(file) ?? fallback))
        let shouldKeep = !cancel && !cancelling && duration >= 1
        let waveform = Self.reduce(samples, count: 64)
        reset()
        if shouldKeep { return (file, Int(duration * 1000), waveform) }
        try? FileManager.default.removeItem(at: file)
        return nil
    }

    func cancel() {
        _ = finish(cancel: true)
    }

    private func tick() {
        guard let recorder, recorder.isRecording else {
            // record(forDuration:) 满 60 秒会自己停；来电、路由变化等中断也会走到这里。
            // 记下停止时刻，保留文件，通知界面自动收尾（发送或判短录音丢弃）。
            let stopped = Date()
            endedAt = stopped
            seconds = min(60, stopped.timeIntervalSince(startedAt))
            level = 0
            timer?.invalidate()
            timer = nil
            autoStopped = true
            return
        }
        recorder.updateMeters()
        seconds = min(60, Date().timeIntervalSince(startedAt))
        let value = min(max((Double(recorder.averagePower(forChannel: 0)) + 48) / 48, 0), 1)
        level = value
        samples.append(value)
    }

    private func reset() {
        timer?.invalidate()
        timer = nil
        recorder = nil
        file = nil
        recording = false
        cancelling = false
        autoStopped = false
        endedAt = nil
        level = 0
        stopSession()
    }

    private func stopSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func fileDuration(_ url: URL) -> Double? {
        guard let audio = try? AVAudioFile(forReading: url), audio.processingFormat.sampleRate > 0 else { return nil }
        return Double(audio.length) / audio.processingFormat.sampleRate
    }

    private static func reduce(_ values: [Double], count: Int) -> [Double] {
        guard !values.isEmpty else { return [0] }
        let width = max(1, Int(ceil(Double(values.count) / Double(count))))
        return stride(from: 0, to: values.count, by: width).map { start in
            values[start ..< min(start + width, values.count)].max() ?? 0
        }.prefix(count).map { $0 }
    }
}

/// 语音播放、未听标记、连续播放和距离感应。
@MainActor
@Observable
final class ImVoicePlayer: NSObject, AVAudioPlayerDelegate {
    static let shared = ImVoicePlayer()
    private(set) var playingId: String?
    private var player: AVAudioPlayer?
    private var queue: [ImLocalMessage] = []
    private weak var store: ImStore?
    private var proximityObserver: NSObjectProtocol?

    func toggle(_ item: ImLocalMessage, messages: [ImLocalMessage], store: ImStore) {
        if playingId == item.id {
            stop()
            return
        }
        // 先释放上一条的 player；其下载或结束回调随后到达时不能消费新队列。
        stop()
        self.store = store
        let following = messages.drop(while: { $0.id != item.id }).dropFirst().filter {
            $0.kind == "voice" && $0.from != store.meId && !store.isVoiceHeard($0)
        }
        queue = [item] + following
        playNext()
    }

    func stop() {
        player?.delegate = nil
        player?.stop()
        player = nil
        playingId = nil
        queue = []
        if let proximityObserver { NotificationCenter.default.removeObserver(proximityObserver) }
        proximityObserver = nil
        UIDevice.current.isProximityMonitoringEnabled = false
        try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.none)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        guard self.player === player else { return }
        playNext()
    }

    private func playNext() {
        player?.delegate = nil
        player?.stop()
        player = nil
        guard !queue.isEmpty, let store else {
            stop()
            return
        }
        let item = queue.removeFirst()
        guard item.kind == "voice" else {
            playNext()
            return
        }
        playingId = item.id
        Task {
            guard let file = await voiceFile(item, store: store), playingId == item.id else {
                if playingId == item.id { playNext() }
                return
            }
            do {
                observeProximity()
                configureRoute()
                let player = try AVAudioPlayer(contentsOf: file)
                player.delegate = self
                self.player = player
                guard player.play() else {
                    store.showToast("语音播放不了")
                    playNext()
                    return
                }
                // 只有系统确认开始播放后才消费未听状态。
                store.markVoiceHeard(item)
            } catch {
                store.showToast("语音播放不了")
                playNext()
            }
        }
    }

    private func observeProximity() {
        UIDevice.current.isProximityMonitoringEnabled = true
        guard proximityObserver == nil else { return }
        proximityObserver = NotificationCenter.default.addObserver(
            forName: UIDevice.proximityStateDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.configureRoute() }
        }
    }

    private func configureRoute() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord, mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetooth]
            )
            if UIDevice.current.proximityState {
                try session.overrideOutputAudioPort(.none)
            } else {
                try session.overrideOutputAudioPort(.speaker)
            }
            try session.setActive(true)
        } catch {
            // 路由切换失败时系统当前输出仍可继续播放。
        }
    }

    func transcribe(_ item: ImLocalMessage, store: ImStore) {
        guard item.kind == "voice" else { return }
        Task {
            let status = SFSpeechRecognizer.authorizationStatus()
            if status == .notDetermined {
                _ = await withCheckedContinuation { continuation in
                    SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
                }
            }
            guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
                store.showToast("没有语音识别权限")
                return
            }
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) else {
                store.showToast("当前语言不支持语音转文字")
                return
            }
            guard recognizer.supportsOnDeviceRecognition else {
                store.showToast("这台设备不支持本机语音转文字")
                return
            }
            guard let file = await voiceFile(item, store: store) else {
                store.showToast("语音还没下载下来")
                return
            }
            let request = SFSpeechURLRecognitionRequest(url: file)
            request.shouldReportPartialResults = false
            request.requiresOnDeviceRecognition = true
            do {
                let result = try await recognizer.recognitionTask(with: request)
                let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { store.setVoiceText(text, for: item) }
            } catch {
                store.showToast("这段语音没识别出来")
            }
        }
    }

    private func voiceFile(_ item: ImLocalMessage, store: ImStore) async -> URL? {
        if let upload = item.upload, let outbox = ImCache.outboxDir(tenant: store.tenant) {
            let local = outbox.appendingPathComponent(upload.file)
            if FileManager.default.fileExists(atPath: local.path) { return local }
        }
        guard case .voice(let blob, _, _)? = item.body else { return nil }
        return await ImAttachmentCache.file(
            blob: blob, tenant: store.tenant, remote: store.mediaURL(convId: item.convId, blob: blob)
        )
    }
}

private extension SFSpeechRecognizer {
    func recognitionTask(with request: SFSpeechRecognitionRequest) async throws -> SFSpeechRecognitionResult {
        try await withCheckedThrowingContinuation { continuation in
            let gate = SpeechContinuationGate()
            gate.attach(recognitionTask(with: request) { result, error in
                if let error {
                    gate.once { continuation.resume(throwing: error) }
                } else if let result, result.isFinal {
                    gate.once { continuation.resume(returning: result) }
                }
            })
            // 系统一直不给 final/error 时不能让 continuation 悬着：90 秒后取消并按失败处理；正常结束会取消这个定时
            let timeout = DispatchWorkItem {
                gate.once { continuation.resume(throwing: CocoaError(.userCancelled)) }
            }
            gate.attach(timeout: timeout)
            DispatchQueue.global().asyncAfter(deadline: .now() + 90, execute: timeout)
        }
    }
}

private final class SpeechContinuationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var task: SFSpeechRecognitionTask?
    private var timeout: DispatchWorkItem?

    /// task / timeout 的读写都在锁里；若 gate 已结束（回调抢先到达），新来的 task 立刻取消。
    func attach(_ task: SFSpeechRecognitionTask) {
        lock.lock()
        let done = finished
        if !done { self.task = task }
        lock.unlock()
        if done { task.cancel() }
    }

    func attach(timeout: DispatchWorkItem) {
        lock.lock()
        let done = finished
        if !done { self.timeout = timeout }
        lock.unlock()
        if done { timeout.cancel() }
    }

    /// 只有第一个调用者会执行 action，同时取消识别任务和超时定时。
    func once(_ action: () -> Void) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        finished = true
        let task = self.task
        let timeout = self.timeout
        self.task = nil
        self.timeout = nil
        lock.unlock()
        task?.cancel()
        timeout?.cancel()
        action()
    }
}
