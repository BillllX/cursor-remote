import SwiftUI
import UIKit

/// iPad 常驻侧栏，层次和手机抽屉一致：助理 → 当前工作区（切换、工具、这个工作区的对话）→ 底部设置。
/// 多出来的只有收起按钮；点对话不收起侧栏。
struct SidebarView: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var collapse: () -> Void = {}
    @State private var chatActions = ChatActionTargets()
    @State private var settingsOpen = false

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 0) {
            brandBar

            AssistantEntryRow(action: store.openAssistantEntry)
                .padding(.horizontal, 12)

            Rectangle()
                .fill(JieboColor.line)
                .frame(height: 1)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

            workspaceCard
                .padding(.horizontal, 12)

            toolStrip
                .padding(.horizontal, 8)
                .padding(.top, 6)

            chatsHeader
                .padding(.top, 14)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if store.currentWorkspaceChats.isEmpty {
                        Text("这个工作区还没有对话")
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.dim)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 10)
                    } else {
                        ForEach(store.currentWorkspaceChats) { chat in
                            chatRow(chat)
                        }
                    }
                }
                .padding(.bottom, 12)
            }

            footer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(JieboColor.sidebar.ignoresSafeArea())
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(JieboColor.line)
                .frame(width: 1)
                .ignoresSafeArea()
                .allowsHitTesting(false)
        }
        .toolbar(.hidden, for: .navigationBar)
        .toolbar(removing: .sidebarToggle)
        .sheet(isPresented: $store.workspaceSheetOpen) {
            WorkspacePickerSheet()
        }
        .sheet(isPresented: $settingsOpen) {
            NavigationStack {
                PhoneSettingsScreen()
                    .navigationDestination(for: PhoneRoute.self) { route in
                        if route == .memory { AssistantMemoryScreen() }
                    }
            }
        }
        .chatActionAlerts($chatActions)
    }

    private var brandBar: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 10) {
                        brandIdentity
                        Spacer(minLength: 8)
                        collapseButton
                    }
                    linkStatus
                }
            } else {
                HStack(spacing: 10) {
                    brandIdentity
                    Spacer(minLength: 8)
                    linkStatus
                    collapseButton
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 12)
    }

    private var brandIdentity: some View {
        HStack(spacing: 10) {
            JieboMark(size: 22)
            Text("接驳")
                .font(JieboFont.display(17))
                .tracking(0.34)
                .foregroundStyle(JieboColor.ink)
        }
    }

    private var linkStatus: some View {
        HStack(spacing: 6) {
            LinkStatusDot(state: store.linkState, size: 8)
                .accessibilityHidden(true)
            Text(store.linkState.title)
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("连接状态，\(store.linkState.title)")
    }

    private var collapseButton: some View {
        Button(action: collapse) {
            Image(systemName: "sidebar.left")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 36, height: 36)
                .hitTarget()
                .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .hoverEffect(.highlight)
        .accessibilityLabel("收起侧栏")
    }

    private var workspaceCard: some View {
        Button(action: store.openWorkspaceSwitcher) {
            HStack(spacing: 10) {
                Image(systemName: NavigationIconId.workspace.symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(JieboColor.brass)
                    .frame(width: 30, height: 30)
                    .background(JieboColor.brass.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text("当前工作区")
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                    Text(store.currentWorkspaceName)
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.up.chevron.down")
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .fill(JieboColor.white.opacity(0.4))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("当前工作区，\(store.currentWorkspaceName)")
        .accessibilityHint("切换到别的工作区")
    }

    private var toolStrip: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                LazyVGrid(columns: [
                    GridItem(.flexible(), spacing: 0),
                    GridItem(.flexible(), spacing: 0),
                    GridItem(.flexible(), spacing: 0)
                ], spacing: 0) {
                    ForEach(ToolLayer.workTools) { layer in
                        toolButton(layer)
                    }
                }
            } else {
                HStack(spacing: 0) {
                    ForEach(ToolLayer.workTools) { layer in
                        toolButton(layer)
                    }
                }
            }
        }
    }

    private func toolButton(_ layer: ToolLayer) -> some View {
        let on = store.toolSelected(layer)
        let marked = layer == .loop && loopLive
        return Button {
            store.toggleTool(layer)
        } label: {
            VStack(spacing: 4) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: layer.symbol)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(on ? JieboColor.pine : JieboColor.ink2)
                        .frame(width: 32, height: 32)
                        .background(on ? JieboColor.pine.opacity(0.12) : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .stroke(on ? JieboColor.pine.opacity(0.28) : JieboColor.line, lineWidth: 1)
                        )
                    Circle()
                        .fill(JieboColor.ok)
                        .frame(width: 7, height: 7)
                        .offset(x: 2, y: -2)
                        .opacity(marked ? 1 : 0)
                }
                Text(layer.title)
                    .font(JieboFont.text(.caption2, weight: on ? .semibold : .regular))
                    .foregroundStyle(on ? JieboColor.ink : JieboColor.dim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .animation(JieboMotion.fade(reduceMotion), value: on)
        .accessibilityLabel(marked ? "\(layer.title)，\(StatusLegendId.running.label)" : layer.title)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var chatsHeader: some View {
        HStack(spacing: 8) {
            Text("工作区对话")
                .font(JieboFont.text(.caption, weight: .medium))
                .tracking(0.6)
                .foregroundStyle(JieboColor.dim)
            Spacer(minLength: 8)
            Button(action: store.openNewChat) {
                Label("新对话", systemImage: "square.and.pencil")
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.pine)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut("n", modifiers: .command)
        }
        .padding(.leading, 20)
        .padding(.trailing, 16)
    }

    private var footer: some View {
        HStack {
            Button {
                settingsOpen = true
            } label: {
                HStack(spacing: 6) {
                    Label("账户与设置", systemImage: NavigationIconId.account.symbol)
                        .font(JieboFont.text(.subheadline, weight: .medium))
                        .foregroundStyle(JieboColor.ink2)
                    if im.totalUnread > 0 {
                        ImUnreadBadge(count: im.totalUnread)
                    }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(im.totalUnread > 0 ? "账户与设置，聊天有 \(im.totalUnread) 条未读" : "账户与设置")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .overlay(alignment: .top) {
            Rectangle().fill(JieboColor.line).frame(height: 1)
        }
    }

    private var loopLive: Bool {
        guard let row = store.loops[store.activeId] else { return false }
        return row.status == "armed" || row.status == "running"
    }

    // MARK: 会话行

    private func chatRow(_ chat: ChatSession) -> some View {
        let selected = chat.id == store.activeId
        let live = chat.turns.contains(where: \.running) || store.runningChatIds.contains(chat.id)
        return Button {
            store.select(chat.id)
        } label: {
            HStack(spacing: 8) {
                Capsule()
                    .fill(selected ? JieboColor.pine : Color.clear)
                    .frame(width: 3, height: 22)
                    .accessibilityHidden(true)
                Text(chat.title)
                    .font(JieboFont.text(.subheadline, weight: chat.unread ? .semibold : .regular))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if selected {
                    Text("当前")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(JieboColor.pine.opacity(0.12))
                        .clipShape(Capsule())
                        .accessibilityHidden(true)
                } else if !live, let touched = chat.touchedAt {
                    AgoLabel(epochMs: touched, font: JieboFont.text(.caption2))
                }
                if live {
                    Text("跑")
                        .font(JieboFont.text(.caption2, weight: .medium))
                        .foregroundStyle(JieboColor.run)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(JieboColor.runBg)
                        .clipShape(Capsule())
                } else if chat.unread {
                    Circle().fill(JieboColor.pine).frame(width: 6, height: 6)
                }
            }
            .foregroundStyle(JieboColor.ink)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(selected ? JieboColor.pine.opacity(0.1) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(selected ? JieboColor.pine.opacity(0.42) : Color.clear, lineWidth: 1)
            )
            .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 10, style: .continuous))
            .hoverEffect(.highlight)
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel([
            chat.title,
            selected ? "当前工作区会话" : nil,
            live ? StatusLegendId.running.label : nil
        ].compactMap { $0 }.joined(separator: "，"))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .chatRowMenu(
            chat,
            rename: { chatActions.beginRename($0) },
            delete: { chatActions.delete = $0 }
        )
    }
}
