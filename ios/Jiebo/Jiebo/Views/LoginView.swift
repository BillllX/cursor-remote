import SwiftUI

struct LoginView: View {
    @Environment(ChatStore.self) private var store
    @FocusState private var focused: Bool

    private var canEnter: Bool {
        !store.tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !store.verifying
    }

    var body: some View {
        @Bindable var store = store
        ZStack {
            JieboColor.paper.ignoresSafeArea()
            Circle()
                .fill(JieboColor.pine.opacity(0.22))
                .frame(width: 280, height: 280)
                .blur(radius: 40)
                .offset(x: -120, y: -220)
            Circle()
                .fill(JieboColor.clay.opacity(0.18))
                .frame(width: 240, height: 240)
                .blur(radius: 36)
                .offset(x: 140, y: 180)
            VStack(spacing: 0) {
                Spacer()
                VStack(alignment: .leading, spacing: 14) {
                    JieboMark(size: 44)
                    Text("接驳")
                        .font(JieboFont.display(30))
                        .tracking(1.2)
                        .foregroundStyle(JieboColor.ink)
                    Text("小驳跟着你，远端替你动手。输入访问码进入。")
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.ink2)
                    GlassEffectContainer(spacing: 12) {
                        VStack(alignment: .leading, spacing: 14) {
                            SecureField("访问码", text: $store.tokenDraft)
                                .textContentType(.password)
                                .font(JieboFont.text(.body))
                                .padding(.horizontal, 14)
                                .frame(minHeight: 44)
                                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 16))
                                .focused($focused)
                                .onSubmit { store.login() }
                            if !store.authError.isEmpty {
                                Text(friendlyError(store.authError))
                                    .font(JieboFont.text(.subheadline))
                                    .foregroundStyle(JieboColor.danger)
                            }
                            Button(action: store.login) {
                                Text(store.verifying ? "正在验证…" : "进入")
                                    .font(JieboFont.text(.callout, weight: .medium))
                                    .frame(maxWidth: .infinity)
                                    .frame(minHeight: 44)
                            }
                            .buttonStyle(.glassProminent)
                            .disabled(!canEnter)
                        }
                    }
                    Text(loginStatusLine)
                        .font(JieboFont.text(.caption, weight: store.linkState == .offline ? .medium : .regular))
                        .foregroundStyle(store.linkState == .offline ? JieboColor.danger : JieboColor.dim)
                        .frame(maxWidth: .infinity, minHeight: store.linkState == .offline ? 44 : 0, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if store.linkState == .offline { store.retryConnection() }
                        }
                        .accessibilityAddTraits(store.linkState == .offline ? .isButton : [])
                        .accessibilityHint(store.linkState == .offline ? "重新连接" : "")
                }
                .padding(EdgeInsets(top: 32, leading: 28, bottom: 24, trailing: 28))
                .frame(maxWidth: 380)
                Spacer()
            }
            .padding(32)
        }
        .onAppear { focused = true }
    }

    /// 核对访问码时不要再写「已连上」：线是通的，身份还没对上。
    private var loginStatusLine: String {
        if store.verifying { return "正在核对访问码" }
        return store.connected ? "已连上服务器" : store.linkState.title
    }
}
