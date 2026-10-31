import SwiftUI
import UIKit
import ImageIO

extension ThreadView {
    /// ChatStore 每批正文变化只递增一次；避免每次 body 都序列化工具结果、拼一条 liveTail 大字符串。
    var liveTail: UInt64 {
        store.turnRenderRevisions[resolvedChatId, default: 0]
    }

    var showThreadLoading: Bool {
        if store.linkState == .offline { return false }
        if chatId == nil, store.coldStartPlaceholder { return true }
        guard let chat = threadChat else { return false }
        guard !chat.turnsComplete, chat.turns.isEmpty else { return false }
        // 正在读缓存、正在拉分页，或服务端列表还没到：空壳先盖住。
        // 已经对过账却没在拉，就不再一直转圈，避免失败后把输入区盖死。
        return store.loadingChatIds.contains(chat.id)
            || store.cacheReadingIds.contains(chat.id)
            || !store.appliedStore
    }

    var emptyState: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 40)
            JieboMark(size: 36)
            Text("从这里开始")
                .font(JieboFont.display(34))
                .tracking(0.68)
                .foregroundStyle(JieboColor.ink)
            Text("网页说话，远端动手。从左侧接着聊，或先打开一个工作区文件。")
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.dim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            ViewThatFits(in: .horizontal) {
                starterRow(axis: .horizontal)
                starterRow(axis: .vertical)
            }
            .padding(.top, 8)
            Text("点左上角打开对话列表 · 可粘贴图片")
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.dim)
                .multilineTextAlignment(.center)
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: viewportHeight > 120 ? viewportHeight - 24 : 0)
        .padding(.horizontal, 24)
    }

    /// iPhone 助理页的空状态：不是「工作区」语境，快捷句也是跟助理说的话
    var assistantEmptyState: some View {
        VStack(spacing: 14) {
            Spacer(minLength: 32)
            AssistantAvatarView(
                phase: store.assistantAvatarPhase,
                size: dynamicTypeSize >= .xxLarge ? 88 : 112
            )
            .padding(.bottom, 2)
            Text(assistantGreeting)
                .font(JieboFont.display(32))
                .tracking(0.64)
                .foregroundStyle(JieboColor.ink)
                .multilineTextAlignment(.center)
            Text("今天想先做点什么？")
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.dim)
                .multilineTextAlignment(.center)

            Group {
                if dynamicTypeSize >= .xxLarge {
                    VStack(spacing: 8) {
                        ForEach(Array(zip(assistantStarters, assistantStarterSymbols).enumerated()), id: \.offset) { item in
                            assistantStarterButton(item.element.0, symbol: item.element.1)
                        }
                    }
                } else {
                    LazyVGrid(
                        columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 2),
                        spacing: 8
                    ) {
                        ForEach(Array(zip(assistantStarters, assistantStarterSymbols).enumerated()), id: \.offset) { item in
                            assistantStarterButton(item.element.0, symbol: item.element.1)
                        }
                    }
                }
            }
            .padding(.top, 18)
            Spacer(minLength: 32)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: viewportHeight > 120 ? viewportHeight - 24 : 0)
        .padding(.horizontal, 20)
    }

    private var assistantGreeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: return "早上好"
        case 12..<18: return "下午好"
        default: return "晚上好"
        }
    }

    private var assistantStarterSymbols: [String] {
        ["magnifyingglass", "note.text", "alarm", "folder.badge.gearshape"]
    }

    private func assistantStarterButton(_ text: String, symbol: String) -> some View {
        Button {
            store.saveDraft(text, forChat: resolvedChatId)
            composerFocusNonce += 1
        } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(JieboFont.text(.title3, weight: .medium))
                    .foregroundStyle(JieboColor.pine)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                Text(text)
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(text)
        .accessibilityHint("填入输入框")
    }

    func starterRow(axis: Axis) -> some View {
        let row = ForEach(starters, id: \.self) { text in
            Button {
                if text == "打开工作区文件" {
                    if !(store.fileBrowserOpen && store.fileBrowserPane == .files) {
                        store.toggleFileBrowser(.files)
                    }
                } else {
                    store.saveDraft(text, forChat: resolvedChatId)
                    composerFocusNonce += 1
                }
            } label: {
                Text(text)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(JieboColor.white)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
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
