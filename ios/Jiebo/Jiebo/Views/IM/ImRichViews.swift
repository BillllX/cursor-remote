import MapKit
import SwiftUI
import UIKit

struct ImLocationPicker: View {
    var onPick: (ImPlace) -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var locator = ImLocationManager()
    @State private var query = ""
    @State private var results: [ImPlace] = []
    @State private var selected: ImPlace?
    @State private var camera: MapCameraPosition = .automatic

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Map(position: $camera) {
                    if let selected {
                        Marker(selected.name, coordinate: selected.coordinate)
                    } else if let coordinate = locator.coordinate {
                        Marker("当前位置", coordinate: coordinate)
                    }
                }
                .frame(height: 260)
                List {
                    if locator.denied {
                        Text("没有定位权限，仍可搜索地点").foregroundStyle(JieboColor.dim)
                    } else if let coordinate = locator.coordinate {
                        Button {
                            Task {
                                selected = await ImPlaceSearch.current(coordinate)
                                center(selected?.coordinate)
                            }
                        } label: {
                            Label("发送当前位置", systemImage: "location.fill")
                        }
                    }
                    ForEach(results) { place in
                        Button {
                            selected = place
                            center(place.coordinate)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(place.name).foregroundStyle(JieboColor.ink)
                                Text(place.address).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.dim)
                            }
                        }
                    }
                }
                .listStyle(.plain)
            }
            .searchable(text: $query, prompt: "搜索地点")
            .onSubmit(of: .search) {
                Task { results = await ImPlaceSearch.search(query, near: locator.coordinate) }
            }
            .navigationTitle("发送位置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("发送") {
                        guard let selected else { return }
                        onPick(selected)
                        dismiss()
                    }
                    .disabled(selected == nil)
                }
            }
            .onAppear { locator.request() }
            .onChange(of: locator.coordinate?.latitude) { _, _ in center(locator.coordinate) }
        }
    }

    private func center(_ coordinate: CLLocationCoordinate2D?) {
        guard let coordinate else { return }
        camera = .region(MKCoordinateRegion(center: coordinate, latitudinalMeters: 2500, longitudinalMeters: 2500))
    }
}

struct ImVoiceBubble: View {
    @Environment(ImStore.self) private var im
    let message: ImLocalMessage
    let mine: Bool
    @State private var player = ImVoicePlayer.shared

    private var details: (duration: Int, waveform: [Double]) {
        if case .voice(_, let duration, let waveform)? = message.body { return (duration, waveform) }
        return (message.upload?.durationMs ?? 0, message.upload?.waveform ?? [])
    }

    var body: some View {
        let detail = details
        VStack(alignment: mine ? .trailing : .leading, spacing: 5) {
            HStack(spacing: 8) {
                Image(systemName: player.playingId == message.id ? "stop.fill" : "speaker.wave.2.fill")
                ImWaveform(values: detail.waveform, active: player.playingId == message.id)
                Text("\(max(1, Int(ceil(Double(detail.duration) / 1000))))″")
                    .font(JieboFont.text(.caption, weight: .medium))
                if !mine, !im.isVoiceHeard(message) {
                    Circle().fill(JieboColor.danger).frame(width: 8, height: 8)
                }
            }
            .foregroundStyle(mine ? JieboColor.fillFg : JieboColor.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(width: min(230, 100 + CGFloat(detail.duration) / 600), alignment: .leading)
            .background(mine ? JieboColor.pine : JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if let text = im.voiceTranscript(message) {
                Text(text)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.ink2)
                    .padding(8)
                    .background(JieboColor.well)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .onTapGesture {
            player.toggle(message, messages: im.visibleMessages(message.convId), store: im)
        }
        .accessibilityLabel("语音 \(max(1, detail.duration / 1000)) 秒")
    }
}

private struct ImWaveform: View {
    let values: [Double]
    let active: Bool
    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array((values.isEmpty ? [0.2] : values).prefix(24).enumerated()), id: \.offset) { _, value in
                Capsule()
                    .frame(width: 2, height: 4 + 16 * max(0.08, value))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(active ? 1 : 0.72)
    }
}

struct ImFileBubble: View {
    @Environment(ImStore.self) private var im
    let message: ImLocalMessage
    let mine: Bool
    @State private var preview: PreviewFile?
    @State private var loading = false

    var body: some View {
        let details = fileDetails
        Button {
            open(details)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "doc.fill").font(.system(size: 30)).foregroundStyle(mine ? JieboColor.fillFg : JieboColor.pine)
                VStack(alignment: .leading, spacing: 4) {
                    Text(details.name).lineLimit(2).foregroundStyle(mine ? JieboColor.fillFg : JieboColor.ink)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(details.size), countStyle: .file))
                        .font(JieboFont.text(.caption2)).foregroundStyle(mine ? JieboColor.fillFg.opacity(0.75) : JieboColor.dim)
                }
                if loading { ProgressView().controlSize(.small) }
            }
            .padding(12)
            .frame(maxWidth: 260, alignment: .leading)
            .background(mine ? JieboColor.pine : JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .sheet(item: $preview, onDismiss: {
            if let preview { cleanupPreview(preview.url) }
            preview = nil
        }) { file in
            QuickLookView(file: file) {
                cleanupPreview(file.url)
                preview = nil
            }
        }
        .onDisappear {
            if let preview { cleanupPreview(preview.url) }
        }
    }

