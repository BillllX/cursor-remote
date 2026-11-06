import SwiftUI
import UIKit

// MARK: 对方资料

/// 聊天页右上「…」：置顶、免打扰、清空聊天记录、拉黑
struct PeerProfileSheet: View {
    @Environment(ImStore.self) private var im
    @Environment(\.dismiss) private var dismiss
    let peer: String
    @State private var clearConfirm = false
    @State private var blockConfirm = false

    private var convId: String { im.convId(with: peer) }

    var body: some View {
        let person = im.user(peer)
        let conv = im.convs[convId]
        let blocked = im.blocked.contains(peer)
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        ImAvatar(user: person, size: 64)
                        Text(person.nickname)
                            .font(JieboFont.text(.title3, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6)
                    .listRowBackground(JieboColor.white)
                }

                Section {
                    Toggle(isOn: Binding(get: { conv?.pin ?? false }, set: { im.setPin(convId, $0) })) {
                        Text("置顶聊天")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                    }
                    .tint(JieboColor.pine)
                    .frame(minHeight: 44)
                    .disabled(!im.canChangeSettings)
                    .listRowBackground(JieboColor.white)
                    Toggle(isOn: Binding(get: { conv?.mute ?? false }, set: { im.setMute(convId, $0) })) {
                        Text("消息免打扰")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                    }
                    .tint(JieboColor.pine)
                    .frame(minHeight: 44)
                    .disabled(!im.canChangeSettings)
                    .listRowBackground(JieboColor.white)
                } footer: {
                    if !im.canChangeSettings {
                        SettingsBlockedNote()
                    }
                }

                Section {
                    Button {
                        clearConfirm = true
                    } label: {
                        Text("清空聊天记录")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.danger)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(JieboColor.white)
                    Button {
                        if blocked {
                            im.setBlocked(peer, false)
                        } else {
                            blockConfirm = true
                        }
                    } label: {
                        Text(blocked ? "解除拉黑" : "拉黑")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(blocked ? JieboColor.pine : JieboColor.danger)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(JieboColor.white)
                } footer: {
                    Text("清空只对你自己生效，对方那边的记录还在。")
                }
                .disabled(!im.canChangeSettings)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(JieboColor.paper)
            .navigationTitle("聊天信息")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .confirmationDialog("清空和「\(person.nickname)」的聊天记录？", isPresented: $clearConfirm, titleVisibility: .visible) {
                Button("清空", role: .destructive) {
                    im.clearHistory(convId)
                    dismiss()
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("你这边看不到这些消息了，对方不受影响。")
            }
            .confirmationDialog("拉黑「\(person.nickname)」？", isPresented: $blockConfirm, titleVisibility: .visible) {
                Button("拉黑", role: .destructive) {
                    im.setBlocked(peer, true)
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("拉黑后对方发来的消息不会送到你这里，对方不会收到提示。")
            }
        }
    }

}

struct SettingsBlockedNote: View {
    @Environment(ImStore.self) private var im
    @Environment(ChatStore.self) private var store

    var body: some View {
        if store.linkState == .offline {
            Button {
                store.retryConnection()
            } label: {
                Text(im.settingsBlockedTitle)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            .buttonStyle(.plain)
        } else {
            Text(im.settingsBlockedTitle)
        }
    }
}
