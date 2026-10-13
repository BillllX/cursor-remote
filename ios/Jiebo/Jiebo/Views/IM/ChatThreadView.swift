import SwiftUI
import UIKit

struct ImViewerTarget: Identifiable, Hashable {
    var id: String
}

/// 和一个人的聊天页：标题是对方昵称，「…」看对方资料。
/// 进来停在最底下；在底部时新消息跟着滚，往上翻着的时候不打扰
struct ChatThreadView: View {
    @Environment(ImStore.self) private var im
    let peer: String
    @State private var atBottom = true
    @State private var profileOpen = false
    @State private var viewer: ImViewerTarget?
    @FocusState private var composerFocused: Bool

    private static let bottomId = "im-bottom"
    /// 相邻两条隔超过这么久，中间插一行时间
    private static let dividerGap: Double = 5 * 60_000

    private var convId: String { im.convId(with: peer) }

    var body: some View {
        let messages = im.visibleMessages(convId)
        let person = im.user(peer)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    olderHeader(hasMessages: !messages.isEmpty)
                    ForEach(Self.rows(messages)) { row in
                        rowView(row, person: person)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomId)
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onAppear {
                proxy.scrollTo(Self.bottomId, anchor: .bottom)
            }
            .onChange(of: messages.last?.id) { _, _ in
                let mineJustSent = messages.last.map { $0.from == im.meId && $0.seq == nil } ?? false
                guard atBottom || mineJustSent else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(Self.bottomId, anchor: .bottom)
                }
            }
            .onChange(of: messages.first?.id) { old, _ in
                // 往前翻了一页：停在原来最上面那条，别跳
                guard let old, !atBottom else { return }
                proxy.scrollTo(old, anchor: .top)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    if im.blocked.contains(peer) {
                        Text("你已拉黑对方，对方发来的消息不会送到你这里")
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.dim)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(JieboColor.sidebar)
                    }
                    ChatComposer(peer: peer, convId: convId, focused: $composerFocused) {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(Self.bottomId, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .background(JieboColor.paper)
        .navigationTitle(person.nickname)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    profileOpen = true
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("聊天信息")
            }
        }
        .sheet(isPresented: $profileOpen) {
            PeerProfileSheet(peer: peer)
        }
        .fullScreenCover(item: $viewer) { target in
            ImImageViewer(convId: convId, startId: target.id)
        }
        .onAppear { im.open(convId: convId) }
        .onDisappear { im.close(convId: convId) }
    }

    // MARK: 行

    private enum Row: Identifiable {
        case time(id: String, at: Double)
        case message(ImLocalMessage)

        var id: String {
            switch self {
            case .time(let id, _): return id
            case .message(let item): return item.id
            }
        }
    }

    private static func rows(_ messages: [ImLocalMessage]) -> [Row] {
        var out: [Row] = []
        var previous: Double?
        for item in messages {
            if previous.map({ item.at - $0 > dividerGap }) ?? true {
                out.append(.time(id: "time|\(item.id)", at: item.at))
            }
            previous = item.at
            out.append(.message(item))
        }
        return out
    }

    @ViewBuilder
    private func rowView(_ row: Row, person: ImUser) -> some View {
        switch row {
        case .time(_, let at):
            Text(ImFormat.dividerTime(at))
                .font(JieboFont.text(.caption2))
                .foregroundStyle(JieboColor.dim)
                .frame(maxWidth: .infinity)
                .padding(.top, 14)
                .padding(.bottom, 6)
        case .message(let item):
            if item.recalled {
                Text(item.from == im.meId ? "你撤回了一条消息" : "\(person.nickname) 撤回了一条消息")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            } else {
                ImBubbleRow(
                    message: item,
                    peer: person,
                    mine: item.from == im.meId,
                    quoted: quoted(item),
                    openImage: { viewer = ImViewerTarget(id: item.id) },
                    quote: {
                        if let seq = item.seq {
                            im.replyTo[item.convId] = seq
                            composerFocused = true
                        }
                    }
                )
                .padding(.vertical, 5)
            }
        }
    }

    private func quoted(_ item: ImLocalMessage) -> ImLocalMessage? {
        guard let seq = item.replyTo else { return nil }
        return im.timelines[item.convId]?.first { $0.seq == seq }
    }

    @ViewBuilder
    private func olderHeader(hasMessages: Bool) -> some View {
        if im.loadingOlder.contains(convId) || (im.loadingLatest.contains(convId) && !hasMessages) {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
        } else if im.olderMore[convId] == false {
            if hasMessages {
                Text("没有更早的消息了")
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            } else {
                Text("还没有消息，打个招呼吧")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            }
        } else {
            // 滚到顶露出来就拉更早的一页
            Color.clear
                .frame(height: 24)
                .onAppear { im.loadOlder(convId) }
        }
    }
}

// MARK: 气泡

