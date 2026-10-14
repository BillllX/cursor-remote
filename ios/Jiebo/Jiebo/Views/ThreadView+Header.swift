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

    /// 助理会话里打开今日/收件箱/记忆层；有未读或待批时挂点
    var assistantTodayButton: some View {
        AssistantTodayButton(
            on: store.toolLayer == .assistant,
            marked: store.assistantBadgeCount > 0
        ) {
            store.toggleTool(.assistant)
        }
    }

    /// 优先级和 iPhone 首页一致：没连上 > 没配 API Key > 正在回复 > 模式
    var padSubtitle: String {
        if !store.connected { return store.linkState.title }
        if !store.hasApiKey { return "服务器还没配 API Key" }
        if threadBusy { return "正在回复" }
        return store.mode(for: resolvedChatId).label
    }

    var phoneSubtitle: String {
        if !store.connected { return store.linkState.title }
        if resolvedChatId == store.assistantChatId {
            return store.hasApiKey ? "个人助理 · \(store.mode(for: resolvedChatId).label)" : "服务器还没配 API Key"
        }
        let place = store.currentWorkspaceName
        return store.hasApiKey ? "\(place) · \(store.mode(for: resolvedChatId).label)" : "服务器还没配 API Key"
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
                        .font(JieboFont.display(17))
                        .tracking(0.34)
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        LinkStatusDot(state: store.linkState, syncing: store.threadSyncBusy)
                        Text(phoneSubtitle)
                            .font(JieboFont.text(.caption2, weight: .medium))
                            .tracking(0.3)
                            .foregroundStyle(store.hasApiKey || !store.connected ? JieboColor.dim : JieboColor.danger)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                }
                .frame(maxWidth: .infinity)
                if resolvedChatId == store.assistantChatId {
                    assistantTodayButton
                }
                if store.canUndo(resolvedChatId) {
                    phoneIcon("arrow.uturn.backward", label: "还原上一轮的改动") {
                        store.undoLast(chatId: resolvedChatId)
                    }
                }
                phoneIcon("folder", label: "文件") {
                    if !(store.fileBrowserOpen && store.fileBrowserPane == .files) {
                        store.toggleFileBrowser(.files)
                    }
                }
                phoneIcon("plus", label: "新对话", action: store.openNewChat)
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
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
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

    func phoneIcon(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
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
                    LinkStatusDot(state: store.linkState, syncing: store.threadSyncBusy, size: 7)
                    Text(padSubtitle)
                        .font(JieboFont.text(.caption, weight: .medium))
                        .tracking(0.4)
                        .foregroundStyle(store.connected && !store.hasApiKey ? JieboColor.danger : JieboColor.dim)
                        .lineLimit(1)
                }
                .accessibilityElement(children: .combine)
            }
            Spacer()
            if store.previewLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(JieboColor.dim)
            }
            if resolvedChatId == store.assistantChatId {
                assistantTodayButton
            }
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
