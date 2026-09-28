import SwiftUI

struct ToolCardView: View {
    @Environment(ChatStore.self) private var store
    var tool: ToolCall
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                // 展开/收起做成独立 Button：容器挂 onTapGesture 会和内部按钮抢手势（P5a 页签同款坑）
                Button {
                    withAnimation(.easeOut(duration: 0.28)) {
                        expanded.toggle()
                    }
                } label: {
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
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? "收起工具结果" : "展开工具结果")
                // P5b：edit/write 工具给文件入口——按类型路由（diff 页签/原文页签/Quick Look）
                if Self.isImageTool(tool) || Self.imagePath(tool) != nil {
                    let imagePath = Self.imagePath(tool)
                    Button {
                        if let imagePath { store.openPreview(imagePath) }
                    } label: {
                        Label(imagePath == nil ? "正在生成图片" : "预览图片", systemImage: "photo")
                            .font(JieboFont.ui(12, weight: .medium))
                            .foregroundStyle(JieboColor.ink)
                            .padding(.horizontal, 8)
                            .frame(height: 26)
                            .background(JieboColor.mist)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(imagePath == nil)
                    .accessibilityLabel(imagePath == nil ? "正在生成图片" : "预览 \(imagePath ?? "")")
                } else if tool.kind.isMutating,
                   let path = ChatStore.toolPath(args: tool.args, result: tool.result),
                   !path.isEmpty
                {
                    Button {
                        store.openToolFile(path)
                    } label: {
                        Image(systemName: "plus.forwardslash.minus")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(JieboColor.brass)
                            .frame(width: 26, height: 26)
                            .background(JieboColor.brass.opacity(0.12))
                            .clipShape(Circle())
                            .hitTarget() // P6：视觉 26，命中 44
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("打开 \(path)")
                }
                badge
            }
            if expanded, let result = tool.result {
                let full = result.pretty(8_000)
                let shown = clip(full)
                ScrollView {
                    Text(shown)
                        .font(JieboFont.mono(12))
                        .foregroundStyle(JieboColor.ink)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240)
                if full.count > 2_000 {
                    Text("只显示前 2000 字，一共 \(full.count) 字")
                        .font(JieboFont.ui(11))
                        .foregroundStyle(JieboColor.dim)
                }
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
        .shadow(color: .black.opacity(0.04), radius: 8, y: 2)
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

    static func isImageTool(_ tool: ToolCall) -> Bool {
        let name = tool.name.lowercased()
        return name.contains("generateimage") || name.contains("generate_image") || name.contains("image_gen")
    }

    /// 生图工具，或结果路径本身就是图片。
    static func imagePath(_ tool: ToolCall) -> String? {
        guard let raw = ChatStore.toolPath(args: tool.args, result: tool.result)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty
        else { return nil }
        let kind = previewKind(of: raw)
        if isImageTool(tool) || kind == .image || kind == .svg { return raw }
        return nil
    }

    private func clip(_ text: String) -> String {
        if text.count <= 2_000 { return text }
        return String(text.prefix(2_000)) + "\n…"
    }
}
