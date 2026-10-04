import SwiftUI

/// 委派详情（规格 §4.4）：只读。没有输入框，没有「继续聊」；文件只能从卡片打开预览。
/// 子会话只从 store.chats 里按 id 取来只读渲染，绝不 select（iPhone 的 activeId 永远是助理）。
struct DelegationDetailSheet: View {
    let delegationId: String

    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var stopConfirm = false
    @State private var stopping = false

    /// 过程区最多显示的步骤数
    private static let processLimit = 30

    init(delegationId: String) {
        self.delegationId = delegationId
    }

    private var delegation: AssistantDelegation? {
        store.assistantState?.delegations.first(where: { $0.id == delegationId })
    }

    /// 子会话（本机没同步到时为 nil）
    private var childChat: ChatSession? {
        guard let childId = delegation?.childChatId, !childId.isEmpty else { return nil }
        return store.chats.first(where: { $0.id == childId })
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let row = delegation {
                        content(row)
                    } else {
                        AssistantMutedText("这项委派已不存在")
                            .padding(.top, 24)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(JieboColor.paper)
            .phoneNotice()
            .navigationTitle("委派")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .confirmationDialog("停止这项委派？", isPresented: $stopConfirm, titleVisibility: .visible) {
            Button("停止", role: .destructive) { stop() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("停掉后已经改过的文件不会自动还原")
        }
        .onAppear { loadProcess() }
        .onChange(of: childChat != nil) { _, hasChat in
            if hasChat { loadProcess() }
        }
        .onChange(of: delegation?.status) { _, status in
            if status != "running" && status != "awaiting" { stopping = false }
        }
    }

    // MARK: 内容

    @ViewBuilder
    private func content(_ row: AssistantDelegation) -> some View {
        let approvals = (store.assistantState?.approvals ?? []).filter { $0.delegationId == row.id }
        header(row)
        if row.status == "awaiting", !approvals.isEmpty {
            VStack(spacing: 8) {
                ForEach(approvals) { approval in
                    ApprovalCard(approval: approval)
                }
            }
        }
        if row.status == "done" || row.status == "failed", let result = row.result {
            AssistantSection("汇报") {
                Text(result)
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(JieboColor.ink)
                    .textSelection(.enabled)
                    .assistantCard()
            }
        }
        processSection
        filesSection
        stopSection(row)
        Text("完整过程在电脑或 iPad 上查看")
            .font(JieboFont.text(.caption))
            .foregroundStyle(JieboColor.dim)
    }

    private func header(_ row: AssistantDelegation) -> some View {
        let colors = row.statusColors
        return VStack(alignment: .leading, spacing: 8) {
            Text(row.title.nilIfEmpty ?? "委派")
                .font(JieboFont.display(18))
                .foregroundStyle(JieboColor.ink)
                .fixedSize(horizontal: false, vertical: true)
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(metaLine(row, now: context.date))
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
            }
            HStack(spacing: 5) {
                Circle()
                    .fill(colors.fg)
                    .frame(width: 6, height: 6)
                Text(row.statusLabel)
                    .font(JieboFont.text(.caption, weight: .medium))
                    .foregroundStyle(colors.fg)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(colors.bg)
            .clipShape(Capsule())
        }
    }

    /// 「notes · 后台 · 已用时 3 分钟」
    private func metaLine(_ row: AssistantDelegation, now: Date) -> String {
        var parts: [String] = []
        let workspace = workspaceName(row.workspace)
        if !workspace.isEmpty { parts.append(workspace) }
        parts.append(row.mode == "foreground" ? "前台" : "后台")
        let endSeconds: Double = row.endedAt.map { $0 / 1000 } ?? now.timeIntervalSince1970
        let minutes = max(0, Int((endSeconds - row.createdAt / 1000) / 60))
        let spent: String
        if minutes < 1 {
            spent = "不到 1 分钟"
        } else if minutes < 60 {
            spent = "\(minutes) 分钟"
        } else {
            spent = "\(minutes / 60) 小时 \(minutes % 60) 分钟"
        }
        parts.append((row.endedAt == nil ? "已用时 " : "用时 ") + spent)
        return parts.joined(separator: " · ")
    }

    // MARK: 过程（只读）

    private var processSection: some View {
        AssistantSection("过程") {
            if let chat = childChat {
                let tools = chat.turns.last?.tools ?? []
                if tools.isEmpty {
                    AssistantMutedText(chat.turnsComplete ? "还没有步骤。" : "正在加载过程…")
                } else {
                    processRows(tools)
                }
            } else {
                AssistantMutedText("过程在电脑上查看")
            }
        }
    }

    /// 子会话最后一轮的文件。按子会话 id 读（它的工作区），先收起 sheet：预览层和 Quick Look 都在 sheet 下面
    @ViewBuilder
    private var filesSection: some View {
        if let chat = childChat, let turn = chat.turns.last, !turn.cardFiles.isEmpty {
            AssistantSection("文件") {
                TurnFileCards(turn: turn, chatId: chat.id, beforeOpen: { dismiss() })
            }
        }
    }

    private func processRows(_ tools: [ToolCall]) -> some View {
        let hidden = max(0, tools.count - Self.processLimit)
        let shown = Array(tools.suffix(Self.processLimit))
        return VStack(alignment: .leading, spacing: 8) {
            if hidden > 0 {
                AssistantMutedText("更早还有 \(hidden) 步")
            }
            ForEach(shown) { tool in
                processRow(tool)
            }
        }
        .assistantCard()
    }

    private func processRow(_ tool: ToolCall) -> some View {
        let running = tool.status == "running"
        let failed = tool.status == "error"
        let color: Color = running ? JieboColor.run : (failed ? JieboColor.danger : JieboColor.ok)
        let symbol = running ? "ellipsis" : (failed ? "xmark" : "checkmark")
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .font(JieboFont.text(.caption2, weight: .semibold))
                .foregroundStyle(color)
                .frame(width: 14)
            Text(running ? "正在\(Self.verb(for: tool))" : Self.verb(for: tool))
                .font(JieboFont.text(.footnote, weight: .medium))
                .foregroundStyle(JieboColor.ink)
            Text(tool.summary)
                .font(JieboFont.monoText(.caption))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private static func verb(for tool: ToolCall) -> String {
        switch tool.kind {
        case .read: return "读"
        case .edit: return "改"
        case .write: return "写"
        case .shell: return "跑"
        case .search: return "搜"
        case .other: return tool.name.isEmpty ? "工具" : tool.name
        }
    }

    // MARK: 停止

    @ViewBuilder
    private func stopSection(_ row: AssistantDelegation) -> some View {
        if row.status == "running" || row.status == "awaiting" {
            if row.mode == "foreground" {
                ActionButton(title: stopping ? "正在停止…" : "停止这项委派", kind: .destructive) {
                    stopConfirm = true
                }
                .disabled(stopping)
            } else {
                AssistantMutedText("后台任务只读，会自己结束")
            }
        }
    }

    private func stop() {
        guard let row = delegation, row.status == "running" || row.status == "awaiting" else { return }
        stopping = true
        store.assistantOp("delegation_cancel", args: ["delegationId": .string(row.id)])
        Task { @MainActor in
            // 8 秒后状态还没变（多半是网关拒绝了，原因已经用 flash 显示）就把按钮恢复
            try? await Task.sleep(for: .seconds(8))
            stopping = false
        }
    }

    private func loadProcess() {
        guard let childId = delegation?.childChatId, !childId.isEmpty else { return }
        store.ensureTurnsLoaded(childId)
    }
}
