import AVFoundation
import Foundation
import Observation
import Speech

/// 输入框长按说话：录音的同时流式转写，松开后把文字交给输入框，由用户改完再发。
@MainActor
@Observable
final class VoiceDictation {
    enum Phase { case idle, starting, recording, finishing }

    private(set) var phase: Phase = .idle
    /// 到目前为止的转写结果（含标点），录音时实时刷新
    private(set) var transcript = ""
    /// 0...1 的输入音量，给波形用
    private(set) var level: CGFloat = 0

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var gotFinal = false
    /// 启动途中（等权限、开音频）用户已经松手或取消
    private var abandoned = false

    var active: Bool { phase != .idle }

    /// 开始录音。返回给用户看的错误；nil 表示已开始，或权限弹窗刚弹出（这次不录，下次长按再录）。
    func start() async -> String? {
        guard phase == .idle else { return nil }
        phase = .starting
        abandoned = false
        transcript = ""
        level = 0
        gotFinal = false

        let speech = SFSpeechRecognizer.authorizationStatus()
        let mic = AVAudioApplication.shared.recordPermission
        if speech == .notDetermined || mic == .undetermined {
            // 首次使用：系统弹窗期间手指多半已经松开，授权完让用户再按一次
            if speech == .notDetermined { _ = await Self.requestSpeechAuthorization() }
            if mic == .undetermined { _ = await AVAudioApplication.requestRecordPermission() }
            phase = .idle
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
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.addsPunctuation = true
            request.taskHint = .dictation
            self.request = request

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
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

        if abandoned {
            cancel()
            return nil
        }
        phase = .recording
        return nil
    }

    /// 松手：停止录音，等最后一段识别结果（最多 2 秒），返回整理好的文字。
    func finish() async -> String {
        guard phase == .recording else {
            cancel()
            return ""
        }
        phase = .finishing
        stopAudio()
        request?.endAudio()
        let deadline = Date().addingTimeInterval(2)
        while !gotFinal, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(60))
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
        if final { gotFinal = true }
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
    }

    private func teardown() {
        stopAudio()
        task = nil
        request = nil
        level = 0
        phase = .idle
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
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
