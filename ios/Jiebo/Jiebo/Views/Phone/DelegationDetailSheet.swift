import SwiftUI

/// 委派详情展示执行过程和产物，可从这里恢复中断的委派。
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
    private func childChat(for row: AssistantDelegation?) -> ChatSession? {
        guard let childId = row?.childChatId, !childId.isEmpty else { return nil }
        return store.chats.first(where: { $0.id == childId })
    }

    var body: some View {
        let row = delegation
        let chat = childChat(for: row)
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let row {
                        content(row, chat: chat)
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
        .onChange(of: chat != nil) { _, hasChat in
            if hasChat { loadProcess() }
        }
        .onChange(of: row?.status) { _, status in
            if status != "running" && status != "awaiting" { stopping = false }
        }
    }

    // MARK: 内容

    @ViewBuilder
    private func content(_ row: AssistantDelegation, chat: ChatSession?) -> some View {
        let approvals = (store.assistantState?.approvals ?? []).filter { $0.delegationId == row.id }
        header(row)
        if row.status == "awaiting", !approvals.isEmpty {
            VStack(spacing: 8) {
                ForEach(approvals) { approval in
                    ApprovalCard(approval: approval)
                }
            }
        }
        if row.status == "done" || row.status == "failed", let result = row.result?.nilIfEmpty {
            AssistantSection("汇报") {
                ChunkedAssistantMessage(text: ReplyText.repair(result))
                    .textSelection(.enabled)
                    .assistantCard()
            }
        }
        processSection(row: row, chat: chat)
        filesSection(chat: chat)
        if let reason = row.waitReason { AssistantMutedText(reason) }
        DelegationQueueAction(item: row, fullWidth: true)
        stopSection(row)
    }

    private func header(_ row: AssistantDelegation) -> some View {
        let colors = row.statusColors
        return VStack(alignment: .leading, spacing: 8) {
            Text(row.title.nilIfEmpty ?? "委派")
                .font(JieboFont.text(.title3, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .fixedSize(horizontal: false, vertical: true)
            // 独立子视图订阅共享 MinuteClock，仅刷新单行用时文案，避免每分钟重绘整张详情页。
            DelegationMetaLabel(
                workspace: row.workspace,
                mode: row.mode,
                createdAt: row.createdAt,
                endedAt: row.endedAt
            )
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

    // MARK: 过程（只读）

    private func processSection(row: AssistantDelegation, chat: ChatSession?) -> some View {
        AssistantSection("过程") {
            if let chat {
                let tools = chat.turns.last?.tools ?? []
                if tools.isEmpty {
                    AssistantMutedText(chat.turnsComplete ? "还没有步骤。" : (store.delegationProcessPendingTitle(chatId: chat.id) ?? "正在加载过程…"))
                } else {
                    processRows(tools)
                }
            } else if row.childChatId.isEmpty {
                AssistantMutedText("这项委派没有单独的过程记录")
            } else {
                AssistantMutedText(store.delegationProcessPendingTitle(chatId: row.childChatId) ?? "正在读取过程…")
            }
        }
    }

    /// 子会话最后一轮的文件。按子会话 id 读（它的工作区），先收起 sheet：预览层和 Quick Look 都在 sheet 下面
    @ViewBuilder
    private func filesSection(chat: ChatSession?) -> some View {
        if let chat, let turn = chat.turns.last, !turn.cardFiles.isEmpty {
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
                DelegationProcessRow(tool: tool)
                    .equatable()
            }
        }
        .assistantCard()
    }

    // MARK: 停止

    @ViewBuilder
    private func stopSection(_ row: AssistantDelegation) -> some View {
        if row.status == "running" || row.status == "awaiting" {
            ActionButton(title: stopping ? "正在停止…" : "停止这项委派", kind: .destructive) {
                stopConfirm = true
            }
            .disabled(stopping)
        }
    }

    private func stop() {
        guard let row = delegation, row.status == "running" || row.status == "awaiting" else { return }
        guard store.cancelDelegation(row.id) else { return }
        stopping = true
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

private struct DelegationProcessRow: View, Equatable {
    let tool: ToolCall
    var palette: JieboPalette = JieboTheme.shared.palette
    var appearance: JieboAppearance = JieboTheme.shared.appearance

    var body: some View {
        let running = tool.status == "running"
        let failed = tool.status == "error"
        let color: Color = running ? JieboColor.run : (failed ? JieboColor.danger : JieboColor.ok)
        let symbol = running ? "ellipsis" : (failed ? "xmark" : "checkmark")
        let verb = ToolCardView.chineseVerb(tool)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .font(JieboFont.text(.caption2, weight: .semibold))
                .foregroundStyle(color)
                .frame(width: 14)
            Text(running ? "正在\(verb)" : verb)
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
}

/// 委派元信息单行：仅进行中（endedAt == nil）时订阅全局共享 MinuteClock，已结束零订阅且绝不触发整张详情页重绘。
private struct DelegationMetaLabel: View {
    let workspace: String
    let mode: String
    let createdAt: Double
    let endedAt: Double?

    var body: some View {
        if let endedAt {
            Text(Self.format(workspace: workspace, mode: mode, createdAt: createdAt, endedAt: endedAt, now: Date()))
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
        } else {
            LiveDelegationMetaText(workspace: workspace, mode: mode, createdAt: createdAt)
        }
    }

    static func format(workspace: String, mode: String, createdAt: Double, endedAt: Double?, now: Date) -> String {
        var parts: [String] = []
        let name = workspaceName(workspace)
        if !name.isEmpty { parts.append(name) }
        parts.append(mode == "foreground" ? "前台" : "后台")
        let endSeconds: Double = endedAt.map { $0 / 1000 } ?? now.timeIntervalSince1970
        let minutes = max(0, Int((endSeconds - createdAt / 1000) / 60))
        let spent: String
        if minutes < 1 {
            spent = "不到 1 分钟"
        } else if minutes < 60 {
            spent = "\(minutes) 分钟"
        } else {
            spent = "\(minutes / 60) 小时 \(minutes % 60) 分钟"
        }
        parts.append((endedAt == nil ? "已用时 " : "用时 ") + spent)
        return parts.joined(separator: " · ")
    }
}

private struct LiveDelegationMetaText: View {
    let workspace: String
    let mode: String
    let createdAt: Double
    @State private var retained = false

    var body: some View {
        let _ = MinuteClock.shared.tick
        Text(DelegationMetaLabel.format(workspace: workspace, mode: mode, createdAt: createdAt, endedAt: nil, now: Date()))
            .font(JieboFont.text(.caption))
            .foregroundStyle(JieboColor.dim)
            .onAppear {
                guard !retained else { return }
                retained = true
                MinuteClock.shared.retain()
            }
            .onDisappear {
                guard retained else { return }
                retained = false
                MinuteClock.shared.release()
            }
    }
}
