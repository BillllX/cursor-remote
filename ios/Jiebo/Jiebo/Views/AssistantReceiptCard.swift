import SwiftUI

struct AssistantReceiptNavigation {
    var openInbox: () -> Void
    var openInboxItem: (String) -> Void
    var openDelegation: (String) -> Void
    var preparePreview: () -> Void = {}
    var openDelegations: () -> Void = {}
    var openAutomation: () -> Void = {}
}

private struct AssistantReceiptNavigationKey: EnvironmentKey {
    static let defaultValue: AssistantReceiptNavigation? = nil
}

private struct AssistantReadingHistoryKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var assistantReceiptNavigation: AssistantReceiptNavigation? {
        get { self[AssistantReceiptNavigationKey.self] }
        set { self[AssistantReceiptNavigationKey.self] = newValue }
    }

    var assistantReadingHistory: Bool {
        get { self[AssistantReadingHistoryKey.self] }
        set { self[AssistantReadingHistoryKey.self] = newValue }
    }
}

/// 所有结果按钮共用同一条真实实体导航，手机和 iPad 只提供各自的路由。
struct AssistantReceiptCard: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.assistantReceiptNavigation) private var navigation
    @Environment(\.sceneSessionState) private var sceneSession
    @Environment(\.dynamicTypeSize) private var typeSize
    let receipt: AssistantReceipt
    var compact = false
    var dismiss: (() -> Void)?
    @State private var detailsOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 0 : 8) {
            HStack(alignment: .center, spacing: 10) {
                if receipt.needsAttention || compact {
                    Image(systemName: receipt.needsAttention ? "exclamationmark.circle" : "sparkle")
                        .foregroundStyle(receipt.needsAttention ? JieboColor.warnFg : JieboColor.sparkText)
                        .font(JieboFont.text(.title3, weight: .medium))
                        .accessibilityHidden(true)
                } else {
                    AssistantAvatarView(phase: .idle, size: 32)
                        .environment(\.homeActive, false)
                        .overlay(alignment: .topTrailing) {
                            Image(systemName: "sparkle").font(.caption)
                                .foregroundStyle(JieboColor.sparkText)
                                .offset(x: 3, y: -3)
                        }
                        .accessibilityHidden(true)
                }
                Button(action: openPrimary) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(receipt.title).font(JieboFont.text(.subheadline, weight: .semibold))
                            .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                        if !compact {
                            Text(receipt.statusTitle).font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.ink2)
                        }
                    }
                    .foregroundStyle(JieboColor.ink)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if let dismiss {
                    Button(action: dismiss) {
                        Image(systemName: "xmark").font(JieboFont.text(.caption))
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(JieboColor.ink2)
                    .accessibilityLabel("收起这条结果")
                } else {
                    Image(systemName: "chevron.right").foregroundStyle(JieboColor.ink2)
                        .accessibilityHidden(true)
                }
            }
            if !compact {
                Text(ReplyText.repair(receipt.summary))
                    .font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.ink2)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { actions }
                    VStack(alignment: .leading, spacing: 4) { actions }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, compact ? 0 : 8)
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(JieboColor.line, lineWidth: JieboStroke.outline)
        }
        .sheet(isPresented: $detailsOpen) {
            NavigationStack {
                ScrollView {
                    ChunkedAssistantMessage(text: receipt.summary).padding(20)
                }
                .navigationTitle("本次结果")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { detailsOpen = false } } }
            }
        }
    }

    @ViewBuilder private var actions: some View {
        ActionButton(title: receipt.primaryTitle, kind: .primary, action: openPrimary)
        if !receipt.needsAttention && receipt.snapshot != nil {
            Button("查看本次运行", action: openDetails)
                .font(JieboFont.text(.footnote)).frame(minHeight: 44).buttonStyle(.plain)
                .foregroundStyle(JieboColor.ink2)
        }
    }

    private func currentReceipt() -> AssistantReceipt? {
        AssistantReceipt.results(in: store.assistantState, now: Date().timeIntervalSince1970 * 1000, recentOnly: false)
            .first { $0.id == receipt.id }
    }

    private func openPrimary() {
        guard let current = currentReceipt() else {
            store.flash("这条结果已更新，请刷新后查看。")
            store.requestAssistant(force: true)
            return
        }
        if current.needsAttention {
            openDetails()
        } else if let file = current.snapshot,
                  let chat = current.sourceChatId ?? current.artifact?.sourceChatId ?? store.assistantChatId,
                  store.supportsReadSha {
            navigation?.preparePreview()
            guard store.openResultSnapshot(file, chatId: chat, workspaceKey: current.workspaceRun?.workspaceKey) else {
                openDetails()
                return
            }
            sceneSession?.presentPreview(from: store)
            markRead(current)
        } else {
            openDetails()
        }
    }

    private func openDetails() {
        guard let current = currentReceipt() else { return }
        if let id = current.inboxId, let navigation {
            navigation.openInboxItem(id)
        } else if let id = current.delegationId, let navigation {
            navigation.openDelegation(id)
        } else {
            detailsOpen = true
        }
        markRead(current)
    }

    private func markRead(_ receipt: AssistantReceipt) {
        let scope = AssistantReceiptMemory.scope(server: GatewayConfig.url.absoluteString, tenant: store.tenantId)
        UserDefaults.standard.set(receipt.id, forKey: scope + ".lastOpened")
        if let id = receipt.inboxId, let item = store.assistantState?.inbox.first(where: { $0.id == id }) {
            store.markInboxRead(item)
        }
    }
}

