import SwiftUI

/// 一轮里多个工具时收成一行摘要；展开后列出紧凑工具卡。
struct ToolRunSummaryView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var tools: [ToolCall]
    var turnRunning: Bool
    var durationMs: Double?
    @State private var detailOpen = false

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
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(turnRunning ? JieboColor.run : JieboColor.ink2)
                        .rotationEffect(.degrees(detailOpen ? 90 : 0))
                    if turnRunning, runningToolId != nil {
                        ShimmerText(text: summaryLine, font: JieboFont.text(.footnote, weight: .medium))
                            .lineLimit(2)
                    } else {
                        Text(summaryLine)
                            .font(JieboFont.text(.footnote, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    if turnRunning {
                        Text("进行中")
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.run)
                            .fixedSize()
                    }
                }
                .padding(.horizontal, 8)
                .frame(minHeight: 44)
                .background(turnRunning ? JieboColor.runBg : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summaryLine)
            .accessibilityValue((turnRunning ? "进行中，" : "") + (detailOpen ? "已展开" : "已收起"))
            .accessibilityHint(detailOpen ? "轻点两下收起步骤" : "轻点两下展开步骤")

            if detailOpen {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(tools) { tool in
                        ToolCardView(
                            tool: tool,
                            compactPresentation: true,
                            showBorder: false
                        )
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(JieboMotion.fade(reduceMotion), value: turnRunning)
    }
}

extension ToolCardView {
    /// 摘要行与紧凑卡用的中文动词。
    static func chineseVerb(_ tool: ToolCall) -> String {
        let crew = Crew.label(name: tool.name, args: tool.args, agent: tool.agent)
        if !crew.isEmpty { return crew }
        switch AssistantToolText.baseName(tool.name) {
        case "skill_use": return "查阅技能"
        case "skill_propose": return "提议新技能"
        case "skill_list": return "查询技能库"
        case "skill_verify": return "核验技能"
        case "skill_proposal_decide": return "审批技能"
        case "skill_proposal_list": return "技能提案列表"
        case "workspace_memory_propose": return "记录工作区记忆"
        case "kb_ingest_submit": return "归档知识库"
        case "wecom_search": return "检索企微"
        case "wecom_watch_check": return "检查企微关注项"
        case "wecom_watch_sync": return "同步企微归档"
        case "wecom_watch_manage": return "企微关注清单"
        case "workspace_schedule_manage": return "管理定时任务"
        case "delegate": return "委派工作区"
        case "create_workspace": return "申请新建工作区"
        case "web_read": return "读取网页"
        default: break
        }
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
            && !AssistantToolText.isSkillTool(tool.name)
            && tool.kind == .other
            && tool.name.range(of: "task", options: .caseInsensitive) == nil
            && !isImageTool(tool)
            && chineseVerb(tool) == "调用工具"
    }
}
