import ImageIO
import LinkPresentation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let root = ShareRoot(items: extensionContext?.inputItems as? [NSExtensionItem] ?? []) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        } cancel: { [weak self] in
            self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        }
        let host = UIHostingController(rootView: root)
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
    }
}

private struct ShareRoot: View {
    let items: [NSExtensionItem]
    var complete: () -> Void
    var cancel: () -> Void
    @State private var snapshot = ImShareBridge.load()
    @State private var selected = Set<String>()
    @State private var note = ""
    @State private var sending = false
    @State private var error = ""
    @State private var notice = ""

    var body: some View {
        NavigationStack {
            Group {
                if let snapshot, !snapshot.people.isEmpty {
                    List(snapshot.people) { person in
                        Button {
                            if !selected.insert(person.id).inserted { selected.remove(person.id) }
                        } label: {
                            HStack {
                                Image(systemName: selected.contains(person.id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selected.contains(person.id) ? .green : .secondary)
                                VStack(alignment: .leading) {
                                    Text(person.nickname).foregroundStyle(.primary)
                                    if person.recentAt > 0 { Text("最近聊天").font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                        }
                    }
                } else {
                    ContentUnavailableView("请先打开接驳", systemImage: "message", description: Text("主 App 打开后会同步联系人和登录状态"))
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    TextField("留言（可选）", text: $note, axis: .vertical).lineLimit(1 ... 3)
                        .textFieldStyle(.roundedBorder)
                    if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
                    if !notice.isEmpty { Text(notice).font(.caption).foregroundStyle(.green) }
                }.padding().background(.bar)
            }
            .navigationTitle("发送到聊天")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消", action: cancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "发送中…" : "发送") { send() }
                        .disabled(selected.isEmpty || sending || snapshot == nil)
                }
            }
        }
        .onAppear {
            if let failure = ImShareBackgroundQueue.shared.failureSummary() {
                error = failure
                ImShareBackgroundQueue.shared.discardFailed()
            }
        }
    }

    private func send() {
        guard let snapshot, KeychainStore.token() != nil, !selected.isEmpty else {
            error = "登录状态已失效，请先打开主 App"
            return
        }
        sending = true
        error = ""
        notice = ""
        Task {
            var payloads: [SharePayload] = []
            let sessionIdentifier = ImShareBackgroundQueue.makeSessionIdentifier()
            var enqueued = false
            do {
                payloads = try await ShareLoader.load(items)
                guard !payloads.isEmpty || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw ShareError.message("没有可发送的内容")
                }
                var order = 0
                for peer in selected.sorted() {
                    for payload in payloads {
                        try ShareSender.enqueue(
                            payload, to: peer, snapshot: snapshot,
                            sessionIdentifier: sessionIdentifier, order: order
                        )
                        order += 1
                        enqueued = true
                    }
                    let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        try ShareSender.enqueue(
                            .text(text), to: peer, snapshot: snapshot,
                            sessionIdentifier: sessionIdentifier, order: order
                        )
                        order += 1
                        enqueued = true
                    }
                }
                try await activateBatch(sessionIdentifier)
                enqueued = false
                ShareLoader.removePayloadFiles(payloads)
                notice = "已加入后台发送队列"
                sending = false
                try? await Task.sleep(for: .milliseconds(700))
                complete()
            } catch let sendError {
                if enqueued {
                    ImShareBackgroundQueue.shared.discardUnstartedBatch(sessionIdentifier)
                }
                ShareLoader.removePayloadFiles(payloads)
                error = sendError.localizedDescription
                sending = false
            }
        }
    }

    private func activateBatch(_ identifier: String) async throws {
        try await withCheckedThrowingContinuation { continuation in
            ImShareBackgroundQueue.shared.activateBatch(identifier) {
                continuation.resume(with: $0)
            }
        }
    }
}

private enum SharePayload {
    case image(URL, mime: String, width: Int, height: Int)
    case file(URL, name: String, mime: String)
    case link(URL, title: String?, icon: URL?)
    case location(lat: Double, lng: Double, name: String)
    case text(String)
}

private enum ShareLoader {
    private static let maxFileBytes = 32 * 1024 * 1024

