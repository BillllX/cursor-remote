import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

extension ComposerView {
    // MARK: - 长按说话

    /// 按下 0.35 秒开始录音；松手把文字填进输入框；按住上滑取消；没到时间就松手算点一下
    var holdToTalk: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if tapVoice { return }
                if !pressing {
                    pressing = true
                    voiceCancelArmed = false
                    holdTask = Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(350))
                        guard !Task.isCancelled, pressing else { return }
                        await beginVoice()
                    }
                }
                guard dictation.active else {
                    // 还没开始录就挪开了手指：当作拖动，不录音
                    if abs(value.translation.width) + abs(value.translation.height) > 10 {
                        holdTask?.cancel()
                        holdTask = nil
                    }
                    return
                }
                let armed = value.translation.height < -60
                if armed != voiceCancelArmed {
                    voiceCancelArmed = armed
                    UISelectionFeedbackGenerator().selectionChanged()
                }
            }
            .onEnded { value in
                if tapVoice { return }
                pressing = false
                holdTask?.cancel()
                holdTask = nil
                switch dictation.phase {
                case .idle:
                    let moved = abs(value.translation.width) + abs(value.translation.height)
                    if moved <= 10 { focused = true }
                case .starting:
                    dictation.cancel()
                case .recording:
                    if voiceCancelArmed {
                        dictation.cancel()
                    } else {
                        finishTask?.cancel()
                        finishTask = Task { @MainActor in
                            let spoken = await dictation.finish()
                            guard !Task.isCancelled else { return }
                            insertTranscript(spoken)
                        }
                    }
                case .finishing:
                    break
                }
                voiceCancelArmed = false
            }
    }

    /// 切会话、页面消失：丢掉进行中的录音和还没回填的转写
    func stopVoice() {
        holdTask?.cancel()
        holdTask = nil
        finishTask?.cancel()
        finishTask = nil
        pressing = false
        voiceCancelArmed = false
        tapVoice = false
        dictation.cancel()
    }

    /// .assistant 的麦克风按钮：点一下开始，再点一下结束并把文字填进输入框
    func toggleVoice() {
        switch dictation.phase {
        case .idle:
            guard !pressing else { return }
            tapVoice = true
            Task { @MainActor in
                await beginVoice(tap: true)
                if dictation.phase == .idle { tapVoice = false }
            }
        case .starting:
            guard tapVoice else { return } // 长按手势发起的录音，不被按钮打断
            dictation.cancel()
            tapVoice = false
        case .recording:
            guard tapVoice else { return }
            finishTask?.cancel()
            finishTask = Task { @MainActor in
                let spoken = await dictation.finish()
                tapVoice = false
                guard !Task.isCancelled else { return }
                insertTranscript(spoken)
            }
        case .finishing:
            break
        }
    }

    private func cancelTapVoice() {
        finishTask?.cancel()
        finishTask = nil
        dictation.cancel()
        tapVoice = false
    }

    private func beginVoice(tap: Bool = false) async {
        focused = false
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if let message = await dictation.start() {
            store.flash(message)
        }
        // 权限弹窗、开音频期间已经松手：start 会自己收掉，这里不再留着录音
        if !tap, !pressing, dictation.phase == .recording { dictation.cancel() }
    }

    private func insertTranscript(_ spoken: String) {
        guard !spoken.isEmpty else {
            store.flash("没听清，再说一次")
            return
        }
        text = text.isEmpty ? spoken : text + spoken
        schedulePersist()
        focused = true
    }

    var voicePanel: some View {
        let finishing = dictation.phase == .finishing
        let tint = voiceCancelArmed ? JieboColor.danger : JieboColor.pine
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                VoiceLevelBars(level: dictation.level, tint: tint, live: dictation.phase == .recording)
                Text(voiceHint(finishing: finishing))
                    .font(JieboFont.text(.caption, weight: .medium))
                    .foregroundStyle(voiceCancelArmed ? JieboColor.danger : JieboColor.ink2)
                Spacer(minLength: 0)
                if finishing { ProgressView().controlSize(.small) }
                if tapVoice, !finishing {
                    Button("取消", action: cancelTapVoice)
                        .buttonStyle(.plain)
                        .font(JieboFont.text(.caption, weight: .medium))
                        .foregroundStyle(JieboColor.ink2)
                        .hitTarget()
                }
            }
            Text(dictation.transcript.isEmpty ? "请说话…" : dictation.transcript)
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(dictation.transcript.isEmpty ? JieboColor.dim : JieboColor.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(6)
        }
        .padding(10)
        .background(voiceCancelArmed ? JieboColor.dangerBg : JieboColor.pine.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(tint.opacity(0.35), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    private func voiceHint(finishing: Bool) -> String {
        if finishing { return "正在转文字…" }
        if dictation.phase == .starting { return "准备录音…" }
        if tapVoice { return dictation.stoppedEarly ? "已停止录音，点话筒填入输入框" : "再点话筒结束" }
        if voiceCancelArmed { return "松开取消" }
        return dictation.stoppedEarly ? "已停止录音，松开填入输入框" : "松开填入输入框 · 上滑取消"
    }
}

/// 录音时的五根音量条
private struct VoiceLevelBars: View {
    var level: CGFloat
    var tint: Color
    var live: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let weights: [CGFloat] = [0.45, 0.8, 1, 0.7, 0.5]

    var body: some View {
        HStack(alignment: .center, spacing: 3) {
            ForEach(weights.indices, id: \.self) { index in
                Capsule()
                    .fill(tint)
                    .frame(width: 3, height: 4 + 14 * (live ? level : 0) * weights[index])
            }
        }
        .frame(width: 27, height: 18)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: level)
    }
}
