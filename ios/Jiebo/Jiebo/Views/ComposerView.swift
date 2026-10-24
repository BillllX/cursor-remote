import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// full = 原来的完整工具栏（iPad / 工作区会话）；assistant = iPhone 助理页：＋ / ⋯ / 麦克风 / 发送。
enum ComposerStyle { case full, assistant }

struct ComposerView: View {
    @Environment(ChatStore.self) var store
    @Environment(\.threadChatId) private var environmentChatId
    /// 外部递增时把光标放进输入框（空会话快捷句）。
    var focusNonce: Int = 0
    var style: ComposerStyle = .full
    @FocusState var focused: Bool
    /// 打字只改这里。直接绑 store.draft 会让整段对话每次按键都重绘。
    @State var text = ""
    @State private var persistTask: Task<Void, Never>?
    /// 防抖中还没落库的草稿和它所属的会话
    @State private var pendingDraft: (chatId: String, text: String)?
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
                TextField(placeholder, text: $text, axis: .vertical)
                    .font(JieboFont.text(.body))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1...8)
                    .focused($focused)
                    .background(TextViewKeyboardInsetLock())
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
                            store.updateMentions(for: value, chatId: chatId)
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
            text = store.draft(for: chatId)
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
            text = store.draft(for: chatId)
            store.refreshCheckpoints(chatId: chatId)
        }
        .onChange(of: store.draft(for: chatId)) { _, value in
            if value == ignoreDraftEcho { return }
            if value != text { text = value }
        }
        .onChange(of: focusNonce) { _, _ in
            focused = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantVoiceRequested)) { notification in
            guard let capture = notification.object as? AssistantCaptureBridge.Capture,
                  dictation.phase == .idle, store.isAssistantChat(chatId)
            else { return }
            toggleVoice()
            AssistantCaptureBridge.remove(id: capture.id, tenant: capture.tenant)
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            let targetChatId = chatId
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
            // 本地刚打的字 350ms 后才落到 store.draft；先落盘，否则追加会基于旧草稿把新字盖掉
            flushDraft()
            for path in paths { store.appendMentionToDraft(path, chatId: chatId) }
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
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !chatImages.isEmpty)
    }

    func schedulePersist() {
        if let pendingDraft, pendingDraft.chatId != chatId { flushDraft() }
        persistTask?.cancel()
        pendingDraft = (chatId, text)
        persistTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            flushDraft()
        }
    }

    private func flushDraft(currentChatId: String? = nil) {
        persistTask?.cancel()
        guard let pending = pendingDraft else { return }
        pendingDraft = nil
        if pending.chatId == (currentChatId ?? chatId) { ignoreDraftEcho = pending.text }
        store.saveDraft(pending.text, forChat: pending.chatId)
    }

    func commitAndSend() {
        focused = false
        persistTask?.cancel()
        pendingDraft = nil
        ignoreDraftEcho = ""
        store.saveDraft(text, forChat: chatId)
        store.submit(chatId: chatId, text: text)
        text = store.draft(for: chatId)
    }
}

/// 多行输入框是 UITextView。键盘弹起时它会按键盘高度再垫一层内边距，字和光标就离开可见区域，发送也点不中。
struct TextViewKeyboardInsetLock: UIViewRepresentable {
    func makeUIView(context: Context) -> Anchor { Anchor() }
    func updateUIView(_ uiView: Anchor, context: Context) { uiView.lock() }

    final class Anchor: UIView {
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
            DispatchQueue.main.async { [weak self] in
                self?.lockNow()
            }
        }

        private func lockNow() {
            if let textView = ancestorTextView() ?? siblingTextView() {
                guard textView.contentInsetAdjustmentBehavior != .never else { return }
                textView.contentInsetAdjustmentBehavior = .never
                textView.contentInset.bottom = 0
                textView.verticalScrollIndicatorInsets.bottom = 0
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