    static func load(_ items: [NSExtensionItem]) async throws -> [SharePayload] {
        sweepAbandonedLoaderFiles()
        var output: [SharePayload] = []
        do {
            for item in items {
                for provider in item.attachments ?? [] {
                    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
                       let prepared = await downsampledImage(provider) {
                        output.append(
                            .image(prepared.file, mime: "image/jpeg", width: prepared.width, height: prepared.height)
                        )
                    } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
                              let copied = try await copiedItemURL(provider) {
                        try checkFileSize(copied.file)
                        let mime = UTType(filenameExtension: copied.name.pathExtension)?.preferredMIMEType
                            ?? "application/octet-stream"
                        output.append(.file(copied.file, name: copied.name, mime: mime))
                    } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                              let url = await value(provider, type: .url) as? URL {
                        guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { continue }
                        if let place = ImShareBridge.appleMapLocation(url) {
                            output.append(.location(lat: place.lat, lng: place.lng, name: place.name))
                        } else {
                            output.append(await linkPayload(url))
                        }
                    } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                              let text = await value(provider, type: .plainText) as? String {
                        if let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
                           ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                            if let place = ImShareBridge.appleMapLocation(url) {
                                output.append(.location(lat: place.lat, lng: place.lng, name: place.name))
                            } else {
                                output.append(await linkPayload(url))
                            }
                        } else {
                            output.append(.text(text))
                        }
                    } else if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier),
                              let copied = try await copiedRepresentation(provider, type: .data, enforceLimit: true) {
                        try checkFileSize(copied.file)
                        let mime = UTType(filenameExtension: copied.name.pathExtension)?.preferredMIMEType
                            ?? "application/octet-stream"
                        output.append(.file(copied.file, name: copied.name, mime: mime))
                    }
                }
            }
        } catch {
            removePayloadFiles(output)
            throw error
        }
        return output
    }

    private static func sweepAbandonedLoaderFiles() {
        guard let outbox,
              let files = try? FileManager.default.contentsOfDirectory(
                  at: outbox, includingPropertiesForKeys: [.contentModificationDateKey]
              )
        else { return }
        let cutoff = Date().addingTimeInterval(-7 * 24 * 3600)
        for file in files where ["load-", "image-", "icon-"].contains(where: { file.lastPathComponent.hasPrefix($0) }) {
            let date = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
            if (date ?? .distantPast) < cutoff { try? FileManager.default.removeItem(at: file) }
        }
    }

    static func removePayloadFiles(_ payloads: [SharePayload]) {
        for payload in payloads {
            switch payload {
            case .image(let file, _, _, _), .file(let file, _, _):
                try? FileManager.default.removeItem(at: file)
            case .link(_, _, let icon):
                if let icon { try? FileManager.default.removeItem(at: icon) }
            default:
                break
            }
        }
    }

    private static func value(_ provider: NSItemProvider, type: UTType) async -> NSSecureCoding? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type.identifier) { value, _ in continuation.resume(returning: value) }
        }
    }

    /// loadFileRepresentation 给的 URL 只在回调内有效，因此复制完成后才恢复 continuation。
    /// enforceLimit：非图片文件复制前先看源文件大小，超过 32MB 直接报错，不往容器里白拷一份。
    private static func copiedRepresentation(
        _ provider: NSItemProvider, type: UTType, enforceLimit: Bool
    ) async throws -> (file: URL, name: String)? {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { source, _ in
                guard let source, let dir = outbox else {
                    continuation.resume(returning: nil)
                    return
                }
                if enforceLimit, sourceTooLarge(source) {
                    continuation.resume(throwing: ShareError.message("文件超过 32MB，无法发送"))
                    return
                }
                let original = originalName(provider: provider, source: source, type: type)
                let target = dir.appendingPathComponent("load-\(UUID().uuidString.lowercased())")
                do {
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: source, to: target)
                    continuation.resume(returning: (target, original))
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private static func copiedItemURL(_ provider: NSItemProvider) async throws -> (file: URL, name: String)? {
        let copied: (file: URL, name: String)? = try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { value, _ in
                guard let source = value as? URL, let dir = outbox else {
                    continuation.resume(returning: nil)
                    return
                }
                // loadItem 回调返回后 URL 及其 sandbox extension 都可能失效，必须在回调内完成访问和复制。
                let scoped = source.startAccessingSecurityScopedResource()
                defer {
                    if scoped { source.stopAccessingSecurityScopedResource() }
                }
                if sourceTooLarge(source) {
                    continuation.resume(throwing: ShareError.message("文件超过 32MB，无法发送"))
                    return
                }
                let original = originalName(provider: provider, source: source, type: .data)
                let target = dir.appendingPathComponent("load-\(UUID().uuidString.lowercased())")
                do {
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: source, to: target)
                    continuation.resume(returning: (target, original))
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
        if let copied { return copied }
        // 某些文件提供器不给可直接读取的 fileURL，退回其受控临时 representation。
        if let represented = try await copiedRepresentation(provider, type: .fileURL, enforceLimit: true) {
            return represented
        }
        return try await copiedRepresentation(provider, type: .data, enforceLimit: true)
    }

    private static func sourceTooLarge(_ source: URL) -> Bool {
        guard let size = try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize else { return false }
        return size > maxFileBytes
    }

    private static func originalName(provider: NSItemProvider, source: URL, type: UTType) -> String {
        var name = provider.suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if name?.isEmpty != false { name = source.lastPathComponent }
        if (name as NSString?)?.pathExtension.isEmpty != false {
            let ext = source.pathExtension.nonEmpty ?? type.preferredFilenameExtension
            if let ext { name = "\(name ?? "文件").\(ext)" }
        }
        return name ?? "文件"
    }

    /// 复制出临时文件 → 下采样压成 JPEG；不论成败，临时的原图副本都立刻删掉。
    private static func downsampledImage(_ provider: NSItemProvider) async -> (file: URL, width: Int, height: Int)? {
        guard let copied = await copiedImageFile(provider) else { return nil }
        defer { try? FileManager.default.removeItem(at: copied.file) }
        return preparedImage(at: copied.file)
    }

    /// 只走文件表示（系统落成临时文件，不进内存）：先试提供方注册的具体图片类型，再试通用 public.image。
    /// 不做 loadDataRepresentation / loadObject 兜底——它们会先把整张图读进内存，没法事先设上限。
    private static func copiedImageFile(_ provider: NSItemProvider) async -> (file: URL, name: String)? {
        var types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }.filter { $0.conforms(to: .image) }
        if !types.contains(.image) { types.append(.image) }
        for type in types {
            if let copied = try? await copiedRepresentation(provider, type: type, enforceLimit: false) { return copied }
        }
        return nil
    }

    /// ImageIO 在解码前下采样，避免把 120MB 原图完整展开进内存。
    private static func preparedImage(at file: URL) -> (file: URL, width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil) else { return nil }
        return preparedImage(from: source)
    }

    private static func preparedImage(from source: CGImageSource) -> (file: URL, width: Int, height: Int)? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 1280,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return preparedImage(UIImage(cgImage: image))
    }

    /// 分享图片统一压缩发送，original=false；长边最多 1280 且不超过 1MB。
    private static func preparedImage(_ image: UIImage) -> (file: URL, width: Int, height: Int)? {
        guard image.size.width > 0, image.size.height > 0, let dir = outbox else { return nil }
        var edge: CGFloat = 1280
        var data: Data?
        var outputSize = CGSize.zero
        while edge >= 480 {
            let scale = min(1, edge / max(image.size.width, image.size.height))
            outputSize = CGSize(width: floor(image.size.width * scale), height: floor(image.size.height * scale))
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let rendered = UIGraphicsImageRenderer(size: outputSize, format: format).image { context in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: outputSize))
                image.draw(in: CGRect(origin: .zero, size: outputSize))
            }
            for quality in [0.78, 0.64, 0.5] {
                if let candidate = rendered.jpegData(compressionQuality: quality), candidate.count <= 1024 * 1024 {
                    data = candidate
                    break
                }
            }
            if data != nil { break }
            edge *= 0.75
        }
        guard let data else { return nil }
        let target = dir.appendingPathComponent("image-\(UUID().uuidString).jpg")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: target, options: .atomic)
            return (target, Int(outputSize.width), Int(outputSize.height))
        } catch {
            return nil
        }
    }

    private static func linkPayload(_ url: URL) async -> SharePayload {
        let metadata: LPLinkMetadata? = await withCheckedContinuation { continuation in
            let provider = LPMetadataProvider()
            let gate = ShareMetadataGate(continuation)
            provider.startFetchingMetadata(for: url) { metadata, _ in gate.finish(metadata) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                provider.cancel()
                gate.finish(nil)
            }
        }
        var icon: URL?
        if let provider = metadata?.iconProvider,
           let copied = await copiedImageFile(provider) {
            icon = preparedIcon(at: copied.file)
            try? FileManager.default.removeItem(at: copied.file)
        }
        return .link(url, title: metadata?.title, icon: icon)
    }

    /// 图标先用 ImageIO 缩到 256 像素再编码，不整图解码。
    private static func preparedIcon(at file: URL) -> URL? {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: 256,
              ] as CFDictionary)
        else { return nil }
        return preparedIcon(UIImage(cgImage: thumb))
    }

    private static func preparedIcon(_ image: UIImage) -> URL? {
        guard let dir = outbox, image.size.width > 0, image.size.height > 0 else { return nil }
        let edge: CGFloat = 256
        let scale = min(1, edge / max(image.size.width, image.size.height))
        let size = CGSize(width: max(1, floor(image.size.width * scale)), height: max(1, floor(image.size.height * scale)))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let data = rendered.jpegData(compressionQuality: 0.75), data.count <= 512 * 1024 else { return nil }
        let target = dir.appendingPathComponent("icon-\(UUID().uuidString.lowercased()).jpg")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard (try? data.write(to: target, options: .atomic)) != nil else { return nil }
        return target
    }

    private static func checkFileSize(_ file: URL) throws {
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0 else {
            try? FileManager.default.removeItem(at: file)
            throw ShareError.message("文件为空或无法读取")
        }
        guard size <= maxFileBytes else {
            try? FileManager.default.removeItem(at: file)
            throw ShareError.message("文件超过 32MB，无法发送")
        }
    }

    private static var outbox: URL? {
        ImShareBridge.container?.appendingPathComponent("share-outbox", isDirectory: true)
    }
}

