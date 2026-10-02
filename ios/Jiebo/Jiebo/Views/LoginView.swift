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
                VStack(alignment: .leading, spacing: 14) {
                    JieboMark(size: 44)
                    Text("接驳")
                        .font(JieboFont.display(30))
                        .tracking(1.2)
                        .foregroundStyle(JieboColor.ink)
                    Text("网页说话，远端动手。先输入密码。")
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.ink2)
                    SecureField("密码", text: $store.tokenDraft)
                        .textContentType(.password)
                        .font(JieboFont.ui(17))
                        .padding(.horizontal, 14)
                        .frame(height: 44)
                        .background(JieboColor.composer)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                                .stroke(focused ? JieboColor.pine.opacity(0.45) : JieboColor.borderStrong, lineWidth: 1)
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
                            .font(JieboFont.ui(16, weight: .medium))
                            .foregroundStyle(canEnter || store.verifying ? JieboColor.fillFg : JieboColor.ink2)
                            .frame(maxWidth: .infinity)
                            .frame(height: 44)
                            .background(canEnter || store.verifying ? JieboColor.pine : JieboColor.mist)
                            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                                    .stroke(canEnter || store.verifying ? Color.clear : JieboColor.line, lineWidth: 1)
                            )
                    }
                    .buttonStyle(PressScaleButtonStyle(enabled: canEnter))
                    .disabled(!canEnter)
                    Text(store.connected ? "已连上服务器" : "正在连接服务器…")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                }
                .padding(EdgeInsets(top: 32, leading: 28, bottom: 24, trailing: 28))
                .frame(maxWidth: 380)
                .background(JieboColor.white)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: JieboRadius.lg, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                )
                .shadow(color: Color(hex: 0x1C1916, alpha: 0.05), radius: 1, y: 1)
                .shadow(color: Color(hex: 0x1C1916, alpha: 0.08), radius: 16, y: 12)
                Spacer()
            }
            .padding(32)
        }
        .onAppear { focused = true }
    }
}
