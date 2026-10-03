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

/// 一轮的文件卡片：大卡最多 2 张，其余紧凑行；紧凑行超过 3 行折叠
struct TurnFileCards: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let turn: Turn
    let chatId: String
    /// 打开前先做的事（委派详情是 sheet，预览层在它下面，要先收起）
    var beforeOpen: (() -> Void)?
    @State private var expanded = false

    private static let featuredLimit = 2
    private static let compactLimit = 3

    init(turn: Turn, chatId: String, beforeOpen: (() -> Void)? = nil) {
        self.turn = turn
        self.chatId = chatId
        self.beforeOpen = beforeOpen
    }

    /// 同类型取最后出现的那个
    private var layout: (featured: [TurnFile], compact: [TurnFile]) {
        let files = turn.cardFiles
        var featured: [TurnFile] = []
        for rank in 0 ... 6 where featured.count < Self.featuredLimit {
            if let pick = files.last(where: { TurnFileStyle.featuredRank($0.kind) == rank }) {
                featured.append(pick)
            }
        }
        let picked = Set(featured.map(\.path))
        return (featured, files.filter { !picked.contains($0.path) })
    }

    var body: some View {
        let parts = layout
        let folded = parts.compact.count > Self.compactLimit && !expanded
        let rows = folded ? Array(parts.compact.prefix(Self.compactLimit)) : parts.compact
        VStack(alignment: .leading, spacing: 8) {
            ForEach(parts.featured) { file in
                TurnFileLargeCard(file: file, turn: turn, chatId: chatId, beforeOpen: beforeOpen)
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
        .frame(maxWidth: JieboMeasure.bubble, alignment: .leading)
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

/// 大卡：顶部一行文件名和状态，下面 16:10 的占位区（缩略图以后做）
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

    var body: some View {
        let state = TurnFileState(file: file, turn: turn, restoring: store.restoringTurnIds.contains(turn.id), localReview: store.localTurnReviews[turn.id])
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
                        VStack(spacing: 6) {
                            Image(systemName: TurnFileStyle.symbol(file.kind))
                                .font(.system(size: 28, weight: .light))
                                .foregroundStyle(JieboColor.dim)
                            Text(caption)
                                .font(JieboFont.ui(11))
                                .foregroundStyle(JieboColor.dim)
                                .lineLimit(1)
                        }
                    }
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
        .accessibilityValue(state.label ?? TurnFileStyle.label(file.kind))
        .accessibilityHint("轻点两下打开预览")
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
