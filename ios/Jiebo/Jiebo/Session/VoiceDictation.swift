import AVFoundation
import Foundation
import Observation
import Speech

/// 输入框长按说话：录音的同时流式转写，松开后把文字交给输入框，由用户改完再发。
@MainActor
@Observable
final class VoiceDictation {
    enum Phase { case idle, starting, recording, finishing }

    /// 服务端识别一次最长约一分钟，提前一点自动停
    static let maxSeconds = 55

    private(set) var phase: Phase = .idle
    /// 到目前为止的转写结果（含标点），录音时实时刷新
    private(set) var transcript = ""
    /// 0...1 的输入音量，给波形用
    private(set) var level: CGFloat = 0
    /// 识别已经结束（到时长上限或服务报错），麦克风已关，等用户松手
    private(set) var stoppedEarly = false

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var limitTask: Task<Void, Never>?
    private var gotFinal = false
    /// 启动途中（等权限、开音频）用户已经松手或取消
    private var abandoned = false
    /// 录音前的音频会话配置，结束后还原，避免预览视频没声音
    private var savedSession: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?
    /// 激活和停用串行排队，避免上一次还没停完就再次改会话
    private var sessionChain: Task<Void, Never>?

    var active: Bool { phase != .idle }

    /// 开始录音。返回给用户看的提示；nil 表示已开始，或启动途中被放弃。
    func start() async -> String? {
        guard phase == .idle else { return nil }
        phase = .starting
        abandoned = false
        stoppedEarly = false
        transcript = ""
        level = 0
        gotFinal = false

        let speech = SFSpeechRecognizer.authorizationStatus()
        let mic = AVAudioApplication.shared.recordPermission
        if speech == .notDetermined || mic == .undetermined {
            // 首次使用：系统弹窗期间手指多半已经松开，授权完让用户再按一次
            if speech == .notDetermined { _ = await Self.requestSpeechAuthorization() }
            if mic == .undetermined, !abandoned { _ = await AVAudioApplication.requestRecordPermission() }
            phase = .idle
            if abandoned { return nil }
            return SFSpeechRecognizer.authorizationStatus() == .authorized && AVAudioApplication.shared.recordPermission == .granted
                ? "可以用了，再长按一次说话"
                : "没有麦克风或语音识别权限，到「设置 › 接驳」里打开"
        }
        guard speech == .authorized, mic == .granted else {
            phase = .idle
            return "没有麦克风或语音识别权限，到「设置 › 接驳」里打开"
        }
        guard let recognizer, recognizer.isAvailable else {
            phase = .idle
            return "语音识别暂时不可用，稍后再试"
        }

        do {
            try await beginRecordSession()
            if abandoned {
                teardown()
                return nil
            }

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            // 通话中、没有麦克风时格式为空，直接 installTap 会触发断言崩溃
            guard format.sampleRate > 0, format.channelCount > 0 else {
                teardown()
                return "现在用不了麦克风，稍后再试"
            }

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.addsPunctuation = true
            request.taskHint = .dictation
            self.request = request

            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format, block: makeTapBlock(request) { [weak self] value in
                Task { @MainActor in self?.level = value }
            })
            engine.prepare()
            try engine.start()

            task = recognizer.recognitionTask(with: request, resultHandler: makeResultHandler { [weak self] text, final in
                Task { @MainActor in self?.receive(text, final: final) }
            })
        } catch {
            teardown()
            return "开不了麦克风：\(error.localizedDescription)"
        }

