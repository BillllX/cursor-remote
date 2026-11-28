import SwiftUI

/// 列表底部通用分页控件（兼容 List Section 与 ScrollView/LazyVStack，不触发 List Section 内嵌 LazyVStack 塌缩）。
struct PaginationLoadMoreRow: View {
    let hasMore: Bool
    var loading: Bool = false
    var loadedCount: Int? = nil
    var totalCount: Int? = nil
    var label: String = "加载更多"
    var autoLoad: Bool = true
    let onLoadMore: () -> Void

    var body: some View {
        if hasMore || loading {
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if loading {
                    ProgressView()
                        .controlSize(.small)
                    Text("正在加载…")
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.dim)
                } else {
                    Button(action: onLoadMore) {
                        HStack(spacing: 6) {
                            Text(label)
                                .font(JieboFont.text(.footnote, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                            if let summary = countSummary {
                                Text(summary)
                                    .font(JieboFont.text(.caption))
                                    .foregroundStyle(JieboColor.dim)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(JieboColor.paper, in: Capsule())
                        .overlay(Capsule().strokeBorder(JieboColor.line, lineWidth: 0.75))
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 8)
            .onAppear {
                if autoLoad, hasMore, !loading {
                    onLoadMore()
                }
            }
        }
    }

    private var countSummary: String? {
        guard let loadedCount else { return nil }
        if let totalCount, totalCount > 0 {
            return "\(loadedCount)/\(totalCount)"
        }
        return loadedCount > 0 ? "已加载 \(loadedCount)" : nil
    }
}

/// 列表顶部通用向上加载更早历史控件。
struct PaginationLoadEarlierHeader: View {
    let hasMore: Bool
    var loading: Bool = false
    var label: String = "加载更早记录"
    let onLoadMore: () -> Void

    var body: some View {
        if hasMore || loading {
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if loading {
                    ProgressView()
                        .controlSize(.small)
                    Text("正在加载…")
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.dim)
                } else {
                    Button(action: onLoadMore) {
                        Text(label)
                            .font(JieboFont.text(.footnote, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(JieboColor.paper, in: Capsule())
                            .overlay(Capsule().strokeBorder(JieboColor.line, lineWidth: 0.75))
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
        }
    }
}
