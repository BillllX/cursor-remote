import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// 「+」菜单里的相册、相机、文件和位置
private enum ComposerAttachment: CaseIterable, Identifiable {
    case album
    case camera
    case file
    case location

    var id: Self { self }

    var title: String {
        switch self {
        case .album: return "相册"
        case .camera: return "拍照"
        case .file: return "文件"
        case .location: return "位置"
        }
    }

    var symbol: String {
        switch self {
        case .album: return "photo.on.rectangle"
        case .camera: return "camera"
        case .file: return "doc"
        case .location: return "location"
        }
    }

    var available: Bool {
        switch self {
        case .album: return true
        case .camera: return UIImagePickerController.isSourceTypeAvailable(.camera)
        case .file, .location: return true
        }
    }
}

/// 选好、还没发的图片：tmp/im-pick 里的文件（不在内存里留原始字节）
struct ImPickedImages: Identifiable {
    let id = UUID()
    var files: [URL]
}

private struct ImLargeImageBatch {
    var images: [ImOutgoingImage]
    var bytes: Int64
    var tenant: String
    var convId: String
    var peer: String
}

extension ImPickTemp {
    /// 相册里选中的一张落成临时文件：优先让系统直接给文件；不行再取字节在后台写成文件（字节写完就释放）
    @MainActor
    static func load(_ item: PhotosPickerItem) async -> URL? {
        if let picked = try? await item.loadTransferable(type: ImPickedFile.self) {
            return picked.url
        }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "img"
        return await Task.detached(priority: .userInitiated) {
            write(data, ext: ext)
        }.value
    }
}

/// 聊天页底部的输入栏：多行（最多 5 行，再多就在框里滚）、「+」菜单、引用条。草稿按会话存
struct ChatComposer: View {
    @Environment(ImStore.self) private var im
    @Environment(\.scenePhase) private var scenePhase
    let peer: String
    let convId: String
    var focused: Binding<Bool>
    var onSent: () -> Void
    /// 打字写入非视图状态缓冲，蓝牙键盘连续击键不重建整条输入栏。
    @State private var draftBuffer = ComposerDraftBuffer()
    @State private var draftRevision = 0
    @State private var hasText = false
    @State private var ignoreDraftEcho: String?
    @State private var loadedDraft = false
    @State private var draftTenant = ""
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickerOpen = false
    @State private var cameraOpen = false
    @State private var cameraDismissed = true
    @State private var cameraShot: URL?
    @State private var cameraTask: Task<Void, Never>?
    @State private var composerActive = false
    @State private var picked: ImPickedImages?
    @State private var voiceMode = false
    @State private var recorder = ImVoiceRecorder()
    @State private var voiceStarted = false
    @State private var voiceBeganAt: Date?
    @State private var voiceStartFailed = false
    /// 录音被系统停掉后已自动收尾；手指没抬起前不再重新开始录
    @State private var voiceAutoFinished = false
    @State private var fileOpen = false
    @State private var locationOpen = false
    @State private var largeImageBatch: ImLargeImageBatch?
    static let maxPhotos = 9

    private var canSend: Bool { hasText }

