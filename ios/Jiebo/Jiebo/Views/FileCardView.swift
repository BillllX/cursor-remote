import SwiftUI

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

    /// 大卡的挑选顺序；nil = 只进紧凑行（代码文件和 binary）
    static func featuredRank(_ kind: PreviewKind) -> Int? {
        switch kind {
        case .html: return 0
        case .canvas: return 1
        case .image, .svg: return 2
        case .pdf: return 3
        case .markdown: return 4
        case .video: return 5
        case .audio: return 6
        case .text, .binary: return nil
        }
    }

    static func filename(_ file: TurnFile) -> String {
        (file.path as NSString).lastPathComponent
    }
}

/// 内联默认横条；轮末/有缩略图时用 featured 大卡。
/// 一轮文件审阅：与卡片是否渲染无关（内联卡片、无 card 的 delete 改动也要能保留/还原）
struct TurnReviewBar: View {
    @Environment(ChatStore.self) private var store
    let turn: Turn
    @State private var confirmRestore = false

    var body: some View {
        HStack(spacing: 8) {
            Text("\(turn.reviewPaths.count) 个文件改动")
                .font(JieboFont.ui(12))
                .foregroundStyle(JieboColor.ink2)
            Button("全部保留") { store.keepTurnFiles(turn.id) }
                .buttonStyle(.plain)
                .font(JieboFont.ui(12, weight: .semibold))
                .foregroundStyle(JieboColor.pine)
            Button(store.restoringTurnIds.contains(turn.id) ? "还原中" : "全部还原") { confirmRestore = true }
                .buttonStyle(.plain)
                .font(JieboFont.ui(12, weight: .medium))
                .foregroundStyle(JieboColor.ink2)
                .disabled(store.restoringTurnIds.contains(turn.id))
        }
        .confirmationDialog(
            "还原这一轮的 \(turn.reviewPaths.count) 个文件？",
            isPresented: $confirmRestore,
            titleVisibility: .visible
        ) {
            Button("全部还原", role: .destructive) { store.restoreTurnFiles(turn.id) }
            Button("取消", role: .cancel) {}
        }
    }
}

enum TurnFileCardLayout {
    case compact
    case featured
}

