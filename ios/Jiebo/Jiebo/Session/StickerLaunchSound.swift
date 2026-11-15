import AVFoundation
import UIKit

/// All audio setup runs on this queue, never on the first-frame/main-thread path.
final class StickerLaunchSound: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ai.jiebo.launch-sound", qos: .utility)
    private var player: AVAudioPlayer?
    private var previous: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?

    func play(startedAt: TimeInterval) {
        queue.async { [self] in
            let session = AVAudioSession.sharedInstance()
            guard session.category != .playAndRecord, session.category != .record,
                  !session.isOtherAudioPlaying,
                  let asset = NSDataAsset(name: "StickerLaunchSound") else { return }
            do {
                previous = (session.category, session.mode, session.categoryOptions)
                try session.setCategory(.ambient, mode: .default)
                try session.setActive(true)
                let sound = try AVAudioPlayer(data: asset.data, fileTypeHint: AVFileType.wav.rawValue)
                sound.volume = 0.5
                sound.prepareToPlay()
                let elapsed = ProcessInfo.processInfo.systemUptime - startedAt
                guard elapsed < StickerLaunchTimeline.revealStart else { restoreSession(); return }
                sound.currentTime = max(0, elapsed)
                player = sound
                sound.play()
            } catch {
                restoreSession() // Sound is optional; never hold up the transition.
            }
        }
    }

    func stop() {
        queue.async { [self] in
            player?.stop()
            player = nil
            restoreSession()
        }
    }

    private func restoreSession() {
        guard let previous else { return }
        self.previous = nil
        let session = AVAudioSession.sharedInstance()
        // Another feature may have acquired audio while the intro was being dismissed.
        guard session.category == .ambient, session.mode == .default else { return }
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(previous.0, mode: previous.1, options: previous.2)
    }
}
