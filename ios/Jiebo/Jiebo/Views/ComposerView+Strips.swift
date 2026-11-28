import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

extension ComposerView {
    var pendingApproval: PendingTool? { chrome.pending }

    var queuedTurns: [Turn] { chrome.queued }

    func approvalBar(_ tool: PendingTool) -> some View {
        let path = tool.args?.string(in: "path", "file", "target_file", "file_path", "target") ?? ""
        let target = path.isEmpty ? tool.name : path
        return VStack(alignment: .leading, spacing: 8) {
            Text("要改文件：\(target)。允许会先还原再写；拒绝还原到发送前。")
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.ink)
            HStack(spacing: 8) {
                ActionButton(title: "拒绝", kind: .destructive) {
                    store.replyToApproval(allow: false, chatId: chatId)
                }
                ActionButton(title: "允许", kind: .primary) {
                    store.replyToApproval(allow: true, chatId: chatId)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.warnBg)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
    }

    var queueBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(queuedTurns) { turn in
                    HStack(spacing: 2) {
                        Image(systemName: "clock")
                            .font(JieboFont.text(.caption2, weight: .semibold))
                            .foregroundStyle(JieboColor.run)
                            .accessibilityHidden(true)
                        Text("排队 · \(String(turn.user.prefix(24)))")
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                            .padding(.leading, 4)
                        Button {
                            store.dropQueuedTurn(turn.id, chatId: chatId)
                        } label: {
                            Image(systemName: "xmark")
                                .font(JieboFont.text(.caption2, weight: .bold))
                                .foregroundStyle(JieboColor.ink2)
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("去掉这条排队")
                    }
                    .padding(.leading, 10)
                    .frame(minHeight: 44)
                    // 胶囊视觉 32 高，布局与热区 44
                    .background(
                        Capsule()
                            .fill(JieboColor.white)
                            .overlay(Capsule().stroke(JieboColor.line, lineWidth: 1))
                            .padding(.vertical, 6)
                    )
                }
            }
        }
    }

    /// @补全候选条（对齐网页端 mention 下拉，iOS 用横滑芯片；按当前 chatId 隔离展示）
    @ViewBuilder
    var mentionStrip: some View {
        let suggestions = store.mentionSuggestions(for: chatId)
        if !suggestions.isEmpty {
            // 同名文件消歧：纯 Substring 单遍统计 basename 次数，零 NSString 桥接与数组分配。
            let items = Self.mentionDisplayItems(suggestions)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(items, id: \.path) { item in
                        Button {
                            syncBufferToStore()
                            store.insertMention(item.path, chatId: chatId)
                        } label: {
                            Text("@\(item.label)")
                                .font(JieboFont.monoText(.caption))
                                .foregroundStyle(JieboColor.ink)
                                .lineLimit(1)
                                .padding(.horizontal, 10)
                                .frame(minHeight: 30)
                                .background(JieboColor.mist)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .hitTarget()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("引用 \(item.path)")
                    }
                }
                .padding(.horizontal, 2)
            }
            .transition(.jieboPanel(from: .top, reduceMotion: reduceMotion).combined(with: .opacity))
        }
    }

    private static func mentionDisplayItems(_ suggestions: [String]) -> [(path: String, label: String)] {
        var nameCounts: [Substring: Int] = [:]
        nameCounts.reserveCapacity(suggestions.count)
        for path in suggestions {
            let name = Self.lastPathSegment(path)
            nameCounts[name, default: 0] += 1
        }
        var result: [(path: String, label: String)] = []
        result.reserveCapacity(suggestions.count)
        for path in suggestions {
            let name = Self.lastPathSegment(path)
            if (nameCounts[name] ?? 0) > 1, let slash = path.lastIndex(of: "/") {
                let dir = path[..<slash]
                let parent = dir.lastIndex(of: "/").map { dir[dir.index(after: $0)...] } ?? dir
                let label = parent.isEmpty ? String(name) : "\(parent)/\(name)"
                result.append((path, label))
            } else {
                result.append((path, String(name)))
            }
        }
        return result
    }

    private static func lastPathSegment(_ path: String) -> Substring {
        var trimmed = path[...]
        while trimmed.count > 1, trimmed.last == "/" {
            trimmed = trimmed.dropLast()
        }
        if trimmed == "/" { return trimmed }
        guard let slash = trimmed.lastIndex(of: "/") else { return trimmed }
        return trimmed[trimmed.index(after: slash)...]
    }

    @ViewBuilder
    var attachmentStrip: some View {
        if !chatImages.isEmpty || !chatUploads.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 26) {
                    ForEach(chatImages) { image in
                        ZStack(alignment: .topTrailing) {
                            let data = image.data
                            Button {
                                viewerItem = AttachmentViewerItem(title: "待发送的图片", load: { data })
                            } label: {
                                AttachmentThumb(key: "pending|\(image.id.uuidString)", side: 56) { data }
                                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                            }
                            .buttonStyle(PressScaleButtonStyle())
                            .accessibilityLabel("待发送的图片")
                            .accessibilityHint("轻点两下查看大图")
                            Button {
                                store.removePendingImage(image.id, chatId: chatId)
                            } label: {
                                // 图标 20pt 压在右上角，命中框 44×44 以图片角为中心，不盖住图片中部（中部是看大图）
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 20))
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(JieboColor.paper, JieboColor.ink2)
                                    .frame(width: 44, height: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .offset(x: 22, y: -22)
                            .accessibilityLabel("移除图片")
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                store.removePendingImage(image.id, chatId: chatId)
                            } label: {
                                Label("移除图片", systemImage: "trash")
                            }
                        }
                    }
                    ForEach(chatUploads) { item in
                        HStack(spacing: 6) {
                            ProgressView()
                                .controlSize(.small)
                            Text(item.compressing ? "压缩中 · \(item.name)" : item.name)
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.ink2)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .frame(minHeight: 32)
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                    }
                }
                // 给右上角的移除按钮留出位置，不被滚动区裁掉
                .padding(.top, 22)
                .padding(.trailing, 22)
                .padding(.bottom, 2)
            }
            .transition(.jieboPanel(from: .top, reduceMotion: reduceMotion).combined(with: .opacity))
            .fullScreenCover(item: $viewerItem) { item in
                AttachmentViewer(item: item)
            }
        }
    }
}
