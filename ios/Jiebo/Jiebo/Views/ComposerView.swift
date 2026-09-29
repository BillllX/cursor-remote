import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct ComposerView: View {
    @Environment(ChatStore.self) private var store
    /// 外部递增时把光标放进输入框（空会话快捷句）。
    var focusNonce: Int = 0
    @FocusState private var focused: Bool
    /// 打字只改这里。直接绑 store.draft 会让整段对话每次按键都重绘。
    @State private var text = ""
    @State private var persistTask: Task<Void, Never>?
    /// 自己写回 store.draft 时不要再灌进输入框，否则会把后打的字盖掉。
    @State private var ignoreDraftEcho: String?
    /// 工具栏宽度。只在宽度变化时重选布局，避免每个字都把两套控件量一遍。
    @State private var controlsWidth: CGFloat = 0
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var photoPickerOpen = false
    @State private var filePickerOpen = false
    @State private var fileBrowserOpen = false
    @Namespace private var modeThumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 8) {
            attachmentStrip
            mentionStrip
            TextField("跟远端说…", text: $text, axis: .vertical)
                .font(JieboFont.ui(17))
                .foregroundStyle(JieboColor.ink)
                .lineLimit(1...8)
                .focused($focused)
                .padding(.horizontal, 6)
                .padding(.vertical, 8)
                .onChange(of: text) { _, value in
                    if value.contains("@") || !store.mentionSuggestions.isEmpty {
                        store.updateMentions(for: value)
                    }
                    schedulePersist()
                }
                .onKeyPress(keys: [.return]) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    commitAndSend()
                    return .handled
                }
            controls
            if controlsWidth >= 420, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Return 发送，Shift+Return 换行")
                    .font(JieboFont.ui(11))
                    .foregroundStyle(JieboColor.dim)
                    .padding(.horizontal, 6)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background {
            // 阴影画在底上，不要挂在输入框这一层。挂在上面的话每个字都会连阴影一起重绘。
            RoundedRectangle(cornerRadius: JieboRadius.xl, style: .continuous)
                .fill(JieboColor.composer)
                .shadow(color: .black.opacity(focused ? 0.10 : 0.05), radius: focused ? 20 : 12, y: focused ? 8 : 6)
                .overlay(
                    RoundedRectangle(cornerRadius: JieboRadius.xl, style: .continuous)
                        .stroke(focused ? JieboColor.ink.opacity(0.22) : JieboColor.borderStrong, lineWidth: focused ? 1.5 : 1)
                )
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 14)
        .background(alignment: .top) {
            LinearGradient(
                colors: [JieboColor.paper.opacity(0), JieboColor.paper],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 28)
            .offset(y: -28)
            .allowsHitTesting(false)
        }
        .background(JieboColor.paper)
        .onAppear { text = store.draft }
        .onChange(of: store.activeId) { _, _ in
            persistTask?.cancel()
            text = store.draft
        }
        .onChange(of: store.draft) { _, value in
            if value == ignoreDraftEcho { return }
            if value != text { text = value }
        }
        .onChange(of: focusNonce) { _, _ in
            focused = true
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task {
                var prepared: [PendingImage] = []
                var failed = 0
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { failed += 1; continue }
                    let mime = item.supportedContentTypes.first?.preferredMIMEType
                    // 压缩 + base64 预计算放后台线程（单张 100-300ms，避免卡主 actor）
                    let image = await Task.detached(priority: .userInitiated) {
                        ImagePrep.prepare(data, mimeType: mime)
                    }.value
                    if let image {
                        prepared.append(image)
                    } else {
                        failed += 1
                    }
                }
                store.addPendingImages(prepared)
                if failed > 0 { store.flash("\(failed) 张图片读取失败，换一张试试") }
            }
        }
        .photosPicker(isPresented: $photoPickerOpen, selection: $photoItems, maxSelectionCount: ImagePrep.maxCount, matching: .images)
        .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                store.attachFiles(urls)
            }
        }
        .sheet(isPresented: $fileBrowserOpen) {
            FileBrowserSheet { path in
                store.appendMentionToDraft(path)
            }
        }
    }

    /// @补全候选条（对齐网页端 mention 下拉，iOS 用横滑芯片）
    @ViewBuilder
    private var mentionStrip: some View {
        if !store.mentionSuggestions.isEmpty {
            // 同名文件消歧：basename 有重复时显示父目录
            let names = store.mentionSuggestions.map { ($0 as NSString).lastPathComponent }
            let duplicated = Set(Dictionary(grouping: names, by: { $0 }).filter { $0.value.count > 1 }.keys)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(store.mentionSuggestions, id: \.self) { path in
                        let name = (path as NSString).lastPathComponent
                        let label = duplicated.contains(name) && path.contains("/")
                            ? (path as NSString).deletingLastPathComponent.components(separatedBy: "/").last.map { "\($0)/\(name)" } ?? name
                            : name
                        Button {
                            store.insertMention(path)
                        } label: {
                            Text("@\(label)")
                                .font(JieboFont.mono(12))
                                .foregroundStyle(JieboColor.ink)
                                .lineLimit(1)
                                .padding(.horizontal, 10)
                                .frame(height: 30)
                                .background(JieboColor.mist)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("引用 \(path)")
                    }
                }
                .padding(.horizontal, 2)
            }
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private var canSendNow: Bool {
        store.uploads.isEmpty
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.pendingImages.isEmpty)
    }

    private func schedulePersist() {
        persistTask?.cancel()
        persistTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            ignoreDraftEcho = text
            store.saveDraft(text)
        }
    }

    private func commitAndSend() {
        persistTask?.cancel()
        ignoreDraftEcho = ""
        store.saveDraft(text)
        store.submit()
        text = store.draft
    }

    private var controls: some View {
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
            sendCluster(enabled: canSendNow)
        }
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
                    .shadow(color: enabled ? JieboColor.pine.opacity(0.32) : .clear, radius: enabled ? 10 : 0, y: enabled ? 4 : 0)
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
            Button(action: store.togglePolicy) {
                Label(plane ? "正在用策略层" : "切到策略层", systemImage: plane ? "checkmark" : "circle")
            }
            Button(action: store.toggleConfirmWrites) {
                Label(confirm ? "写入前逐条确认" : "自动写入", systemImage: confirm ? "checkmark.shield.fill" : "checkmark.shield")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 32, height: 32)
                .background(JieboColor.mist)
                .clipShape(Circle())
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
            Button {
                fileBrowserOpen = true
            } label: {
                Label("工作区文件…", systemImage: "folder")
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(JieboColor.ink2)
                .frame(width: 32, height: 32)
                .background(JieboColor.mist)
                .clipShape(Circle())
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
                Text(on ? "逐条确认" : "自动写入")
                    .font(JieboFont.ui(11, weight: .regular))
            }
            // 次级：关态 ink2 可读、无填充；开态浅 brass；字号 11 让出主焦点给模式/模型
            .foregroundStyle(on ? JieboColor.brass : JieboColor.ink2)
            .padding(.horizontal, 10)
            .frame(height: 32)
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
                .font(JieboFont.ui(11, weight: .regular))
                .foregroundStyle(plane ? JieboColor.brass : JieboColor.ink2)
                .padding(.horizontal, 10)
                .frame(height: 32)
                .background(plane ? JieboColor.brass.opacity(0.10) : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel(plane ? "策略层" : "现状路径")
    }

    @ViewBuilder
    private var attachmentStrip: some View {
        if !store.pendingImages.isEmpty || !store.uploads.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(store.pendingImages) { image in
                        ZStack(alignment: .topTrailing) {
                            Group {
                                if let uiImage = UIImage(data: image.data) {
                                    Image(uiImage: uiImage)
                                        .resizable()
                                        .scaledToFill()
                                } else {
                                    JieboColor.mist
                                }
                            }
                            .frame(width: 44, height: 44)
                            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                            Button {
                                store.removePendingImage(image.id)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 16))
                                    .foregroundStyle(JieboColor.dim)
                                    .background(Circle().fill(JieboColor.paper).padding(2))
                            }
                            .offset(x: 4, y: -4)
                            .accessibilityLabel("移除图片")
                        }
                    }
                    ForEach(store.uploads) { item in
                        HStack(spacing: 6) {
                            ProgressView()
                                .controlSize(.small)
                            Text(item.name)
                                .font(JieboFont.ui(12))
                                .foregroundStyle(JieboColor.ink2)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .frame(height: 32)
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                    }
                }
                .padding(.vertical, 2)
            }
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private var modePicker: some View {
        HStack(spacing: 0) {
            ForEach(AgentMode.allCases, id: \.self) { item in
                Button {
                    store.chooseMode(item)
                } label: {
                    Text(item.label)
                        .font(JieboFont.ui(13, weight: .medium))
                        .foregroundStyle(store.mode == item ? JieboColor.ink : JieboColor.ink2)
                        .padding(.horizontal, 12)
                        .frame(height: 32)
                        .background {
                            if store.mode == item {
                                Capsule()
                                    .fill(JieboColor.hoverStrong)
                                    .matchedGeometryEffect(id: "mode-thumb", in: modeThumb)
                            }
                        }
                        .hitTarget() // P6：滑块视觉 32 高不变，命中 44
                }
                .buttonStyle(PressScaleButtonStyle())
            }
        }
        .padding(2)
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(JieboColor.line, lineWidth: 1)
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
                .font(JieboFont.ui(13, weight: .medium))
                .foregroundStyle(JieboColor.paper)
                .padding(.horizontal, 10)
                .frame(height: 32)
                .background(JieboColor.pine)
                .clipShape(Capsule())
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
                    .font(JieboFont.ui(13, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .frame(maxWidth: maxWidth)
            .background(JieboColor.mist)
            .clipShape(Capsule())
            .hitTarget()
        }
        .buttonStyle(PressScaleButtonStyle())
    }
}