    var body: some View {
        VStack(spacing: 0) {
            if let seq = im.replyTo[convId] {
                replyStrip(seq)
            }
            HStack(alignment: .bottom, spacing: 8) {
                iconButton(voiceMode ? "keyboard" : "waveform", label: voiceMode ? "切换到键盘" : "切换到语音") {
                    voiceMode.toggle()
                    if voiceMode { focused.wrappedValue = false }
                }
                if voiceMode {
                    voiceButton
                } else {
                    ComposerEntryField(
                        placeholder: "发消息",
                        lineLimit: 1 ... 5,
                        buffer: draftBuffer,
                        revision: draftRevision,
                        focused: focused,
                        submitOnReturn: true,
                        onEdit: noteTyped,
                        onSubmit: send
                    )
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(JieboColor.white)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: JieboStroke.outline)
                    )
                }
                if canSend {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(JieboColor.fillFg)
                            .frame(width: 36, height: 36)
                            .background(JieboColor.pine)
                            .clipShape(Circle())
                            .hitTarget()
                    }
                    .buttonStyle(PressScaleButtonStyle())
                    .accessibilityLabel("发送")
                } else {
                    attachMenu
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .background(JieboColor.paper.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            Rectangle().fill(JieboColor.line).frame(height: 1)
        }
        .confirmationDialog(
            "确认发送原图？",
            isPresented: Binding(
                get: { largeImageBatch != nil },
                set: { if !$0, largeImageBatch != nil { cancelLargeImageBatch() } }
            ),
            titleVisibility: .visible
        ) {
            Button("发送") { approveLargeImageBatch() }
            Button("取消", role: .cancel) { cancelLargeImageBatch() }
        } message: {
            if let batch = largeImageBatch {
                Text("本机处理后的实际待传大小为 \(ChatStore.megabytes(Int(batch.bytes)))。")
            }
        }
        .onAppear {
            composerActive = true
            guard !loadedDraft else { return }
            loadedDraft = true
            draftTenant = im.tenant
            replaceDraft(im.draft(for: convId))
        }
        .onChange(of: im.tenant) { _, nextTenant in
            cancelPendingCameraShot()
            draftBuffer.cancelPersist()
            draftTenant = nextTenant
            ignoreDraftEcho = nil
            replaceDraft(nextTenant.isEmpty ? "" : im.draft(for: convId))
        }
        .onChange(of: convId) { oldConvId, nextConvId in
            cancelPendingCameraShot()
            flushDraft(for: oldConvId, commitComposition: true)
            ignoreDraftEcho = nil
            replaceDraft(im.draft(for: nextConvId))
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { flushDraft(for: convId, commitComposition: true) }
        }
        .onChange(of: im.draft(for: convId)) { _, externalDraft in
            if externalDraft == ignoreDraftEcho {
                ignoreDraftEcho = nil
                return
            }
            if externalDraft != draftBuffer.text, !focused.wrappedValue {
                replaceDraft(externalDraft)
            }
        }
        .onDisappear {
            composerActive = false
            cancelPendingCameraShot()
            flushDraft(for: convId, commitComposition: true)
            cancelLargeImageBatch()
            recorder.cancel()
            voiceStarted = false
            voiceBeganAt = nil
            voiceStartFailed = false
            voiceAutoFinished = false
        }
        .photosPicker(isPresented: $pickerOpen, selection: $photoItems, maxSelectionCount: Self.maxPhotos, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            loadPicked(items)
        }
        // 相机盖子收完再弹预览：同一刻又收又弹，sheet 会弹不出来；JPEG 编码与落盘移至后台并校验会话存活
        .fullScreenCover(isPresented: $cameraOpen, onDismiss: {
            cameraDismissed = true
            guard let shot = cameraShot else { return }
            cameraShot = nil
            picked = ImPickedImages(files: [shot])
        }) {
            CameraPicker { image in
                cancelPendingCameraShot()
                cameraDismissed = false
                cameraOpen = false
                guard let image else { return }
                let capturedTenant = im.tenant
                let capturedConvId = convId
                cameraTask = Task { @MainActor in
                    let shot = await Task.detached(priority: .userInitiated) { () -> URL? in
                        guard !Task.isCancelled, let data = image.jpegData(compressionQuality: 0.92) else { return nil }
                        return ImPickTemp.write(data, ext: "jpg")
                    }.value
                    guard let shot else { return }
                    guard !Task.isCancelled, composerActive, im.tenant == capturedTenant, convId == capturedConvId else {
                        ImPickTemp.remove([shot])
                        return
                    }
                    if cameraDismissed {
                        picked = ImPickedImages(files: [shot])
                    } else {
                        cameraShot = shot
                    }
                }
            }
            .ignoresSafeArea()
        }
        .sheet(item: $picked) { batch in
            ImSendPreview(files: batch.files) { original in
                sendImages(batch.files, original: original)
            }
        }
        .fileImporter(isPresented: $fileOpen, allowedContentTypes: [.data, .content], allowsMultipleSelection: false) { result in
            guard let source = try? result.get().first else { return }
            let tenant = im.tenant
            // adopt 在本回调内先取得 security scope，再在后台复制，复制结束后才 stop。
            ImFilePrep.adopt(source, tenant: tenant) { prepared in
                guard tenant == im.tenant else {
                    if let prepared, let dir = ImCache.outboxDir(tenant: tenant) {
                        ImPickTemp.remove([dir.appendingPathComponent(prepared.file)])
                    }
                    return
                }
                if let prepared {
                    im.sendFile(file: prepared.file, name: prepared.name, size: prepared.size, mime: prepared.mime, to: peer)
                    onSent()
                } else {
                    im.showToast("文件读不出来，或超过 32MB")
                }
            }
        }
        .sheet(isPresented: $locationOpen) {
            ImLocationPicker { place in
                im.sendLocation(
                    lat: place.coordinate.latitude, lng: place.coordinate.longitude,
                    name: place.name, address: place.address, to: peer
                )
                onSent()
            }
        }
    }