struct ImBubbleRow: View {
    @Environment(ImStore.self) private var im
    let message: ImLocalMessage
    let peer: ImUser
    let mine: Bool
    let quoted: ImLocalMessage?
    var openImage: () -> Void
    var quote: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if mine {
                Spacer(minLength: 48)
                status
                    .frame(minHeight: 36)
                content
            } else {
                ImAvatar(user: peer, size: 36)
                content
                Spacer(minLength: 48)
            }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    private var content: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
            bubble
                .contextMenu { menu }
            if let quoted {
                quoteBlock(quoted)
            } else if message.replyTo != nil {
                quoteText("引用的消息不在本机")
            }
            if message.rejected {
                Text("消息已发出，但被对方拒收了")
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
            }
        }
    }

    @ViewBuilder
    private var status: some View {
        switch message.state {
        case .sending:
            if message.kind != "image" {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("正在发送")
            }
        case .failed:
            Button {
                im.resend(message)
            } label: {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(JieboColor.danger)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("发送失败，点一下重发")
        case .sent:
            EmptyView()
        }
    }

    @ViewBuilder
    private var bubble: some View {
        if message.kind == "image" {
            ImMessageImage(message: message)
                .onTapGesture(perform: openImage)
                .accessibilityLabel("图片")
                .accessibilityAddTraits(.isButton)
        } else {
            Text(bubbleText)
                .font(JieboFont.text(.body))
                .foregroundStyle(textColor)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(bubbleColor)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay {
                    if !mine {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    }
                }
                .frame(maxWidth: JieboMeasure.bubble, alignment: mine ? .trailing : .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var bubbleText: String {
        if case .text(let text)? = message.body { return text }
        return ImFormat.preview(kind: message.kind, body: message.body)
    }

    private var isPlainText: Bool {
        if case .text? = message.body { return true }
        return false
    }

    private var textColor: Color {
        guard isPlainText else { return mine ? JieboColor.fillFg.opacity(0.8) : JieboColor.dim }
        return mine ? JieboColor.fillFg : JieboColor.ink
    }

    private var bubbleColor: Color {
        mine ? JieboColor.pine : JieboColor.white
    }

    @ViewBuilder
    private var menu: some View {
        if isPlainText {
            Button {
                UIPasteboard.general.string = bubbleText
            } label: {
                Label("复制", systemImage: "doc.on.doc")
            }
        }
        if message.seq != nil {
            Button(action: quote) {
                Label("引用", systemImage: "quote.bubble")
            }
        }
        if im.canRecall(message) {
            Button {
                im.recall(message)
            } label: {
                Label("撤回", systemImage: "arrow.uturn.backward")
            }
        }
        Button(role: .destructive) {
            im.deleteLocally(message)
        } label: {
            Label("删除", systemImage: "trash")
        }
    }

    private func quoteBlock(_ target: ImLocalMessage) -> some View {
        let who = target.from == im.meId ? "我" : im.user(target.from).nickname
        let text = target.recalled ? "这条消息已撤回" : ImFormat.preview(kind: target.kind, body: target.body)
        return quoteText("\(who)：\(text)")
    }

    private func quoteText(_ text: String) -> some View {
        Text(text)
            .font(JieboFont.text(.caption))
            .foregroundStyle(JieboColor.ink2)
            .lineLimit(2)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(JieboColor.well)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .frame(maxWidth: JieboMeasure.bubble * 0.8, alignment: mine ? .trailing : .leading)
    }
}

// MARK: 图片消息

/// 缩略图；本机刚发的先显示 outbox 里的本地图，上传时盖一层进度
struct ImMessageImage: View {
    @Environment(ImStore.self) private var im
    @Environment(\.displayScale) private var displayScale
    let message: ImLocalMessage
    @State private var image: UIImage?

    private static let maxEdge: CGFloat = 200
    private static let minEdge: CGFloat = 80

    var body: some View {
        let size = displaySize
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                JieboColor.well
                Image(systemName: "photo")
                    .font(.system(size: 22, weight: .light))
                    .foregroundStyle(JieboColor.dim)
            }
            if message.state == .sending {
                Color.black.opacity(0.32)
                ImProgressRing(fraction: message.progress)
                    .frame(width: 34, height: 34)
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        }
        .task(id: loadKey) { await load() }
    }

    private var pixelSize: (w: Int, h: Int) {
        if case .image(_, _, let w, let h, _)? = message.body { return (w, h) }
        if let outgoing = message.outgoing { return (outgoing.w, outgoing.h) }
        return (0, 0)
    }

    private var displaySize: CGSize {
        let (w, h) = pixelSize
        guard w > 0, h > 0 else { return CGSize(width: 160, height: 160) }
        let scale = Self.maxEdge / CGFloat(max(w, h))
        let width = max(Self.minEdge, CGFloat(w) * scale)
        let height = max(Self.minEdge, CGFloat(h) * scale)
        return CGSize(width: min(width, Self.maxEdge), height: min(height, Self.maxEdge))
    }

    private var thumbBlob: String? {
        if case .image(_, let thumb, _, _, _)? = message.body { return thumb }
        return message.outgoing?.thumb
    }

    private var loadKey: String {
        "\(message.id)|\(thumbBlob ?? "")|\(im.tickets[message.convId]?.sig ?? "")"
    }

    @MainActor
    private func load() async {
        let pixel = Int(Self.maxEdge * displayScale)
        if let outgoing = message.outgoing, let dir = ImCache.outboxDir(tenant: im.tenant) {
            let file = dir.appendingPathComponent(outgoing.thumbFile)
            if FileManager.default.fileExists(atPath: file.path),
               let local = await ImImageCache.shared.local(file: file, maxPixel: pixel) {
                image = local
                return
            }
        }
        guard let thumb = thumbBlob else { return }
        if let hit = ImImageCache.shared.cached(thumb, maxPixel: pixel) {
            image = hit
            return
        }
        image = await ImImageCache.shared.image(
            blob: thumb, tenant: im.tenant, remote: im.mediaURL(convId: message.convId, blob: thumb), maxPixel: pixel
        )
    }
}

/// 上传进度圈；还不知道进度时转圈
struct ImProgressRing: View {
    var fraction: Double?

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.white.opacity(0.35), lineWidth: 3)
            if let fraction {
                Circle()
                    .trim(from: 0, to: max(0.02, fraction))
                    .stroke(Color.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            } else {
                ProgressView()
                    .tint(.white)
            }
        }
        .accessibilityLabel(fraction.map { "正在上传，\(Int($0 * 100))%" } ?? "正在上传")
    }
}
