import SwiftUI
import UIKit
import ImageIO

extension ThreadView {
    /// ChatStore 每批正文变化只递增一次；避免每次 body 都序列化工具结果、拼一条 liveTail 大字符串。
    var liveTail: UInt64 {
        store.turnRenderRevisions[resolvedChatId, default: 0]
    }

    var showThreadLoading: Bool {
        if !store.connected { return false }
        if chatId == nil, store.coldStartPlaceholder { return true }
        guard let chat = threadChat else { return false }
        guard !chat.turnsComplete, chat.turns.isEmpty else { return false }
        // 助理页在主会话选定前也会停在空壳上。先写「正在打开」，不要留一整块空白。
        if chrome == .embedded { return true }
        // 正在读缓存、正在拉分页，或服务端列表还没到：空壳先盖住。
        // 已经对过账却没在拉，就不再一直转圈，避免失败后把输入区盖死。
        return store.loadingChatIds.contains(chat.id)
            || store.cacheReadingIds.contains(chat.id)
            || !store.appliedStore
    }

    /// 更早的内容现在拉不了。nil 表示已经连上，可以写正在加载或加载更早内容。
    var earlierLoadBlockedTitle: String? {
        if !store.unlocked { return "还没登录。登录后再看更早的内容。" }
        if !store.connected {
            return store.linkState == .offline
                ? "已断开。点按重连后再看更早的内容。"
                : "正在连接。连上后再看更早的内容。"
        }
        if store.cachedOnlyIds.contains(resolvedChatId) {
            return "这条对话还没对上服务器，稍后再看更早的内容。"
        }
        return nil
    }

    var earlierNetworkTitle: String {
        if let title = earlierLoadBlockedTitle { return title }
        if store.loadingChatIds.contains(resolvedChatId) { return "正在加载更早内容…" }
        return "加载更早内容"
    }

    var earlierNetworkDisabled: Bool {
        if store.unlocked, store.linkState == .offline { return false }
        if earlierLoadBlockedTitle != nil { return true }
        return store.loadingChatIds.contains(resolvedChatId)
    }

    var emptyState: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 40)
            JieboMark(size: 36)
            Text("从这里开始")
                .font(JieboFont.display(34))
                .tracking(0.68)
                .foregroundStyle(JieboColor.ink)
            Text(chrome == .phoneLegacy
                 ? "点左上角菜单接着聊，或先打开文件、终端输出。"
                 : "从左侧接着聊，或先打开文件、终端输出。")
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.dim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            ViewThatFits(in: .horizontal) {
                starterRow(axis: .horizontal)
                starterRow(axis: .vertical)
            }
            .padding(.top, 8)
            Text(chrome == .phoneLegacy ? "点按左上角查看对话 · 可粘贴图片" : "对话列表在左侧 · 可粘贴图片")
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.dim)
                .multilineTextAlignment(.center)
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: viewportHeight > 120 ? viewportHeight - 24 : 0)
        .padding(.horizontal, 24)
    }

    /// 没有聊天内容时，用真实的最近结果和两个轻入口开始。
    var assistantEmptyState: some View {
        VStack(alignment: .leading, spacing: 20) {
            Spacer(minLength: 16)
            HStack(spacing: 14) {
                AssistantPlayfulAvatar(phase: store.assistantAvatarPhase, size: 64)
                VStack(alignment: .leading, spacing: 6) {
                    Text(assistantGreeting)
                        .font(JieboFont.text(.title2, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                    Text("今天想先推进哪件事？")
                        .font(JieboFont.text(.subheadline))
                        .foregroundStyle(JieboColor.ink2)
                }
            }
            if let receipt = assistantResumeReceipt {
                AssistantReceiptCard(receipt: receipt)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { assistantQuickEntries }
                VStack(alignment: .leading, spacing: 10) { assistantQuickEntries }
            }
            Spacer(minLength: 16)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: viewportHeight > 120 ? viewportHeight - 24 : 0)
        .padding(.horizontal, 4)
    }

    private var assistantResumeReceipt: AssistantReceipt? {
        let results = AssistantReceipt.results(in: store.assistantState,
            now: Date().timeIntervalSince1970 * 1000, recentOnly: false)
        let scope = AssistantReceiptMemory.scope(server: GatewayConfig.url.absoluteString, tenant: store.tenantId)
        if let id = UserDefaults.standard.string(forKey: scope + ".lastOpened"),
           let previous = results.first(where: { $0.id == id }) { return previous }
        return results.first
    }

    private var assistantGreeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: return "早上好"
        case 12..<18: return "下午好"
        default: return "晚上好"
        }
    }

    @ViewBuilder private var assistantQuickEntries: some View {
        assistantQuickEntry("记一句", symbol: "note.text", draft: "帮我记一下：")
        assistantQuickEntry("设个提醒", symbol: "alarm", draft: "提醒我")
    }

    private func assistantQuickEntry(_ title: String, symbol: String, draft: String) -> some View {
        Button {
            // 已有草稿先保留，避免快捷入口抹掉用户正准备发送的内容。
            if store.draft(for: resolvedChatId).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                store.applyExternalDraft(draft, forChat: resolvedChatId)
            }
            composerFocusNonce += 1
        } label: {
            Label(title, systemImage: symbol)
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink)
                .padding(.horizontal, 18)
                .frame(minHeight: 44)
                .background(JieboColor.white, in: Capsule())
                .overlay(Capsule().stroke(JieboColor.line, lineWidth: JieboStroke.outline))
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityHint("在输入框里补充内容")
    }

    func starterRow(axis: Axis) -> some View {
        let row = ForEach(starters, id: \.self) { text in
            Button {
                if text == "打开文件" {
                    store.openFilesOnWorkbench(chatId: resolvedChatId)
                } else if text == "终端输出" {
                    store.openTerminalOnWorkbench(chatId: resolvedChatId)
                } else {
                    store.applyExternalDraft(text, forChat: resolvedChatId)
                    composerFocusNonce += 1
                }
            } label: {
                Text(text)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(JieboColor.white)
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: JieboStroke.outline)
                    )
            }
            .buttonStyle(PressScaleButtonStyle())
        }
        return Group {
            if axis == .horizontal {
                HStack(spacing: 8) { row }
            } else {
                VStack(spacing: 8) { row }
            }
        }
    }

    /// 订阅引导只挂在最近一轮记下带日期待办的回执下面，不在每条回执后面重复
    func calendarInviteTurnId(_ turns: [Turn]) -> String? {
        guard CalendarInvite.pending(store.assistantState?.calendar, dismissed: calendarInviteDismissed) else { return nil }
        return turns.last(where: { turn in
            TodoReceipt.captured(in: turn, todos: store.assistantState?.todos).contains { !$0.duplicate && $0.due != nil }
        })?.id
    }

    func timeSeparator(before turn: Turn, previous: Turn?) -> String? {
        guard let at = turn.startedAt, at > 0 else { return nil }
        guard let prev = previous?.startedAt, prev > 0 else { return nil }
        guard at - prev > 10 * 60 * 1000 else { return nil }
        return formatTurnTimeSeparator(at)
    }
}
