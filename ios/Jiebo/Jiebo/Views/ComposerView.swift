import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// full = 原来的完整工具栏（iPad / 工作区会话）；assistant = iPhone 助理页：＋ / ⋯ / 麦克风 / 发送。
enum ComposerStyle { case full, assistant }

struct ComposerView: View {
    @Environment(ChatStore.self) var store
    @Environment(\.threadChatId) private var environmentChatId
    @Environment(\.sceneSessionState) private var sceneSession
    /// 外部递增时把光标放进输入框（空会话快捷句）。
    var focusNonce: Int = 0
    var style: ComposerStyle = .full
    @FocusState var focused: Bool
    /// 打字写进这个对象，不写进视图状态。这样每个字不会把整条输入栏和会话回合再画一遍。
    @State var draftBuffer = ComposerDraftBuffer()
    /// 外部改草稿时递增，输入框据此把文字灌进去。
    @State var draftRevision = 0
    /// 只在「有字 / 没字」之间翻转，用来换话筒和发送，不跟着每个字变。
    @State var hasText = false
    /// 自己写回 store.draft 时不要再灌进输入框，否则会把后打的字盖掉。
    @State private var ignoreDraftEcho: String?
    /// 工具栏宽度。只在宽度变化时重选布局，避免每个字都把两套控件量一遍。
    @State var controlsWidth: CGFloat = 0
    @State private var photoItems: [PhotosPickerItem] = []
    @State var viewerItem: AttachmentViewerItem?
    @State var photoPickerOpen = false
    @State var filePickerOpen = false
    @State var fileBrowserOpen = false
    /// 长按输入框说话
    @State var dictation = VoiceDictation()
    @State var holdTask: Task<Void, Never>?
    @State var finishTask: Task<Void, Never>?
    @State var pressing = false
    /// 按住时上滑超过阈值：松手就丢掉这段录音
    @State var voiceCancelArmed = false
    /// .assistant：点按麦克风开始的录音。期间长按手势不动作，两种入口互斥共用同一个 dictation
    @State var tapVoice = false
    @Namespace var modeThumb
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    @Environment(\.assistantSceneToken) private var assistantSceneToken
    @Environment(\.assistantVoicePresenterActive) private var assistantVoicePresenterActive

