import SwiftUI
import UIKit
import ImageIO

extension ThreadView {
    /// ChatStore 每批正文变化只递增一次；避免每次 body 都序列化工具结果、拼一条 liveTail 大字符串。
    var liveTail: UInt64 {
        store.turnRenderRevisions[resolvedChatId, default: 0]
    }

    var showThreadLoading: Bool {
        if chatId == nil, store.coldStartPlaceholder { return true }
        guard let chat = threadChat else { return false }
        return !chat.turnsComplete && chat.turns.isEmpty
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
        VStack(spacing: 16) {
            Spacer(minLength: 40)
            JieboMark(size: 36)
            Text("\(store.assistantName) 在这儿")
                .font(JieboFont.display(30))
                .tracking(0.6)
                .foregroundStyle(JieboColor.ink)
                .multilineTextAlignment(.center)
            Text("记事、提醒、查东西，或者让它去某个项目里干活，不用你自己打开任何东西。")
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.dim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            VStack(spacing: 8) {
                ForEach(assistantStarters, id: \.self) { text in
                    Button {
                        store.saveDraft(text, forChat: resolvedChatId)
                        composerFocusNonce += 1
                    } label: {
                        Text(text)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .background(JieboColor.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .stroke(JieboColor.line, lineWidth: 1)
                            )
                            .hitTarget()
                    }
                    .buttonStyle(PressScaleButtonStyle())
                }
            }
            .padding(.top, 8)
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: viewportHeight > 120 ? viewportHeight - 24 : 0)
        .padding(.horizontal, 24)
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
