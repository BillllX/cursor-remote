import SwiftUI
import UIKit

/// 聊天主页：列表 → 聊天页，只有两层。手机和 iPad 窄窗用导航栈，iPad 宽窗左右分栏。
/// 打开哪个会话只看 im.selectedPeer，导航栈的路径和分栏的右边都从它来
struct ChatHome: View {
    @Environment(ImStore.self) private var im
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var settingsOpen = false

    private var split: Bool {
        UIDevice.current.userInterfaceIdiom == .pad && sizeClass == .regular
    }

    var body: some View {
        Group {
            if split {
                splitLayout
            } else {
                stackLayout
            }
        }
        .background(JieboColor.paper)
        .overlay(alignment: .top) {
            ImToast(text: im.toast)
        }
        .sheet(isPresented: $settingsOpen) {
            ChatSettingsSheet()
        }
    }

    private var path: Binding<[String]> {
        Binding(
            get: { im.selectedPeer.map { [$0] } ?? [] },
            set: { im.selectedPeer = $0.last }
        )
    }

    private var stackLayout: some View {
        NavigationStack(path: path) {
            ChatListView(openSettings: { settingsOpen = true })
                .navigationDestination(for: String.self) { peer in
                    ChatThreadView(peer: peer)
                }
        }
    }

    private var splitLayout: some View {
        NavigationSplitView {
            ChatListView(openSettings: { settingsOpen = true })
                .navigationSplitViewColumnWidth(min: 280, ideal: 330, max: 420)
        } detail: {
            if let peer = im.selectedPeer {
                NavigationStack {
                    ChatThreadView(peer: peer)
                }
                .id(peer)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(JieboColor.dim)
                    Text("选一个人开始聊天")
                        .font(JieboFont.text(.callout))
                        .foregroundStyle(JieboColor.dim)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(JieboColor.paper)
            }
        }
        .navigationSplitViewStyle(.balanced)
    }
}

// MARK: 列表

struct ChatListView: View {
    @Environment(ImStore.self) private var im
    @Environment(ChatStore.self) private var store
    var openSettings: () -> Void
    @State private var query = ""