    private var attachMenu: some View {
        Menu {
            ForEach(ComposerAttachment.allCases.filter(\.available)) { item in
                Button {
                    switch item {
                    case .album: pickerOpen = true
                    case .camera: cameraOpen = true
                    case .file: fileOpen = true
                    case .location: locationOpen = true
                    }
                } label: {
                    Label(item.title, systemImage: item.symbol)
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 36, height: 36)
                .hitTarget()
        }
        .accessibilityLabel("发送附件")
    }

    private func iconButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 36, height: 36)
                .hitTarget()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func replyStrip(_ seq: Int) -> some View {
        let target = im.timelineMessage(convId: convId, seq: seq)
        let who = target.map { $0.from == im.meId ? "我" : im.user($0.from).nickname } ?? ""
        let text = target.map { ImFormat.preview(kind: $0.kind, body: $0.body) } ?? "一条消息"
        return HStack(spacing: 8) {
            Rectangle()
                .fill(JieboColor.pine)
                .frame(width: 2, height: 24)
            Text(who.isEmpty ? "引用：\(text)" : "引用 \(who)：\(text)")
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.ink2)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button {
                im.replyTo[convId] = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(JieboColor.dim)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("取消引用")
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
    }

    private func replaceDraft(_ value: String) {
        draftBuffer.text = value
        draftRevision += 1
        let filled = value.contains { !$0.isWhitespace }
        if filled != hasText { hasText = filled }
    }

    private func noteTyped(_ value: String) {
        let filled = value.contains { !$0.isWhitespace }
        if filled != hasText { hasText = filled }
        scheduleDraftSave(value, for: convId)
    }

    private func scheduleDraftSave(_ value: String, for targetConvId: String) {
        let tenantAtSchedule = im.tenant
        guard !tenantAtSchedule.isEmpty, tenantAtSchedule == draftTenant else { return }
        if let pending = draftBuffer.pendingChatId, pending != targetConvId {
            flushDraft(for: pending)
        }
        // 清空草稿立即同步；常态打字用单一 deadline 循环 300ms 防抖落库，避免每敲一字建毁 Task
        if value.isEmpty {
            draftBuffer.cancelPersist()
            if !im.draft(for: targetConvId).isEmpty {
                ignoreDraftEcho = ""
                im.setDraft("", convId: targetConvId)
            }
            return
        }
        draftBuffer.pendingChatId = targetConvId
        draftBuffer.pendingText = value
        draftBuffer.persistDeadline = ContinuousClock.now + .milliseconds(300)
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
                guard im.tenant == tenantAtSchedule, let conv = draftBuffer.pendingChatId else { return }
                let pendingText = draftBuffer.pendingText
                draftBuffer.pendingChatId = nil
                if conv == convId { ignoreDraftEcho = pendingText }
                im.setDraft(pendingText, convId: conv)
                return
            }
            if draftBuffer.persistGeneration == generation {
                draftBuffer.persistTask = nil
            }
        }
    }

    private func flushDraft(for targetConvId: String, commitComposition: Bool = false) {
        let pendingId = draftBuffer.pendingChatId
        let rawPending = pendingId == targetConvId ? draftBuffer.pendingText : draftBuffer.text
        // 切会话时 self.convId 已经指向 nextConvId，必须由显式 commitComposition 触发 unmarkText()，
        // 否则未上屏文字既不会存入 oldConvId，其残留 markedTextRange 还会拦住新会话草稿写入。
        let pendingText = commitComposition ? draftBuffer.commitText() : rawPending
        draftBuffer.cancelPersist()
        // 登出或已切租户时绝不把旧视图里的本地 text 回灌进新租户草稿表
        guard !im.tenant.isEmpty, im.tenant == draftTenant else { return }
        guard pendingText != im.draft(for: targetConvId) else { return }
        if targetConvId == convId { ignoreDraftEcho = pendingText }
        im.setDraft(pendingText, convId: targetConvId)
    }

    // MARK: 发

    private func send() {
        let value = draftBuffer.commitText()
        guard value.contains(where: { !$0.isWhitespace }) else { return }
        if let url = ImLinkMetadata.recognized(value) {
            draftBuffer.cancelPersist()
            ignoreDraftEcho = ""
            replaceDraft("")
            im.setDraft("", convId: convId)
            let tenant = im.tenant
            Task {
                let metadata = await ImLinkMetadata.load(url, tenant: tenant)
                guard tenant == im.tenant else { return }
                im.sendLink(url: url, title: metadata.title, desc: metadata.desc, iconFile: metadata.iconFile, to: peer)
                onSent()
            }
        } else {
            guard im.sendText(value, to: peer) else { return }
            draftBuffer.cancelPersist()
            ignoreDraftEcho = ""
            replaceDraft("")
            im.setDraft("", convId: convId)
            onSent()
        }
    }

    private var voiceButton: some View {
        ImVoiceRecordButtonLabel(recorder: recorder)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if !voiceStarted, !voiceAutoFinished {
                            voiceStarted = true
                            voiceBeganAt = Date()
                            voiceStartFailed = false
                            Task {
                                if let warning = await recorder.start() {
                                    im.showToast(warning)
                                    voiceStartFailed = true
                                    voiceStarted = false
                                    voiceBeganAt = nil
                                } else if !voiceStarted {
                                    _ = recorder.finish(cancel: true)
                                }
                            }
                        }
                        recorder.setCancelling(value.translation.height < -60)
                    }
                    .onEnded { _ in
                        if voiceAutoFinished {
                            voiceAutoFinished = false
                        } else {
                            finishVoice()
                        }
                    }
            )
            .onChange(of: recorder.autoStopped) { _, stopped in
                guard stopped, voiceStarted else { return }
                voiceAutoFinished = true
                finishVoice()
            }
            .accessibilityLabel("按住说话，上滑取消")
    }

    private func finishVoice() {
        let pressedFor = voiceBeganAt.map { Date().timeIntervalSince($0) } ?? 0
        defer {
            voiceStarted = false
            voiceBeganAt = nil
            voiceStartFailed = false
        }
        let elapsed = recorder.seconds
        let wasCancelling = recorder.cancelling
        guard let recording = recorder.finish(cancel: wasCancelling) else {
            if !voiceStartFailed, !wasCancelling, elapsed > 0 || pressedFor < 1 { im.showToast("说话时间太短") }
            return
        }
        let tenant = im.tenant
        let peer = peer
        guard let dir = ImCache.outboxDir(tenant: tenant) else {
            ImPickTemp.remove([recording.0])
            return
        }
        let name = "voice-\(UUID().uuidString.lowercased()).m4a"
        let target = dir.appendingPathComponent(name)
        Task { @MainActor in
            let moved = await Task.detached(priority: .userInitiated) { () -> Bool in
                do {
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    try FileManager.default.moveItem(at: recording.0, to: target)
                    return true
                } catch {
                    try? FileManager.default.removeItem(at: recording.0)
                    return false
                }
            }.value
            guard moved else {
                im.showToast("录音保存不了")
                return
            }
            guard tenant == im.tenant else {
                ImPickTemp.remove([target])
                return
            }
            im.sendVoice(file: name, durationMs: recording.1, waveform: recording.2, to: peer)
            onSent()
        }
    }

    /// 一张一张落成临时文件（同一时刻最多一张图的字节在内存里）
    private func loadPicked(_ items: [PhotosPickerItem]) {
        Task { @MainActor in
            var files: [URL] = []
            var failed = 0
            for item in items.prefix(Self.maxPhotos) {
                if let file = await ImPickTemp.load(item) {
                    files.append(file)
                } else {
                    failed += 1
                }
            }
            if failed > 0 { im.showToast("\(failed) 张图片读不出来，换一张试试") }
            if !files.isEmpty { picked = ImPickedImages(files: files) }
        }
    }

    /// 后台线程逐张处理：非原图长边 1280，缩略图长边 400；处理完一张就删掉它的临时文件
    private func sendImages(_ files: [URL], original: Bool) {
        let tenant = im.tenant
        let peer = peer
        Task { @MainActor in
            let uploadProfile = MobileMediaPolicy.imUpload(
                mode: MobileDataRuntime.mode,
                cost: MobileDataRuntime.networkCost
            )
            var prepared: [ImOutgoingImage] = []
            var failed = 0
            for file in files {
                let outgoing = await Task.detached(priority: .userInitiated) { [uploadProfile] () -> ImOutgoingImage? in
                    let result = ImImagePrep.prepare(
                        file: file, original: original, tenant: tenant, profile: uploadProfile
                    )
                    ImPickTemp.remove([file])
                    return result
                }.value
                if let outgoing {
                    prepared.append(outgoing)
                } else {
                    failed += 1
                }
            }
            guard tenant == im.tenant else {
                removeLargeImageBatchFiles(
                    ImLargeImageBatch(images: prepared, bytes: 0, tenant: tenant, convId: convId, peer: peer)
                )
                return
            }
            if !prepared.isEmpty {
                let sizes: [Int64]
                if let dir = ImCache.outboxDir(tenant: tenant) {
                    let fileNames = prepared.map(\.file)
                    sizes = await Task.detached(priority: .userInitiated) {
                        fileNames.map { ImPickTemp.size(dir.appendingPathComponent($0)) }
                    }.value
                } else {
                    sizes = []
                }
                guard tenant == im.tenant else {
                    removeLargeImageBatchFiles(
                        ImLargeImageBatch(images: prepared, bytes: 0, tenant: tenant, convId: convId, peer: peer)
                    )
                    return
                }
                if sizes.contains(where: { $0 > Int64(MobileMediaPolicy.largeShareRetryBudget) }) {
                    largeImageBatch = ImLargeImageBatch(
                        images: prepared,
                        bytes: sizes.reduce(0, +),
                        tenant: tenant,
                        convId: convId,
                        peer: peer
                    )
                } else {
                    im.sendImages(prepared, to: peer)
                    onSent()
                }
            }
            if failed > 0 { im.showToast("\(failed) 张图片处理不了，换一张试试") }
        }
    }

    private func approveLargeImageBatch() {
        guard let batch = largeImageBatch else { return }
        largeImageBatch = nil
        // Dialog 可能跨过导航或切租户；产生上传副作用前再次核对原租约。
        guard im.tenant == batch.tenant, convId == batch.convId, peer == batch.peer else {
            removeLargeImageBatchFiles(batch)
            return
        }
        im.sendImages(batch.images, to: batch.peer)
        onSent()
    }

    private func cancelPendingCameraShot() {
        cameraTask?.cancel()
        cameraTask = nil
        if let shot = cameraShot {
            cameraShot = nil
            ImPickTemp.remove([shot])
        }
    }

    private func cancelLargeImageBatch() {
        guard let batch = largeImageBatch else { return }
        largeImageBatch = nil
        removeLargeImageBatchFiles(batch)
    }

    private func removeLargeImageBatchFiles(_ batch: ImLargeImageBatch) {
        guard let dir = ImCache.outboxDir(tenant: batch.tenant) else { return }
        for image in batch.images {
            ImPickTemp.remove([
                dir.appendingPathComponent(image.file),
                dir.appendingPathComponent(image.thumbFile),
            ])
        }
    }
}

