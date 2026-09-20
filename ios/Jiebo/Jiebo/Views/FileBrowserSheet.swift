import SwiftUI

/// 工作区文件清单：搜索 + 点选把 @路径 写进草稿（对齐网页端的文件树面板）
struct FileBrowserSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var filter = ""

    let onPick: (String) -> Void

    var body: some View {
        NavigationStack {
            List {
                ForEach(filtered, id: \.self) { path in
                    Button {
                        onPick(path)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text((path as NSString).lastPathComponent)
                                .font(JieboFont.ui(14, weight: .medium))
                                .foregroundStyle(JieboColor.ink)
                            Text(path)
                                .font(JieboFont.mono(11))
                                .foregroundStyle(JieboColor.dim)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .listRowBackground(Color.clear)
                }
                if store.treeTruncated {
                    Text("工作区文件太多，清单被截断了，用搜索缩小范围。")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                        .listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .searchable(text: $filter, prompt: "搜文件名或路径")
            .navigationTitle("工作区文件")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .onAppear { store.requestFileIndex() }
        }
        .presentationDetents([.medium, .large])
    }

    private var filtered: [String] {
        let q = filter.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return store.fileIndex }
        return ChatStore.rankMentions(store.fileIndex, query: q, limit: 500)
    }
}