    var chatId: String { environmentChatId.isEmpty ? store.activeId : environmentChatId }
    var chat: ChatSession? { store.chatSession(chatId) }
    var chatBusy: Bool { store.isBusy(chatId) }
    var chatMode: AgentMode { store.mode(for: chatId) }
    var chatModel: String { store.model(for: chatId) }
    var chatImages: [PendingImage] { store.pendingImages(for: chatId) }

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
                entryField(lineLimit: 1 ... 8, submitOnReturn: true, vertical: 8, horizontal: 6)
                controls
                if controlsWidth >= 420, !hasText {
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
        .confirmationDialog(
            "确认上传大文件？",
            isPresented: Binding(
                get: { store.uploadConfirmation != nil },
                set: { if !$0 { store.resolveUploadConfirmation(false) } }
            ),
            titleVisibility: .visible
        ) {
            Button("上传") { store.resolveUploadConfirmation(true) }
            Button("取消", role: .cancel) { store.resolveUploadConfirmation(false) }
        } message: {
            if let confirmation = store.uploadConfirmation {
                Text("\(confirmation.name) 压缩后的实际待传大小为 \(ChatStore.megabytes(confirmation.bytes))。")
            }
        }
        .onAppear {
            replaceDraft(sceneDraft(for: chatId))
            store.refreshCheckpoints(chatId: chatId)
        }
        .onDisappear {
            stopVoice()
            flushDraft()
        }
        .animation(JieboMotion.snappy(reduceMotion), value: dictation.active)
        .onChange(of: chatId) { oldId, _ in
            stopVoice()
            flushDraft(currentChatId: oldId)
            replaceDraft(sceneDraft(for: chatId))
            store.refreshCheckpoints(chatId: chatId)
        }
        .onChange(of: store.draft(for: chatId)) { _, value in
            guard sceneSession == nil else { return }
            if value == ignoreDraftEcho { return }
            if value != draftBuffer.text { replaceDraft(value) }
        }
        .onChange(of: focusNonce) { _, _ in
            focused = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantVoiceComposerRequested)) { notification in
            handleAssistantVoice(notification)
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantComposerFocusRequested)) { notification in
            guard let delivery = notification.object as? PadSceneCommandDelivery,
                  delivery.sceneToken == assistantSceneToken,
                  assistantVoicePresenterActive,
                  store.isAssistantChat(chatId)
            else { return }
            focused = true
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            let targetChatId = chatId
            Task {
                let uploadProfile = MobileMediaPolicy.workbenchUpload(
                    mode: MobileDataRuntime.mode,
                    cost: MobileDataRuntime.networkCost
                )
                var prepared: [PendingImage] = []
                var failed = 0
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { failed += 1; continue }
                    let mime = item.supportedContentTypes.first?.preferredMIMEType
                    // 压缩 + base64 预计算放后台线程（单张 100-300ms，避免卡主 actor）
                    let image = await Task.detached(priority: .userInitiated) { [uploadProfile] in
                        ImagePrep.prepare(data, mimeType: mime, profile: uploadProfile)
                    }.value
                    if let image {
                        prepared.append(image)
                    } else {
                        failed += 1
                    }
                }
                store.addPendingImages(prepared, toChat: targetChatId)
                if failed > 0 { store.flash("\(failed) 张图片读取失败，换一张试试") }
            }
        }
        // 落在输入文字上时系统文本框自己插字；落在输入框其余位置时这里接，只认文件行、页签拖出来的 @路径
        .dropDestination(for: String.self) { items, _ in
            let paths = items.compactMap { item -> String? in
                let trimmed = item.trimmingCharacters(in: .whitespacesAndNewlines)
                guard trimmed.hasPrefix("@"), trimmed.count > 1,
                      !trimmed.contains(where: \.isWhitespace) else { return nil }
                return String(trimmed.dropFirst())
            }
            guard !paths.isEmpty else { return false }
            let current = draftBuffer.text
            let separator = current.isEmpty || current.hasSuffix(" ") ? "" : " "
            replaceDraft(current + separator + paths.map { "@\($0)" }.joined(separator: " "))
            schedulePersist()
            return true
        }
        // iPad Files / Safari 拖入：文件走现有上传，网页地址只写入当前草稿，由用户确认后发送。
        .dropDestination(for: URL.self) { urls, _ in
            let files = urls.filter(\.isFileURL)
            let links = urls.filter { !$0.isFileURL }.map(\.absoluteString)
            guard !files.isEmpty || !links.isEmpty else { return false }
            if !files.isEmpty { store.attachFiles(files, chatId: chatId) }
            if !links.isEmpty {
                let current = draftBuffer.text
                let separator = current.isEmpty || current.hasSuffix("\n") ? "" : "\n"
                replaceDraft(current + separator + links.joined(separator: "\n"))
                schedulePersist()
            }
            return true
        }
        .photosPicker(isPresented: $photoPickerOpen, selection: $photoItems, maxSelectionCount: ImagePrep.maxCount, matching: .images)
        .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                store.attachFiles(urls, chatId: chatId)
            }
        }
        .sheet(isPresented: $fileBrowserOpen) {
            FileBrowserSheet(chatId: chatId) { path in
                store.appendMentionToDraft(path, chatId: chatId)
            }
        }
    }

    private func handleAssistantVoice(_ notification: Notification) {
        guard let delivery = notification.object as? AssistantVoiceDelivery,
              delivery.sceneToken == assistantSceneToken,
              assistantVoicePresenterActive,
              dictation.phase == .idle,
              store.isAssistantChat(chatId)
        else { return }
        toggleVoice()
        AssistantCaptureBridge.remove(id: delivery.capture.id, tenant: delivery.capture.tenant)
    }

    /// 最低支持 iOS 26：助理胶囊仍是浮在内容上的玻璃底。底栏本身用 safeAreaInset，不用 safeAreaBar。
    private var floating: Bool { style == .assistant && JieboGlass.available }

    var placeholder: String {
        if style == .assistant {
            if !store.connected { return "正在连服务器…" }
            if chatBusy { return "正在回复，发送会排队" }
            return "跟\(store.assistantName)说点什么"
        }
        if !store.connected { return "正在连服务器…" }
        if chatBusy { return "正在动手，Enter 会排队" }
        switch chatMode {
        case .ask: return "问一句，不改文件，@ 引用 · 长按说话"
        case .plan: return "描述任务，只出方案 · 长按说话"
        case .agent: return "交代要做的事，@ 引用 · 长按说话"
        }
    }

    var canSendNow: Bool {
        store.uploads.isEmpty
            && (hasText || !chatImages.isEmpty)
    }

    @ViewBuilder
    func entryField(lineLimit: ClosedRange<Int>, submitOnReturn: Bool, vertical: CGFloat, horizontal: CGFloat) -> some View {
        ComposerEntryField(
            placeholder: placeholder,
            lineLimit: lineLimit,
            buffer: draftBuffer,
            revision: draftRevision,
            focused: $focused,
            submitOnReturn: submitOnReturn,
            onEdit: noteTyped,
            onSubmit: commitAndSend
        )
        .padding(.horizontal, horizontal)
        .padding(.vertical, vertical)
        .overlay {
            if !focused || dictation.active {
                Color.clear
                    .contentShape(Rectangle())
                    .gesture(holdToTalk)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityHint(submitOnReturn ? "长按说话，松开后转成文字" : "")
    }

    /// 只在空与非空切换时改 hasText。补全和草稿防抖不碰视图状态。
    func noteTyped(_ value: String) {
        let filled = !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if filled != hasText { hasText = filled }
        if mentionsMayChange(value) {
            store.updateMentions(for: value, chatId: chatId)
        }
        schedulePersist()
    }

    /// `@` 不在当前词尾、候选也收起时，不必每个字都扫一遍补全。
    func mentionsMayChange(_ value: String) -> Bool {
        if !store.mentionSuggestions.isEmpty { return true }
        guard let at = value.lastIndex(of: "@") else { return false }
        let tail = value[at...]
        if tail.contains(where: \.isWhitespace) { return false }
        let before = value[..<at]
        return before.isEmpty || before.last?.isWhitespace == true
    }

    func replaceDraft(_ value: String) {
        draftBuffer.text = value
        draftRevision += 1
        let filled = !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if filled != hasText { hasText = filled }
    }

    func schedulePersist() {
        if let pending = draftBuffer.pendingChatId, pending != chatId { flushDraft() }
        draftBuffer.persistTask?.cancel()
        draftBuffer.pendingChatId = chatId
        draftBuffer.pendingText = draftBuffer.text
        draftBuffer.persistTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            flushDraft()
        }
    }

    private func flushDraft(currentChatId: String? = nil) {
        draftBuffer.persistTask?.cancel()
        guard let pendingId = draftBuffer.pendingChatId else { return }
        let pendingText = draftBuffer.pendingText
        draftBuffer.pendingChatId = nil
        if pendingId == (currentChatId ?? chatId) { ignoreDraftEcho = pendingText }
        if let sceneSession {
            sceneSession.saveDraft(pendingText, for: pendingId)
        } else {
            store.saveDraft(pendingText, forChat: pendingId)
        }
    }

    func commitAndSend() {
        focused = false
        draftBuffer.persistTask?.cancel()
        draftBuffer.pendingChatId = nil
        ignoreDraftEcho = ""
        let current = draftBuffer.text
        // 发送接口保持兼容；共享 draft 只在这一瞬间作提交参数，不再作为多窗口编辑状态。
        store.saveDraft(current, forChat: chatId)
        store.submit(chatId: chatId, text: current)
        let next = store.draft(for: chatId)
        sceneSession?.saveDraft(next, for: chatId)
        replaceDraft(next)
    }

    private func sceneDraft(for id: String) -> String {
        sceneSession?.draft(for: id, fallback: store.draft(for: id)) ?? store.draft(for: id)
    }
}

