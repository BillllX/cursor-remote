import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct ComposerView: View {
    @Environment(ChatStore.self) private var store
    @FocusState private var focused: Bool
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var photoPickerOpen = false
    @State private var filePickerOpen = false
    @State private var fileBrowserOpen = false
    @Namespace private var modeThumb
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                attachMenu
                modePicker
                modelPicker
                Spacer()
                policyToggle
                confirmToggle
                if store.busy {
                    Button("停止", action: store.stop)
                        .font(JieboFont.ui(14, weight: .medium))
                        .foregroundStyle(JieboColor.danger)
                }
            }
            attachmentStrip
            mentionStrip
            HStack(alignment: .bottom, spacing: 10) {
                TextField("跟远端说…", text: $store.draft, axis: .vertical)
                    .font(JieboFont.ui(16))
                    .lineLimit(1...8)
                    .focused($focused)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 6)
                    .onChange(of: store.draft) { _, value in
                        store.saveDraft(value)
                    }
                    .onKeyPress(keys: [.return]) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        store.submit()
                        return .handled
                    }
                Button(action: store.submit) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(store.canSend ? JieboColor.paper : JieboColor.dim)
                        .frame(width: 32, height: 32)
                        .background(store.canSend ? JieboColor.pine : JieboColor.mist)
                        .clipShape(Circle())
                        .hitTarget() // P6：视觉 32，命中 44
                }
                .buttonStyle(.plain)
                .disabled(!store.canSend)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel("发送")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(JieboColor.composer)
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.xl, style: .continuous)
                .stroke(JieboColor.borderStrong, lineWidth: 1)
        )
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 16)
        .background(JieboColor.paper)
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
            .transition(.opacity)
        }
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
        .accessibilityLabel("添加附件")
    }

    private var confirmToggle: some View {
        let on = store.active?.confirmWrites == true
        return Button(action: store.toggleConfirmWrites) {
            HStack(spacing: 4) {
                Image(systemName: on ? "checkmark.shield.fill" : "checkmark.shield")
                    .font(.system(size: 11, weight: .semibold))
                Text(on ? "逐条确认" : "自动写入")
                    .font(JieboFont.ui(12, weight: .medium))
            }
            .foregroundStyle(on ? JieboColor.brass : JieboColor.dim)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(on ? JieboColor.brass.opacity(0.12) : JieboColor.mist)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .hitTarget() // P6：视觉 32 高，命中 44
        }
        .accessibilityLabel(on ? "写入前确认" : "自动写入")
    }

    private var policyToggle: some View {
        let plane = store.active?.policy == "plane"
        return Button(action: store.togglePolicy) {
            Text(plane ? "策略层" : "现状")
                .font(JieboFont.ui(12, weight: .medium))
                .foregroundStyle(plane ? JieboColor.brass : JieboColor.dim)
                .padding(.horizontal, 10)
                .frame(height: 32)
                .background(plane ? JieboColor.brass.opacity(0.12) : JieboColor.mist)
                .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                .hitTarget()
        }
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
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(JieboColor.line, lineWidth: 1)
        )
        .animation(reduceMotion ? nil : .easeOut(duration: 0.28), value: store.mode)
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
            .background(JieboColor.mist)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .hitTarget()
        }
    }
}
