import CoreLocation
import Combine
import Foundation
@preconcurrency import LinkPresentation
import MapKit
import UIKit
import UniformTypeIdentifiers

enum ImFilePrep {
    typealias Prepared = (file: String, name: String, size: Double, mime: String)

    /// 必须在 fileImporter 回调尚未返回时取得 scope；复制放后台，完成后才释放 scope。
    static func adopt(_ source: URL, tenant: String, completion: @escaping @MainActor (Prepared?) -> Void) {
        let scoped = source.startAccessingSecurityScopedResource()
        DispatchQueue.global(qos: .userInitiated).async {
            let prepared = copy(source, tenant: tenant)
            if scoped { source.stopAccessingSecurityScopedResource() }
            Task { @MainActor in
                completion(prepared)
            }
        }
    }

    private static func copy(_ source: URL, tenant: String) -> Prepared? {
        guard let dir = ImCache.outboxDir(tenant: tenant) else { return nil }
        let name = source.lastPathComponent.isEmpty ? "文件" : source.lastPathComponent
        let safeExt = source.pathExtension.lowercased()
        let stored = "file-\(UUID().uuidString.lowercased())" + (safeExt.isEmpty ? "" : ".\(safeExt)")
        let target = dir.appendingPathComponent(stored)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: target)
            let size = Double((try target.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0)
            guard size > 0, size <= 32 * 1024 * 1024 else {
                try? FileManager.default.removeItem(at: target)
                return nil
            }
            let mime = UTType(filenameExtension: safeExt)?.preferredMIMEType ?? "application/octet-stream"
            return (stored, name, size, mime)
        } catch {
            return nil
        }
    }
}

enum ImLinkMetadata {
    static func load(_ url: URL, tenant: String) async -> (title: String?, desc: String?, iconFile: String?) {
        let metadata: LPLinkMetadata? = await withCheckedContinuation { continuation in
            let provider = LPMetadataProvider()
            let gate = ImMetadataGate(continuation, provider: provider)
            provider.startFetchingMetadata(for: url) { metadata, _ in
                gate.finish(metadata)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                gate.cancel()
            }
        }
        guard let metadata else { return (nil, nil, nil) }
        var iconFile: String?
        if let provider = metadata.iconProvider,
           let image = await provider.imImage(),
           let data = image.imIconPNG(),
           data.count <= 512 * 1024,
           let dir = ImCache.outboxDir(tenant: tenant) {
            let name = "icon-\(UUID().uuidString.lowercased()).png"
            let target = dir.appendingPathComponent(name)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if (try? data.write(to: target, options: .atomic)) != nil { iconFile = name }
        }
        return (metadata.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty, nil, iconFile)
    }

    static func recognized(_ text: String) -> URL? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.contains(where: \.isWhitespace),
              let url = URL(string: value),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil
        else { return nil }
        return url
    }
}

private final class ImMetadataGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<LPLinkMetadata?, Never>?
    private let provider: LPMetadataProvider

    init(_ continuation: CheckedContinuation<LPLinkMetadata?, Never>, provider: LPMetadataProvider) {
        self.continuation = continuation
        self.provider = provider
    }

    func finish(_ metadata: LPLinkMetadata?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: metadata)
    }

    func cancel() {
        provider.cancel()
        finish(nil)
    }
}

private extension NSItemProvider {
    func imImage() async -> UIImage? {
        await withCheckedContinuation { continuation in
            guard canLoadObject(ofClass: UIImage.self) else {
                continuation.resume(returning: nil)
                return
            }
            loadObject(ofClass: UIImage.self) { value, _ in continuation.resume(returning: value as? UIImage) }
        }
    }
}

private extension UIImage {
    func imIconPNG() -> Data? {
        let side: CGFloat = 128
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
        return renderer.pngData { _ in
            let scale = min(side / size.width, side / size.height)
            let draw = CGSize(width: size.width * scale, height: size.height * scale)
            self.draw(in: CGRect(x: (side - draw.width) / 2, y: (side - draw.height) / 2, width: draw.width, height: draw.height))
        }
    }
}

@MainActor
final class ImLocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var coordinate: CLLocationCoordinate2D?
    @Published var denied = false
    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func request() {
        manager.requestWhenInUseAuthorization()
        manager.requestLocation()
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let coordinate = locations.last?.coordinate
        Task { @MainActor in
            self.coordinate = coordinate
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            denied = status == .denied || status == .restricted
            if status == .authorizedAlways || status == .authorizedWhenInUse {
                self.manager.requestLocation()
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}

struct ImPlace: Identifiable, Hashable {
    let id = UUID()
    var coordinate: CLLocationCoordinate2D
    var name: String
    var address: String

    static func == (lhs: ImPlace, rhs: ImPlace) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

enum ImPlaceSearch {
    static func search(_ query: String, near coordinate: CLLocationCoordinate2D?) async -> [ImPlace] {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        if let coordinate {
            request.region = MKCoordinateRegion(center: coordinate, latitudinalMeters: 20_000, longitudinalMeters: 20_000)
        }
        guard let response = try? await MKLocalSearch(request: request).start() else { return [] }
        return response.mapItems.prefix(20).map { item in
            ImPlace(
                coordinate: item.location.coordinate,
                name: item.name ?? "位置",
                address: addressLine(for: item)
            )
        }
    }

    static func current(_ coordinate: CLLocationCoordinate2D) async -> ImPlace {
        let location = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        let item = await reverseItem(at: location)
        return ImPlace(
            coordinate: coordinate,
            name: item?.name ?? "当前位置",
            address: item.map { addressLine(for: $0) } ?? ""
        )
    }

    private static func reverseItem(at location: CLLocation) async -> MKMapItem? {
        guard let request = MKReverseGeocodingRequest(location: location) else { return nil }
        return (try? await request.mapItems)?.first
    }

    private static func addressLine(for item: MKMapItem) -> String {
        if let line = item.addressRepresentations?.fullAddress(includingRegion: false, singleLine: true),
           !line.isEmpty
        {
            return line
        }
        return item.address?.fullAddress ?? ""
    }
}

enum ImMapOpen {
    static func apple(lat: Double, lng: Double, name: String) -> URL? {
        var parts = URLComponents(string: "https://maps.apple.com/")
        parts?.queryItems = [
            URLQueryItem(name: "ll", value: "\(lat),\(lng)"),
            URLQueryItem(name: "q", value: name),
        ]
        return parts?.url
    }

    /// MapKit 给出 WGS-84；高德 dev=1 表示坐标尚未国测偏移，由高德转换。
    static func amap(lat: Double, lng: Double, name: String) -> URL? {
        var parts = URLComponents(string: "iosamap://viewMap")
        parts?.queryItems = [
            URLQueryItem(name: "sourceApplication", value: "接驳"),
            URLQueryItem(name: "lat", value: String(lat)),
            URLQueryItem(name: "lon", value: String(lng)),
            URLQueryItem(name: "poiname", value: name),
            URLQueryItem(name: "dev", value: "1"),
        ]
        return parts?.url
    }
}
