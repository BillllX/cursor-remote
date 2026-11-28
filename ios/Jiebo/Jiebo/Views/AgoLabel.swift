import Observation
import SwiftUI
import UIKit

/// 全局共享分钟时钟：替代列表中数十个独立 TimelineView(.everyMinute)，
/// 仅在有活跃订阅者且 App 处于前台时每 60 秒递增一次 tick，进后台自动暂停、回前台立即校准。
@MainActor
@Observable
final class MinuteClock {
    static let shared = MinuteClock()

    private(set) var tick: UInt64 = 0

    @ObservationIgnored private var subscribers = 0
    @ObservationIgnored private var isForeground = true
    @ObservationIgnored private var loopTask: Task<Void, Never>?
    @ObservationIgnored private var loopGeneration: UInt64 = 0
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    private init() {
        isForeground = UIApplication.shared.applicationState != .background
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.isForeground = false
                self.stopLoop()
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.isForeground = true
                if self.subscribers > 0 {
                    self.tick &+= 1
                    self.startLoopIfNeeded()
                }
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.significantTimeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.isForeground, self.subscribers > 0 else { return }
                self.tick &+= 1
                self.stopLoop()
                self.startLoopIfNeeded()
            }
        })
    }

    func retain() {
        subscribers += 1
        startLoopIfNeeded()
    }

    func release() {
        subscribers = max(0, subscribers - 1)
        if subscribers == 0 {
            stopLoop()
        }
    }

    private func startLoopIfNeeded() {
        guard subscribers > 0, isForeground, loopTask == nil else { return }
        loopGeneration &+= 1
        let generation = loopGeneration
        loopTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                // 对齐到下一个整分钟边界，避免每条记录各自漂移
                let now = Date().timeIntervalSince1970
                let delay = max(1.0, 60.0 - now.truncatingRemainder(dividingBy: 60.0))
                try? await Task.sleep(for: .seconds(delay))
                guard let self,
                    !Task.isCancelled,
                    self.loopGeneration == generation,
                    self.subscribers > 0,
                    self.isForeground
                else { break }
                self.tick &+= 1
            }
            if let self, self.loopGeneration == generation {
                self.loopTask = nil
            }
        }
    }

    private func stopLoop() {
        loopGeneration &+= 1
        loopTask?.cancel()
        loopTask = nil
    }
}

/// 「5 分钟前」这类相对时间，由全局单一 MinuteClock 驱动，超过 7 天的固定月日与空值零订阅。
struct AgoLabel: View {
    let epochMs: Double?
    var font: Font
    var long = false

    static func isLiveWindow(_ epochMs: Double) -> Bool {
        epochMs > 0 && (Date().timeIntervalSince1970 - epochMs / 1000) < 86_400 * 7
    }

    var body: some View {
        if let epochMs, Self.isLiveWindow(epochMs) {
            LiveAgoLabel(epochMs: epochMs, font: font, long: long)
        } else {
            Text(agoText(epochMs, long: long))
                .font(font)
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
        }
    }
}

private struct LiveAgoLabel: View {
    let epochMs: Double
    let font: Font
    let long: Bool
    @State private var expired = false

    var body: some View {
        Group {
            if expired {
                Text(agoText(epochMs, long: long))
                    .font(font)
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(1)
            } else {
                LiveAgoTickText(epochMs: epochMs, font: font, long: long) {
                    expired = true
                }
            }
        }
        .onChange(of: epochMs) { _, next in
            if expired && AgoLabel.isLiveWindow(next) {
                expired = false
            }
        }
    }
}

private struct LiveAgoTickText: View {
    let epochMs: Double
    let font: Font
    let long: Bool
    let onExpire: () -> Void
    @State private var retained = false

    var body: some View {
        let tick = MinuteClock.shared.tick
        Text(agoText(epochMs, long: long))
            .font(font)
            .foregroundStyle(JieboColor.dim)
            .lineLimit(1)
            .onAppear {
                guard !retained else { return }
                retained = true
                MinuteClock.shared.retain()
            }
            .onChange(of: tick) { _, _ in
                if !AgoLabel.isLiveWindow(epochMs) {
                    onExpire()
                }
            }
            .onDisappear {
                guard retained else { return }
                retained = false
                MinuteClock.shared.release()
            }
    }
}
