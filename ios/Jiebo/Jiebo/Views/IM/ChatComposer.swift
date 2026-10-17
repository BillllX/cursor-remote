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

extension ImPickTemp {
    /// 相册里选中的一张落成临时文件：优先让系统直接给文件；不行再取字节写成文件（字节写完就释放）
    @MainActor
    static func load(_ item: PhotosPickerItem) async -> URL? {
        if let picked = try? await item.loadTransferable(type: ImPickedFile.self) {
            return picked.url
        }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "img"
        return write(data, ext: ext)
    }
}

/// 聊天页底部的输入栏：多行（最多 5 行，再多就在框里滚）、「+」菜单、引用条。草稿按会话存
struct ChatComposer: View {
    @Environment(ImStore.self) private var im
    let peer: String
    let convId: String
    var focused: FocusState<Bool>.Binding
    var onSent: () -> Void
    @State private var text = ""
    @State private var loadedDraft = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickerOpen = false
    @State private var cameraOpen = false
    @State private var cameraShot: URL?
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
    static let maxPhotos = 9

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

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
                    TextField("发消息", text: $text, axis: .vertical)
                        .lineLimit(1 ... 5)
                        .focused(focused)
                        .font(JieboFont.text(.body))
                        .foregroundStyle(JieboColor.ink)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(JieboColor.white)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .stroke(JieboColor.line, lineWidth: 1)
                        )
                }
                if canSend {
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(JieboColor.pine)
                            .frame(width: 40, height: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressScaleButtonStyle())
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityLabel("发送")
                } else {
                    attachMenu
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .background(JieboColor.sidebar.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            Rectangle().fill(JieboColor.line).frame(height: 1)
        }
        .onAppear {
            guard !loadedDraft else { return }
            loadedDraft = true
            text = im.drafts[convId] ?? ""
        }
        .onChange(of: text) { _, value in
            im.setDraft(value, convId: convId)
        }
        .onDisappear {
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
        // 相机盖子收完再弹预览：同一刻又收又弹，sheet 会弹不出来
        .fullScreenCover(isPresented: $cameraOpen, onDismiss: {
            guard let shot = cameraShot else { return }
            cameraShot = nil
            picked = ImPickedImages(files: [shot])
        }) {
            CameraPicker { image in
                // 拍的那张只在这里编码一次，写成文件后字节和 UIImage 都不留
                if let image, let data = image.jpegData(compressionQuality: 0.92) {
                    cameraShot = ImPickTemp.write(data, ext: "jpg")
                }
                cameraOpen = false
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
                        try? FileManager.default.removeItem(at: dir.appendingPathComponent(prepared.file))
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
            Image(systemName: "plus.circle")
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 40, height: 40)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("发送附件")
    }

    private func iconButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 22))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 40, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func replyStrip(_ seq: Int) -> some View {
        let target = im.timelines[convId]?.first { $0.seq == seq }
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

    // MARK: 发

    private func send() {
        let value = text
        if let url = ImLinkMetadata.recognized(value) {
            text = ""
            let tenant = im.tenant
            Task {
                let metadata = await ImLinkMetadata.load(url, tenant: tenant)
                guard tenant == im.tenant else { return }
                im.sendLink(url: url, title: metadata.title, desc: metadata.desc, iconFile: metadata.iconFile, to: peer)
                onSent()
            }
        } else {
            guard im.sendText(value, to: peer) else { return }
            text = ""
            onSent()
        }
    }

    private var voiceButton: some View {
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
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(JieboColor.line)
            }
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
        guard let dir = ImCache.outboxDir(tenant: im.tenant) else { return }
        let name = "voice-\(UUID().uuidString.lowercased()).m4a"
        let target = dir.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: recording.0, to: target)
            im.sendVoice(file: name, durationMs: recording.1, waveform: recording.2, to: peer)
            onSent()
        } catch {
            try? FileManager.default.removeItem(at: recording.0)
            im.showToast("录音保存不了")
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
            var prepared: [ImOutgoingImage] = []
            var failed = 0
            for file in files {
                let outgoing = await Task.detached(priority: .userInitiated) { () -> ImOutgoingImage? in
                    let result = ImImagePrep.prepare(file: file, original: original, tenant: tenant)
                    ImPickTemp.remove([file])
                    return result
                }.value
                if let outgoing {
                    prepared.append(outgoing)
                } else {
                    failed += 1
                }
            }
            guard tenant == im.tenant else { return }
            if !prepared.isEmpty {
                im.sendImages(prepared, to: peer)
                onSent()
            }
            if failed > 0 { im.showToast("\(failed) 张图片处理不了，换一张试试") }
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
            totalBytes = source.reduce(Int64(0)) { $0 + ImPickTemp.size($1) }
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
                Text(notice)
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.white.opacity(0.18))
                    .clipShape(Capsule())
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
                if FileManager.default.fileExists(atPath: local.path) { file = local }
            }
            if file == nil, case .image(let blob, _, _, _, _)? = item.body {
                file = await ImImageCache.shared.originalFile(blob: blob, tenant: tenant, remote: im.mediaURL(convId: convId, blob: blob))
            }
            let result: String
            if let file {
                result = await ImPhotoSaver.save(file: file)
            } else {
                result = "图片还没下载下来，稍后再试"
            }
            saving = false
            notice = result
            try? await Task.sleep(for: .seconds(2))
            if notice == result { notice = "" }
        }
    }
}

private struct ImViewerPage: View {
    @Environment(ImStore.self) private var im
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let message: ImLocalMessage
    @State private var image: UIImage?
    @State private var failed = false
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
                Text("图片加载不出来")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(.white.opacity(0.7))
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: loadKey) { await load() }
    }

    private var loadKey: String {
        "\(message.id)|\(im.tickets[message.convId]?.sig ?? "")"
    }

    @MainActor
    private func load() async {
        if let outgoing = message.outgoing, let dir = ImCache.outboxDir(tenant: im.tenant) {
            let file = dir.appendingPathComponent(outgoing.file)
            if FileManager.default.fileExists(atPath: file.path),
               let local = await ImImageCache.shared.local(file: file, maxPixel: Self.maxPixel) {
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