private enum ShareSender {
    static func enqueue(
        _ payload: SharePayload, to peer: String, snapshot: ImShareBridge.Snapshot,
        sessionIdentifier: String, order: Int
    ) throws {
        let clientId = "share-\(Int64(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8))"
        switch payload {
        case .text(let text):
            try ImShareBackgroundQueue.shared.enqueueJSON(
                ["clientId": clientId, "to": peer, "kind": "text", "body": ["text": text]],
                snapshot: snapshot, sessionIdentifier: sessionIdentifier, order: order
            )
        case .link(let url, let title, let icon):
            var body: [String: Any] = ["url": url.absoluteString]
            if let title { body["title"] = title }
            let message: [String: Any] = ["clientId": clientId, "to": peer, "kind": "link", "body": body]
            if let icon {
                try ImShareBackgroundQueue.shared.enqueueUpload(
                    icon, uploadKind: "icon", mime: "image/jpeg", message: message,
                    snapshot: snapshot, sessionIdentifier: sessionIdentifier, order: order
                )
            } else {
                try ImShareBackgroundQueue.shared.enqueueJSON(
                    message, snapshot: snapshot, sessionIdentifier: sessionIdentifier, order: order
                )
            }
        case .location(let lat, let lng, let name):
            try ImShareBackgroundQueue.shared.enqueueJSON([
                "clientId": clientId, "to": peer, "kind": "location",
                "body": ["lat": lat, "lng": lng, "name": name, "address": ""],
            ], snapshot: snapshot, sessionIdentifier: sessionIdentifier, order: order)
        case .image(let file, let mime, let width, let height):
            try ImShareBackgroundQueue.shared.enqueueUpload(
                file, uploadKind: "image", mime: mime,
                message: ["clientId": clientId, "to": peer, "kind": "image", "body": ["w": width, "h": height, "original": false]],
                snapshot: snapshot, sessionIdentifier: sessionIdentifier, order: order
            )
        case .file(let file, let name, let mime):
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            guard size <= 32 * 1024 * 1024 else { throw ShareError.message("文件超过 32MB，无法发送") }
            try ImShareBackgroundQueue.shared.enqueueUpload(
                file, uploadKind: "file", mime: mime,
                message: ["clientId": clientId, "to": peer, "kind": "file", "body": ["name": name, "size": size, "mime": mime]],
                snapshot: snapshot, sessionIdentifier: sessionIdentifier, order: order
            )
        }
    }
}

private final class ShareMetadataGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<LPLinkMetadata?, Never>?

    init(_ continuation: CheckedContinuation<LPLinkMetadata?, Never>) {
        self.continuation = continuation
    }

    func finish(_ metadata: LPLinkMetadata?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: metadata)
    }
}

private enum ShareError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        if case .message(let value) = self { return value }
        return nil
    }
}

private extension String {
    var pathExtension: String { (self as NSString).pathExtension }
    var nonEmpty: String? { isEmpty ? nil : self }
}