/// 输入框的字。不是视图状态，改它不会让整条输入栏重绘。
final class ComposerDraftBuffer {
    var text = ""
    var pendingChatId: String?
    var pendingText = ""
    var persistTask: Task<Void, Never>?
}

/// 只有这一层跟着每个字重绘。按钮、会话回合和玻璃底留在外面。
private struct ComposerEntryField: View {
    var placeholder: String
    var lineLimit: ClosedRange<Int>
    var buffer: ComposerDraftBuffer
    var revision: Int
    var focused: FocusState<Bool>.Binding
    var submitOnReturn: Bool
    var onEdit: (String) -> Void
    var onSubmit: () -> Void
    @State private var text = ""
    @State private var appliedRevision = -1

    var body: some View {
        TextField(placeholder, text: $text, axis: .vertical)
            .font(JieboFont.text(.body))
            .foregroundStyle(JieboColor.ink)
            .lineLimit(lineLimit)
            .focused(focused)
            .background(TextViewKeyboardInsetLock())
            .onAppear { adoptBuffer(revision) }
            .onChange(of: revision) { _, revision in adoptBuffer(revision) }
            .onChange(of: text) { _, value in
                guard value != buffer.text else { return }
                buffer.text = value
                onEdit(value)
            }
            .onKeyPress(keys: [.return]) { press in
                guard submitOnReturn else { return .ignored }
                if press.modifiers.contains(.shift) { return .ignored }
                onSubmit()
                return .handled
            }
    }