/// 一轮的文件卡片：大卡最多 2 张，其余紧凑行；紧凑行超过 3 行折叠
struct TurnFileCards: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let turn: Turn
    let chatId: String
    /// 打开前先做的事（委派详情是 sheet，预览层在它下面，要先收起）
    var beforeOpen: (() -> Void)?
    /// 只画这一组（卡片插在正文中间时按段分组）；nil 画整轮
    var files: [TurnFile]?
    var cardLayout: TurnFileCardLayout = .featured
    @State private var expanded = false

    private static let featuredLimit = 2
    private static let compactLimit = 3

    init(
        turn: Turn,
        chatId: String,
        files: [TurnFile]? = nil,
        cardLayout: TurnFileCardLayout = .featured,
        beforeOpen: (() -> Void)? = nil
    ) {
        self.turn = turn
        self.chatId = chatId
        self.files = files
        self.cardLayout = cardLayout
        self.beforeOpen = beforeOpen
    }

    /// 同类型取最后出现的那个。大卡按整轮挑，分组时只留落在本组的
    private var filePartition: (featured: [TurnFile], compact: [TurnFile]) {
        let all = turn.cardFiles
        var featured: [TurnFile] = []
        for rank in 0 ... 6 where featured.count < Self.featuredLimit {
            if let pick = all.last(where: { TurnFileStyle.featuredRank($0.kind) == rank }) {
                featured.append(pick)
            }
        }
        let picked = Set(featured.map(\.path))
        guard let files else {
            return (featured, all.filter { !picked.contains($0.path) })
        }
        let group = Set(files.map(\.path))
        return (featured.filter { group.contains($0.path) }, files.filter { !picked.contains($0.path) })
    }

    var body: some View {
        let parts = filePartition
        let folded = parts.compact.count > Self.compactLimit && !expanded
        let rows = folded ? Array(parts.compact.prefix(Self.compactLimit)) : parts.compact
        VStack(alignment: .leading, spacing: 8) {
            ForEach(parts.featured) { file in
                if cardLayout == .compact {
                    TurnFileStripCard(file: file, turn: turn, chatId: chatId, beforeOpen: beforeOpen)
                } else {
                    TurnFileLargeCard(file: file, turn: turn, chatId: chatId, beforeOpen: beforeOpen)
                }
            }
            if !rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, file in
                        if index > 0 {
                            Rectangle().fill(JieboColor.line).frame(height: 0.5)
                        }
                        TurnFileRow(file: file, turn: turn, chatId: chatId, beforeOpen: beforeOpen)
                    }
                    if parts.compact.count > Self.compactLimit {
                        Rectangle().fill(JieboColor.line).frame(height: 0.5)
                        moreButton(hidden: parts.compact.count - Self.compactLimit)
                    }
                }
                .background(JieboColor.white)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                )
            }
        }
        .frame(maxWidth: cardLayout == .compact ? .infinity : JieboMeasure.bubble, alignment: .leading)
    }

    private func moreButton(hidden: Int) -> some View {
        Button {
            withAnimation(JieboMotion.snappy(reduceMotion)) { expanded.toggle() }
        } label: {
            HStack(spacing: 6) {
                Text(expanded ? "收起" : "还有 \(hidden) 个文件")
                    .font(JieboFont.ui(12, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                    .rotationEffect(.degrees(expanded ? 180 : 0))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(expanded ? "收起文件列表" : "还有 \(hidden) 个文件")
        .accessibilityValue(expanded ? "已展开" : "已收起")
        .accessibilityHint(expanded ? "轻点两下收起" : "轻点两下展开")
    }
}

/// 内联用 64pt 横条：左侧小缩略图或图标，右侧文件名
struct TurnFileStripCard: View {
    @Environment(ChatStore.self) private var store
    let file: TurnFile
    let turn: Turn
    let chatId: String
    var beforeOpen: (() -> Void)?

    private func thumbTrigger(writing: Bool) -> String {
        let key = ThumbnailStore.shared.cacheKey(for: file, chatId: chatId, store: store).key
        return "\(key)|\(store.connected)|\(writing)"
    }

    private func requestThumb(writing: Bool) {
        guard !writing else { return }
        ThumbnailStore.shared.request(file: file, chatId: chatId, store: store)
    }

    var body: some View {
        let state = TurnFileState(file: file, turn: turn, restoring: store.restoringTurnIds.contains(turn.id), localReview: store.localTurnReviews[turn.id])
        let thumb = ThumbnailStore.shared.thumbnail(for: file, chatId: chatId, store: store)
        let writing = state == .writing
        Button {
            beforeOpen?()
            store.openTurnFile(file, chatId: chatId)
        } label: {
            HStack(spacing: 10) {
                stripThumb(thumb: thumb, kind: file.kind)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(TurnFileStyle.filename(file))
                        .font(JieboFont.ui(13, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(TurnFileStyle.label(file.kind))
                        .font(JieboFont.ui(11))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                TurnFileTrailing(state: state)
            }
            .padding(.horizontal, 10)
            .frame(height: 64)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle(enabled: state != .writing))
        .disabled(state == .writing)
        .onAppear { requestThumb(writing: writing) }
        .onChange(of: thumbTrigger(writing: writing)) { _, _ in requestThumb(writing: writing) }
        .onDisappear { ThumbnailStore.shared.cancel(file: file, chatId: chatId, store: store) }
    }

    @ViewBuilder
    private func stripThumb(thumb: ThumbState, kind: PreviewKind) -> some View {
        switch thumb {
        case .image(let image):
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        default:
            ZStack {
                JieboColor.mist.opacity(0.6)
                Image(systemName: TurnFileStyle.symbol(kind))
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(JieboColor.dim)
            }
        }
    }
}

/// 大卡：顶部一行文件名和状态，下面 16:10 的缩略图区（没有缩略图时是图标占位）
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

    private var caption: String {
        let kind = TurnFileStyle.label(file.kind)
        guard let size = file.size else { return kind }
        return "\(kind) · \(formatBytes(size))"
    }

    /// 键、连接、能力、写入状态任一变化都重新请求（同一键 ThumbnailStore 只会真正发一次）
    private func thumbTrigger(writing: Bool) -> String {
        let key = ThumbnailStore.shared.cacheKey(for: file, chatId: chatId, store: store).key
        return "\(key)|\(store.connected)|\(store.gatewayFeatures.contains("read_req_id"))|\(writing)"
    }

    private func requestThumb(writing: Bool) {
        // 正在写的文件内容不完整，等写完再截
        guard !writing else { return }
        ThumbnailStore.shared.request(file: file, chatId: chatId, store: store)
    }

    private func spokenValue(_ state: TurnFileState, thumb: ThumbState) -> String {
        let base = state.label ?? TurnFileStyle.label(file.kind)
        return thumb == .loading ? "\(base)，生成缩略图中" : base
    }

    var body: some View {
        let state = TurnFileState(file: file, turn: turn, restoring: store.restoringTurnIds.contains(turn.id), localReview: store.localTurnReviews[turn.id])
        let thumb = ThumbnailStore.shared.thumbnail(for: file, chatId: chatId, store: store)
        let writing = state == .writing
        Button {
            beforeOpen?()
            store.openTurnFile(file, chatId: chatId)
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: TurnFileStyle.symbol(file.kind))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(width: 16)
                    Text(TurnFileStyle.filename(file))
                        .font(JieboFont.ui(13, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    TurnFileTrailing(state: state)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                Rectangle().fill(JieboColor.line).frame(height: 0.5)
                Rectangle()
                    .fill(JieboColor.mist.opacity(0.5))
                    .aspectRatio(16.0 / 10.0, contentMode: .fit)
                    .overlay {
                        TurnFileThumbnail(state: thumb, kind: file.kind, caption: caption)
                    }
                    .clipped()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle(enabled: state != .writing))
        .disabled(state == .writing)
        .accessibilityLabel(TurnFileStyle.filename(file))
        .accessibilityValue(spokenValue(state, thumb: thumb))
        .accessibilityHint("轻点两下打开预览")
        .onAppear { requestThumb(writing: writing) }
        .onChange(of: thumbTrigger(writing: writing)) { _, _ in requestThumb(writing: writing) }
        // 滑出屏幕：还没发出的请求撤掉，下次出现再排
        .onDisappear { ThumbnailStore.shared.cancel(file: file, chatId: chatId, store: store) }
    }
}

/// 大卡的 16:10 区：缩略图 / markdown 前几行 / 加载骨架 / 图标占位
private struct TurnFileThumbnail: View {
    let state: ThumbState
    let kind: PreviewKind
    let caption: String

    /// 网页、画布、PDF 从顶部裁，其余居中
    private var alignment: Alignment {
        switch kind {
        case .html, .canvas, .pdf: return .top
        default: return .center
        }
    }

    var body: some View {
        switch state {
        case .image(let image):
            Color.clear
                .overlay(alignment: alignment) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                }
                .clipped()
        case .text(let text):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(text.split(separator: "\n").enumerated()), id: \.offset) { index, line in
                    Text(String(line))
                        .font(JieboFont.ui(index == 0 ? 12 : 11, weight: index == 0 ? .semibold : .regular))
                        .foregroundStyle(JieboColor.ink2)
                        .lineLimit(1)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(JieboColor.white)
            .clipped()
        case .loading:
            placeholder
                .overlay { ThumbSkeleton() }
        case .none, .failed:
            placeholder
        }
    }

    private var placeholder: some View {
        VStack(spacing: 6) {
            Image(systemName: TurnFileStyle.symbol(kind))
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(JieboColor.dim)
            Text(caption)
                .font(JieboFont.ui(11))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// 缩略图加载中的骨架：一道淡光从左扫到右；减少动态效果时静态
private struct ThumbSkeleton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                JieboColor.white.opacity(0.25)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                    let t = CGFloat(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6)
                    GeometryReader { proxy in
                        LinearGradient(
                            colors: [Color.clear, JieboColor.white.opacity(0.5), Color.clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: proxy.size.width * 0.5)
                        .offset(x: (t * 1.5 - 0.5) * proxy.size.width)
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
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
            HStack(spacing: 8) {
                Image(systemName: fileGlyph(file.path, isDir: false, open: false))
                    .font(.system(size: 12))
                    .foregroundStyle(JieboColor.dim)
                    .frame(width: 16)
                Text(TurnFileStyle.filename(file))
                    .font(JieboFont.mono(12))
                    .foregroundStyle(JieboColor.ink2)
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
                    .font(JieboFont.mono(11))
                    .lineLimit(1)
                    .fixedSize()
                }
                TurnFileTrailing(state: state)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle(enabled: state != .writing))
        .disabled(state == .writing)
        .accessibilityLabel(TurnFileStyle.filename(file))
        .accessibilityValue(spokenValue(state))
        .accessibilityHint("轻点两下打开预览")
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
                    ShimmerText(text: label, font: JieboFont.ui(11, weight: .medium))
                } else {
                    Text(label)
                        .font(JieboFont.ui(11, weight: .medium))
                        .foregroundStyle(state == .restored ? JieboColor.ink2 : JieboColor.run)
                }
            }
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(state == .restored ? JieboColor.mist : JieboColor.runBg)
            .clipShape(Capsule())
            .fixedSize()
        } else {
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(JieboColor.dim)
        }
    }
}
