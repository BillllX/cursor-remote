import SwiftUI

struct ThreadView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        VStack(spacing: 0) {
            header
            if !store.notice.isEmpty {
                banner(store.notice, color: JieboColor.pine)
            }
            if !store.bannerError.isEmpty {
                banner(friendlyError(store.bannerError), color: JieboColor.danger)
            }
            thread
            ComposerView()
        }
        .background(JieboColor.paper.ignoresSafeArea())
    }

    private var header: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(store.active?.title ?? "新对话")
                    .font(JieboFont.display(26))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Text(store.hasApiKey ? store.mode.label : "服务器还没配 API Key")
                    .font(JieboFont.ui(13))
                    .foregroundStyle(store.hasApiKey ? JieboColor.dim : JieboColor.danger)
            }
            Spacer()
            if store.busy {
                ProgressView()
                    .tint(JieboColor.pine)
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 18)
        .padding(.bottom, 10)
    }

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if let chat = store.active, chat.turns.isEmpty {
                        emptyState
                    }
                    ForEach(store.active?.turns ?? []) { turn in
                        TurnView(turn: turn)
                            .id(turn.id)
                    }
                    Color.clear.frame(height: 1).id("thread-end")
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 12)
            }
            .onChange(of: store.active?.turns.last?.assistant) { _, _ in
                proxy.scrollTo("thread-end", anchor: .bottom)
            }
            .onChange(of: store.active?.turns.count) { _, _ in
                proxy.scrollTo("thread-end", anchor: .bottom)
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("对着远端工作区说话。")
                .font(JieboFont.display(28))
                .foregroundStyle(JieboColor.ink)
            Text("消息经东京站送到 gateway，Agent 在那台机器上改文件、跑命令。")
                .font(JieboFont.ui(16))
                .foregroundStyle(JieboColor.ink2)
        }
        .padding(.top, 48)
        .frame(maxWidth: 560, alignment: .leading)
    }

    private func banner(_ text: String, color: Color) -> some View {
        Text(text)
            .font(JieboFont.ui(13))
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.vertical, 8)
            .background(color.opacity(0.08))
    }
}

private struct TurnView: View {
    var turn: Turn

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !turn.user.isEmpty {
                HStack {
                    Spacer(minLength: 80)
                    Text(turn.user)
                        .font(JieboFont.ui(16))
                        .foregroundStyle(JieboColor.ink)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(JieboColor.userBubble)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                }
            }
            if !turn.thinking.isEmpty {
                DisclosureGroup("思考") {
                    Text(turn.thinking)
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(JieboFont.ui(13, weight: .medium))
                .foregroundStyle(JieboColor.dim)
                .tint(JieboColor.pine)
            }
            ForEach(turn.tools) { tool in
                ToolCardView(tool: tool)
            }
            if let pending = turn.pendingTool {
                ApprovalCard(tool: pending)
            }
            if !turn.assistant.isEmpty {
                Text(markdown(turn.assistant))
                    .font(JieboFont.ui(16))
                    .foregroundStyle(JieboColor.ink)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let task = turn.task, turn.running, turn.assistant.isEmpty {
                Text(task)
                    .font(JieboFont.ui(14))
                    .foregroundStyle(JieboColor.dim)
            }
            if let error = turn.error, !error.isEmpty {
                Text(friendlyError(error))
                    .font(JieboFont.ui(14))
                    .foregroundStyle(JieboColor.danger)
            }
            if let duration = formatDuration(turn.durationMs).nilIfEmpty, !turn.running {
                Text(duration)
                    .font(JieboFont.ui(11))
                    .foregroundStyle(JieboColor.dim)
            }
        }
    }

    private func markdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

private struct ApprovalCard: View {
    @Environment(ChatStore.self) private var store
    var tool: PendingTool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("允许 \(tool.name)？")
                .font(JieboFont.ui(15, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
            if let args = tool.args {
                Text(args.pretty(240))
                    .font(JieboFont.mono(12))
                    .foregroundStyle(JieboColor.ink2)
            }
            HStack(spacing: 10) {
                Button("允许") { store.replyToApproval(allow: true) }
                    .buttonStyle(.borderedProminent)
                Button("拒绝") { store.replyToApproval(allow: false) }
                    .buttonStyle(.bordered)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                .stroke(JieboColor.brass, lineWidth: 1)
        )
    }
}
