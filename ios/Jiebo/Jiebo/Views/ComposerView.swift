import SwiftUI

struct ComposerView: View {
    @Environment(ChatStore.self) private var store
    @FocusState private var focused: Bool

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                modePicker
                modelPicker
                Spacer()
                if store.busy {
                    Button("停止", action: store.stop)
                        .font(JieboFont.ui(14, weight: .medium))
                        .foregroundStyle(JieboColor.danger)
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("跟远端说…", text: $store.draft, axis: .vertical)
                    .font(JieboFont.ui(16))
                    .lineLimit(1...8)
                    .focused($focused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(JieboColor.white)
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                            .stroke(JieboColor.line, lineWidth: 1)
                    )
                    .onChange(of: store.draft) { _, value in
                        store.saveDraft(value)
                    }
                    .onKeyPress(.return) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        store.submit()
                        return .handled
                    }
                Button(action: store.submit) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(JieboColor.paper)
                        .frame(width: 44, height: 44)
                        .background(store.canSend ? JieboColor.pine : JieboColor.pineSoft)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(!store.canSend)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel("发送")
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 16)
        .background(JieboColor.paper)
    }

    private var modePicker: some View {
        HStack(spacing: 0) {
            ForEach(AgentMode.allCases, id: \.self) { item in
                Button {
                    store.chooseMode(item)
                } label: {
                    Text(item.label)
                        .font(JieboFont.ui(12, weight: store.mode == item ? .semibold : .regular))
                        .foregroundStyle(store.mode == item ? JieboColor.paper : JieboColor.ink2)
                        .padding(.horizontal, 10)
                        .frame(height: 32)
                        .background(store.mode == item ? JieboColor.pine : Color.clear)
                }
                .buttonStyle(.plain)
            }
        }
        .background(JieboColor.white)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        )
    }

    private var modelPicker: some View {
        Menu {
            ForEach(ModelCatalog.groups(from: store.models)) { group in
                Section(group.label) {
                    ForEach(group.models) { item in
                        Button(item.name) { store.chooseModel(item.id) }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(ModelCatalog.label(for: store.model))
                    .font(JieboFont.ui(13, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
        }
    }
}
