import SwiftUI
import UIKit

/// iPad 登录后的两个主页：工作台（原来的界面）和聊天（平台用户之间即时消息）
enum HomeMode: String, CaseIterable, Identifiable {
    case workbench
    case chat

    static let storageKey = "jiebo.homeMode"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .workbench: return "工作台"
        case .chat: return "聊天"
        }
    }

    var symbol: String {
        switch self {
        case .workbench: return "rectangle.3.group"
        case .chat: return "bubble.left.and.bubble.right"
        }
    }
}

private struct HomeActiveKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    /// 这一层主页现在在前面。藏起来的那层别弹全屏盖子
    var homeActive: Bool {
        get { self[HomeActiveKey.self] }
        set { self[HomeActiveKey.self] = newValue }
    }
}

/// iPhone 直接进入三入口 PhoneTabShell；iPad 的两个主页继续常驻并保留 HomeMode。
struct HomeShell: View {
    @Environment(ChatStore.self) private var store
    @Environment(ImStore.self) private var im
    @Environment(DeviceBridgeCoordinator.self) private var deviceBridge
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(HomeMode.storageKey) private var mode: HomeMode = .workbench

    var body: some View {
        Group {
            if UIDevice.current.userInterfaceIdiom == .phone {
                PhoneTabShell()
            } else {
                padHomes
            }
        }
        // iPhone、iPad 共用唯一确认承载点；只要主页在线就能安全声明 device_bridge。
        .sheet(item: confirmationBinding) { draft in
            DeviceWriteConfirmationSheet(draft: draft)
        }
        .onAppear {
            deviceBridge.setConfirmationPresenter(active: true)
        }
        .onDisappear {
            deviceBridge.setConfirmationPresenter(active: false)
        }
    }

    private var confirmationBinding: Binding<DeviceWriteConfirmation?> {
        Binding(
            get: { deviceBridge.confirmation },
            set: { value in
                if value == nil, deviceBridge.confirmation != nil {
                    deviceBridge.resolveConfirmation(allowed: false)
                }
            }
        )
    }

    private var padHomes: some View {
        ZStack {
            WorkbenchView()
                .homeLayer(visible: mode == .workbench, reduceMotion: reduceMotion)
            ChatHome()
                .homeLayer(visible: mode == .chat, reduceMotion: reduceMotion)
        }
        .onAppear {
            im.setHomeVisible(mode == .chat)
            dispatchPush()
        }
        .onChange(of: mode) { _, next in
            im.setHomeVisible(next == .chat)
        }
        .onChange(of: PushRouting.shared.pending) { _, _ in
            dispatchPush()
        }
    }

    /// iPad 点通知：聊天通知切到聊天主页；助理通知不订阅，直接丢弃。
    private func dispatchPush() {
        guard let target = PushRouting.shared.pending else { return }
        if target.isIm, let convId = target.convId {
            _ = PushRouting.shared.consume()
            mode = .chat
            openConversation(convId)
        } else if target.isWorkspace, let chatId = target.chatId {
            _ = PushRouting.shared.consume()
            mode = .chat
            openWorkspace(chatId)
        } else {
            // iPad 不订阅助理推送，没有壳会来取，丢掉免得一直挂着
            _ = PushRouting.shared.consume()
        }
    }

    private func openWorkspace(_ chatId: String) {
        Task { @MainActor in
            store.requestWorkspaceAgents()
            while store.workspaceAgent(chatId: chatId) == nil, !store.workspaceAgentsLoaded {
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled else { return }
            }
            guard let item = store.workspaceAgent(chatId: chatId) else { return }
            store.chatHomeDestination = .workspace(item.path)
            store.enterWorkspaceThread(path: item.path, chatId: chatId)
        }
    }

    /// 冷启动时自己的 id 可能还没读出来：等一会儿再算对方是谁
    private func openConversation(_ convId: String) {
        Task { @MainActor in
            var waited = 0
            while ImConv.peer(of: convId, me: im.meId) == nil, waited < 80 {
                try? await Task.sleep(for: .milliseconds(100))
                waited += 1
            }
            guard let peer = ImConv.peer(of: convId, me: im.meId) else { return }
            im.selectedPeer = peer
            store.chatHomeDestination = .person(peer)
        }
    }
}

extension View {
    fileprivate func homeLayer(visible: Bool, reduceMotion: Bool) -> some View {
        opacity(visible ? 1 : 0)
            // 两层始终常驻，只让透明度交叉变化，保留各自导航和滚动状态。
            .animation(JieboMotion.standard(reduceMotion), value: visible)
            .allowsHitTesting(visible)
            .accessibilityHidden(!visible)
            .disabled(!visible)
            .environment(\.homeActive, visible)
            .zIndex(visible ? 1 : 0)
    }
}

/// 设置页顶上的「主页」：工作台 / 聊天二选一
struct HomeModeSection: View {
    @AppStorage(HomeMode.storageKey) private var mode: HomeMode = .workbench
    var onPick: (HomeMode) -> Void = { _ in }

    var body: some View {
        Section {
            ForEach(HomeMode.allCases) { item in
                Button {
                    mode = item
                    onPick(item)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: item.symbol)
                            .font(JieboFont.text(.subheadline, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                            .frame(width: 24)
                        Text(item.title)
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                        Spacer(minLength: 8)
                        if mode == item {
                            Image(systemName: "checkmark")
                                .font(JieboFont.text(.subheadline, weight: .semibold))
                                .foregroundStyle(JieboColor.pine)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(JieboColor.white)
                .accessibilityAddTraits(mode == item ? .isSelected : [])
            }
        } header: {
            Text("主页")
        } footer: {
            Text("聊天是和平台上的其他人发消息。随时可以切回来，工作台里正在跑的对话不受影响。")
        }
    }
}

/// 聊天未读的红色数字（≥1000 显示 999+）
struct ImUnreadBadge: View {
    var count: Int

    var body: some View {
        Text(ImFormat.badge(count))
            .font(JieboFont.text(.caption2, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .frame(minWidth: 16, minHeight: 16)
            .background(JieboColor.danger)
            .clipShape(Capsule())
            .accessibilityHidden(true)
    }
}