        phase = .recording
        limitTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(Self.maxSeconds))
            guard !Task.isCancelled else { return }
            self?.stopEarly()
        }
        return nil
    }

    /// 松手：停止录音，等最后一段识别结果（最多 2 秒），返回整理好的文字。
    /// 调用方的任务被取消（切会话、页面消失）时立刻返回空串。
    func finish() async -> String {
        guard phase == .recording else {
            cancel()
            return ""
        }
        phase = .finishing
        stopAudio()
        request?.endAudio()
        let deadline = Date().addingTimeInterval(2)
        while !gotFinal, phase == .finishing, !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(60))
        }
        guard phase == .finishing, !Task.isCancelled else {
            cancel()
            return ""
        }
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        teardown()
        return text
    }

    /// 上滑取消、启动途中松手、页面切走：丢掉这段录音
    func cancel() {
        guard phase != .idle else { return }
        if phase == .starting { abandoned = true }
        task?.cancel()
        teardown()
        transcript = ""
    }

    private func receive(_ text: String?, final: Bool) {
        guard phase == .recording || phase == .finishing else { return }
        if let text, !text.isEmpty { transcript = text }
        guard final else { return }
        gotFinal = true
        if phase == .recording { stopEarly() }
    }

    /// 到时长上限或识别结束：关麦克风，保留已转写的文字，等用户松手
    private func stopEarly() {
        guard phase == .recording, !stoppedEarly else { return }
        stoppedEarly = true
        stopAudio()
        request?.endAudio()
        level = 0
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
    }

    private func teardown() {
        limitTask?.cancel()
        limitTask = nil
        stopAudio()
        task = nil
        request = nil
        level = 0
        stoppedEarly = false
        phase = .idle
        guard let saved = savedSession else { return }
        savedSession = nil
        let previous = sessionChain
        let next = Task { @MainActor in
            await previous?.value
            let session = AVAudioSession.sharedInstance()
            await deactivateAudioSession(session)
            try? session.setCategory(saved.category, mode: saved.mode, options: saved.options)
        }
        sessionChain = next
    }

    /// 先排到上一次停用之后，再改成录音并异步激活。激活本身会阻塞，不能留在主线程同步调用。
    private func beginRecordSession() async throws {
        let previous = sessionChain
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let next = Task { @MainActor in
                await previous?.value
                do {
                    let session = AVAudioSession.sharedInstance()
                    savedSession = (session.category, session.mode, session.categoryOptions)
                    try session.setCategory(.record, mode: .measurement, options: .duckOthers)
                    try await activateAudioSession(session)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
            sessionChain = Task { _ = await next.value }
        }
    }

    private static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }
}

private struct AudioSessionActivationError: LocalizedError {
    var errorDescription: String? { "系统没有打开录音" }
}

/// 异步激活。同步 setActive 在主线程上会卡住界面；iOS 27 之前没有异步接口。
private func activateAudioSession(_ session: AVAudioSession) async throws {
    if #available(iOS 27.0, *) {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            session.activate(options: []) { activated, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if activated {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: AudioSessionActivationError())
                }
            }
        }
    } else {
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }
}

/// 异步停用。类别要等停用完成后再改，否则主线程会在会话仍活跃时卡住。
private func deactivateAudioSession(_ session: AVAudioSession) async {
    if #available(iOS 27.0, *) {
        await withCheckedContinuation { continuation in
            session.deactivate(options: .notifyOthersOnDeactivation) { _, _ in
                continuation.resume()
            }
        }
    } else {
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// 这两个回调跑在音频 / 识别线程上，必须在不带主线程隔离的地方构造
private func makeTapBlock(
    _ request: SFSpeechAudioBufferRecognitionRequest,
    onLevel: @escaping @Sendable (CGFloat) -> Void
) -> AVAudioNodeTapBlock {
    { buffer, _ in
        request.append(buffer)
        onLevel(audioLevel(buffer))
    }
}

private func makeResultHandler(
    _ onResult: @escaping @Sendable (String?, Bool) -> Void
) -> (SFSpeechRecognitionResult?, Error?) -> Void {
    { result, error in
        onResult(result?.bestTranscription.formattedString, (result?.isFinal ?? false) || error != nil)
    }
}

/// 音频线程上算的音量（RMS 映射到 0...1）
private func audioLevel(_ buffer: AVAudioPCMBuffer) -> CGFloat {
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    let count = Int(buffer.frameLength)
    var sum: Float = 0
    for index in 0..<count { sum += channel[index] * channel[index] }
    let rms = sqrt(sum / Float(count))
    let db = 20 * log10(max(rms, 0.000_01))
    return CGFloat(min(max((db + 50) / 50, 0), 1))
}