// MARK: 语音按住说话标签（隔离 12.5Hz 电平与计时更新，避免重建整条 ChatComposer）

private struct ImVoiceRecordButtonLabel: View {
    let recorder: ImVoiceRecorder

    var body: some View {
        HStack(spacing: 8) {
            if recorder.recording {
                HStack(alignment: .center, spacing: 2) {
                    ForEach(0 ..< 5, id: \.self) { index in
                        Capsule()
                            .frame(width: 2, height: CGFloat(5 + recorder.level * Double(5 + index * 3)))
                    }
                }
            }
            Text(recorder.recording ? (recorder.cancelling ? "松开取消" : "松开发送 · \(Int(recorder.seconds))″") : "按住说话")
                .font(JieboFont.text(.body, weight: .medium))
        }
        .foregroundStyle(recorder.cancelling ? JieboColor.danger : JieboColor.ink)
        .frame(maxWidth: .infinity, minHeight: 40)
        .background(recorder.recording ? JieboColor.well : JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(JieboColor.line)
        }
    }
}

// MARK: 发送前预览

/// 选完图先看一眼：可以勾「原图」。预览只解码长边 previewPixel 的缩略图；取消（含下滑关掉）时删临时文件
struct ImSendPreview: View {
    let files: [URL]
    var onSend: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var original = false
    @State private var thumbs: [UIImage] = []
    @State private var sent = false
    @State private var totalBytes: Int64 = 0

