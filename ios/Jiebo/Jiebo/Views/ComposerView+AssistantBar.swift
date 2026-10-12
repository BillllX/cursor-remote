import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

extension ComposerView {
    /// iPhone 助理：单行胶囊 — ＋（含 ⋯ 项）、输入、话筒/发送
    var assistantCapsuleRow: some View {
        HStack(alignment: .bottom, spacing: 6) {
            assistantAttachMenu
            TextField(placeholder, text: $text, axis: .vertical)
                .font(JieboFont.text(.body))
                .foregroundStyle(JieboColor.ink)
                .lineLimit(1...6)
                .focused($focused)
                .background(TextViewKeyboardInsetLock())
                .padding(.vertical, 11)
                .overlay {
                    if !focused || dictation.active {
                        Color.clear
                            .contentShape(Rectangle())
                            .gesture(holdToTalk)
                            .accessibilityHidden(true)
                    }
                }
                .onChange(of: text) { _, value in
                    if value.contains("@") || !store.mentionSuggestions.isEmpty {
                        store.updateMentions(for: value)
                    }
                    schedulePersist()
                }
            // 忙碌时停止和发送并存：发送会排在当前这轮之后（与 iPad 的完整输入框一致）
            if store.busy {
                if !canSendNow { micButton }
                stopButton
                if canSendNow { sendButton(queued: true) }
            } else if canSendNow {
                sendButton(queued: false)
            } else {
                micButton
            }
        }
        .padding(.leading, 4)
        .padding(.trailing, 4)
        .padding(.vertical, 2)
        .animation(JieboMotion.snappy(reduceMotion), value: store.busy)
        .animation(JieboMotion.snappy(reduceMotion), value: canSendNow)
        .modifier(CapsuleSurface(focused: focused))
    }

    private var stopButton: some View {
        Button(action: store.stop) {
            Image(systemName: "stop.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(JieboColor.danger)
                .frame(width: 36, height: 36)
                .background(JieboColor.dangerBg)
                .clipShape(Circle())
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .transition(.scale.combined(with: .opacity))
        .accessibilityLabel("停止回复")
    }

    private func sendButton(queued: Bool) -> some View {
        Button(action: commitAndSend) {
            Image(systemName: "arrow.up")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(JieboColor.fillFg)
                .frame(width: 36, height: 36)
                .background(JieboColor.pine)
                .clipShape(Circle())
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .transition(.scale.combined(with: .opacity))
        .keyboardShortcut(.return, modifiers: .command)
        .accessibilityLabel(queued ? "排队发送" : "发送")
        .accessibilityHint(queued ? "当前回复结束后再发" : "")
    }

    /// 胶囊上方一行小字：当前模式和模型。原来只藏在「＋」里，看不出这次会不会动手改文件
    var assistantStatusLine: some View {
        Menu {
            Picker(selection: Binding(get: { store.mode }, set: { store.chooseMode($0) })) {
                ForEach(AgentMode.allCases, id: \.self) { item in
                    Text(item.label).tag(item)
                }
            } label: {
                Label("模式", systemImage: "slider.horizontal.3")
            }
            .pickerStyle(.menu)
            Picker(selection: Binding(get: { store.model }, set: { store.chooseModel($0) })) {
                ForEach(ModelCatalog.groups(from: store.models)) { group in
                    Section(group.label) {
                        ForEach(group.models) { item in
                            Text(item.name).tag(item.id)
                        }
                    }
                }
            } label: {
                Label("模型", systemImage: "cpu")
            }
            .pickerStyle(.menu)
        } label: {
            HStack(spacing: 4) {
                Text(store.mode.label)
                    .foregroundStyle(store.mode == .agent ? JieboColor.ink2 : JieboColor.pine)
                Text("·")
                Text(ModelCatalog.label(for: store.model))
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .accessibilityHidden(true)
            }
            .font(JieboFont.text(.caption, weight: .medium))
            .foregroundStyle(JieboColor.dim)
            .padding(.horizontal, 10)
            .frame(minHeight: 24)
            // 浮在消息上时没有底，字会和正文叠在一起
            .jieboGlass(in: Capsule())
            .contentShape(Capsule())
        }
        .menuOrder(.fixed)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, -4)
        .accessibilityLabel("模式 \(store.mode.label)，模型 \(ModelCatalog.label(for: store.model))")
        .accessibilityHint("轻点切换")
    }

    private var assistantAttachMenu: some View {
        Menu {
            Button { photoPickerOpen = true } label: { Label("照片", systemImage: "photo") }
            Button { filePickerOpen = true } label: { Label("文件", systemImage: "doc") }
            Section {
                Toggle(isOn: Binding(get: { store.active?.policy == "plane" }, set: { on in
                    if on != (store.active?.policy == "plane") { store.togglePolicy() }
                })) {
                    Label("策略层", systemImage: "square.stack.3d.up")
                }
                Toggle(isOn: Binding(get: { store.active?.confirmWrites == true }, set: { on in
                    if on != (store.active?.confirmWrites == true) { store.toggleConfirmWrites() }
                })) {
                    Label("写入前确认", systemImage: "checkmark.shield")
                }
            }
            Section {
                Button(action: store.undoLast) {
                    Label("撤销上一次", systemImage: "arrow.uturn.backward")
                }
                .disabled(!store.canUndo)
                if !store.checkpoints.isEmpty {
                    Menu {
                        ForEach(store.checkpoints) { item in
                            Button(item.label) { store.restoreCheckpoint(item.id) }
                                .disabled(store.busy)
                        }
                    } label: {
                        Label("还原到检查点", systemImage: "clock.arrow.circlepath")
                    }
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 36, height: 36)
                .hitTarget()
        }
        .menuOrder(.fixed)
        .accessibilityLabel("添加与更多")
    }

    var micButton: some View {
        let recording = dictation.active
        return Button(action: toggleVoice) {
            Image(systemName: recording ? "mic.fill" : "mic")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(recording ? JieboColor.pine : JieboColor.ink2)
                .frame(width: 36, height: 36)
                .background(recording ? JieboColor.pine.opacity(0.14) : Color.clear)
                .clipShape(Circle())
                .symbolEffect(.pulse, isActive: recording && !reduceMotion)
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .transition(.scale.combined(with: .opacity))
        .accessibilityLabel(recording ? "结束录音" : "语音输入")
    }
}

/// iPhone 助理输入胶囊的底：iOS 26+ 是浮在内容上的 Liquid Glass（聚焦时描一圈强调色），更早的系统保留原来的实底 + 阴影
private struct CapsuleSurface: ViewModifier {
    var focused: Bool

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: shape)
                .overlay(shape.stroke(JieboColor.pine.opacity(focused ? 0.35 : 0), lineWidth: 1))
        } else {
            content.background {
                shape
                    .fill(JieboColor.composer)
                    .shadow(color: JieboColor.ink.opacity(0.05), radius: 1, y: 1)
                    .shadow(color: JieboColor.ink.opacity(focused ? 0.14 : 0.08), radius: focused ? 12 : 8, y: 4)
                    .overlay(shape.stroke(focused ? JieboColor.pine.opacity(0.4) : JieboColor.line, lineWidth: 1))
            }
        }
    }
}
