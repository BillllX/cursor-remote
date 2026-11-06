import SwiftUI
import UIKit
import ImageIO

extension ThreadView {
    @ViewBuilder
    var header: some View {
        switch chrome {
        case .pad:
            padHeader
        case .phoneLegacy:
            phoneHeader
        case .embedded:
            EmptyView()
        }
    }

    var headerTitle: String {
        resolvedChatId == store.assistantChatId ? store.assistantName : (threadChat?.title ?? "新对话")
    }

    /// 优先级：没连上 > 正在同步 > 没配 API Key > 正在回复 > 模式
    var padSubtitle: String {
        if !store.connected { return store.linkState.title }
        if store.isThreadSyncBusy(resolvedChatId) { return ChatStore.syncingThreadTitle }
        if let hint = store.approvalHint(for: resolvedChatId, surface: .padThread) {
            return hint.title
        }
        if !store.hasApiKey { return ChatStore.missingApiKeyTitle }
        if threadBusy { return "正在回复" }
        if resolvedChatId == store.assistantChatId, let title = store.backgroundAttentionTitle {
            return title
        }
        return store.mode(for: resolvedChatId).label
    }

    var phoneSubtitle: String {
        if !store.connected { return store.linkState.title }
        if store.isThreadSyncBusy(resolvedChatId) { return ChatStore.syncingThreadTitle }
        if let hint = store.approvalHint(for: resolvedChatId, surface: .phoneWorkbench) {
            return hint.title
        }
        if resolvedChatId == store.assistantChatId {
            if !store.hasApiKey { return ChatStore.missingApiKeyTitle }
            if !threadBusy, let title = store.backgroundAttentionTitle { return title }
            return "小驳 · \(store.mode(for: resolvedChatId).label)"
        }
        let place = store.workspaceTitle(anchoredTo: resolvedChatId)
        return store.hasApiKey ? "\(place) · \(store.mode(for: resolvedChatId).label)" : ChatStore.missingApiKeyTitle
    }

    var phoneStatus: String? {
        if let row = store.loops[resolvedChatId], row.status == "armed" || row.status == "running" {
            if let summary = row.lastSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
                return "Loop · 第 \(row.tick) 拍 · \(summary)"
            }
            return "Loop · 第 \(row.tick) 拍"
        }
        if threadBusy { return "正在回复" }
        return nil
    }

    var phoneHeader: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                phoneIcon("line.3.horizontal", label: "菜单", action: openDrawer)
                VStack(spacing: 1) {
                    Text(headerTitle)
                        .font(JieboFont.text(.headline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        LinkStatusDot(state: store.linkState, syncing: store.isThreadSyncBusy(resolvedChatId))
                        connectionSubtitle(phoneSubtitle)
                    }
                }
                .frame(maxWidth: .infinity)
                if store.canUndo(resolvedChatId) {
                    phoneIcon("arrow.uturn.backward", label: "还原上一轮的改动") {
                        store.undoLast(chatId: resolvedChatId)
                    }
                }
                phoneIcon("folder", label: "文件") {
                    store.openFilesOnWorkbench(chatId: resolvedChatId)
                }
                phoneIcon("terminal", label: "终端输出") {
                    store.openTerminalOnWorkbench(chatId: resolvedChatId)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
            .padding(.bottom, phoneStatus == nil ? 8 : 4)
            if let phoneStatus {
                Button {
                    if store.loops[resolvedChatId] != nil { store.toggleTool(.loop) }
                } label: {
                    HStack(spacing: 6) {
                        Circle().fill(JieboColor.ok).frame(width: 6, height: 6)
                        Text(phoneStatus)
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(JieboColor.white)
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .disabled(store.loops[resolvedChatId] == nil)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
        }
    }

    @ViewBuilder
    func connectionSubtitle(_ text: String) -> some View {
        let label = Text(text)
            .font(JieboFont.text(.caption, weight: .medium))
            .foregroundStyle(!store.connected || !store.hasApiKey ? JieboColor.danger : JieboColor.dim)
            .lineLimit(text == ChatStore.missingApiKeyTitle || text == store.backgroundAttentionTitle ? 2 : 1)
        if !store.connected {
            Button {
                store.retryConnection()
            } label: {
                label.frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .disabled(store.linkState != .offline)
            .accessibilityHint(store.linkState == .offline ? "重新连接" : "")
        } else if store.isThreadSyncBusy(resolvedChatId) {
            Button {
                store.retryThreadSync(resolvedChatId)
            } label: {
                label
            }
            .buttonStyle(.plain)
            .accessibilityHint("再拉一次这条会话")
        } else if store.approvalHint(for: resolvedChatId, surface: chrome == .pad ? .padThread : .phoneWorkbench) == .openInbox {
            Button {
                store.requestOpenApprovals()
            } label: {
                label
            }
            .buttonStyle(.plain)
            .accessibilityHint("打开待处理")
        } else if chrome == .phoneLegacy,
                  store.approvalHint(for: resolvedChatId, surface: .phoneWorkbench) == .backToAssistant {
            Button {
                store.requestReturnToAssistant()
            } label: {
                label
            }
            .buttonStyle(.plain)
            .accessibilityHint("回到小驳")
        } else if resolvedChatId == store.assistantChatId,
                  let title = store.backgroundAttentionTitle,
                  text == title {
            Button {
                store.requestAssistant(force: true)
            } label: {
                label
            }
            .buttonStyle(.plain)
            .accessibilityHint(store.backgroundAttentionReason ?? "再检查后台模型")
        } else {
            label
        }
    }

    func phoneIcon(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(JieboFont.text(.callout, weight: .semibold))
                .foregroundStyle(JieboColor.ink)
                .frame(width: 32, height: 32)
                .background(JieboColor.mist)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(label)
    }

    var padHeader: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(headerTitle)
                    .font(JieboFont.display(22))
                    .tracking(0.44)
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    LinkStatusDot(state: store.linkState, syncing: store.isThreadSyncBusy(resolvedChatId), size: 7)
                    connectionSubtitle(padSubtitle)
                }
            }
            Spacer()
            if store.previewLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(JieboColor.dim)
            }
            Button {
                store.openTerminalOnWorkbench(chatId: resolvedChatId)
            } label: {
                Text("终端输出")
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .background(JieboColor.mist)
                    .clipShape(Capsule())
            }
            .buttonStyle(PressScaleButtonStyle())
            .accessibilityLabel("终端输出")
            if store.canUndo(resolvedChatId) {
                Button {
                    store.undoLast(chatId: resolvedChatId)
                } label: {
                    Image(systemName: "arrow.uturn.backward")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(width: 30, height: 30)
                        .background(JieboColor.mist)
                        .clipShape(Circle())
                        .shadow(color: .black.opacity(0.06), radius: 4, y: 1)
                        .hitTarget() // P6：视觉 30，命中 44
                }
                .buttonStyle(PressScaleButtonStyle())
                .accessibilityLabel("还原上一轮的改动")
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 18)
        .padding(.bottom, 18)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(JieboColor.line)
                .frame(height: 1)
        }
    }
}
