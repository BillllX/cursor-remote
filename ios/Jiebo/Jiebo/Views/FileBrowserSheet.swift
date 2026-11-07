import SwiftUI

/// 工作区文件清单：搜索 + 点选把 @路径 写进草稿（对齐网页端的文件树面板）
struct FileBrowserSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.sceneSessionState) private var sceneSession
    @State private var filter = ""

    let chatId: String
    let onPick: (String) -> Void

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
                    .listRowBackground(JieboColor.paper)
                }
                if filtered.isEmpty {
                    Text(store.fileIndexEmptyTitle ?? (filter.trimmingCharacters(in: .whitespaces).isEmpty ? "没有文件列表" : "没有匹配的文件"))
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
            .onAppear { store.requestFileIndex(chatId: chatId, userInitiated: true) }
        }
        .presentationDetents([.medium, .large])
    }

    private var filtered: [String] {
        let q = filter.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return store.fileIndex }
        return ChatStore.rankMentions(store.fileIndex, query: q, limit: 500)
    }
}