    private var fileDetails: (blob: String?, name: String, size: Double) {
        if case .file(let blob, let name, let size, _)? = message.body { return (blob, name, size) }
        return (message.upload?.blob, message.upload?.name ?? "文件", message.upload?.size ?? 0)
    }

    private func open(_ details: (blob: String?, name: String, size: Double)) {
        loading = true
        Task {
            var file: URL?
            if let blob = details.blob {
                file = await ImAttachmentCache.file(
                    blob: blob, tenant: im.tenant, remote: im.mediaURL(convId: message.convId, blob: blob)
                )
            } else if let upload = message.upload, let dir = ImCache.outboxDir(tenant: im.tenant) {
                let local = dir.appendingPathComponent(upload.file)
                if FileManager.default.fileExists(atPath: local.path) { file = local }
            }
            loading = false
            guard let file else {
                im.showToast("文件下载失败")
                return
            }
            let named = FileManager.default.temporaryDirectory.appendingPathComponent("im-preview-\(UUID().uuidString)-\(details.name)")
            try? FileManager.default.copyItem(at: file, to: named)
            preview = PreviewFile(url: FileManager.default.fileExists(atPath: named.path) ? named : file, name: details.name)
        }
    }

    private func cleanupPreview(_ file: URL) {
        guard file.lastPathComponent.hasPrefix("im-preview-") else { return }
        try? FileManager.default.removeItem(at: file)
    }
}

struct ImLinkBubble: View {
    @Environment(\.openURL) private var openURL
    @Environment(ImStore.self) private var im
    let payload: ImBody
    let mine: Bool
    let convId: String
    @State private var iconImage: UIImage?
    var body: some View {
        Group {
            if case .link(let raw, let title, let desc, let icon) = payload, let url = URL(string: raw) {
                Button { openURL(url) } label: {
                    HStack(alignment: .top, spacing: 9) {
                        if let iconImage {
                            Image(uiImage: iconImage).resizable().scaledToFit().frame(width: 42, height: 42)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text(title ?? url.host ?? raw).font(JieboFont.text(.subheadline, weight: .semibold)).lineLimit(2)
                            if let desc { Text(desc).font(JieboFont.text(.caption)).lineLimit(2) }
                            Text(url.host ?? raw).font(JieboFont.text(.caption2)).opacity(0.7).lineLimit(1)
                        }
                    }
                    .foregroundStyle(mine ? JieboColor.fillFg : JieboColor.ink)
                    .padding(12).frame(maxWidth: 270, alignment: .leading)
                    .background(mine ? JieboColor.pine : JieboColor.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
                .task(id: icon) {
                    guard let icon else { return }
                    iconImage = await ImImageCache.shared.image(
                        blob: icon, tenant: im.tenant, remote: im.mediaURL(convId: convId, blob: icon), maxPixel: 128
                    )
                }
            }
        }
    }
}

struct ImLocationBubble: View {
    @Environment(\.openURL) private var openURL
    let payload: ImBody
    @State private var snapshot: UIImage?

    var body: some View {
        Group {
            if case .location(let lat, let lng, let name, let address) = payload {
                Menu {
                    if let apple = ImMapOpen.apple(lat: lat, lng: lng, name: name) {
                        Button("Apple 地图") { openURL(apple) }
                    }
                    if let amap = ImMapOpen.amap(lat: lat, lng: lng, name: name) {
                        Button("高德地图") { openURL(amap) }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 0) {
                        Group {
                            if let snapshot { Image(uiImage: snapshot).resizable().scaledToFill() }
                            else { JieboColor.well.overlay { ProgressView() } }
                        }
                        .frame(width: 260, height: 130).clipped()
                        VStack(alignment: .leading, spacing: 3) {
                            Text(name.isEmpty ? "位置" : name).font(JieboFont.text(.subheadline, weight: .semibold))
                            Text(address).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.dim).lineLimit(2)
                        }.padding(10)
                    }
                    .foregroundStyle(JieboColor.ink).background(JieboColor.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .task(id: "\(lat),\(lng)") { snapshot = await mapSnapshot(lat: lat, lng: lng) }
            }
        }
    }

    private func mapSnapshot(lat: Double, lng: Double) async -> UIImage? {
        let coordinate = CLLocationCoordinate2D(latitude: lat, longitude: lng)
        let options = MKMapSnapshotter.Options()
        options.region = MKCoordinateRegion(
            center: coordinate,
            latitudinalMeters: 1800, longitudinalMeters: 1800
        )
        options.size = CGSize(width: 520, height: 260)
        options.scale = 2
        guard let snapshot = try? await MKMapSnapshotter(options: options).start() else { return nil }
        let point = snapshot.point(for: coordinate)
        let format = UIGraphicsImageRendererFormat()
        format.scale = snapshot.image.scale
        return UIGraphicsImageRenderer(size: snapshot.image.size, format: format).image { _ in
            snapshot.image.draw(at: .zero)
            let side: CGFloat = 38
            let rect = CGRect(x: point.x - side / 2, y: point.y - side, width: side, height: side)
            UIImage(systemName: "mappin.circle.fill")?
                .withTintColor(.systemRed, renderingMode: .alwaysOriginal)
                .draw(in: rect)
        }
    }
}
