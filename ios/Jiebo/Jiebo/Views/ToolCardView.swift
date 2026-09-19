import SwiftUI

struct ToolCardView: View {
    var tool: ToolCall
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(tool.kind.label)
                    .font(JieboFont.ui(11, weight: .semibold))
                    .foregroundStyle(JieboColor.pine)
                    .padding(.horizontal, 8)
                    .frame(height: 22)
                    .background(JieboColor.userBubble)
                    .clipShape(Capsule())
                Text(tool.summary)
                    .font(JieboFont.mono(12))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Spacer()
                if tool.status == "running" {
                    ProgressView()
                        .controlSize(.small)
                        .tint(JieboColor.pine)
                } else if tool.status == "error" {
                    Image(systemName: "exclamationmark.circle")
                        .foregroundStyle(JieboColor.danger)
                }
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
        .onTapGesture { expanded.toggle() }
    }

    private func clip(_ text: String) -> String {
        if text.count <= 2_000 { return text }
        return String(text.prefix(2_000)) + "\n…"
    }
}
