import SwiftUI

/// iPad 小驳域：今日、收件箱，以及分开的待办、计划、委派。
/// 只有“今日”挂载固定助理会话，因此任何可见时刻都只有一个可编辑 Composer。
struct PadAssistantShell: View {
    @Environment(ChatStore.self) private var store
    @Environment(PadRouter.self) private var router
    @Environment(\.assistantSceneToken) private var sceneToken
    @Environment(\.sceneSessionState) private var sceneSession
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var preferredCompactColumn = NavigationSplitViewColumn.sidebar
    @State private var containerWidth: CGFloat = 0
    @State private var settingsOpen = false

    private var projection: PadAssistantProjection {
        PadAssistantProjection(state: store.assistantState)
    }

    var body: some View {
        @Bindable var router = router
        NavigationSplitView(
            columnVisibility: $columnVisibility,
            preferredCompactColumn: $preferredCompactColumn
        ) {
            List(PadAssistantSection.allCases) { section in
                PadSectionNavigationRow(
                    section: section,
                    selected: router.assistantSection == section,
                    onOpen: {
                        router.openAssistant(
                            section: section,
                            selection: section == .today ? .assistantChat : nil
                        )
                        showDetailIfCompact()
                    },
                    onDrop: { transfers in handleNavigationDrop(transfers, section: section) }
                )
                .listRowBackground(
                    router.assistantSection == section
                        ? JieboColor.pine.opacity(0.1)
                        : JieboColor.paper
                )
                .accessibilityAddTraits(router.assistantSection == section ? .isSelected : [])
            }
            .navigationTitle("小驳")
            .navigationSplitViewColumnWidth(
                min: router.layoutMode.sidebarWidth.minimum,
                ideal: router.layoutMode.sidebarWidth.ideal,
                max: router.layoutMode.sidebarWidth.maximum
            )
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Button {
                    settingsOpen = true
                } label: {
                    Label("设置", systemImage: NavigationIconId.account.symbol)
                        .font(JieboFont.text(.subheadline, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("设置")
                .accessibilityHint("打开设置")
                .background(JieboColor.paper)
                .overlay(alignment: .top) {
                    Rectangle().fill(JieboColor.line).frame(height: 1)
                }
            }
            .sheet(isPresented: $settingsOpen) {
                NavigationStack {
                    PhoneSettingsScreen()
                        .navigationDestination(for: PhoneRoute.self) { route in
                            PhoneSettingsDestination(route: route)
                        }
                }
            }
        } detail: {
            VStack(spacing: 0) {
                if !store.connected {
                    Button {
                        store.retryConnection()
                    } label: {
                        Text(store.linkState.title)
                            .font(JieboFont.text(.caption, weight: .medium))
                            .foregroundStyle(JieboColor.danger)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .padding(.horizontal, 16)
                    }
                    .buttonStyle(.plain)
                    .disabled(store.linkState != .offline)
                    .accessibilityHint(store.linkState == .offline ? "重新连接" : "")
                } else if store.assistantThreadSyncBusy {
                    Button {
                        store.retryAssistantThreadSync()
                    } label: {
                        Text(ChatStore.syncingThreadTitle)
                            .font(JieboFont.text(.caption, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .padding(.horizontal, 16)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("再拉一次这条会话")
                } else if !store.hasApiKey {
                    Text(ChatStore.missingApiKeyTitle)
                        .font(JieboFont.text(.caption, weight: .medium))
                        .foregroundStyle(JieboColor.danger)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 16)
                        .background(JieboColor.paper)
                        .accessibilityAddTraits(.updatesFrequently)
                } else if store.connected, let title = store.backgroundAttentionTitle {
                    Button {
                        store.requestAssistant(force: true)
                    } label: {
                        Text(title)
                            .font(JieboFont.text(.caption, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                            .lineLimit(3)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .padding(.horizontal, 16)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("再向服务器确认后台模型")
                }
                sectionContent
            }
            .navigationTitle(router.assistantSection.title)
            .navigationBarTitleDisplayMode(.inline)
        }
        .navigationSplitViewStyle(.balanced)
        .background(JieboColor.paper)
        .overlay(alignment: .top) {
            if let feedback = router.dropFeedback {
                Text(feedback)
                    .font(JieboFont.text(.footnote, weight: .semibold))
                    .foregroundStyle(JieboColor.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .jieboGlass(in: Capsule(), interactive: false)
                    .padding(.top, 8)
                    .task(id: feedback) {
                        try? await Task.sleep(for: .seconds(2))
                        if router.dropFeedback == feedback { router.dropFeedback = nil }
                    }
            }
        }
        .modifier(PadAssistantSearch(enabled: router.assistantSection != .memory))
        .environment(\.assistantVoicePresenterActive, router.assistantSection == .today)
        .task {
            showDetailIfCompact()
            syncPreviewPresentation()
            store.requestAssistant(memory: router.assistantSection == .memory)
        }
        .onChange(of: router.assistantSection) { _, section in
            sceneSession?.dismissPreview()
            store.requestAssistant(memory: section == .memory, force: true)
            showDetailIfCompact()
        }
        .onDisappear {
            if router.assistantSection == .memory {
                store.requestAssistant(memory: false, force: true)
            }
        }
        .onChange(of: sizeClass) { _, next in
            updateLayout(width: containerWidth)
            if next == .compact {
                preferredCompactColumn = .detail
            } else {
                columnVisibility = .all
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .padSceneSidebarToggleRequested)) { note in
            guard let delivery = note.object as? PadSceneCommandDelivery,
                  delivery.sceneToken == sceneToken
            else { return }
            columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
        }
        .task(id: router.pendingVoiceCapture?.id) {
            guard let capture = router.takePendingVoice() else { return }
            // 等固定会话 ThreadView 的唯一 Composer 完成挂载，再交给它启动听写。
            await Task.yield()
            let delivery = AssistantVoiceDelivery(sceneToken: sceneToken, capture: capture)
            NotificationCenter.default.post(name: .assistantVoiceComposerRequested, object: delivery)
        }
        .onChange(of: sceneSession?.previewKey) { oldKey, newKey in
            if newKey != nil {
                syncPreviewPresentation()
            } else if oldKey != nil {
                router.restoreAfterPreview()
            }
        }
        .onChange(of: router.inspectorPresented) { wasPresented, isPresented in
            guard wasPresented, !isPresented, case .preview = router.inspectorMode else { return }
            sceneSession?.dismissPreview()
            router.dismissInspector()
        }
        .inspector(isPresented: $router.inspectorPresented) {
            PadUnifiedInspector()
                .inspectorColumnWidth(
                    min: router.layoutMode.inspectorWidth.minimum,
                    ideal: router.layoutMode.inspectorWidth.ideal,
                    max: router.layoutMode.inspectorWidth.maximum
                )
        }
        .overlay {
            if sceneSession?.previewFullscreen == true, let tab = sceneSession?.previewTab(in: store) {
                PreviewPanelView(tab: tab, modal: true, canFullscreen: true)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(JieboColor.white.ignoresSafeArea())
            }
        }
        // 非“今日”页没有 ThreadView，由域壳承接系统预览/分享；今日仍由唯一 ThreadView 承接，避免双重 present。
        .sheet(item: detachedPreviewFile, onDismiss: store.closePreview) { file in
            QuickLookView(file: file, onClose: { store.dismissPreviewFile() })
                .ignoresSafeArea()
        }
        .sheet(item: detachedExportFile, onDismiss: store.closeExport) { file in
            ActivityView(items: [file.url])
        }
        .background {
            GeometryReader { proxy in
                Color.clear
                    .onAppear { updateLayout(width: proxy.size.width) }
                    .onChange(of: proxy.size.width) { _, width in updateLayout(width: width) }
            }
        }
    }

    private func updateLayout(width: CGFloat) {
        containerWidth = width
        router.layoutMode = PadLayoutMode.resolve(
            width: width,
            compactSizeClass: sizeClass == .compact
        )
    }

    private func handleNavigationDrop(
        _ transfers: [PadSemanticTransfer],
        section: PadAssistantSection
    ) -> Bool {
        defer { router.activeSemanticDragKind = nil }
        if section == .memory {
            router.dropFeedback = "记忆栏目不接受拖放，请使用记忆管理操作"
            return false
        }
        guard let target = PadSemanticDropTarget(rawValue: section.rawValue) else { return false }
        guard transfers.count == 1,
              let transfer = transfers.first,
              transfer.isValid,
              target.accepts(transfer.kind),
              projection.contains(transfer)
        else {
            router.dropFeedback = "这个项目不能放到\(section.title)"
            return false
        }
        if let column = section.workColumn,
           let task = projection.personalTasks.first(where: { $0.id == transfer.stableID }),
           AssistantWorkColumn.matching(task.kind) != column
        {
            let home = AssistantWorkColumn.matching(task.kind).title
            router.dropFeedback = "「\(transfer.title)」属于\(home)"
            return false
        }
        if section == .today {
            let accepted = store.continuePadTransfer(transfer)
            if accepted { router.openAssistant() }
            router.dropFeedback = accepted ? "已把「\(transfer.title)」交给小驳" : "没有提交这个项目"
            showDetailIfCompact()
            return accepted
        }
        let selection: PadSelection? = switch transfer.kind {
        case .task: .task(transfer.stableID)
        case .inbox: .inboxItem(transfer.stableID)
        case .draft: .draft(transfer.stableID)
        case .artifact: .artifact(transfer.stableID)
        }
        router.openAssistant(section: section, selection: section == .today ? .assistantChat : selection)
        router.dropFeedback = "已在\(section.title)定位「\(transfer.title)」"
        showDetailIfCompact()
        return true
    }

    private func showDetailIfCompact() {
        guard sizeClass == .compact else { return }
        preferredCompactColumn = .detail
    }

    private func syncPreviewPresentation() {
        guard sceneSession?.previewTab(in: store) != nil else { return }
        if case .detail = router.inspectorMode {
            let returnSelection = router.inspectorPresented ? router.selection : .assistantChat
            router.openPreview(returningTo: returnSelection)
        } else {
            router.inspectorPresented = true
        }
    }

    private var detachedPreviewFile: Binding<PreviewFile?> {
        Binding(
            get: {
                router.assistantSection == .today || store.fileBrowserOpen ? nil : store.previewFile
            },
            set: { store.previewFile = $0 }
        )
    }

    private var detachedExportFile: Binding<PreviewFile?> {
        Binding(
            get: {
                router.assistantSection == .today || store.fileBrowserOpen ? nil : store.exportFile
            },
            set: { store.exportFile = $0 }
        )
    }

    @ViewBuilder
    private var sectionContent: some View {
        Group {
            switch router.assistantSection {
            case .today:
                PadTodayExperience(projection: projection)
            case .inbox:
                PadInboxExperience(projection: projection)
            case .todos:
                PadTaskExperience(projection: projection, column: .todo)
            case .plans:
                PadTaskExperience(projection: projection, column: .plan)
            case .delegations:
                PadTaskExperience(projection: projection, column: .delegation)
            case .artifacts:
                PadArtifactExperience(projection: projection)
            case .memory:
                MemoryCenterPanelView()
            }
        }
        .modifier(PadNoticeHost(enabled: router.assistantSection != .today && !router.inspectorPresented))
    }
}

private struct PadAssistantSearch: ViewModifier {
    @Environment(PadRouter.self) private var router
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        @Bindable var router = router
        if enabled {
            content.searchable(
                text: $router.searchQuery,
                isPresented: $router.searchPresented,
                prompt: "搜索当前栏目"
            )
        } else {
            content
        }
    }
}

private struct PadSectionNavigationRow: View {
    @Environment(PadRouter.self) private var router
    let section: PadAssistantSection
    let selected: Bool
    let onOpen: () -> Void
    let onDrop: ([PadSemanticTransfer]) -> Bool
    @State private var targeted = false

    private var legalHover: Bool {
        guard targeted, let kind = router.activeSemanticDragKind else { return false }
        let target: PadSemanticDropTarget? = switch section {
        case .today: .today
        case .inbox: .inbox
        case .todos: .todos
        case .plans: .plans
        case .delegations: .delegations
        case .artifacts: .artifacts
        case .memory: nil
        }
        return target?.accepts(kind) == true
    }

    var body: some View {
        Button(action: onOpen) {
            Label(section.title, systemImage: section.symbol)
                .font(JieboFont.text(.body))
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(section.title)
        .dropDestination(for: PadSemanticTransfer.self, action: { items, _ in
            onDrop(items)
        }, isTargeted: { targeted = $0 })
        .overlay {
            if legalHover {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(JieboColor.pine, lineWidth: 2)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityHint(section == .memory ? "打开栏目" : "打开栏目，也可把匹配项目拖到这里")
    }
}

private struct PadNoticeHost: ViewModifier {
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.phoneNotice()
        } else {
            content
        }
    }
}
