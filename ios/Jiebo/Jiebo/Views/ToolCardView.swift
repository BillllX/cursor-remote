import SwiftUI

struct ToolCardView: View {
    var tool: ToolCall
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(tool.kind.label)
                    .font(JieboFont.mono(13))
                    .fontWeight(.medium)
                    .foregroundStyle(JieboColor.ink)
                // crew 徽章：子代理角色（摸仓库/改代码/交叉审）+ 模型（过 ModelCatalog 美化，对齐网页 modelLabel）
                let crew = Crew.label(name: tool.name, args: tool.args, agent: tool.agent)
                if !crew.isEmpty {
                    Text(crew + (tool.model?.nilIfEmpty.map { " · \(ModelCatalog.label(for: $0))" } ?? ""))
                        .font(JieboFont.ui(10, weight: .medium))
                        .foregroundStyle(JieboColor.brass)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(JieboColor.brass.opacity(0.14))
                        .clipShape(Capsule())
                }
                Text(tool.summary)
                    .font(JieboFont.mono(12))
                    .foregroundStyle(JieboColor.ink2)
                    .lineLimit(1)
                Spacer()
                badge
            }
            if expanded, let result = tool.result {
                Text(clip(result.pretty(4_000)))
                    .font(JieboFont.mono(11))
                    .foregroundStyle(JieboColor.ink2)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.easeOut(duration: 0.28)) {
                expanded.toggle()
            }
        }
    }

    /// 对齐 web 的 .tool-badge：右侧 999px 状态丸
    @ViewBuilder
    private var badge: some View {
        switch tool.status {
        case "running":
            badgeView("运行中", fg: JieboColor.run, bg: JieboColor.runBg)
        case "error":
            badgeView("出错", fg: JieboColor.danger, bg: JieboColor.dangerBg)
        default:
            badgeView("完成", fg: JieboColor.ok, bg: JieboColor.okBg)
        }
    }

    private func badgeView(_ text: String, fg: Color, bg: Color) -> some View {
        Text(text)
            .font(JieboFont.ui(11, weight: .medium))
            .foregroundStyle(fg)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(bg)
            .clipShape(Capsule())
    }

    private func clip(_ text: String) -> String {
        if text.count <= 2_000 { return text }
        return String(text.prefix(2_000)) + "\n…"
    }
}
