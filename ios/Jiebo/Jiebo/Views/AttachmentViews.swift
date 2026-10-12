import SwiftUI
import UIKit
import ImageIO

/// 附图解码：ImageIO 直接按目标像素解码，不先解出整张原图（相机图解开是几十 MB）。
/// 缓存按字节计；NSCache 本身线程安全，后台解码可以直接写。
enum JieboThumbDecoder {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 32 * 1024 * 1024
        return cache
    }()

    static func cached(_ key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    static func store(_ image: UIImage, key: String) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 1
        cache.setObject(image, forKey: key as NSString, cost: cost)
    }

    static func decode(_ data: Data, maxPixel: CGFloat) -> UIImage? {
        let options: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, options as CFDictionary) else { return nil }
        let thumbOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(maxPixel, 1),
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }

    /// base64 太长不能整段哈希（每次重算都要扫几 MB）：长度 + 头、中、尾各 48 字节，连续存储时 O(1) 取样
    static func key(base64 text: String, size: CGFloat) -> String {
        var text = text
        return text.withUTF8 { bytes in
            let n = bytes.count
            func slice(_ start: Int) -> String {
                let lo = max(0, min(start, n))
                let hi = min(n, lo + 48)
                return String(decoding: UnsafeBufferPointer(rebasing: bytes[lo..<hi]), as: UTF8.self)
            }
            return "b64|\(Int(size))|\(n)|\(slice(0))|\(slice(n / 2))|\(slice(n - 48))"
        }
    }
}

/// 附图缩略：先查缓存；没有就在后台解码，解好淡入。重算 body（流式每个 token、输入每个按键）不再碰原图。
struct AttachmentThumb: View {
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let key: String
    /// 视图边长（pt）；scaledToFill，长边按 2 倍解，短边也铺得满
    let side: CGFloat
    let load: @Sendable () -> Data?
    @State private var image: UIImage?

    init(key: String, side: CGFloat, load: @escaping @Sendable () -> Data?) {
        self.key = key
        self.side = side
        self.load = load
        _image = State(initialValue: JieboThumbDecoder.cached(key))
    }

    var body: some View {
        ZStack {
            JieboColor.well
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .frame(width: side, height: side)
        .clipped()
        .task(id: key) {
            if let hit = JieboThumbDecoder.cached(key) {
                image = hit
                return
            }
            let maxPixel = side * 2 * displayScale
            let load = self.load
            let key = self.key
            let decoded = await Task.detached(priority: .userInitiated) { () -> UIImage? in
                guard let data = load(), let image = JieboThumbDecoder.decode(data, maxPixel: maxPixel) else { return nil }
                JieboThumbDecoder.store(image, key: key)
                return image
            }.value
            guard !Task.isCancelled else { return }
            withAnimation(JieboMotion.fade(reduceMotion)) { image = decoded }
        }
    }
}

/// 点开附图：全屏看原图（按屏幕像素解码），双指缩放、双击放大、拖动平移，可分享
struct AttachmentViewerItem: Identifiable {
    let id = UUID()
    let title: String
    let load: @Sendable () -> Data?
}

struct AttachmentViewer: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    let item: AttachmentViewerItem
    @State private var image: UIImage?
    @State private var failed = false
    @State private var scale: CGFloat = 1
    @State private var pinch: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var pan: CGSize = .zero
    @State private var chromeHidden = false

