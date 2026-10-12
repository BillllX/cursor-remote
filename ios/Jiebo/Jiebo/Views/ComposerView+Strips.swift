import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

extension ComposerView {
    var pendingApproval: PendingTool? {
        store.active?.turns.reversed().first { $0.pendingTool != nil }?.pendingTool
    }

    var queuedTurns: [Turn] {
        store.active?.turns.filter(\.queued) ?? []
    }

    func approvalBar(_ tool: PendingTool) -> some View {
        let path = tool.args?.string(in: "path", "file", "target_file", "file_path", "target") ?? ""
        let target = path.isEmpty ? tool.name : path
        return VStack(alignment: .leading, spacing: 8) {
            Text("要改文件：\(target)。允许会先还原再写；拒绝还原到发送前。")
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.ink)
            HStack(spacing: 8) {
                Button("拒绝", role: .destructive) { store.replyToApproval(allow: false) }
                    .buttonStyle(.bordered)
                Button("允许") { store.replyToApproval(allow: true) }
                    .buttonStyle(.borderedProminent)
                    .tint(JieboColor.pine)
            }
            .font(JieboFont.text(.subheadline, weight: .semibold))
            .controlSize(.large)
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
                            store.dropQueuedTurn(turn.id)
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

    /// @补全候选条（对齐网页端 mention 下拉，iOS 用横滑芯片）
    @ViewBuilder
    var mentionStrip: some View {
        if !store.mentionSuggestions.isEmpty {
            // 同名文件消歧：basename 有重复时显示父目录
            let names = store.mentionSuggestions.map { ($0 as NSString).lastPathComponent }
            let duplicated = Set(Dictionary(grouping: names, by: { $0 }).filter { $0.value.count > 1 }.keys)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(store.mentionSuggestions, id: \.self) { path in
                        let name = (path as NSString).lastPathComponent
                        let label = duplicated.contains(name) && path.contains("/")
                            ? (path as NSString).deletingLastPathComponent.components(separatedBy: "/").last.map { "\($0)/\(name)" } ?? name
                            : name
                        Button {
                            store.insertMention(path)
                        } label: {
                            Text("@\(label)")
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
                        .accessibilityLabel("引用 \(path)")
                    }
                }
                .padding(.horizontal, 2)
            }
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    @ViewBuilder
    var attachmentStrip: some View {
        if !store.pendingImages.isEmpty || !store.uploads.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 26) {
                    ForEach(store.pendingImages) { image in
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
                                store.removePendingImage(image.id)
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
                                store.removePendingImage(image.id)
                            } label: {
                                Label("移除图片", systemImage: "trash")
                            }
                        }
                    }
                    ForEach(store.uploads) { item in
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
            .transition(.move(edge: .top).combined(with: .opacity))
            .fullScreenCover(item: $viewerItem) { item in
                AttachmentViewer(item: item)
            }
        }
    }
}
