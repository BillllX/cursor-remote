import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

extension ComposerView {
    @ViewBuilder
    var controls: some View {
        if style == .full {
            fullControls
        }
    }

    private var fullControls: some View {
        HStack(alignment: .center, spacing: 8) {
            attachMenu
            if controlsWidth >= 420 {
                modePicker
                modelPicker(maxWidth: 180)
            } else {
                compactMode
                modelPicker(maxWidth: 108)
            }
            if controlsWidth >= 640 {
                policyToggle
                confirmToggle
            } else {
                moreMenu
            }
            Spacer(minLength: 8)
            // 聚焦后输入框上的长按说话会被键盘盖住，没字可发时给一个点按的话筒
            if !canSendNow || dictation.active {
                micButton
            }
            sendCluster(enabled: canSendNow)
        }
        .animation(JieboMotion.snappy(reduceMotion), value: canSendNow)
        .background {
            GeometryReader { geo in
                Color.clear
                    .onAppear { controlsWidth = geo.size.width }
                    .onChange(of: geo.size.width) { _, width in
                        if abs(width - controlsWidth) > 1 { controlsWidth = width }
                    }
            }
        }
    }

    private func sendCluster(enabled: Bool) -> some View {
        HStack(spacing: 8) {
            if store.busy {
                Button(action: store.stop) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(JieboColor.paper)
                        .frame(width: 32, height: 32)
                        .background(JieboColor.danger)
                        .clipShape(Circle())
                        .hitTarget()
                }
                .buttonStyle(PressScaleButtonStyle())
                .accessibilityLabel("停止")
                .transition(.scale.combined(with: .opacity))
            }
            Button(action: commitAndSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(enabled ? JieboColor.paper : JieboColor.dim.opacity(0.45))
                    .frame(width: 32, height: 32)
                    .background(enabled ? JieboColor.pine : JieboColor.mist.opacity(0.55))
                    .clipShape(Circle())
                    .scaleEffect(enabled ? 1 : 0.94)
                    .animation(JieboMotion.snappy(reduceMotion), value: enabled)
                    .hitTarget()
            }
            .buttonStyle(PressScaleButtonStyle(enabled: enabled))
            .disabled(!enabled)
            .keyboardShortcut(.return, modifiers: .command)
            .accessibilityLabel("发送")
        }
    }

    private var moreMenu: some View {
        let plane = store.active?.policy == "plane"
        let confirm = store.active?.confirmWrites == true
        return Menu {
            if style == .assistant {
                Menu {
                    ForEach(AgentMode.allCases, id: \.self) { item in
                        Button {
                            store.chooseMode(item)
                        } label: {
                            Label(item.label, systemImage: store.mode == item ? "checkmark" : "circle")
                        }
                    }
                } label: {
                    Label("模式 · \(store.mode.label)", systemImage: "slider.horizontal.3")
                }
                Menu {
                    ForEach(ModelCatalog.groups(from: store.models)) { group in
                        Section(group.label) {
                            ForEach(group.models) { item in
                                Button(item.name) { store.chooseModel(item.id) }
                            }
                        }
                    }
                } label: {
                    Label("模型 · \(ModelCatalog.label(for: store.model))", systemImage: "cpu")
                }
                Divider()
            }
            Button(action: store.togglePolicy) {
                Label(plane ? "正在用策略层" : "切到策略层", systemImage: plane ? "checkmark" : "circle")
            }
            Button(action: store.toggleConfirmWrites) {
                Label(confirm ? "确认写" : "直写", systemImage: confirm ? "checkmark.shield.fill" : "checkmark.shield")
            }
            Button(action: store.undoLast) {
                Label("撤销上一次", systemImage: "arrow.uturn.backward")
            }
            .disabled(!store.canUndo)
            if store.checkpoints.isEmpty {
                Button(store.mode == .ask ? "只问不会打检查点" : "动手或出方案时会记下检查点") {}
                    .disabled(true)
            } else {
                ForEach(store.checkpoints) { item in
                    Button("还原 · \(item.label)") { store.restoreCheckpoint(item.id) }
                        .disabled(store.busy)
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 32, height: 32)
                .background(Color.clear)
                .clipShape(Circle())
                .overlay(Circle().stroke(JieboColor.line, lineWidth: 1))
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("更多")
    }

    private var attachMenu: some View {
        Menu {
            // PhotosPicker 不能直接嵌在 Menu 内容里：iPadOS 上菜单关闭后选择器视图随之销毁，
            // 表现为点了「照片」没反应或选完不回传——改用 isPresented 修饰符挂在稳定视图上
            Button {
                photoPickerOpen = true
            } label: {
                Label("照片", systemImage: "photo")
            }
            Button {
                filePickerOpen = true
            } label: {
                Label("文件", systemImage: "doc")
            }
            if style == .full {
                Button {
                    fileBrowserOpen = true
                } label: {
                    Label("工作区文件…", systemImage: "folder")
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 32, height: 32)
                .background(Color.clear)
                .clipShape(Circle())
                .overlay(Circle().stroke(JieboColor.line, lineWidth: 1))
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("添加附件")
    }

    private var confirmToggle: some View {
        let on = store.active?.confirmWrites == true
        return Button(action: store.toggleConfirmWrites) {
            HStack(spacing: 4) {
                Image(systemName: on ? "checkmark.shield.fill" : "checkmark.shield")
                    .font(.system(size: 11, weight: .regular))
                Text(on ? "确认写" : "直写")
                    .font(JieboFont.text(.caption2, weight: .regular))
            }
            // 次级：关态 ink2 可读、无填充；开态浅 brass；字号 11 让出主焦点给模式/模型
            .foregroundStyle(on ? JieboColor.brass : JieboColor.ink2)
            .padding(.horizontal, 10)
            .frame(minHeight: 32)
            .background(on ? JieboColor.brass.opacity(0.10) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .hitTarget() // P6：视觉 32 高，命中 44
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(on ? "写入前确认" : "自动写入")
    }

    private var policyToggle: some View {
        let plane = store.active?.policy == "plane"
        return Button(action: store.togglePolicy) {
            Text(plane ? "策略层" : "现状")
                .font(JieboFont.text(.caption2, weight: .regular))
                .foregroundStyle(plane ? JieboColor.brass : JieboColor.ink2)
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .background(plane ? JieboColor.brass.opacity(0.10) : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(plane ? "策略层" : "现状路径")
    }

    private var modePicker: some View {
        HStack(spacing: 0) {
            ForEach(AgentMode.allCases, id: \.self) { item in
                Button {
                    store.chooseMode(item)
                } label: {
                    Text(item.label)
                        .font(JieboFont.text(.footnote, weight: .medium))
                        .foregroundStyle(store.mode == item ? JieboColor.ink : JieboColor.ink2)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 32)
                        .background {
                            if store.mode == item {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(JieboColor.ink.opacity(0.06))
                                    .matchedGeometryEffect(id: "mode-thumb", in: modeThumb)
                            }
                        }
                        .hitTarget() // P6：滑块视觉 32 高不变，命中 44
                }
                .buttonStyle(PressScaleButtonStyle())
            }
        }
        .padding(2)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(JieboColor.line, lineWidth: 1)
        )
        .animation(JieboMotion.snappy(reduceMotion), value: store.mode)
    }

    private var compactMode: some View {
        Menu {
            ForEach(AgentMode.allCases, id: \.self) { item in
                Button(item.label) { store.chooseMode(item) }
            }
        } label: {
            Text(store.mode.label)
                .font(JieboFont.text(.footnote, weight: .medium))
                .foregroundStyle(JieboColor.ink)
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .background(Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(JieboColor.line, lineWidth: 1)
                )
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("模式 \(store.mode.label)")
    }

    private func modelPicker(maxWidth: CGFloat) -> some View {
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
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 32)
            .frame(maxWidth: maxWidth)
            .background(Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
            .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
    }
}