    private func adoptBuffer(_ revision: Int) {
        guard revision != appliedRevision else { return }
        appliedRevision = revision
        if text != buffer.text { text = buffer.text }
    }
}

/// 多行输入框是 UITextView。键盘弹起时它会按键盘高度再垫一层内边距，字和光标就离开可见区域，发送也点不中。
struct TextViewKeyboardInsetLock: UIViewRepresentable {
    func makeUIView(context: Context) -> Anchor { Anchor() }
    func updateUIView(_ uiView: Anchor, context: Context) {
        if !uiView.didLock { uiView.lock() }
    }

    final class Anchor: UIView {
        fileprivate var didLock = false
        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            backgroundColor = .clear
        }

        required init?(coder: NSCoder) { return nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            lock()
        }

        func lock() {
            guard !didLock else { return }
            DispatchQueue.main.async { [weak self] in
                self?.lockNow()
            }
        }

        private func lockNow() {
            guard !didLock else { return }
            if let textView = ancestorTextView() ?? siblingTextView() {
                guard textView.contentInsetAdjustmentBehavior != .never else {
                    didLock = true
                    return
                }
                textView.contentInsetAdjustmentBehavior = .never
                textView.contentInset.bottom = 0
                textView.verticalScrollIndicatorInsets.bottom = 0
                didLock = true
            }
        }

        private func ancestorTextView() -> UITextView? {
            var view: UIView? = superview
            for _ in 0..<8 {
                if let textView = view as? UITextView { return textView }
                view = view?.superview
            }
            return nil
        }

        /// 背景层往往和文本视图并列，不在它里面。只看附近两层，避免锁到消息列表里的文本。
        private func siblingTextView() -> UITextView? {
            let parents = [superview, superview?.superview]
            for parent in parents {
                guard let parent else { continue }
                if let textView = parent as? UITextView { return textView }
                for child in parent.subviews {
                    if let textView = child as? UITextView { return textView }
                    if let textView = child.subviews.first(where: { $0 is UITextView }) as? UITextView {
                        return textView
                    }
                }
            }
            return nil
        }
    }
}