/// 优先保留确认入口，结果与执行中各有唯一的展示位置。
struct AssistantReceiptDock: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.assistantReceiptNavigation) private var navigation
    @Environment(\.assistantReadingHistory) private var reading
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.homeActive) private var homeActive
    @State private var dismissalRevision = 0
    @State private var appeared = false
    @State private var pulse = false
    @State private var clockNow = Date()

    private var scope: String {
        AssistantReceiptMemory.scope(server: GatewayConfig.url.absoluteString, tenant: store.tenantId)
    }

    private var needsPeriodicClock: Bool {
        guard homeActive, scenePhase == .active, let state = store.assistantState else { return false }
        if state.approvals.contains(where: { $0.expiresAt > 0 }) { return true }
        if (state.draftCards ?? []).contains(where: { $0.status == "waiting_user" && $0.expiresAt > 0 }) { return true }
        if !state.inbox.isEmpty || !state.delegations.isEmpty { return true }
        return false
    }

    /// 保持单一稳定的 dockContent 视图身份，避免切后台/开侧栏时重建分支销毁已打开的详情 Sheet。
    var body: some View {
        dockContent(nowDate: clockNow)
            .task(id: needsPeriodicClock) {
                clockNow = Date()
                guard needsPeriodicClock else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(30))
                    guard !Task.isCancelled else { return }
                    clockNow = Date()
                }
            }
    }

    private func dockContent(nowDate: Date) -> some View {
        let now = nowDate.timeIntervalSince1970 * 1000
        let receipts = AssistantReceipt.results(in: store.assistantState, now: now)
            .filter { !AssistantReceiptMemory.contains($0.id, scope: scope + ".dismissed") }
        let receipt = receipts.first
        let drafts = (store.assistantState?.draftCards ?? []).filter {
            $0.status == "waiting_user" && ($0.expiresAt <= 0 || $0.expiresAt > now)
        }
            .sorted { $0.createdAt > $1.createdAt }
        let approvals = (store.assistantState?.approvals ?? []).filter { $0.expiresAt <= 0 || $0.expiresAt > now }
        let skills = store.memoryCenterSkillProposals.filter { $0.status == "pending" }
        let pendingCount = max(drafts.count, approvals.count) + skills.count
        let running = (store.assistantState?.delegations ?? []).filter { ["queued", "running", "awaiting"].contains($0.status) }
        let selectedKey = pendingCount > 0 ? "pending:\(drafts.first?.id ?? approvals.first?.id ?? skills.first?.id ?? "")" : receipt?.id ?? running.first?.id
        return VStack(spacing: 4) {
                if pendingCount > 0 {
                    if let skill = skills.first {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("待启用技能：\(skill.name)")
                                .font(JieboFont.text(.subheadline, weight: .semibold))
                            if !reading { Text(skill.summary).font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.ink2) }
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 12) { skillActions(skill) }
                                VStack(alignment: .leading, spacing: 4) { skillActions(skill) }
                            }
                        }
                        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(JieboColor.white, in: RoundedRectangle(cornerRadius: 16))
                    } else if reading {
                        inboxLink(title: "需要你确认",
                                  detail: "\(pendingCount) 项待处理", symbol: "hand.raised")
                    } else if let draft = drafts.first {
                        DraftActionCard(draft: draft, onOpenDelegation: navigation?.openDelegation)
                    } else if let approval = approvals.first {
                        ApprovalCard(approval: approval, onOpenDelegation: approval.delegationId.flatMap { id in
                            navigation.map { routing in { routing.openDelegation(id) } }
                        })
                    }
                } else if let receipt {
                    AssistantReceiptCard(receipt: receipt, compact: reading) {
                        AssistantReceiptMemory.record(receipt.id, scope: scope + ".dismissed")
                        dismissalRevision += 1
                    }
                    .scaleEffect(pulse ? 1.018 : 1, anchor: .bottom)
                    .offset(y: pulse ? -3 : 0)
                } else if let item = running.first {
                    inboxLink(title: item.title, detail: item.waitReason ?? item.statusLabel, symbol: "ellipsis.circle") {
                        navigation?.openDelegation(item.id)
                    }
                }
                if pendingCount > 1 || (pendingCount == 0 && (receipts.count > 1 || running.count > 1)) {
                    Button("查看全部") {
                        if pendingCount > 0 || receipts.count > 1 { navigation?.openInbox() }
                        else { navigation?.openDelegations() }
                    }
                        .font(JieboFont.text(.caption)).foregroundStyle(JieboColor.ink2)
                        .frame(minHeight: 44).buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, selectedKey == nil ? 0 : 6)
            .padding(.bottom, selectedKey == nil ? 0 : 4)
            .onChange(of: selectedKey) { _, key in
                guard let key else { return }
                guard appeared else {
                    AssistantReceiptMemory.record(key, scope: scope + ".seen")
                    appeared = true
                    return
                }
                guard !reading, homeActive, scenePhase == .active,
                      !AssistantReceiptMemory.contains(key, scope: scope + ".seen") else { return }
                AssistantReceiptMemory.record(key, scope: scope + ".seen")
                guard !reduceMotion else { return }
                withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { pulse = true }
            }
            .task(id: pulse) {
                guard pulse else { return }
                try? await Task.sleep(for: .milliseconds(220))
                guard !Task.isCancelled else { return }
                withAnimation(.spring(response: 0.4, dampingFraction: 0.65)) { pulse = false }
            }
            .onAppear {
                appeared = store.assistantState != nil
                if let selectedKey { AssistantReceiptMemory.record(selectedKey, scope: scope + ".seen") }
            }
            .onChange(of: dismissalRevision) { _, _ in pulse = false }
            .onChange(of: homeActive) { _, active in if !active { pulse = false } }
            .onChange(of: scenePhase) { _, phase in if phase != .active { pulse = false } }
            .onChange(of: reduceMotion) { _, reduced in if reduced { pulse = false } }
    }

    @ViewBuilder private func skillActions(_ skill: SkillFactoryProposalRow) -> some View {
        ActionButton(title: "启用", kind: .primary) {
            store.memoryCenterDecideSkillProposal(proposalId: skill.id, approve: true, expectedRev: skill.rev)
        }
        ActionButton(title: "拒绝", kind: .outline) {
            store.memoryCenterDecideSkillProposal(proposalId: skill.id, approve: false, expectedRev: skill.rev)
        }
    }

    private func inboxLink(title: String, detail: String, symbol: String, action: (() -> Void)? = nil) -> some View {
        Button { if let action { action() } else { navigation?.openInbox() } } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol).foregroundStyle(JieboColor.sparkText)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).foregroundStyle(JieboColor.ink).font(JieboFont.text(.subheadline, weight: .medium))
                    if !reading { Text(detail).foregroundStyle(JieboColor.ink2).font(JieboFont.text(.caption)) }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").foregroundStyle(JieboColor.ink2)
            }
            .padding(.horizontal, 12).padding(.vertical, 6).frame(minHeight: 44)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
