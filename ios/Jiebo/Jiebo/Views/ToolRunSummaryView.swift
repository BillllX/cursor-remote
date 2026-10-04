import SwiftUI

/// 一轮里多个工具时收成一行摘要；展开后列出紧凑工具卡。
struct ToolRunSummaryView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var tools: [ToolCall]
    var turnRunning: Bool
    var durationMs: Double?
    @State private var detailOpen = false
    @State private var userPinned = false

    private var runningToolId: String? {
        tools.last(where: { $0.status == "running" })?.callId
    }

    private var summaryLine: String {
        let count = tools.count
        let head = "执行了 \(count) 个步骤"
        if turnRunning { return head }
        if let duration = formatDuration(durationMs).nilIfEmpty {
            return "\(head) · \(duration)"
        }
        return head
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(JieboMotion.snappy(reduceMotion)) {
                    detailOpen.toggle()
                    userPinned = true
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                        .rotationEffect(.degrees(detailOpen ? 90 : 0))
                    Text(summaryLine)
                        .font(JieboFont.ui(13, weight: .medium))
                        .foregroundStyle(JieboColor.ink2)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 4)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(detailOpen ? "收起工具步骤" : "展开工具步骤")

            if detailOpen {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(tools) { tool in
                        ToolCardView(
                            tool: tool,
                            compactPresentation: true,
                            showBorder: false,
                            forceExpanded: detailOpen && turnRunning && tool.callId == runningToolId
                        )
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { syncExpansion() }
        .onChange(of: turnRunning) { _, _ in syncExpansion() }
        .onChange(of: runningToolId) { _, _ in syncExpansion() }
    }

    private func syncExpansion() {
        guard !userPinned else { return }
        if turnRunning {
            detailOpen = true
        } else {
            detailOpen = false
        }
    }
}

extension ToolCardView {
    /// 摘要行与紧凑卡用的中文动词。
    static func chineseVerb(_ tool: ToolCall) -> String {
        let crew = Crew.label(name: tool.name, args: tool.args, agent: tool.agent)
        if !crew.isEmpty { return crew }
        switch tool.kind {
        case .shell: return "运行命令"
        case .search: return "搜索"
        case .edit: return "编辑"
        case .write: return "写入"
        case .read: return "读取"
        case .other:
            if tool.name.range(of: "task", options: .caseInsensitive) != nil { return "任务" }
            return tool.name.isEmpty ? "工具" : tool.name
        }
    }
}
