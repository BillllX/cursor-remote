import PhotosUI
import SwiftUI
import UIKit

/// 聊天主页左上角齿轮：主页切换、我的头像和昵称、通知预览、拉黑名单
struct ChatSettingsSheet: View {
    @Environment(ImStore.self) private var im
    @Environment(\.dismiss) private var dismiss
    @State private var nickname = ""
    @State private var avatarItem: PhotosPickerItem?
    @State private var avatarPickerOpen = false
    @State private var unblockTarget: ImUser?

    private var trimmedNickname: String {
        nickname.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            List {
                if UIDevice.current.userInterfaceIdiom == .pad {
                    HomeModeSection { mode in
                        if mode == .workbench { dismiss() }
                    }
                }

                Section {
                    Button {
                        avatarPickerOpen = true
                    } label: {
                        HStack(spacing: 14) {
                            ImAvatar(user: im.me?.user ?? ImUser(id: im.meId, nickname: "我", avatar: nil), size: 56)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("头像")
                                    .font(JieboFont.text(.subheadline))
                                    .foregroundStyle(JieboColor.ink)
                                Text("从相册选一张，会裁成正方形")
                                    .font(JieboFont.text(.caption))
                                    .foregroundStyle(JieboColor.dim)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(JieboFont.text(.caption2, weight: .semibold))
                                .foregroundStyle(JieboColor.dim)
                        }
                        .frame(minHeight: 64)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!im.canChangeSettings)
                    .listRowBackground(JieboColor.white)

                    HStack(spacing: 10) {
                        Text("昵称")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                        TextField("1 到 32 个字", text: $nickname)
                            .font(JieboFont.text(.subheadline))
                            .multilineTextAlignment(.trailing)
                            .submitLabel(.done)
                            .onSubmit(saveNickname)
                        if nicknameChanged {
                            Button("保存", action: saveNickname)
                                .font(JieboFont.text(.subheadline, weight: .semibold))
                                .foregroundStyle(JieboColor.pine)
                                .buttonStyle(.plain)
                        }
                    }
                    .frame(minHeight: 44)
                    .disabled(!im.canChangeSettings)
                    .listRowBackground(JieboColor.white)
                } header: {
                    Text("我的资料")
                } footer: {
                    if !im.canChangeSettings {
                        Text("未连接，连上服务器后才能改")
                    }
                }

                Section {
                    Toggle(isOn: Binding(
                        get: { im.me?.notifyPreview ?? false },
                        set: { im.setNotifyPreview($0) }
                    )) {
                        Text("通知显示消息内容")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                    }
                    .tint(JieboColor.pine)
                    .frame(minHeight: 44)
                    .disabled(!im.canChangeSettings || im.me == nil)
                    .listRowBackground(JieboColor.white)
                } header: {
                    Text("通知")
                } footer: {
                    Text("关着时通知只写「某某发来一条消息」，锁屏上别人看不到内容。")
                }

                Section {
                    let list = blockedUsers
                    if list.isEmpty {
                        Text("没有拉黑任何人")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.dim)
                            .listRowBackground(JieboColor.white)
                    } else {
                        ForEach(list) { user in
                            HStack(spacing: 12) {
                                ImAvatar(user: user, size: 32)
                                Text(user.nickname)
                                    .font(JieboFont.text(.subheadline))
                                    .foregroundStyle(JieboColor.ink)
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                                Button("解除") { unblockTarget = user }
                                    .font(JieboFont.text(.subheadline, weight: .medium))
                                    .foregroundStyle(JieboColor.pine)
                                    .buttonStyle(.plain)
                                    .disabled(!im.canChangeSettings)
                            }
                            .frame(minHeight: 44)
                            .listRowBackground(JieboColor.white)
                        }
                    }
                } header: {
                    Text("已拉黑")
                } footer: {
                    Text("拉黑后对方照样能发，但消息不会送到你这里。")
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(JieboColor.paper)
            .navigationTitle("聊天设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .photosPicker(isPresented: $avatarPickerOpen, selection: $avatarItem, matching: .images)
            .onChange(of: avatarItem) { _, item in
                guard let item else { return }
                avatarItem = nil
                uploadAvatar(item)
            }
            .confirmationDialog(
                "解除拉黑\(unblockTarget.map { "「\($0.nickname)」" } ?? "")？",
                isPresented: Binding(get: { unblockTarget != nil }, set: { if !$0 { unblockTarget = nil } }),
                titleVisibility: .visible
            ) {
                Button("解除拉黑") {
                    if let user = unblockTarget { im.setBlocked(user.id, false) }
                    unblockTarget = nil
                }
                Button("取消", role: .cancel) { unblockTarget = nil }
            }
            .overlay(alignment: .top) {
                ImToast(text: im.toast)
            }
        }
        .onAppear {
            nickname = im.me?.nickname ?? ""
        }
        .onChange(of: im.me?.nickname) { _, next in
            if let next { nickname = next }
        }
    }

    private var nicknameChanged: Bool {
        !trimmedNickname.isEmpty && trimmedNickname != im.me?.nickname
    }

    private var blockedUsers: [ImUser] {
        im.blocked.sorted().map { im.user($0) }
    }

    private func saveNickname() {
        guard nicknameChanged else { return }
        im.setNickname(trimmedNickname)
    }

    private func uploadAvatar(_ item: PhotosPickerItem) {
        let tenant = im.tenant
        Task { @MainActor in
            guard let picked = await ImPickTemp.load(item) else {
                im.showToast("这张图读不出来，换一张试试")
                return
            }
            let file = await Task.detached(priority: .userInitiated) { () -> String? in
                let name = ImImagePrep.avatar(file: picked, tenant: tenant)
                ImPickTemp.remove([picked])
                return name
            }.value
            guard tenant == im.tenant else { return }
            guard let file else {
                im.showToast("这张图处理不了，换一张试试")
                return
            }
            im.uploadAvatar(file: file)
        }
    }
}

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
                    .listRowBackground(JieboColor.white)
                    Toggle(isOn: Binding(get: { conv?.mute ?? false }, set: { im.setMute(convId, $0) })) {
                        Text("消息免打扰")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink)
                    }
                    .tint(JieboColor.pine)
                    .frame(minHeight: 44)
                    .listRowBackground(JieboColor.white)
                } footer: {
                    if !im.canChangeSettings {
                        Text("未连接，连上服务器后才能改")
                    }
                }
                .disabled(!im.canChangeSettings)

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
