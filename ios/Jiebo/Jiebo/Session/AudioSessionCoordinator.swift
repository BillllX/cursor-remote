import Foundation
#if canImport(AVFAudio)
import AVFAudio
#endif

/// 全局音频会话归属方。同一进程同时最多只有一个采集 owner，避免长录音与短语音/听写/回放互相踩踏。
enum AudioSessionOwner: String, Codable, Equatable, Sendable {
    case idle
    case longRecording
    case longPaused
    case shortRecording
    case dictation
    case playback
    case interrupted
}

/// 每次成功获取音频租约签发的不可变令牌；晚到的释放回调必须匹配 generation 才允许释放。
struct AudioSessionLeaseToken: Equatable, Hashable, Sendable {
    let owner: AudioSessionOwner
    let generation: UInt64
}

enum AudioSessionLeaseResult: Equatable, Sendable {
    case granted(AudioSessionLeaseToken)
    case rejected(reason: String)
}

/// 纯 Foundation 租约仲裁状态机，供 iOS 运行时与 Linux 契约单测共享验证。
struct AudioSessionLeaseArbitrator: Sendable {
    private(set) var owner: AudioSessionOwner = .idle
    private(set) var generation: UInt64 = 0

    /// 申请音频租约。长录音进行中严禁短语音、听写或回放抢占麦克风与会话。
    mutating func acquire(for requester: AudioSessionOwner) -> AudioSessionLeaseResult {
        guard requester != .idle, requester != .interrupted else {
            return .rejected(reason: "无效的音频租约请求")
        }
        if owner == .longRecording {
            return .rejected(reason: "正在录音整理，请先暂停录音")
        }
        if owner == .shortRecording {
            return .rejected(reason: "正在发送语音消息，请稍后再试")
        }
        if owner == .dictation {
            return .rejected(reason: "正在语音输入，请稍后再试")
        }
        // 长录音暂停时允许回放、短语音或听写临时使用；长录音继续时可重新拿回租约
        generation &+= 1
        owner = requester
        return .granted(AudioSessionLeaseToken(owner: requester, generation: generation))
    }

    /// 标记长录音进入暂停态并显式释放麦克风占用（允许用户回放或发短语音）。
    mutating func markLongRecordingPaused(token: AudioSessionLeaseToken) -> Bool {
        guard owner == .longRecording, token.owner == .longRecording, token.generation == generation else {
            return false
        }
        owner = .longPaused
        return true
    }

    /// 系统来电/Siri 中断记录。
    mutating func markInterrupted(token: AudioSessionLeaseToken) -> Bool {
        guard token.generation == generation, owner == token.owner else { return false }
        owner = .interrupted
        return true
    }

    /// 释放租约：仅当 generation 与 owner 匹配时才生效，防止旧任务晚到 completion 停掉新 owner。
    @discardableResult
    mutating func release(_ token: AudioSessionLeaseToken) -> Bool {
        guard token.generation == generation else { return false }
        guard owner == token.owner || (token.owner == .longRecording && (owner == .longPaused || owner == .interrupted)) else {
            return false
        }
        owner = .idle
        return true
    }

    var isLongRecordingActive: Bool {
        owner == .longRecording
    }
}

#if canImport(AVFAudio)
/// App 级 AVAudioSession 串行仲裁与配置器。
@MainActor
final class AudioSessionCoordinator {
    static let shared = AudioSessionCoordinator()

    private var arbitrator = AudioSessionLeaseArbitrator()
    private var sessionChain: Task<Void, Never>?

    private init() {}

    var currentOwner: AudioSessionOwner { arbitrator.owner }
    var isLongRecordingActive: Bool { arbitrator.isLongRecordingActive }

    func acquire(for owner: AudioSessionOwner) -> AudioSessionLeaseResult {
        arbitrator.acquire(for: owner)
    }

    @discardableResult
    func markLongRecordingPaused(token: AudioSessionLeaseToken) -> Bool {
        let changed = arbitrator.markLongRecordingPaused(token: token)
        if changed {
            deactivateSessionAsync()
        }
        return changed
    }

    @discardableResult
    func markInterrupted(token: AudioSessionLeaseToken) -> Bool {
        arbitrator.markInterrupted(token: token)
    }

    func release(_ token: AudioSessionLeaseToken, deactivate: Bool = true) {
        let released = arbitrator.release(token)
        if released, deactivate {
            deactivateSessionAsync()
        }
    }

    /// 串行激活录音或播放会话，避免与前一次异步 deactivate 竞态。
    func configureAndActivate(
        token: AudioSessionLeaseToken,
        category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions = [],
        overrideSpeaker: Bool? = nil
    ) async throws {
        guard arbitrator.generation == token.generation else {
            throw NSError(
                domain: "AudioSessionCoordinator",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "音频租约已失效"]
            )
        }
        let previous = sessionChain
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let next = Task { @MainActor in
                await previous?.value
                guard self.arbitrator.generation == token.generation else {
                    continuation.resume(
                        throwing: NSError(
                            domain: "AudioSessionCoordinator",
                            code: -2,
                            userInfo: [NSLocalizedDescriptionKey: "音频租约已变更"]
                        )
                    )
                    return
                }
                do {
                    try await Self.applySession(
                        category: category,
                        mode: mode,
                        options: options,
                        overrideSpeaker: overrideSpeaker
                    )
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
            sessionChain = Task { _ = await next.value }
        }
    }

    func waitForPendingSessionOps() async {
        await sessionChain?.value
    }

    private func deactivateSessionAsync() {
        let previous = sessionChain
        let expectedGen = arbitrator.generation
        let next = Task { @MainActor in
            await previous?.value
            // 若等待期间已有新租约生成，则不再停用系统音频会话
            guard self.arbitrator.generation == expectedGen,
                  self.arbitrator.owner == .idle || self.arbitrator.owner == .longPaused
            else { return }
            await Self.deactivateSystemSession()
        }
        sessionChain = next
    }

    /// 串行后台音频会话队列（供 AudioSessionCoordinator 与 VoiceDictation 共享，避免双队列交叉改写 AVAudioSession）。
    nonisolated static let audioQueue = DispatchQueue(label: "ai.jiebo.audio-session.coordinator", qos: .userInitiated)

    private static func applySession(
        category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions,
        overrideSpeaker: Bool?
    ) async throws {
        let session = AVAudioSession.sharedInstance()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            audioQueue.async {
                do {
                    try session.setCategory(category, mode: mode, options: options)
                    if let overrideSpeaker {
                        try session.overrideOutputAudioPort(overrideSpeaker ? .speaker : .none)
                    }
                    try session.setActive(true)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func deactivateSystemSession() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            audioQueue.async {
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                continuation.resume()
            }
        }
    }
}
#endif
