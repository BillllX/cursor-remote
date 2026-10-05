import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// full = 原来的完整工具栏（iPad / 工作区会话）；assistant = iPhone 助理页：＋ / ⋯ / 麦克风 / 发送。
enum ComposerStyle { case full, assistant }

struct ComposerView: View {
    @Environment(ChatStore.self) private var store
    /// 外部递增时把光标放进输入框（空会话快捷句）。
    var focusNonce: Int = 0
    var style: ComposerStyle = .full
    @FocusState private var focused: Bool
    /// 打字只改这里。直接绑 store.draft 会让整段对话每次按键都重绘。
    @State private var text = ""
    @State private var persistTask: Task<Void, Never>?
    /// 防抖中还没落库的草稿和它所属的会话
    @State private var pendingDraft: (chatId: String, text: String)?
    /// 自己写回 store.draft 时不要再灌进输入框，否则会把后打的字盖掉。
    @State private var ignoreDraftEcho: String?
    /// 工具栏宽度。只在宽度变化时重选布局，避免每个字都把两套控件量一遍。
    @State private var controlsWidth: CGFloat = 0
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var viewerItem: AttachmentViewerItem?
    @State private var photoPickerOpen = false
    @State private var filePickerOpen = false
    @State private var fileBrowserOpen = false
    /// 长按输入框说话
    @State private var dictation = VoiceDictation()
    @State private var holdTask: Task<Void, Never>?
    @State private var finishTask: Task<Void, Never>?
    @State private var pressing = false
    /// 按住时上滑超过阈值：松手就丢掉这段录音
    @State private var voiceCancelArmed = false
    /// .assistant：点按麦克风开始的录音。期间长按手势不动作，两种入口互斥共用同一个 dictation
    @State private var tapVoice = false
    @Namespace private var modeThumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 8) {
            if let pending = pendingApproval {
                approvalBar(pending)
            }
            if !queuedTurns.isEmpty {
                queueBar
            }
            attachmentStrip
            mentionStrip
            if dictation.active {
                voicePanel
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if style == .assistant {
                assistantStatusLine
                assistantCapsuleRow
            } else {
                TextField(placeholder, text: $text, axis: .vertical)
                    .font(JieboFont.text(.body))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1...8)
                    .focused($focused)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 8)
                    .overlay {
                        if !focused || dictation.active {
                            Color.clear
                                .contentShape(Rectangle())
                                .gesture(holdToTalk)
                                .accessibilityHidden(true)
                        }
                    }
                    .accessibilityHint("长按说话，松开后转成文字")
                    .onChange(of: text) { _, value in
                        if value.contains("@") || !store.mentionSuggestions.isEmpty {
                            store.updateMentions(for: value)
                        }
                        schedulePersist()
                    }
                    .onKeyPress(keys: [.return]) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        commitAndSend()
                        return .handled
                    }
                controls
                if controlsWidth >= 420, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Return 发送，Shift+Return 换行")
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                        .padding(.horizontal, 6)
                        .transition(.opacity)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, style == .assistant ? 8 : 10)
        .padding(.bottom, style == .assistant ? 8 : 10)
        .background {
            if style != .assistant {
                RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous)
                    .fill(JieboColor.composer)
                    .shadow(color: JieboColor.ink.opacity(0.05), radius: 1, y: 1)
                    .shadow(color: JieboColor.ink.opacity(focused ? 0.16 : 0.1), radius: focused ? 16 : 14, y: 8)
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous)
                            .stroke(focused ? JieboColor.pine.opacity(0.45) : JieboColor.line, lineWidth: 1)
                    )
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, floating ? 8 : 16)
        // 浮动玻璃底栏：不铺实底，让消息从胶囊下面透过去
        .background(floating ? Color.clear : JieboColor.paper)
        .onAppear {
            text = store.draft
            store.refreshCheckpoints()
        }
        .onDisappear(perform: stopVoice)
        .animation(JieboMotion.snappy(reduceMotion), value: dictation.active)
        .onChange(of: store.activeId) { _, _ in
            stopVoice()
            flushDraft()
            text = store.draft
            store.refreshCheckpoints()
        }
        .onChange(of: store.draft) { _, value in
            if value == ignoreDraftEcho { return }
            if value != text { text = value }
        }
        .onChange(of: focusNonce) { _, _ in
            focused = true
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            let chatId = store.activeId
            Task {
                var prepared: [PendingImage] = []
                var failed = 0
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { failed += 1; continue }
                    let mime = item.supportedContentTypes.first?.preferredMIMEType
                    // 压缩 + base64 预计算放后台线程（单张 100-300ms，避免卡主 actor）
                    let image = await Task.detached(priority: .userInitiated) {
                        ImagePrep.prepare(data, mimeType: mime)
                    }.value
                    if let image {
                        prepared.append(image)
                    } else {
                        failed += 1
                    }
                }
                store.addPendingImages(prepared, toChat: chatId)
                if failed > 0 { store.flash("\(failed) 张图片读取失败，换一张试试") }
            }
        }
        .photosPicker(isPresented: $photoPickerOpen, selection: $photoItems, maxSelectionCount: ImagePrep.maxCount, matching: .images)
        .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                store.attachFiles(urls)
            }
        }
        .sheet(isPresented: $fileBrowserOpen) {
            FileBrowserSheet { path in
                store.appendMentionToDraft(path)
            }
        }
    }

    /// 助理胶囊在 iOS 26+ 由 ThreadView 放进 safeAreaBar，浮在消息上
    private var floating: Bool { style == .assistant && JieboGlass.available }

    private var pendingApproval: PendingTool? {
        store.active?.turns.reversed().first { $0.pendingTool != nil }?.pendingTool
    }

    private var queuedTurns: [Turn] {
        store.active?.turns.filter(\.queued) ?? []
    }

    private func approvalBar(_ tool: PendingTool) -> some View {
        let path = tool.args?.string(in: "path", "file", "target_file", "file_path", "target") ?? ""
        let target = path.isEmpty ? tool.name : path
        return VStack(alignment: .leading, spacing: 8) {
            Text("要改文件：\(target)。允许会先还原再写；拒绝还原到发送前。")
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.ink)
            HStack(spacing: 8) {
                Button("拒绝", role: .destructive) { store.replyToApproval(allow: false) }
                    .buttonStyle(.bordered)
                Button("允许") { store.replyToApproval(allow: true) }
                    .buttonStyle(.borderedProminent)
                    .tint(JieboColor.pine)
            }
            .font(JieboFont.text(.subheadline, weight: .semibold))
            .controlSize(.large)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.warnBg)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
    }

    private var queueBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(queuedTurns) { turn in
                    HStack(spacing: 2) {
                        Image(systemName: "clock")
                            .font(JieboFont.text(.caption2, weight: .semibold))
                            .foregroundStyle(JieboColor.run)
                            .accessibilityHidden(true)
                        Text("排队 · \(String(turn.user.prefix(24)))")
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                            .padding(.leading, 4)
                        Button {
                            store.dropQueuedTurn(turn.id)
                        } label: {
                            Image(systemName: "xmark")
                                .font(JieboFont.text(.caption2, weight: .bold))
                                .foregroundStyle(JieboColor.ink2)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("去掉这条排队")
                    }
                    .padding(.leading, 10)
                    .frame(minHeight: 44)
                    // 胶囊视觉 32 高，布局与热区 44
                    .background(
                        Capsule()
                            .fill(JieboColor.white)
                            .overlay(Capsule().stroke(JieboColor.line, lineWidth: 1))
                            .padding(.vertical, 6)
                    )
                }
            }
        }
    }

    // MARK: - 长按说话

    /// 按下 0.35 秒开始录音；松手把文字填进输入框；按住上滑取消；没到时间就松手算点一下
    private var holdToTalk: some Gesture {
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
    private func stopVoice() {
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
    private func toggleVoice() {
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

    private var voicePanel: some View {
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

    private var placeholder: String {
        if style == .assistant {
            if !store.connected { return "正在连服务器…" }
            if store.busy { return "正在回复，发送会排队" }
            return "跟\(store.assistantName)说点什么"
        }
        if !store.connected { return "正在连服务器…" }
        if store.busy { return "正在动手，Enter 会排队" }
        switch store.mode {
        case .ask: return "问一句，不改文件，@ 引用 · 长按说话"
        case .plan: return "描述任务，只出方案 · 长按说话"
        case .agent: return "交代要做的事，@ 引用 · 长按说话"
        }
    }

    /// @补全候选条（对齐网页端 mention 下拉，iOS 用横滑芯片）
    @ViewBuilder
    private var mentionStrip: some View {
        if !store.mentionSuggestions.isEmpty {
            // 同名文件消歧：basename 有重复时显示父目录
            let names = store.mentionSuggestions.map { ($0 as NSString).lastPathComponent }
            let duplicated = Set(Dictionary(grouping: names, by: { $0 }).filter { $0.value.count > 1 }.keys)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(store.mentionSuggestions, id: \.self) { path in
                        let name = (path as NSString).lastPathComponent
                        let label = duplicated.contains(name) && path.contains("/")
                            ? (path as NSString).deletingLastPathComponent.components(separatedBy: "/").last.map { "\($0)/\(name)" } ?? name
                            : name
                        Button {
                            store.insertMention(path)
                        } label: {
                            Text("@\(label)")
                                .font(JieboFont.monoText(.caption))
                                .foregroundStyle(JieboColor.ink)
                                .lineLimit(1)
                                .padding(.horizontal, 10)
                                .frame(minHeight: 30)
                                .background(JieboColor.mist)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .hitTarget()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("引用 \(path)")
                    }
                }
                .padding(.horizontal, 2)
            }
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private var canSendNow: Bool {
        store.uploads.isEmpty
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.pendingImages.isEmpty)
    }

    private func schedulePersist() {
        if let pendingDraft, pendingDraft.chatId != store.activeId { flushDraft() }
        persistTask?.cancel()
        pendingDraft = (store.activeId, text)
        persistTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            flushDraft()
        }
    }

    private func flushDraft() {
        persistTask?.cancel()
        guard let pending = pendingDraft else { return }
        pendingDraft = nil
        if pending.chatId == store.activeId { ignoreDraftEcho = pending.text }
        store.saveDraft(pending.text, forChat: pending.chatId)
    }

    private func commitAndSend() {
        persistTask?.cancel()
        pendingDraft = nil
        ignoreDraftEcho = ""
        store.saveDraft(text)
        store.submit()
        text = store.draft
    }

    @ViewBuilder
    private var controls: some View {
        if style == .full {
            fullControls
        }
    }

    /// iPhone 助理：单行胶囊 — ＋（含 ⋯ 项）、输入、话筒/发送
    private var assistantCapsuleRow: some View {
        HStack(alignment: .bottom, spacing: 6) {
            assistantAttachMenu
            TextField(placeholder, text: $text, axis: .vertical)
                .font(JieboFont.text(.body))
                .foregroundStyle(JieboColor.ink)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.vertical, 11)
                .overlay {
                    if !focused || dictation.active {
                        Color.clear
                            .contentShape(Rectangle())
                            .gesture(holdToTalk)
                            .accessibilityHidden(true)
                    }
                }
                .onChange(of: text) { _, value in
                    if value.contains("@") || !store.mentionSuggestions.isEmpty {
                        store.updateMentions(for: value)
                    }
                    schedulePersist()
                }
            // 忙碌时停止和发送并存：发送会排在当前这轮之后（与 iPad 的完整输入框一致）
            if store.busy {
                if !canSendNow { micButton }
                stopButton
                if canSendNow { sendButton(queued: true) }
            } else if canSendNow {
                sendButton(queued: false)
            } else {
                micButton
            }
        }
        .padding(.leading, 4)
        .padding(.trailing, 4)
        .padding(.vertical, 2)
        .animation(JieboMotion.snappy(reduceMotion), value: store.busy)
        .animation(JieboMotion.snappy(reduceMotion), value: canSendNow)
        .modifier(CapsuleSurface(focused: focused))
    }

    private var stopButton: some View {
        Button(action: store.stop) {
            Image(systemName: "stop.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(JieboColor.danger)
                .frame(width: 36, height: 36)
                .background(JieboColor.dangerBg)
                .clipShape(Circle())
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .transition(.scale.combined(with: .opacity))
        .accessibilityLabel("停止回复")
    }

    private func sendButton(queued: Bool) -> some View {
        Button(action: commitAndSend) {
            Image(systemName: "arrow.up")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(JieboColor.fillFg)
                .frame(width: 36, height: 36)
                .background(JieboColor.pine)
                .clipShape(Circle())
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .transition(.scale.combined(with: .opacity))
        .keyboardShortcut(.return, modifiers: .command)
        .accessibilityLabel(queued ? "排队发送" : "发送")
        .accessibilityHint(queued ? "当前回复结束后再发" : "")
    }

    /// 胶囊上方一行小字：当前模式和模型。原来只藏在「＋」里，看不出这次会不会动手改文件
    private var assistantStatusLine: some View {
        Menu {
            Picker(selection: Binding(get: { store.mode }, set: { store.chooseMode($0) })) {
                ForEach(AgentMode.allCases, id: \.self) { item in
                    Text(item.label).tag(item)
                }
            } label: {
                Label("模式", systemImage: "slider.horizontal.3")
            }
            .pickerStyle(.menu)
            Picker(selection: Binding(get: { store.model }, set: { store.chooseModel($0) })) {
                ForEach(ModelCatalog.groups(from: store.models)) { group in
                    Section(group.label) {
                        ForEach(group.models) { item in
                            Text(item.name).tag(item.id)
                        }
                    }
                }
            } label: {
                Label("模型", systemImage: "cpu")
            }
            .pickerStyle(.menu)
        } label: {
            HStack(spacing: 4) {
                Text(store.mode.label)
                    .foregroundStyle(store.mode == .agent ? JieboColor.ink2 : JieboColor.pine)
                Text("·")
                Text(ModelCatalog.label(for: store.model))
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .accessibilityHidden(true)
            }
            .font(JieboFont.text(.caption, weight: .medium))
            .foregroundStyle(JieboColor.dim)
            .padding(.horizontal, 10)
            .frame(minHeight: 24)
            // 浮在消息上时没有底，字会和正文叠在一起
            .jieboGlass(in: Capsule())
            .contentShape(Capsule())
        }
        .menuOrder(.fixed)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, -4)
        .accessibilityLabel("模式 \(store.mode.label)，模型 \(ModelCatalog.label(for: store.model))")
        .accessibilityHint("轻点切换")
    }

    private var assistantAttachMenu: some View {
        Menu {
            Button { photoPickerOpen = true } label: { Label("照片", systemImage: "photo") }
            Button { filePickerOpen = true } label: { Label("文件", systemImage: "doc") }
            Section {
                Toggle(isOn: Binding(get: { store.active?.policy == "plane" }, set: { on in
                    if on != (store.active?.policy == "plane") { store.togglePolicy() }
                })) {
                    Label("策略层", systemImage: "square.stack.3d.up")
                }
                Toggle(isOn: Binding(get: { store.active?.confirmWrites == true }, set: { on in
                    if on != (store.active?.confirmWrites == true) { store.toggleConfirmWrites() }
                })) {
                    Label("写入前确认", systemImage: "checkmark.shield")
                }
            }
            Section {
                Button(action: store.undoLast) {
                    Label("撤销上一次", systemImage: "arrow.uturn.backward")
                }
                .disabled(!store.canUndo)
                if !store.checkpoints.isEmpty {
                    Menu {
                        ForEach(store.checkpoints) { item in
                            Button(item.label) { store.restoreCheckpoint(item.id) }
                                .disabled(store.busy)
                        }
                    } label: {
                        Label("还原到检查点", systemImage: "clock.arrow.circlepath")
                    }
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 36, height: 36)
                .hitTarget()
        }
        .menuOrder(.fixed)
        .accessibilityLabel("添加与更多")
    }

    private var micButton: some View {
        let recording = dictation.active
        return Button(action: toggleVoice) {
            Image(systemName: recording ? "mic.fill" : "mic")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(recording ? JieboColor.pine : JieboColor.ink2)
                .frame(width: 36, height: 36)
                .background(recording ? JieboColor.pine.opacity(0.14) : Color.clear)
                .clipShape(Circle())
                .symbolEffect(.pulse, isActive: recording && !reduceMotion)
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .transition(.scale.combined(with: .opacity))
        .accessibilityLabel(recording ? "结束录音" : "语音输入")
    }

    private var fullControls: some View {
        HStack(alignment: .center, spacing: 8) {
            attachMenu
            if controlsWidth >= 420 {
                modePicker
                modelPicker(maxWidth: 180)
            } else {
                compactMode
                modelPicker(maxWidth: 108)
            }
            if controlsWidth >= 640 {
                policyToggle
                confirmToggle
            } else {
                moreMenu
            }
            Spacer(minLength: 8)
            sendCluster(enabled: canSendNow)
        }
        .background {
            GeometryReader { geo in
                Color.clear
                    .onAppear { controlsWidth = geo.size.width }
                    .onChange(of: geo.size.width) { _, width in
                        if abs(width - controlsWidth) > 1 { controlsWidth = width }
                    }
            }
        }
    }

    private func sendCluster(enabled: Bool) -> some View {
        HStack(spacing: 8) {
            if store.busy {
                Button(action: store.stop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(JieboColor.paper)
                        .frame(width: 32, height: 32)
                        .background(JieboColor.danger)
                        .clipShape(Circle())
                        .hitTarget()
                }
                .buttonStyle(PressScaleButtonStyle())
                .accessibilityLabel("停止")
                .transition(.scale.combined(with: .opacity))
            }
            Button(action: commitAndSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(enabled ? JieboColor.paper : JieboColor.dim.opacity(0.45))
                    .frame(width: 32, height: 32)
                    .background(enabled ? JieboColor.pine : JieboColor.mist.opacity(0.55))
                    .clipShape(Circle())
                    .scaleEffect(enabled ? 1 : 0.94)
                    .animation(JieboMotion.snappy(reduceMotion), value: enabled)
                    .hitTarget()
            }
            .buttonStyle(PressScaleButtonStyle(enabled: enabled))
            .disabled(!enabled)
            .keyboardShortcut(.return, modifiers: .command)
            .accessibilityLabel("发送")
        }
    }

    private var moreMenu: some View {
        let plane = store.active?.policy == "plane"
        let confirm = store.active?.confirmWrites == true
        return Menu {
            if style == .assistant {
                Menu {
                    ForEach(AgentMode.allCases, id: \.self) { item in
                        Button {
                            store.chooseMode(item)
                        } label: {
                            Label(item.label, systemImage: store.mode == item ? "checkmark" : "circle")
                        }
                    }
                } label: {
                    Label("模式 · \(store.mode.label)", systemImage: "slider.horizontal.3")
                }
                Menu {
                    ForEach(ModelCatalog.groups(from: store.models)) { group in
                        Section(group.label) {
                            ForEach(group.models) { item in
                                Button(item.name) { store.chooseModel(item.id) }
                            }
                        }
                    }
                } label: {
                    Label("模型 · \(ModelCatalog.label(for: store.model))", systemImage: "cpu")
                }
                Divider()
            }
            Button(action: store.togglePolicy) {
                Label(plane ? "正在用策略层" : "切到策略层", systemImage: plane ? "checkmark" : "circle")
            }
            Button(action: store.toggleConfirmWrites) {
                Label(confirm ? "确认写" : "直写", systemImage: confirm ? "checkmark.shield.fill" : "checkmark.shield")
            }
            Button(action: store.undoLast) {
                Label("撤销上一次", systemImage: "arrow.uturn.backward")
            }
            .disabled(!store.canUndo)
            if store.checkpoints.isEmpty {
                Button(store.mode == .ask ? "只问不会打检查点" : "动手或出方案时会记下检查点") {}
                    .disabled(true)
            } else {
                ForEach(store.checkpoints) { item in
                    Button("还原 · \(item.label)") { store.restoreCheckpoint(item.id) }
                        .disabled(store.busy)
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 32, height: 32)
                .background(Color.clear)
                .clipShape(Circle())
                .overlay(Circle().stroke(JieboColor.line, lineWidth: 1))
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("更多")
    }

    private var attachMenu: some View {
        Menu {
            // PhotosPicker 不能直接嵌在 Menu 内容里：iPadOS 上菜单关闭后选择器视图随之销毁，
            // 表现为点了「照片」没反应或选完不回传——改用 isPresented 修饰符挂在稳定视图上
            Button {
                photoPickerOpen = true
            } label: {
                Label("照片", systemImage: "photo")
            }
            Button {
                filePickerOpen = true
            } label: {
                Label("文件", systemImage: "doc")
            }
            if style == .full {
                Button {
                    fileBrowserOpen = true
                } label: {
                    Label("工作区文件…", systemImage: "folder")
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 32, height: 32)
                .background(Color.clear)
                .clipShape(Circle())
                .overlay(Circle().stroke(JieboColor.line, lineWidth: 1))
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("添加附件")
    }

    private var confirmToggle: some View {
        let on = store.active?.confirmWrites == true
        return Button(action: store.toggleConfirmWrites) {
            HStack(spacing: 4) {
                Image(systemName: on ? "checkmark.shield.fill" : "checkmark.shield")
                    .font(.system(size: 11, weight: .regular))
                Text(on ? "确认写" : "直写")
                    .font(JieboFont.text(.caption2, weight: .regular))
            }
            // 次级：关态 ink2 可读、无填充；开态浅 brass；字号 11 让出主焦点给模式/模型
            .foregroundStyle(on ? JieboColor.brass : JieboColor.ink2)
            .padding(.horizontal, 10)
            .frame(minHeight: 32)
            .background(on ? JieboColor.brass.opacity(0.10) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .hitTarget() // P6：视觉 32 高，命中 44
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(on ? "写入前确认" : "自动写入")
    }

    private var policyToggle: some View {
        let plane = store.active?.policy == "plane"
        return Button(action: store.togglePolicy) {
            Text(plane ? "策略层" : "现状")
                .font(JieboFont.text(.caption2, weight: .regular))
                .foregroundStyle(plane ? JieboColor.brass : JieboColor.ink2)
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .background(plane ? JieboColor.brass.opacity(0.10) : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(plane ? "策略层" : "现状路径")
    }

    @ViewBuilder
    private var attachmentStrip: some View {
        if !store.pendingImages.isEmpty || !store.uploads.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 26) {
                    ForEach(store.pendingImages) { image in
                        ZStack(alignment: .topTrailing) {
                            let data = image.data
                            Button {
                                viewerItem = AttachmentViewerItem(title: "待发送的图片", load: { data })
                            } label: {
                                AttachmentThumb(key: "pending|\(image.id.uuidString)", side: 56) { data }
                                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                            }
                            .buttonStyle(PressScaleButtonStyle())
                            .accessibilityLabel("待发送的图片")
                            .accessibilityHint("轻点两下查看大图")
                            Button {
                                store.removePendingImage(image.id)
                            } label: {
                                // 图标 20pt 压在右上角，命中框 44×44 以图片角为中心，不盖住图片中部（中部是看大图）
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 20))
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(JieboColor.paper, JieboColor.ink2)
                                    .frame(width: 44, height: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .offset(x: 22, y: -22)
                            .accessibilityLabel("移除图片")
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                store.removePendingImage(image.id)
                            } label: {
                                Label("移除图片", systemImage: "trash")
                            }
                        }
                    }
                    ForEach(store.uploads) { item in
                        HStack(spacing: 6) {
                            ProgressView()
                                .controlSize(.small)
                            Text(item.name)
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.ink2)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .frame(minHeight: 32)
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                    }
                }
                // 给右上角的移除按钮留出位置，不被滚动区裁掉
                .padding(.top, 22)
                .padding(.trailing, 22)
                .padding(.bottom, 2)
            }
            .transition(.move(edge: .top).combined(with: .opacity))
            .fullScreenCover(item: $viewerItem) { item in
                AttachmentViewer(item: item)
            }
        }
    }

    private var modePicker: some View {
        HStack(spacing: 0) {
            ForEach(AgentMode.allCases, id: \.self) { item in
                Button {
                    store.chooseMode(item)
                } label: {
                    Text(item.label)
                        .font(JieboFont.text(.footnote, weight: .medium))
                        .foregroundStyle(store.mode == item ? JieboColor.ink : JieboColor.ink2)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 32)
                        .background {
                            if store.mode == item {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(JieboColor.ink.opacity(0.06))
                                    .matchedGeometryEffect(id: "mode-thumb", in: modeThumb)
                            }
                        }
                        .hitTarget() // P6：滑块视觉 32 高不变，命中 44
                }
                .buttonStyle(PressScaleButtonStyle())
            }
        }
        .padding(2)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        )
        .animation(JieboMotion.snappy(reduceMotion), value: store.mode)
    }

    private var compactMode: some View {
        Menu {
            ForEach(AgentMode.allCases, id: \.self) { item in
                Button(item.label) { store.chooseMode(item) }
            }
        } label: {
            Text(store.mode.label)
                .font(JieboFont.text(.footnote, weight: .medium))
                .foregroundStyle(JieboColor.ink)
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .background(Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                )
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("模式 \(store.mode.label)")
    }

    private func modelPicker(maxWidth: CGFloat) -> some View {
        Menu {
            ForEach(ModelCatalog.groups(from: store.models)) { group in
                Section(group.label) {
                    ForEach(group.models) { item in
                        Button(item.name) { store.chooseModel(item.id) }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(ModelCatalog.label(for: store.model))
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 32)
            .frame(maxWidth: maxWidth)
            .background(Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
            .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
    }
}

/// iPhone 助理输入胶囊的底：iOS 26+ 是浮在内容上的 Liquid Glass（聚焦时描一圈强调色），更早的系统保留原来的实底 + 阴影
private struct CapsuleSurface: ViewModifier {
    var focused: Bool

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: shape)
                .overlay(shape.stroke(JieboColor.pine.opacity(focused ? 0.35 : 0), lineWidth: 1))
        } else {
            content.background {
                shape
                    .fill(JieboColor.composer)
                    .shadow(color: JieboColor.ink.opacity(0.05), radius: 1, y: 1)
                    .shadow(color: JieboColor.ink.opacity(focused ? 0.14 : 0.08), radius: focused ? 12 : 8, y: 4)
                    .overlay(shape.stroke(focused ? JieboColor.pine.opacity(0.4) : JieboColor.line, lineWidth: 1))
            }
        }
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
