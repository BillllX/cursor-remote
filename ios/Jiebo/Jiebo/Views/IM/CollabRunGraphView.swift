import SwiftUI

/// P3 只读运行图。任何审批、重试、取消仍由既有 Collab 安全边界处理，不在 iOS 绕开。
struct CollabRunGraphView: View {
    @Environment(ImStore.self) private var im
    @Environment(\.dismiss) private var dismiss
    let convId: String
    var embedded = false

    var body: some View {
        NavigationStack {
            Group {
                let runs = im.collabRuns[convId] ?? []
                if runs.isEmpty {
                    ContentUnavailableView(
                        "暂无协作运行",
                        systemImage: "point.3.connected.trianglepath.dotted",
                        description: Text(im.online ? "正在从网关同步运行图。" : "连接恢复后会自动同步。")
                    )
                } else {
                    List(runs) { run in
                        Section {
                            ForEach(run.tasks) { task in
                                VStack(alignment: .leading, spacing: 7) {
                                    HStack {
                                        Text(task.title)
                                            .font(JieboFont.text(.body, weight: .semibold))
                                        Spacer()
                                        Text(statusText(task.status))
                                            .font(JieboFont.text(.caption, weight: .semibold))
                                            .foregroundStyle(statusColor(task.status))
                                    }
                                    Text(task.workspaceId)
                                        .font(JieboFont.text(.caption))
                                        .foregroundStyle(JieboColor.dim)
                                    if let summary = task.summary, !summary.isEmpty {
                                        Text(summary)
                                            .font(JieboFont.text(.callout))
                                            .foregroundStyle(JieboColor.ink)
                                    }
                                    HStack(spacing: 12) {
                                        if task.attempt > 0 { Label("第 \(task.attempt) 次", systemImage: "arrow.clockwise") }
                                        if task.fileCount > 0 { Label("\(task.fileCount) 个文件", systemImage: "doc") }
                                        if task.needsApproval {
                                            Label("等待审批", systemImage: "checkmark.shield")
                                                .foregroundStyle(JieboColor.brass)
                                        }
                                    }
                                    .font(JieboFont.text(.caption))
                                    .foregroundStyle(JieboColor.dim)
                                }
                                .padding(.vertical, 4)
                            }
                        } header: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(run.summary?.nilIfEmpty ?? "协作运行")
                                Text("状态：\(statusText(run.status)) · 版本 \(run.version)")
                                    .font(JieboFont.text(.caption))
                                    .textCase(nil)
                            }
                        } footer: {
                            if run.partial {
                                Text("这是部分结果，网关仍在汇总。")
                            }
                        }
                    }
                }
            }
            .navigationTitle("协作运行图")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !embedded {
                        Button("关闭") { dismiss() }
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        im.syncCollab(convId: convId)
                    } label: {
                        Label("刷新", systemImage: "arrow.clockwise")
                    }
                    .disabled(!im.online)
                }
            }
            .onAppear {
                im.open(convId: convId)
                im.syncCollab(convId: convId)
            }
            .onDisappear { im.close(convId: convId) }
        }
    }

    private func statusText(_ status: String) -> String {
        switch status {
        case "planning": return "规划中"
        case "pending", "queued": return "等待中"
        case "running": return "运行中"
        case "awaiting", "needs_user": return "等待用户"
        case "blocked": return "已阻塞"
        case "aggregating", "publishing": return "汇总中"
        case "completed", "succeeded": return "已完成"
        case "failed": return "失败"
        case "cancelled": return "已取消"
        default: return "未知状态"
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "completed", "succeeded": return JieboColor.pine
        case "failed": return JieboColor.danger
        case "awaiting", "needs_user", "blocked": return JieboColor.brass
        default: return JieboColor.dim
        }
    }
}
