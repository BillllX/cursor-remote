import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// 胶囊输入栏样式（全端已统一使用 .assistant 胶囊栏，保留 .full 枚举项以兼容潜在引用）。
enum ComposerStyle { case full, assistant }

struct ComposerView: View {
    @Environment(ChatStore.self) var store
    @Environment(\.threadChatId) private var environmentChatId
    @Environment(\.sceneSessionState) private var sceneSession
    /// 外部递增时把光标放进输入框（空会话快捷句）。
    var focusNonce: Int = 0
    var style: ComposerStyle = .assistant
    @State var focused = false
    /// 打字写进这个对象，不写进视图状态。这样每个字不会把整条输入栏和会话回合再画一遍。
    @State var draftBuffer = ComposerDraftBuffer()
    /// 外部改草稿时递增，输入框据此把文字灌进去。
    @State var draftRevision = 0
    /// 只在「有字 / 没字」之间翻转，用来换话筒和发送，不跟着每个字变。
    @State var hasText = false
    /// 自己写回 store.draft 时不要再灌进输入框，否则会把后打的字盖掉。
    @State private var ignoreDraftEcho: String?
    @State private var photoItems: [PhotosPickerItem] = []
    @State var viewerItem: AttachmentViewerItem?
    @State var personalRecordingOpen = false
    @State var modelPickerOpen = false
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
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    /// 发送、停止、更多跟正文同一套 Dynamic Type，圆钮和图形一起变大。
    @ScaledMetric(relativeTo: .body) var assistantSendGlyph = 16
    @ScaledMetric(relativeTo: .body) var assistantStopGlyph = 13
    @ScaledMetric(relativeTo: .body) var assistantMoreGlyph = 17
    @ScaledMetric(relativeTo: .body) var assistantControl = 36
    @Environment(\.assistantSceneToken) private var assistantSceneToken
    @Environment(\.assistantVoicePresenterActive) private var assistantVoicePresenterActive
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.homeActive) private var homeActive
    @Environment(\.coldLaunchVisible) private var coldLaunchVisible
    private var canFocus: Bool { homeActive && !coldLaunchVisible && scenePhase == .active }

    var chatId: String { environmentChatId.isEmpty ? store.activeId : environmentChatId }
    var isAssistantSession: Bool { store.isAssistantChat(chatId) }
    var editingResource: String {
        chatId == store.assistantChatId ? "assistant-composer" : "chat-composer:\(chatId)"
    }
    var ownsSceneEditing: Bool {
        if SceneEditingOwnership.shared.isOwner(resource: editingResource, sceneToken: assistantSceneToken) {
            return true
        }
        return !SceneEditingOwnership.shared.hasClaimant(resource: editingResource)
    }
    var chrome: ComposerChrome {
        store.composerChromeByChat[chatId] ?? ComposerChrome(model: store.model)
    }
    var chatBusy: Bool { store.liveBusyIds.contains(chatId) }
    var chatModel: String { chrome.model.isEmpty ? store.model : chrome.model }
    var chatImages: [PendingImage] { store.pendingImages(for: chatId) }
    var chatUploads: [UploadItem] {
        guard !store.uploads.isEmpty else { return [] }
        return store.uploads.filter { $0.chatId == chatId }
    }

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
                    .transition(.jieboPanel(from: .bottom, reduceMotion: reduceMotion).combined(with: .opacity))
            }
            VStack(alignment: .leading, spacing: 12) {
                if UIDevice.current.userInterfaceIdiom == .pad {
                    assistantStatusLine
                }
                assistantCapsuleRow
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .padding(.horizontal, UIDevice.current.userInterfaceIdiom == .pad ? 16 : 0)
        .padding(.top, UIDevice.current.userInterfaceIdiom == .pad ? 8 : 0)
        .padding(.bottom, UIDevice.current.userInterfaceIdiom == .pad ? (floating ? 8 : 16) : (floating ? 0 : 8))
        // 底栏铺主题底色，避免正文从输入区域透出。
        .background {
            if floating {
                LinearGradient(
                    stops: [
                        .init(color: JieboColor.paper.opacity(0), location: 0),
                        .init(color: JieboColor.paper.opacity(0.96), location: 0.22),
                        .init(color: JieboColor.paper, location: 1)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .padding(.top, -20)
            } else {
                JieboColor.paper
            }
        }
        .confirmationDialog(
            "确认上传大文件？",
            isPresented: Binding(
                get: { homeActive && !coldLaunchVisible && store.uploadConfirmation != nil },
                set: { if homeActive && !$0 { store.resolveUploadConfirmation(false) } }
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
            if homeActive { store.applyPhoneChatPreferences(chatId: chatId) }
            replaceDraft(sceneDraft(for: chatId))
            if homeActive { store.refreshCheckpoints(chatId: chatId) }
        }
        .onChange(of: store.lastModel) { _, _ in
            if homeActive { store.applyPhoneChatPreferences(chatId: chatId) }
        }
        .onDisappear {
            stopVoice()
            flushDraft(commitComposition: true)
        }
        .onChange(of: homeActive) { _, active in
            if !active {
                focused = false
                stopVoice()
                flushDraft(commitComposition: true)
            } else {
                store.applyPhoneChatPreferences(chatId: chatId)
            }
        }
        .animation(JieboMotion.snappy(reduceMotion), value: dictation.active)
        .onChange(of: chatId) { oldId, _ in
            stopVoice()
            flushDraft(currentChatId: oldId, commitComposition: true)
            if homeActive { store.applyPhoneChatPreferences(chatId: chatId) }
            replaceDraft(sceneDraft(for: chatId))
            if homeActive { store.refreshCheckpoints(chatId: chatId) }
        }
        .onChange(of: store.draft(for: chatId)) { _, value in
            if let sceneSession {
                // 卡住后上一句写进共享草稿。本窗口输入框读场景草稿，空的时候才接上，不盖住正在打的字。
                let visible = draftBuffer.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let incoming = value.trimmingCharacters(in: .whitespacesAndNewlines)
                guard visible.isEmpty, !incoming.isEmpty else { return }
                sceneSession.saveDraft(value, for: chatId)
                replaceDraft(value)
                focused = canFocus
                return
            }
            if value == ignoreDraftEcho { return }
            if value != draftBuffer.text { replaceDraft(value) }
        }
        .onChange(of: store.externalDraftDelivery) { _, delivery in
            guard let delivery, delivery.chatId == chatId else { return }
            let current = draftBuffer.text
            let next: String
            switch delivery.kind {
            case .replace(let value):
                next = value
            case .insertMention(let path):
                guard let range = ChatStore.trailingMentionRange(in: current) else { return }
                let leading = current[range.lowerBound...].first.map { $0 == " " || $0 == "\n" || $0 == "\r\n" ? String($0) : "" } ?? ""
                var updated = current
                updated.replaceSubrange(range, with: "\(leading)@\(path) ")
                next = updated
            case .appendMention(let path):
                let mention = "@\(path)"
                guard !current.contains(mention) else { return }
                let base = store.stripTrailingQuery(current)
                let needsSpace = !base.isEmpty && !base.hasSuffix(" ") && !base.hasSuffix("\n")
                next = base + (needsSpace ? " " : "") + mention + " "
            }
            draftBuffer.cancelPersist()
            ignoreDraftEcho = next
            sceneSession?.saveDraft(next, for: chatId)
            store.saveDraft(next, forChat: chatId)
            replaceDraft(next)
            if canFocus && ownsSceneEditing {
                focused = canFocus
            }
        }
        .onChange(of: focusNonce) { _, _ in
            focused = canFocus
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantVoiceComposerRequested)) { notification in
            handleAssistantVoice(notification)
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantComposerFocusRequested)) { notification in
            guard let delivery = notification.object as? PadSceneCommandDelivery,
                  delivery.sceneToken == assistantSceneToken,
                  assistantVoicePresenterActive, canFocus,
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
            syncBufferToStore()
            return true
        }
        // iPad Files / Safari 拖入：文件走现有上传，网页地址只写入当前草稿，由用户确认后发送。
        .dropDestination(for: URL.self) { urls, _ in
            let files = urls.filter(\.isFileURL)
            let links = urls.filter { !$0.isFileURL }.map(\.absoluteString)
            guard !files.isEmpty || !links.isEmpty else { return false }
            if !files.isEmpty {
                syncBufferToStore()
                store.attachFiles(files, chatId: chatId)
            }
            if !links.isEmpty {
                let current = draftBuffer.text
                let separator = current.isEmpty || current.hasSuffix("\n") ? "" : "\n"
                replaceDraft(current + separator + links.joined(separator: "\n"))
                syncBufferToStore()
            }
            return true
        }
        .photosPicker(isPresented: $photoPickerOpen, selection: $photoItems, maxSelectionCount: ImagePrep.maxCount, matching: .images)
        .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                syncBufferToStore()
                store.attachFiles(urls, chatId: chatId)
            }
        }
        .sheet(isPresented: $personalRecordingOpen) {
            PersonalRecordingPanel(store: store)
        }
        .task(id: store.unlocked ? store.tenantId : "") {
            guard isAssistantSession, store.unlocked else { return }
            while !Task.isCancelled, store.unlocked {
                await PersonalRecording.shared.recover(store: store)
                do { try await Task.sleep(for: .seconds(120)) } catch { return }
            }
        }
        .sheet(isPresented: $fileBrowserOpen) {
            FileBrowserSheet(chatId: chatId) { path in
                syncBufferToStore()
                store.appendMentionToDraft(path, chatId: chatId)
            }
        }
    }

    func syncBufferToStore() {
        draftBuffer.cancelPersist()
        let current = draftBuffer.commitText()
        ignoreDraftEcho = current
        sceneSession?.saveDraft(current, for: chatId)
        store.saveDraft(current, forChat: chatId)
    }

    private func handleAssistantVoice(_ notification: Notification) {
        guard let delivery = notification.object as? AssistantVoiceDelivery,
              delivery.sceneToken == assistantSceneToken,
              assistantVoicePresenterActive, canFocus,
              dictation.phase == .idle,
              store.isAssistantChat(chatId)
        else { return }
        toggleVoice()
        let captureId = delivery.capture.id
        let captureTenant = delivery.capture.tenant
        Task.detached(priority: .utility) {
            AssistantCaptureBridge.remove(id: captureId, tenant: captureTenant)
        }
    }

    /// 最低支持 iOS 26：助理胶囊仍是浮在内容上的玻璃底。底栏本身用 safeAreaInset，不用 safeAreaBar。
    private var floating: Bool { JieboGlass.available }

    var placeholder: String {
        if store.linkState == .offline { return "已断开" }
        if !store.connected { return "正在连接…" }
        if isAssistantSession {
            if chatBusy { return "正在回复，发送会排队" }
            return "跟\(store.assistantName)说点什么"
        }
        if chatBusy { return "正在动手，发送会排队" }
        return "交代要做的事，@ 引用"
    }

    var canSendNow: Bool {
        !store.uploads.contains(where: { $0.chatId == chatId })
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
            onSubmit: { commitAndSend(keepFocus: true) }
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
        let filled = value.contains { !$0.isWhitespace }
        if filled != hasText { hasText = filled }
        if mentionsMayChange(value) {
            store.updateMentions(for: value, chatId: chatId)
        }
        schedulePersist()
    }

    /// `@` 不在当前词尾、候选也收起时，不必每个字都扫一遍补全。
    func mentionsMayChange(_ value: String) -> Bool {
        if !store.mentionSuggestions(for: chatId).isEmpty { return true }
        guard let at = value.lastIndex(of: "@") else { return false }
        let tail = value[at...]
        if tail.contains(where: \.isWhitespace) { return false }
        let before = value[..<at]
        return before.isEmpty || before.last?.isWhitespace == true
    }

    func replaceDraft(_ value: String) {
        draftBuffer.text = value
        draftRevision += 1
        let filled = value.contains { !$0.isWhitespace }
        if filled != hasText { hasText = filled }
    }

    func schedulePersist() {
        if let pending = draftBuffer.pendingChatId, pending != chatId { flushDraft() }
        draftBuffer.pendingChatId = chatId
        draftBuffer.pendingText = draftBuffer.text
        draftBuffer.persistDeadline = ContinuousClock.now + .milliseconds(350)
        // 复用单一防抖循环：蓝牙键盘连续盲打数十字符不再每键新建/取消 Task。
        // 用 persistGeneration 隔离被取消的旧循环，防止旧循环唤醒后把新 persistTask 覆写为 nil。
        guard draftBuffer.persistTask == nil else { return }
        draftBuffer.persistGeneration &+= 1
        let generation = draftBuffer.persistGeneration
        draftBuffer.persistTask = Task { @MainActor in
            while !Task.isCancelled && draftBuffer.persistGeneration == generation {
                guard let deadline = draftBuffer.persistDeadline else { break }
                let remaining = ContinuousClock.now.duration(to: deadline)
                if remaining > .zero {
                    try? await Task.sleep(for: remaining)
                    continue
                }
                guard !Task.isCancelled && draftBuffer.persistGeneration == generation else { return }
                draftBuffer.persistDeadline = nil
                draftBuffer.persistTask = nil
                flushDraft()
                return
            }
            if draftBuffer.persistGeneration == generation {
                draftBuffer.persistTask = nil
            }
        }
    }

    func flushDraft(currentChatId: String? = nil, commitComposition: Bool = false) {
        let pendingId = draftBuffer.pendingChatId
        let pendingText = draftBuffer.pendingText
        draftBuffer.cancelPersist()
        if let pendingId {
            // 仅在切会话/切后台/页面消失等显式离开边界才强制提交 IME 组合态；
            // 350ms 定时落库绝不调 unmarkText()，防止选拼音超过 350ms 被强行拆候选栏上屏。
            let committed = (commitComposition && pendingId == (currentChatId ?? chatId))
                ? draftBuffer.commitText()
                : pendingText
            if pendingId == (currentChatId ?? chatId) { ignoreDraftEcho = committed }
            sceneSession?.saveDraft(committed, for: pendingId)
            store.saveDraft(committed, forChat: pendingId)
            return
        }
        guard commitComposition, draftBuffer.hasUncommittedComposition else { return }
        let targetId = currentChatId ?? chatId
        let committed = draftBuffer.commitText()
        if targetId == chatId { ignoreDraftEcho = committed }
        sceneSession?.saveDraft(committed, for: targetId)
        store.saveDraft(committed, forChat: targetId)
    }

    func commitAndSend(keepFocus: Bool = false) {
        guard canFocus, ownsSceneEditing, canSendNow else { return }
        focused = keepFocus
        let current = draftBuffer.commitText()
        draftBuffer.cancelPersist()
        ignoreDraftEcho = ""
        // 直接进入 submit：成功发送时一次清空草稿与追加回合，不再先 saveDraft 造成二次写 chats 与重复扫描 @ 补全。
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
@MainActor
final class ComposerDraftBuffer {
    var text = ""
    var pendingChatId: String?
    var pendingText = ""
    var persistDeadline: ContinuousClock.Instant?
    var persistTask: Task<Void, Never>?
    var persistGeneration: UInt64 = 0
    weak var activeTextView: ComposerTextView?

    var hasUncommittedComposition: Bool {
        activeTextView?.markedTextRange != nil
    }

    /// 点击发送或切会话落库前，将尚未上屏的 IME 组合文字（如韩文尾音节/中文字词）同步提交到 buffer。
    @discardableResult
    func commitText() -> String {
        if let view = activeTextView {
            if view.markedTextRange != nil {
                view.unmarkText()
            }
            let latest = view.text ?? ""
            if text != latest { text = latest }
        }
        return text
    }

    func cancelPersist() {
        persistGeneration &+= 1
        persistTask?.cancel()
        persistTask = nil
        persistDeadline = nil
        pendingChatId = nil
    }
}
