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
        NavigationStack {
            List {
                ForEach(filtered, id: \.self) { path in
                    // 两个并列 Button，不嵌套——List 行里 Button 套 Button 的命中测试不可靠
                    HStack(spacing: 4) {
                        Button {
                            onPick(path)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text((path as NSString).lastPathComponent)
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
                        .accessibilityLabel("插入 \((path as NSString).lastPathComponent)")
                        // 眼睛：直接预览（不进草稿）
                        Button {
                            store.openPreview(path, chatId: chatId)
                            sceneSession?.presentPreview(from: store)
                            dismiss()
                        } label: {
                            Image(systemName: "eye")
                                .font(.system(size: 13))
                                .foregroundStyle(JieboColor.dim)
                                .frame(width: 32, height: 32)
                                .hitTarget()
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("预览 \(path)")
                    }
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
