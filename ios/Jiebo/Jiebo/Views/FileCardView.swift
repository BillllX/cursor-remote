import SwiftUI
import UIKit

/// 卡片上的状态：工具还在写、整轮还原在等回执、已经还原
enum TurnFileState: Equatable {
    case idle, writing, restoring, restored

    /// localReview：没有工具能带标记的轮次在本机记下的结果（ChatStore.localTurnReviews）
    init(file: TurnFile, turn: Turn, restoring: Bool, localReview: String?) {
        if turn.isWriting(file) {
            self = .writing
        } else if restoring {
            self = .restoring
        } else if localReview == "rejected" || turn.isRestored(file) {
            self = .restored
        } else {
            self = .idle
        }
    }

    var label: String? {
        switch self {
        case .idle: return nil
        case .writing: return "正在写"
        case .restoring: return "还原中"
        case .restored: return "已还原"
        }
    }
}

enum TurnFileStyle {
    static func symbol(_ kind: PreviewKind) -> String {
        switch kind {
        case .html: return "globe"
        case .canvas: return "square.grid.2x2"
        case .image, .svg: return "photo"
        case .pdf: return "doc.richtext"
        case .markdown: return "doc.text"
        case .video: return "film"
        case .audio: return "waveform"
        case .text: return "chevron.left.forwardslash.chevron.right"
        case .binary: return "doc"
        }
    }

    static func label(_ kind: PreviewKind) -> String {
        switch kind {
        case .html: return "网页"
        case .canvas: return "画布"
        case .image: return "图片"
        case .svg: return "矢量图"
        case .pdf: return "PDF"
        case .markdown: return "文档"
        case .video: return "视频"
        case .audio: return "音频"
        case .text: return "代码"
        case .binary: return "文件"
        }
    }

    static func filename(_ file: TurnFile) -> String {
        (file.path as NSString).lastPathComponent
    }

    static func caption(_ file: TurnFile) -> String {
        let kind = label(file.kind)
        guard let size = file.size else { return kind }
        return "\(kind) · \(formatBytes(size))"
    }

    /// 网页、画布、PDF 从顶部裁，其余居中
    static func thumbAlignment(_ kind: PreviewKind) -> Alignment {
        switch kind {
        case .html, .canvas, .pdf: return .top
        default: return .center
        }
    }
}

/// 一轮文件审阅：与卡片是否渲染无关（内联卡片、无 card 的 delete 改动也要能保留/还原）
struct TurnReviewBar: View {
    @Environment(ChatStore.self) private var store
    let turn: Turn
    @State private var confirmRestore = false

    var body: some View {
        let restoring = store.restoringTurnIds.contains(turn.id)
        HStack(spacing: 8) {
            Text("\(turn.reviewPaths.count) 个文件改动")
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.ink2)
            Spacer(minLength: 4)
            Button(restoring ? "还原中" : "全部还原") { confirmRestore = true }
                .buttonStyle(.bordered)
                .tint(JieboColor.ink2)
                .disabled(restoring)
            Button("全部保留") { store.keepTurnFiles(turn.id) }
                .buttonStyle(.borderedProminent)
                .tint(JieboColor.pine)
                .disabled(restoring)
        }
        .font(JieboFont.text(.footnote, weight: .semibold))
        .controlSize(.large)
        .frame(minHeight: 44)
        .frame(maxWidth: JieboMeasure.bubble, alignment: .leading)
        .confirmationDialog(
            "还原这一轮的 \(turn.reviewPaths.count) 个文件？",
            isPresented: $confirmRestore,
            titleVisibility: .visible
        ) {
            Button("全部还原", role: .destructive) { store.restoreTurnFiles(turn.id) }
            Button("取消", role: .cancel) {}
        } message: {
            Text("文件会回到这一轮开始之前的样子。")
        }
    }
}