    private static let previewPixel = 720

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(Array(thumbs.enumerated()), id: \.offset) { _, image in
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFit()
                                .frame(maxHeight: 360)
                                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .frame(maxHeight: .infinity)
                .overlay {
                    if thumbs.isEmpty { ProgressView() }
                }
                Button {
                    original.toggle()
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: original ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 20))
                            .foregroundStyle(original ? JieboColor.pine : JieboColor.dim)
                        Text(original ? "原图（\(ByteCountFormatter.string(fromByteCount: totalBytes, countStyle: .file))）" : "原图")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(original ? .isSelected : [])
                .padding(.bottom, 12)
            }
            .background(JieboColor.paper)
            .navigationTitle(files.count > 1 ? "发送 \(files.count) 张图片" : "发送图片")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("发送") {
                        sent = true
                        onSend(original)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
        .task {
            let source = files
            let pixel = Self.previewPixel
            totalBytes = await Task.detached(priority: .userInitiated) {
                source.reduce(Int64(0)) { $0 + ImPickTemp.size($1) }
            }.value
            // 一张一张解码，每张解完就显示，不攒一批
            for file in source {
                let thumb = await Task.detached(priority: .userInitiated) {
                    ImImageDecode.image(at: file, maxPixel: pixel)
                }.value
                if let thumb { thumbs.append(thumb) }
            }
        }
        .onDisappear {
            if !sent { ImPickTemp.remove(files) }
        }
    }
}