    var body: some View {
        let rows = im.directory(query: query)
        List {
            if !rows.chatted.isEmpty {
                Section {
                    ForEach(rows.chatted) { row in
                        conversationRow(row)
                    }
                }
            }
            if !rows.others.isEmpty {
                Section {
                    ForEach(rows.others) { row in
                        contactRow(row)
                    }
                } header: {
                    Text(rows.chatted.isEmpty ? "平台上的人" : "还没聊过")
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .overlay {
            if rows.chatted.isEmpty, rows.others.isEmpty {
                emptyState
            }
        }
        .searchable(text: $query, prompt: "搜昵称或拼音首字母")
        .refreshable { await im.refreshList() }
        .navigationTitle("聊天")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: openSettings) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                }
                .accessibilityLabel("聊天设置")
            }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text("聊天")
                        .font(JieboFont.text(.headline))
                        .foregroundStyle(JieboColor.ink)
                    if !im.online {
                        Text(store.connected ? "服务器没开聊天功能" : "正在连接…")
                            .font(JieboFont.text(.caption2))
                            .foregroundStyle(JieboColor.dim)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    // MARK: 行

    private func conversationRow(_ row: ImDirectoryRow) -> some View {
        let conv = row.conv
        let selected = im.selectedPeer == row.user.id
        return Button {
            im.selectedPeer = row.user.id
        } label: {
            HStack(spacing: 12) {
                ImAvatar(user: row.user, size: 48)
                    .overlay(alignment: .topTrailing) {
                        unreadMark(conv)
                            .offset(x: 6, y: -6)
                    }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(row.user.nickname)
                            .font(JieboFont.text(.body, weight: .medium))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(ImFormat.listTime(im.lastActivity(conv)))
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.dim)
                    }
                    HStack(spacing: 6) {
                        previewLine(conv, peer: row.user)
                            .font(JieboFont.text(.subheadline))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        if conv?.mute == true {
                            Image(systemName: "bell.slash")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.dim)
                        }
                    }
                }
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(selected ? JieboColor.mist : (conv?.pin == true ? JieboColor.sidebar : JieboColor.paper))
        .accessibilityLabel(rowAccessibility(row))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let conv {
                if im.canChangeSettings {
                    Button(role: .destructive) {
                        im.clearHistory(conv.convId)
                    } label: {
                        Label("删除", systemImage: "trash")
                    }
                    Button {
                        im.setPin(conv.convId, !conv.pin)
                    } label: {
                        Label(conv.pin ? "取消置顶" : "置顶", systemImage: conv.pin ? "pin.slash" : "pin")
                    }
                    .tint(JieboColor.brass)
                } else {
                    // 断线时删除、置顶发不出去：不给按钮，只告诉为什么
                    Button {
                        im.showToast("未连接，连上服务器后再试")
                    } label: {
                        Label("未连接", systemImage: "wifi.slash")
                    }
                    .tint(JieboColor.dim)
                }
            }
        }
    }

    private func contactRow(_ row: ImDirectoryRow) -> some View {
        Button {
            im.selectedPeer = row.user.id
        } label: {
            HStack(spacing: 12) {
                ImAvatar(user: row.user, size: 40)
                Text(row.user.nickname)
                    .font(JieboFont.text(.body))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(im.selectedPeer == row.user.id ? JieboColor.mist : JieboColor.paper)
        .accessibilityLabel(row.user.nickname)
    }

    @ViewBuilder
    private func unreadMark(_ conv: ImConvRow?) -> some View {
        if let conv, conv.unread > 0 {
            if conv.mute {
                Circle()
                    .fill(JieboColor.danger)
                    .frame(width: 10, height: 10)
                    .accessibilityHidden(true)
            } else {
                ImUnreadBadge(count: conv.unread)
            }
        }
    }

    /// 草稿优先（红色「[草稿]」）；再看最后一条（含本机还没发出去的）
    private func previewLine(_ conv: ImConvRow?, peer: ImUser) -> Text {
        guard let conv else { return Text("") }
        if im.selectedPeer != peer.id, let draft = im.drafts[conv.convId]?.trimmingCharacters(in: .whitespacesAndNewlines), !draft.isEmpty {
            return Text("[草稿] ").foregroundStyle(JieboColor.danger)
                + Text(draft.replacingOccurrences(of: "\n", with: " ")).foregroundStyle(JieboColor.dim)
        }
        let pending = im.timelines[conv.convId]?.last(where: { $0.seq == nil })
        let latest: ImLocalMessage?
        if let pending, pending.at >= (conv.last?.at ?? 0) {
            latest = pending
        } else {
            latest = conv.last.map(ImLocalMessage.init)
        }
        guard let latest else { return Text("") }
        if latest.recalled {
            let who = latest.from == im.meId ? "你" : peer.nickname
            return Text("\(who)撤回了一条消息").foregroundStyle(JieboColor.dim)
        }
        var text = ImFormat.preview(kind: latest.kind, body: latest.body)
        if latest.kind == "image", latest.body == nil { text = "[图片]" }
        if conv.mute, conv.unread > 1 { text = "[\(ImFormat.badge(conv.unread))条] " + text }
        if latest.state == .failed {
            return Text("[发送失败] ").foregroundStyle(JieboColor.danger) + Text(text).foregroundStyle(JieboColor.dim)
        }
        return Text(text).foregroundStyle(JieboColor.dim)
    }

    private func rowAccessibility(_ row: ImDirectoryRow) -> String {
        var parts = [row.user.nickname]
        if let conv = row.conv {
            if conv.pin { parts.append("置顶") }
            if conv.unread > 0 { parts.append("\(conv.unread) 条未读") }
            if conv.mute { parts.append("消息免打扰") }
            if let last = conv.last, !last.recalled { parts.append(ImFormat.preview(kind: last.kind, body: last.body)) }
        }
        return parts.joined(separator: "，")
    }

    @ViewBuilder
    private var emptyState: some View {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(spacing: 10) {
            Image(systemName: trimmed.isEmpty ? "person.2" : "magnifyingglass")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(JieboColor.dim)
            if !trimmed.isEmpty {
                Text("没找到「\(trimmed)」")
                    .font(JieboFont.text(.callout))
                    .foregroundStyle(JieboColor.ink2)
            } else if !im.contactsLoaded {
                Text(im.online ? "正在加载…" : "连上服务器后，这里会列出平台上的人")
                    .font(JieboFont.text(.callout))
                    .foregroundStyle(JieboColor.ink2)
                    .multilineTextAlignment(.center)
            } else {
                Text("平台上还没有别人")
                    .font(JieboFont.text(.callout, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                Text("等有人加入，就能在这里找到他们、发消息")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: 头像

/// 有头像画头像，没有就用昵称第一个字当占位
struct ImAvatar: View {
    @Environment(ImStore.self) private var im
    @Environment(\.displayScale) private var displayScale
    var user: ImUser
    var size: CGFloat
    @State private var image: UIImage?

    private static let tints: [Color] = [JieboColor.pine, JieboColor.brass, JieboColor.clay, JieboColor.okSoft, JieboColor.run]

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Self.tint(for: user.id)
                Text(initial)
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .accessibilityHidden(true)
        .task(id: taskKey) { await load() }
    }

    private var initial: String {
        let trimmed = user.nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.first.map { String($0).uppercased() } ?? "?"
    }

    private var pixel: Int { Int(size * displayScale) }

    private var taskKey: String {
        "\(user.avatar ?? "")|\(im.avatarTicket?.sig ?? "")"
    }

    static func tint(for id: String) -> Color {
        let sum = id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return tints[sum % tints.count]
    }

    @MainActor
    private func load() async {
        guard let blob = user.avatar else {
            image = nil
            return
        }
        if let hit = ImImageCache.shared.cached(blob, maxPixel: pixel) {
            image = hit
            return
        }
        image = await ImImageCache.shared.image(blob: blob, tenant: im.tenant, remote: im.avatarURL(blob), maxPixel: pixel)
    }
}

// MARK: 轻提示

struct ImToast: View {
    var text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if !text.isEmpty {
                Text(text)
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(JieboColor.white)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(JieboColor.line, lineWidth: 1))
                    .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .animation(JieboMotion.fade(reduceMotion), value: text)
        .allowsHitTesting(false)
    }
}