    /// 解码按屏幕像素 × maxScale，放到最大也不糊
    private static let maxScale: CGFloat = 3
    private static let doubleTapScale: CGFloat = 2.5

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black
                // 视口取整屏（含安全区）：导航栏、状态栏浮在图上，显隐时图不跟着变大变小
                GeometryReader { geo in
                    content(in: geo.size)
                }
                if chromeHidden {
                    // 导航栏藏起来后「完成」不在层级里，Esc 靠这个隐形按钮
                    Button("完成") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .opacity(0)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .ignoresSafeArea()
            .navigationTitle(item.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar(chromeHidden ? .hidden : .visible, for: .navigationBar)
            .statusBarHidden(chromeHidden)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
                if let image {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(
                            item: Image(uiImage: image),
                            preview: SharePreview(item.title, image: Image(uiImage: image))
                        )
                    }
                }
            }
        }
        .accessibilityAction(.escape) { dismiss() }
    }

    @ViewBuilder
    private func content(in viewport: CGSize) -> some View {
        ZStack {
            if let image {
                let fit = Self.fitted(image.size, in: viewport)
                let live = min(max(scale * pinch, 1), Self.maxScale)
                let shown = Self.clamp(
                    CGSize(width: offset.width + pan.width, height: offset.height + pan.height),
                    fit: fit, scale: live, in: viewport
                )
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: fit.width, height: fit.height)
                    .scaleEffect(live)
                    .offset(shown)
                    .accessibilityLabel(item.title)
                    .accessibilityAddTraits(.isImage)
            } else if failed {
                Label("图片打不开", systemImage: "photo.badge.exclamationmark")
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(.white.opacity(0.8))
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(width: viewport.width, height: viewport.height)
        .contentShape(Rectangle())
        .gesture(zoom(in: viewport))
        .simultaneousGesture(drag(in: viewport), including: scale > 1 ? .all : .subviews)
        .gesture(taps(in: viewport))
        .task {
            let maxPixel = min(4096, max(viewport.width, viewport.height) * displayScale * Self.maxScale)
            let load = item.load
            let decoded = await Task.detached(priority: .userInitiated) {
                load().flatMap { JieboThumbDecoder.decode($0, maxPixel: maxPixel) }
            }.value
            guard !Task.isCancelled else { return }
            image = decoded
            failed = decoded == nil
        }
    }

    /// 双击优先于单击：双击在点击处放大 / 复原，单击显隐导航栏
    private func taps(in viewport: CGSize) -> some Gesture {
        SpatialTapGesture(count: 2)
            .onEnded { value in
                withAnimation(JieboMotion.snappy(reduceMotion)) {
                    if scale > 1 {
                        scale = 1
                        offset = .zero
                    } else {
                        let s = Self.doubleTapScale
                        let dx = value.location.x - viewport.width / 2
                        let dy = value.location.y - viewport.height / 2
                        scale = s
                        offset = clamped(CGSize(width: -dx * (s - 1), height: -dy * (s - 1)), scale: s, in: viewport)
                    }
                }
            }
            .exclusively(before: TapGesture().onEnded {
                guard !voiceOver else { return }
                withAnimation(JieboMotion.fade(reduceMotion)) { chromeHidden.toggle() }
            })
    }

    private func zoom(in viewport: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in pinch = value.magnification }
            .onEnded { value in
                let next = min(max(scale * value.magnification, 1), Self.maxScale)
                withAnimation(JieboMotion.snappy(reduceMotion)) {
                    scale = next
                    pinch = 1
                    offset = next == 1 ? .zero : clamped(offset, scale: next, in: viewport)
                }
            }
    }

    private func drag(in viewport: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in pan = value.translation }
            .onEnded { value in
                let moved = CGSize(
                    width: offset.width + value.translation.width,
                    height: offset.height + value.translation.height
                )
                offset = clamped(moved, scale: scale, in: viewport)
                pan = .zero
            }
    }

    private func clamped(_ value: CGSize, scale: CGFloat, in viewport: CGSize) -> CGSize {
        guard let image else { return .zero }
        return Self.clamp(value, fit: Self.fitted(image.size, in: viewport), scale: scale, in: viewport)
    }

    static func fitted(_ size: CGSize, in viewport: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return viewport }
        let ratio = min(viewport.width / size.width, viewport.height / size.height)
        return CGSize(width: size.width * ratio, height: size.height * ratio)
    }

    /// 放大后图边不离开屏幕边：可平移量 = (放大后尺寸 − 视口) / 2，图比视口小的方向不让移
    static func clamp(_ value: CGSize, fit: CGSize, scale: CGFloat, in viewport: CGSize) -> CGSize {
        let maxX = max(0, (fit.width * scale - viewport.width) / 2)
        let maxY = max(0, (fit.height * scale - viewport.height) / 2)
        return CGSize(
            width: min(max(value.width, -maxX), maxX),
            height: min(max(value.height, -maxY), maxY)
        )
    }
}
