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
        if turnRunning {
            // 跑的时候说清楚正在做哪一步
            if let index = tools.lastIndex(where: { $0.status == "running" }) {
                return "第 \(index + 1) 步 · \(ToolCardView.chineseVerb(tools[index]))"
            }
            return "已执行 \(count) 个步骤"
        }
        let failed = tools.filter { $0.status == "error" }.count
        let head = failed > 0 ? "执行了 \(count) 个步骤，\(failed) 个失败" : "执行了 \(count) 个步骤"
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
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                        .rotationEffect(.degrees(detailOpen ? 90 : 0))
                    if turnRunning {
                        ShimmerText(text: summaryLine, font: JieboFont.text(.footnote, weight: .medium))
                    } else {
                        Text(summaryLine)
                            .font(JieboFont.text(.footnote, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summaryLine)
            .accessibilityValue(detailOpen ? "已展开" : "已收起")
            .accessibilityHint(detailOpen ? "轻点两下收起步骤" : "轻点两下展开步骤")

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
            if tool.name.range(of: "task", options: .caseInsensitive) != nil { return "子任务" }
            if isImageTool(tool) { return "生成图片" }
            return "调用工具"
        }
    }

    /// 动词是兜底的「调用工具」：卡片标题行补上原始工具名
    static func isGeneric(_ tool: ToolCall) -> Bool {
        Crew.label(name: tool.name, args: tool.args, agent: tool.agent).isEmpty
            && tool.kind == .other
            && tool.name.range(of: "task", options: .caseInsensitive) == nil
            && !isImageTool(tool)
    }
}