/// 一轮（或正文里一段）的文件：能出缩略图的类型 1–2 个时各占一张大卡，更多时排成横向画廊；
/// 代码、二进制、音频进紧凑行，超过 3 行折叠。
struct TurnFileCards: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let turn: Turn
    let chatId: String
    /// 打开前先做的事（委派详情是 sheet，预览层在它下面，要先收起）
    var beforeOpen: (() -> Void)?
    /// 只画这一组（卡片插在正文中间时按段分组）；nil 画整轮
    var files: [TurnFile]?
    @State private var expanded = false

    private static let largeLimit = 2
    private static let compactLimit = 3

    init(
        turn: Turn,
        chatId: String,
        files: [TurnFile]? = nil,
        beforeOpen: (() -> Void)? = nil
    ) {
        self.turn = turn
        self.chatId = chatId
        self.files = files
        self.beforeOpen = beforeOpen
    }

    private var partition: (preview: [TurnFile], rows: [TurnFile]) {
        let scope = files ?? turn.cardFiles
        return (
            scope.filter { ThumbnailStore.renderable($0.kind) },
            scope.filter { !ThumbnailStore.renderable($0.kind) }
        )
    }

    var body: some View {
        let parts = partition
        let folded = parts.rows.count > Self.compactLimit && !expanded
        let rows = folded ? Array(parts.rows.prefix(Self.compactLimit)) : parts.rows
        VStack(alignment: .leading, spacing: 8) {
            if parts.preview.count > Self.largeLimit {
                gallery(parts.preview)
            } else {
                ForEach(parts.preview) { file in
                    TurnFileLargeCard(file: file, turn: turn, chatId: chatId, beforeOpen: beforeOpen)
                        .frame(maxWidth: JieboMeasure.bubble, alignment: .leading)
                }
            }
            if !rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, file in
                        if index > 0 {
                            Rectangle().fill(JieboColor.line).frame(height: 0.5).padding(.leading, 36)
                        }
                        TurnFileRow(file: file, turn: turn, chatId: chatId, beforeOpen: beforeOpen)
                    }
                    if parts.rows.count > Self.compactLimit {
                        Rectangle().fill(JieboColor.line).frame(height: 0.5)
                        moreButton(hidden: parts.rows.count - Self.compactLimit)
                    }
                }
                .background(JieboColor.white)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                )
                .frame(maxWidth: JieboMeasure.bubble, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 3 个以上可预览文件：横向滑动，按卡片吸附，裁在内容列以内；卡宽让第二张露出一截，提示还能滑
    private func gallery(_ items: [TurnFile]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(items.count) 个可预览文件")
                .font(JieboFont.text(.caption, weight: .medium))
                .foregroundStyle(JieboColor.dim)
                .accessibilityHidden(true)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 10) {
                    ForEach(items) { file in
                        TurnFileTile(file: file, turn: turn, chatId: chatId, beforeOpen: beforeOpen)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(items.count) 个可预览文件")
        }
        // iPad 宽屏上和气泡、紧凑行同宽，不横向拉满
        .frame(maxWidth: JieboMeasure.bubble, alignment: .leading)
    }

    private func moreButton(hidden: Int) -> some View {
        Button {
            withAnimation(JieboMotion.snappy(reduceMotion)) { expanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Text(expanded ? "收起" : "还有 \(hidden) 个文件")
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                Image(systemName: "chevron.down")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                    .rotationEffect(.degrees(expanded ? 180 : 0))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(expanded ? "收起文件列表" : "还有 \(hidden) 个文件")
        .accessibilityValue(expanded ? "已展开" : "已收起")
        .accessibilityHint(expanded ? "轻点两下收起" : "轻点两下展开")
    }
}

/// 卡片出现时请求缩略图；键、连接、能力、写入状态任一变化再推一次（同一键 ThumbnailStore 只真正发一次）；
/// 滑出屏幕撤掉还没发出的请求
private struct ThumbRequest: ViewModifier {
    @Environment(ChatStore.self) private var store
    let file: TurnFile
    let chatId: String
    let writing: Bool

    /// 末位：状态回到 .none（内存淘汰、被撤）时也算变化，卡片还在就重新要
    private var trigger: String {
        let key = ThumbnailStore.shared.cacheKey(for: file, chatId: chatId, store: store).key
        let idle = ThumbnailStore.shared.thumbnail(for: file, chatId: chatId, store: store) == .none
        return "\(key)|\(store.connected)|\(store.gatewayFeatures.contains("read_req_id"))|\(writing)|\(idle)"
    }

    private func request() {
        // 正在写的文件内容不完整，等写完再截
        guard !writing else { return }
        ThumbnailStore.shared.request(file: file, chatId: chatId, store: store)
    }

    func body(content: Content) -> some View {
        content
            .onAppear(perform: request)
            .onChange(of: trigger) { _, _ in request() }
            .onDisappear { ThumbnailStore.shared.cancel(file: file, chatId: chatId, store: store) }
    }
}

/// 卡片共用的长按菜单
private struct TurnFileMenu: ViewModifier {
    @Environment(ChatStore.self) private var store
    let file: TurnFile
    let chatId: String
    var beforeOpen: (() -> Void)?

    private var failed: Bool {
        ThumbnailStore.shared.thumbnail(for: file, chatId: chatId, store: store) == .failed
    }

    func body(content: Content) -> some View {
        content
            .contextMenu {
                Button {
                    beforeOpen?()
                    store.openTurnFile(file, chatId: chatId)
                } label: {
                    Label("打开预览", systemImage: "eye")
                }
                if failed {
                    Button {
                        ThumbnailStore.shared.retry(file: file, chatId: chatId, store: store)
                    } label: {
                        Label("重新生成预览", systemImage: "arrow.clockwise")
                    }
                }
                Button {
                    UIPasteboard.general.string = file.path
                } label: {
                    Label("复制路径", systemImage: "doc.on.doc")
                }
            }
            .accessibilityActions {
                if failed {
                    Button("重新生成预览") {
                        ThumbnailStore.shared.retry(file: file, chatId: chatId, store: store)
                    }
                }
            }
    }
}

/// 大卡：上面 16:10 预览，下面文件名和类型（同系统链接预览的版式）
struct TurnFileLargeCard: View {
    @Environment(ChatStore.self) private var store
    let file: TurnFile
    let turn: Turn
    let chatId: String
    var beforeOpen: (() -> Void)?

    init(file: TurnFile, turn: Turn, chatId: String, beforeOpen: (() -> Void)? = nil) {
        self.file = file
        self.turn = turn
        self.chatId = chatId
        self.beforeOpen = beforeOpen
    }

    var body: some View {
        let state = TurnFileState(file: file, turn: turn, restoring: store.restoringTurnIds.contains(turn.id), localReview: store.localTurnReviews[turn.id])
        let thumb = ThumbnailStore.shared.thumbnail(for: file, chatId: chatId, store: store)
        Button {
            beforeOpen?()
            store.openTurnFile(file, chatId: chatId)
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                TurnFileThumbnail(state: thumb, kind: file.kind)
                    .aspectRatio(16.0 / 10.0, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipped()
                Rectangle().fill(JieboColor.line).frame(height: 0.5)
                TurnFileFooter(file: file, state: state)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous))
        }
        .buttonStyle(PressScaleButtonStyle(enabled: state != .writing))
        .disabled(state == .writing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(TurnFileStyle.filename(file))
        .accessibilityValue(TurnFileSpoken.value(file: file, state: state, thumb: thumb))
        .accessibilityHint("轻点两下打开预览")
        .accessibilityAddTraits(.isButton)
        .modifier(ThumbRequest(file: file, chatId: chatId, writing: state == .writing))
        .modifier(TurnFileMenu(file: file, chatId: chatId, beforeOpen: beforeOpen))
    }
}

/// 画廊里的一张：固定宽度，预览 + 两行文字
struct TurnFileTile: View {
    @Environment(ChatStore.self) private var store
    @ScaledMetric(relativeTo: .body) private var baseWidth: CGFloat = 248
    private var width: CGFloat { min(baseWidth, 300) }
    let file: TurnFile
    let turn: Turn
    let chatId: String
    var beforeOpen: (() -> Void)?

    var body: some View {
        let state = TurnFileState(file: file, turn: turn, restoring: store.restoringTurnIds.contains(turn.id), localReview: store.localTurnReviews[turn.id])
        let thumb = ThumbnailStore.shared.thumbnail(for: file, chatId: chatId, store: store)
        Button {
            beforeOpen?()
            store.openTurnFile(file, chatId: chatId)
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                TurnFileThumbnail(state: thumb, kind: file.kind)
                    .frame(width: width, height: width * 10 / 16)
                    .clipped()
                Rectangle().fill(JieboColor.line).frame(height: 0.5)
                TurnFileFooter(file: file, state: state)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
            }
            .frame(width: width, alignment: .leading)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        }
        .buttonStyle(PressScaleButtonStyle(enabled: state != .writing))
        .disabled(state == .writing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(TurnFileStyle.filename(file))
        .accessibilityValue(TurnFileSpoken.value(file: file, state: state, thumb: thumb))
        .accessibilityHint("轻点两下打开预览")
        .accessibilityAddTraits(.isButton)
        .modifier(ThumbRequest(file: file, chatId: chatId, writing: state == .writing))
        .modifier(TurnFileMenu(file: file, chatId: chatId, beforeOpen: beforeOpen))
    }
}

private enum TurnFileSpoken {
    static func value(file: TurnFile, state: TurnFileState, thumb: ThumbState) -> String {
        let base = state.label ?? TurnFileStyle.caption(file)
        return thumb == .loading ? "\(base)，正在生成预览" : base
    }
}

/// 卡片底部：类型图标、文件名、类型与大小、右侧状态
private struct TurnFileFooter: View {
    let file: TurnFile
    let state: TurnFileState

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: TurnFileStyle.symbol(file.kind))
                .font(JieboFont.text(.footnote, weight: .semibold))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(TurnFileStyle.filename(file))
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(TurnFileStyle.caption(file))
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            TurnFileTrailing(state: state)
        }
    }
}

