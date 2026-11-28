import SwiftUI

/// 工作区文件清单：搜索 + 点选把 @路径 写进草稿（对齐网页端的文件树面板）
struct FileBrowserSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.sceneSessionState) private var sceneSession
    @State private var filter = ""
    @State private var filtered: [String] = []
    @State private var filterTask: Task<Void, Never>?

    let chatId: String
    let onPick: (String) -> Void

    private var basePaths: [String] {
        store.mentionFilePool(for: chatId)
    }

    var body: some View {
        let palette = JieboTheme.shared.palette
        let appearance = JieboTheme.shared.appearance
        NavigationStack {
            List {
                ForEach(filtered, id: \.self) { path in
                    FileBrowserSheetRow(
                        chatId: chatId,
                        path: path,
                        palette: palette,
                        appearance: appearance,
                        onPick: {
                            onPick(path)
                            dismiss()
                        },
                        onPreview: {
                            store.openPreview(path, chatId: chatId)
                            sceneSession?.presentPreview(from: store)
                            dismiss()
                        }
                    )
                    .equatable()
                    .listRowBackground(JieboColor.white)
                }
                if filtered.isEmpty {
                    Text(store.fileIndexEmptyTitle(for: chatId) ?? (filter.trimmingCharacters(in: .whitespaces).isEmpty ? "没有文件列表" : "没有匹配的文件"))
                        .font(JieboFont.text(.subheadline))
                        .foregroundStyle(JieboColor.dim)
                        .listRowBackground(JieboColor.paper)
                }
                if store.treeTruncated {
                    Text("文件太多，清单被截断了，用搜索缩小范围。")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                        .listRowBackground(JieboColor.paper)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(JieboColor.paper)
            .searchable(text: $filter, prompt: "搜文件名或路径")
            .navigationTitle("文件")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .onAppear {
                store.requestFileIndex(chatId: chatId, userInitiated: true)
                refreshFiltered(immediate: true)
            }
            .onChange(of: basePaths) { _, _ in refreshFiltered(immediate: true) }
            .onChange(of: filter) { _, _ in refreshFiltered(immediate: false) }
            .onDisappear { filterTask?.cancel(); filterTask = nil }
        }
        .presentationDetents([.medium, .large])
    }

    private func refreshFiltered(immediate: Bool) {
        filterTask?.cancel()
        let pool = basePaths
        let q = filter.trimmingCharacters(in: .whitespaces)
        if q.isEmpty {
            filterTask = nil
            filtered = pool
            return
        }
        filterTask = Task { @MainActor in
            if !immediate {
                try? await Task.sleep(for: .milliseconds(120))
                guard !Task.isCancelled else { return }
            }
            if pool.count > 1000 {
                let ranked = await Task.detached(priority: .userInitiated) {
                    ChatStore.rankMentions(pool, query: q, limit: 500)
                }.value
                guard !Task.isCancelled else { return }
                filtered = ranked
            } else {
                filtered = ChatStore.rankMentions(pool, query: q, limit: 500)
            }
        }
    }
}

/// 单行文件引用项：Equatable 隔离避免筛选或输入期间未变行重复 diff，并用纯 Substring 替代 NSString 桥接。
private struct FileBrowserSheetRow: View, Equatable {
    /// 纳入判等以确保 chatId 变化时回调绑定到新会话。
    let chatId: String
    let path: String
    /// 供 Equatable 感知主题色盘与明暗外观切换，确保 JieboColor 及时重绘。
    let palette: JieboPalette
    let appearance: JieboAppearance
    let onPick: () -> Void
    let onPreview: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.chatId == rhs.chatId && lhs.path == rhs.path && lhs.palette == rhs.palette && lhs.appearance == rhs.appearance
    }

    private var fileName: Substring {
        var trimmed = path[...]
        while trimmed.count > 1, trimmed.last == "/" {
            trimmed = trimmed.dropLast()
        }
        if trimmed == "/" { return trimmed }
        guard let slash = trimmed.lastIndex(of: "/") else { return trimmed }
        return trimmed[trimmed.index(after: slash)...]
    }

    var body: some View {
        let name = fileName
        // 两个并列 Button，不嵌套——List 行里 Button 套 Button 的命中测试不可靠
        HStack(spacing: 4) {
            Button(action: onPick) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(JieboFont.text(.subheadline, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                    Text(path)
                        .font(JieboFont.monoText(.caption2))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("插入 \(name)")
            // 眼睛：直接预览（不进草稿）
            Button(action: onPreview) {
                Image(systemName: "eye")
                    .font(.system(size: 13))
                    .foregroundStyle(JieboColor.dim)
                    .frame(width: 32, height: 32)
                    .hitTarget()
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("预览 \(path)")
        }
    }
}
