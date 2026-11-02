import SwiftUI
import UIKit

/// 会话的重命名 / 删除目标。iPad 侧栏和窄窗抽屉共用：提示要挂在不会消失的宿主上，抽屉一关挂在它身上的 alert 会跟着没
struct ChatActionTargets {
    var rename: ChatSession?
    var draft = ""
    var delete: ChatSession?

    mutating func beginRename(_ chat: ChatSession) {
        draft = chat.isUntitled ? "" : chat.title
        rename = chat
    }
}

extension View {
    /// 会话行的长按菜单
    func chatRowMenu(
        _ chat: ChatSession,
        rename: @escaping (ChatSession) -> Void,
        delete: @escaping (ChatSession) -> Void
    ) -> some View {
        contextMenu {
            Button { rename(chat) } label: {
                Label("重命名", systemImage: "pencil")
            }
            Button(role: .destructive) { delete(chat) } label: {
                Label("删除", systemImage: "trash")
            }
        }
    }

    func chatActionAlerts(_ targets: Binding<ChatActionTargets>) -> some View {
        modifier(ChatActionAlerts(targets: targets))
    }
}

private struct ChatActionAlerts: ViewModifier {
    @Environment(ChatStore.self) private var store
    @Binding var targets: ChatActionTargets

    func body(content: Content) -> some View {
        content
            .alert(
                "重命名会话",
                isPresented: Binding(get: { targets.rename != nil }, set: { if !$0 { targets.rename = nil } }),
                presenting: targets.rename
            ) { chat in
                TextField("对话标题", text: $targets.draft)
                    .textInputAutocapitalization(.sentences)
                Button("取消", role: .cancel) { targets.rename = nil }
                Button("确定") {
                    store.renameChat(chat.id, to: targets.draft)
                    targets.rename = nil
                }
            } message: { chat in
                Text(store.cachedOnlyIds.contains(chat.id)
                    ? "「\(chat.title)」还没对上服务器，现在改名不会留下。"
                    : store.connected
                        ? "「\(chat.title)」改名后，其他设备也会看到。"
                        : "还没连上。「\(chat.title)」会先在这台设备改名，连上后其他设备也会看到。")
            }
            .alert(
                "删除这个会话？",
                isPresented: Binding(get: { targets.delete != nil }, set: { if !$0 { targets.delete = nil } }),
                presenting: targets.delete
            ) { chat in
                Button("删除", role: .destructive) {
                    store.deleteChat(chat.id)
                    targets.delete = nil
                }
                Button("取消", role: .cancel) { targets.delete = nil }
            } message: { chat in
                Text(store.connected
                    ? "「\(chat.title)」会从列表里去掉，其他设备上也看不到。"
                    : "「\(chat.title)」会先从这台设备去掉。连上后，其他设备上也看不到。")
            }
    }
}