/// 16:10 预览区：缩略图 / markdown 前几行 / 加载骨架 / 图标占位。
/// 底色用 well（浅色略深、深色略亮于卡片），不用用户气泡色——深色主题下那个颜色发闷，像一层遮罩。
private struct TurnFileThumbnail: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: ThumbState
    let kind: PreviewKind

    var body: some View {
        ZStack {
            JieboColor.well
            switch state {
            case .image(let image):
                // 透明图垫卡片色，免得透出底色发灰
                JieboColor.white
                    .overlay(alignment: TurnFileStyle.thumbAlignment(kind)) {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    }
                    .clipped()
                    .transition(.opacity)
            case .text(let text):
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(text.split(separator: "\n").enumerated()), id: \.offset) { index, line in
                        Text(String(line))
                            .font(index == 0 ? JieboFont.text(.footnote, weight: .semibold) : JieboFont.text(.caption))
                            .foregroundStyle(index == 0 ? JieboColor.ink : JieboColor.ink2)
                            .lineLimit(1)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(JieboColor.white)
                .transition(.opacity)
            case .loading:
                placeholder(note: nil)
                ThumbSkeleton()
            case .failed:
                placeholder(note: "暂时无法生成预览")
            case .none:
                placeholder(note: nil)
            }
        }
        .animation(JieboMotion.fade(reduceMotion), value: state)
    }

    private func placeholder(note: String?) -> some View {
        VStack(spacing: 6) {
            Image(systemName: TurnFileStyle.symbol(kind))
                .font(.system(.title, design: .default, weight: .light))
                .foregroundStyle(JieboColor.dim)
            if let note {
                Text(note)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// 缩略图加载中的骨架：等 0.3 秒还没出图才淡入，一道淡光从左扫到右（Core Animation 驱动，不逐帧重绘）；
/// 减少动态效果时只留静态浅色。
private struct ThumbSkeleton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false
    @State private var sweep = false

    var body: some View {
        GeometryReader { proxy in
            if reduceMotion {
                JieboColor.shimmer
            } else {
                LinearGradient(
                    colors: [Color.clear, JieboColor.shimmer, Color.clear],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(width: proxy.size.width * 0.5)
                .offset(x: sweep ? proxy.size.width : -proxy.size.width * 0.5)
            }
        }
        .opacity(visible ? 1 : 0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { visible = true }
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { sweep = true }
        }
    }
}

/// 紧凑行：图标 + 文件名 + 增删行数 + chevron
struct TurnFileRow: View {
    @Environment(ChatStore.self) private var store
    let file: TurnFile
    let turn: Turn
    let chatId: String
    var beforeOpen: (() -> Void)?

    init(file: TurnFile, turn: Turn, chatId: String, beforeOpen: (() -> Void)? = nil) {
        self.file = file
        self.turn = turn
        self.chatId = chatId
        self.beforeOpen = beforeOpen
    }

    private var hasCounts: Bool { file.added != nil || file.removed != nil }

    private func spokenValue(_ state: TurnFileState) -> String {
        var parts: [String] = []
        if let label = state.label { parts.append(label) }
        if hasCounts { parts.append("新增 \(file.added ?? 0) 行，删除 \(file.removed ?? 0) 行") }
        return parts.joined(separator: "，")
    }

    var body: some View {
        let state = TurnFileState(file: file, turn: turn, restoring: store.restoringTurnIds.contains(turn.id), localReview: store.localTurnReviews[turn.id])
        Button {
            beforeOpen?()
            store.openTurnFile(file, chatId: chatId)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: fileGlyph(file.path, isDir: false, open: false))
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
                    .frame(width: 16)
                Text(TurnFileStyle.filename(file))
                    .font(JieboFont.monoText(.footnote))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if hasCounts {
                    HStack(spacing: 4) {
                        Text("+\(file.added ?? 0)")
                            .foregroundStyle(JieboColor.ok)
                        Text("−\(file.removed ?? 0)")
                            .foregroundStyle(JieboColor.danger)
                    }
                    .font(JieboFont.monoText(.caption))
                    .lineLimit(1)
                    .fixedSize()
                }
                TurnFileTrailing(state: state)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle(enabled: state != .writing))
        .disabled(state == .writing)
        .accessibilityLabel(TurnFileStyle.filename(file))
        .accessibilityValue(spokenValue(state))
        .accessibilityHint("轻点两下打开预览")
        .modifier(TurnFileMenu(file: file, chatId: chatId, beforeOpen: beforeOpen))
    }
}

/// 右侧：有状态显示胶囊，否则 chevron
private struct TurnFileTrailing: View {
    let state: TurnFileState

    var body: some View {
        if let label = state.label {
            Group {
                if state == .writing {
                    // ShimmerText 在减少动态效果时自己退成静态字
                    ShimmerText(text: label, font: JieboFont.text(.caption, weight: .medium))
                } else {
                    Text(label)
                        .font(JieboFont.text(.caption, weight: .medium))
                        .foregroundStyle(state == .restored ? JieboColor.ink2 : JieboColor.run)
                }
            }
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(state == .restored ? JieboColor.well : JieboColor.runBg)
            .clipShape(Capsule())
            .fixedSize()
        } else {
            Image(systemName: "chevron.right")
                .font(JieboFont.text(.caption2, weight: .semibold))
                .foregroundStyle(JieboColor.dim)
                .accessibilityHidden(true)
        }
    }
}