// MARK: 拍照

/// UIImagePickerController 的 SwiftUI 包装：拍完回一张图，取消回 nil
struct CameraPicker: UIViewControllerRepresentable {
    var onFinish: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (UIImage?) -> Void

        init(onFinish: @escaping (UIImage?) -> Void) {
            self.onFinish = onFinish
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onFinish(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onFinish(nil)
        }
    }
}

// MARK: 看大图

/// 全屏看图：左右滑切换这个会话里的图片，可以存相册
struct ImImageViewer: View {
    @Environment(ImStore.self) private var im
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let convId: String
    @State private var selection: String
    @State private var notice = ""
    @State private var saving = false

    init(convId: String, startId: String) {
        self.convId = convId
        _selection = State(initialValue: startId)
    }

    private var items: [ImLocalMessage] {
        im.visibleMessages(convId).filter { $0.kind == "image" && !$0.recalled && ($0.body != nil || $0.outgoing != nil) }
    }

    var body: some View {
        let list = items
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            TabView(selection: $selection) {
                ForEach(list) { item in
                    ImViewerPage(message: item)
                        .tag(item.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
            HStack {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("关闭")
                Spacer()
                if let index = list.firstIndex(where: { $0.id == selection }), list.count > 1 {
                    Text("\(index + 1) / \(list.count)")
                        .font(JieboFont.text(.subheadline, weight: .medium))
                        .foregroundStyle(.white)
                }
                Spacer()
                Button {
                    save(list.first { $0.id == selection })
                } label: {
                    Group {
                        if saving {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "square.and.arrow.down")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(.white)
                        }
                    }
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                }
                .disabled(saving)
                .accessibilityLabel("存到相册")
            }
            .padding(.horizontal, 8)
            if !notice.isEmpty {
                Group {
                    if notice == ImStore.imageSaveOffline {
                        Button {
                            store.retryConnection()
                            notice = "正在连接，连上后再存。"
                        } label: {
                            noticeCapsule
                        }
                        .buttonStyle(.plain)
                    } else {
                        noticeCapsule
                    }
                }
                .frame(maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, 40)
                .transition(.opacity)
            }
        }
        .statusBarHidden()
    }

    private func save(_ item: ImLocalMessage?) {
        guard let item, !saving else { return }
        saving = true
        let tenant = im.tenant
        Task { @MainActor in
            var file: URL?
            if let outgoing = item.outgoing, let dir = ImCache.outboxDir(tenant: tenant) {
                let local = dir.appendingPathComponent(outgoing.file)
                file = await Task.detached(priority: .userInitiated) {
                    FileManager.default.fileExists(atPath: local.path) ? local : nil
                }.value
            }
            if file == nil, case .image(let blob, _, _, _, _)? = item.body {
                file = await ImImageCache.shared.originalFile(blob: blob, tenant: tenant, remote: im.mediaURL(convId: convId, blob: blob))
            }
            let result: String
            if let file {
                result = await ImPhotoSaver.save(file: file)
            } else {
                result = im.imageSaveBlockedTitle
            }
            saving = false
            notice = result
            if result != ImStore.imageSaveOffline {
                try? await Task.sleep(for: .seconds(2))
                if notice == result { notice = "" }
            }
        }
    }

    private var noticeCapsule: some View {
        Text(notice)
            .font(JieboFont.text(.footnote, weight: .medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Color.white.opacity(0.18))
            .clipShape(Capsule())
            .frame(minHeight: 44)
    }
}

private struct ImViewerPage: View {
    @Environment(ImStore.self) private var im
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let message: ImLocalMessage
    @State private var image: UIImage?
    @State private var failed = false
    @State private var retry = 0
    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1

    private static let maxPixel = 2560

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale)
                    .gesture(
                        MagnifyGesture()
                            .onChanged { value in scale = min(max(settledScale * value.magnification, 1), 5) }
                            .onEnded { _ in settledScale = scale }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(JieboMotion.spatial(reduceMotion)) {
                            scale = scale > 1 ? 1 : 2.5
                            settledScale = scale
                        }
                    }
                    .accessibilityLabel("图片")
            } else if failed {
                VStack(spacing: 12) {
                    Text(im.imageUnavailableTitle)
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                    if store.linkState == .offline {
                        Button("重连") { store.retryConnection() }
                            .font(JieboFont.text(.footnote, weight: .medium))
                            .foregroundStyle(.white)
                            .frame(minWidth: 44, minHeight: 44)
                    } else if store.connected, im.online {
                        Button("再试一次") { retry += 1 }
                            .font(JieboFont.text(.footnote, weight: .medium))
                            .foregroundStyle(.white)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                }
                .padding(.horizontal, 24)
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: loadKey) { await load() }
    }

    private var loadKey: String {
        let link = switch store.linkState {
        case .connected: "up"
        case .connecting: "wait"
        case .offline: "down"
        }
        return "\(message.id)|\(im.tickets[message.convId]?.sig ?? "")|\(link)|\(retry)"
    }

    @MainActor
    private func load() async {
        failed = false
        if let outgoing = message.outgoing, let dir = ImCache.outboxDir(tenant: im.tenant) {
            let file = dir.appendingPathComponent(outgoing.file)
            if let local = await ImImageCache.shared.localIfExists(file: file, maxPixel: Self.maxPixel) {
                image = local
                return
            }
        }
        guard case .image(let blob, _, _, _, _)? = message.body else {
            failed = true
            return
        }
        if let hit = ImImageCache.shared.cached(blob, maxPixel: Self.maxPixel) {
            image = hit
            return
        }
        let loaded = await ImImageCache.shared.image(
            blob: blob, tenant: im.tenant, remote: im.mediaURL(convId: message.convId, blob: blob), maxPixel: Self.maxPixel
        )
        image = loaded
        failed = loaded == nil
    }
}
