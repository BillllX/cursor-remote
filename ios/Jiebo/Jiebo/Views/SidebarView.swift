import SwiftUI
import UIKit

/// iPad 常驻侧栏，层次和手机抽屉一致：助理 → 当前工作区（切换、工具、这个工作区的对话）→ 底部设置。
/// 多出来的只有收起按钮；点对话不收起侧栏。
struct SidebarView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var collapse: () -> Void = {}
    @State private var chatActions = ChatActionTargets()
    /// P9：管理员统计面板
    @State private var adminStatsOpen = false
    @State private var themeOpen = false
    @State private var logoutConfirm = false

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
                            .font(JieboFont.ui(13))
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
        .sheet(isPresented: $themeOpen) {
            ThemeSettingsSheet()
        }
        .sheet(isPresented: $adminStatsOpen) {
            AdminStatsView()
        }
        .chatActionAlerts($chatActions)
        .confirmationDialog("退出登录？", isPresented: $logoutConfirm, titleVisibility: .visible) {
            Button("退出登录", role: .destructive, action: store.logout)
            Button("取消", role: .cancel) {}
        } message: {
            Text("退出后需要重新输入访问码才能连回来。")
        }
    }

    private var brandBar: some View {
        HStack(spacing: 10) {
            JieboMark(size: 22)
            Text("接驳")
                .font(JieboFont.display(17))
                .tracking(0.34)
                .foregroundStyle(JieboColor.ink)
            Spacer(minLength: 8)
            LinkStatusDot(state: store.linkState, size: 8)
                .accessibilityHidden(true)
            Text(store.linkState.title)
                .font(JieboFont.ui(12))
                .foregroundStyle(JieboColor.dim)
                .lineLimit(1)
            Button(action: collapse) {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleButtonStyle())
            .accessibilityLabel("收起侧栏")
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 12)
    }

    private var workspaceCard: some View {
        Button(action: store.openWorkspaceSwitcher) {
            HStack(spacing: 10) {
                Image(systemName: "folder")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(JieboColor.brass)
                    .frame(width: 30, height: 30)
                    .background(JieboColor.brass.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text("当前工作区")
                        .font(JieboFont.ui(11))
                        .foregroundStyle(JieboColor.dim)
                    Text(store.currentWorkspaceName)
                        .font(JieboFont.ui(15, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 12, weight: .semibold))
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
        HStack(spacing: 0) {
            ForEach(ToolLayer.workTools) { layer in
                toolButton(layer)
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
                    .font(JieboFont.ui(11, weight: on ? .semibold : .regular))
                    .foregroundStyle(on ? JieboColor.ink : JieboColor.dim)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleButtonStyle())
        .animation(JieboMotion.fade(reduceMotion), value: on)
        .accessibilityLabel(marked ? "\(layer.title)，正在运行" : layer.title)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var chatsHeader: some View {
        HStack(spacing: 8) {
            Text("对话")
                .font(JieboFont.ui(12, weight: .medium))
                .tracking(0.6)
                .foregroundStyle(JieboColor.dim)
            Spacer(minLength: 8)
            Button(action: store.openNewChat) {
                Label("新对话", systemImage: "square.and.pencil")
                    .font(JieboFont.ui(13, weight: .medium))
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
            Menu {
                Button { themeOpen = true } label: {
                    Label("主题 · \(JieboTheme.shared.palette.title)", systemImage: "paintpalette")
                }
                if store.isAdmin {
                    Button { adminStatsOpen = true } label: {
                        Label("使用统计", systemImage: "chart.bar")
                    }
                }
                Divider()
                Button(role: .destructive) { logoutConfirm = true } label: {
                    Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                Label("设置", systemImage: "gearshape")
                    .font(JieboFont.ui(14, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
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
                Text(chat.title)
                    .font(JieboFont.ui(15, weight: chat.unread ? .semibold : .regular))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if !live, let touched = chat.touchedAt {
                    AgoLabel(epochMs: touched, font: JieboFont.ui(11))
                }
                if live {
                    Text("跑")
                        .font(JieboFont.ui(10, weight: .medium))
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
            .background(selected ? JieboColor.white : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(selected ? JieboColor.line : Color.clear, lineWidth: 1)
            )
            .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 10, style: .continuous))
            .hoverEffect(.highlight)
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(live ? "\(chat.title)，正在运行" : chat.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .chatRowMenu(
            chat,
            rename: { chatActions.beginRename($0) },
            delete: { chatActions.delete = $0 }
        )
    }
}
