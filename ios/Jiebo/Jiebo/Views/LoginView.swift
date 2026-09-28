import SwiftUI

struct LoginView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool

    private var canEnter: Bool {
        !store.tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !store.verifying
    }

    var body: some View {
        @Bindable var store = store
        ZStack {
            JieboColor.paper.ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer()
                VStack(alignment: .leading, spacing: 18) {
                    JieboMark(size: 56)
                    Text("接驳")
                        .font(JieboFont.display(36))
                        .foregroundStyle(JieboColor.ink)
                    Text("网页说话，远端动手。先输入密码。")
                        .font(JieboFont.ui(16))
                        .foregroundStyle(JieboColor.ink2)
                    SecureField("密码", text: $store.tokenDraft)
                        .textContentType(.password)
                        .font(JieboFont.ui(17))
                        .padding(.horizontal, 14)
                        .frame(height: 44)
                        .background(JieboColor.white)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                                .stroke(focused ? JieboColor.ink.opacity(0.28) : JieboColor.line, lineWidth: focused ? 1.5 : 1)
                        )
                        .animation(JieboMotion.fade(reduceMotion), value: focused)
                        .focused($focused)
                        .onSubmit { store.login() }
                    if !store.authError.isEmpty {
                        Text(friendlyError(store.authError))
                            .font(JieboFont.ui(14))
                            .foregroundStyle(JieboColor.danger)
                    }
                    Button(action: store.login) {
                        Text(store.verifying ? "正在验证…" : "进入")
                            .font(JieboFont.ui(16, weight: .semibold))
                            .foregroundStyle(JieboColor.paper)
                            .frame(maxWidth: .infinity)
                            .frame(height: 44)
                            .background(canEnter || store.verifying ? JieboColor.pine : JieboColor.pineSoft)
                            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                    }
                    .buttonStyle(PressScaleButtonStyle(enabled: canEnter))
                    .disabled(!canEnter)
                    Text(store.connected ? "已连上服务器" : "正在连 gateway…")
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.dim)
                }
                .padding(32)
                .frame(maxWidth: 440)
                .background(JieboColor.white)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                )
                Spacer()
            }
            .padding(32)
        }
        .onAppear { focused = true }
    }
}
