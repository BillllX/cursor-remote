import SwiftUI
import UIKit

/// 供归属选择器使用的轻量工作区项（与服务端 workspaceAgentDirectories 的 key 对齐）
private struct RecordingWorkspaceChoice: Identifiable, Hashable {
    var key: String
    var displayName: String
    var id: String { key }
}

private enum RecordingPanelTab: String, CaseIterable, Identifiable {
    case record
    case history
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .record: return "录音"
        case .history: return "历史"
        case .settings: return "设置"
        }
    }
}

// MARK: - 主面板（录音 / 历史 / 设置）

struct PersonalRecordingPanel: View {
    let store: ChatStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tab: RecordingPanelTab = .record
    @State private var confirmClear = false
    @State private var pendingDeleteLocal: LocalRecordingSummary?

    private var model: PersonalRecording { .shared }
    private var player: RecordingAudioPlayer { .shared }

    private var workspaceChoices: [RecordingWorkspaceChoice] {
        if !store.workspaceAgents.isEmpty {
            return store.workspaceAgents
                .filter { !$0.directoryName.isEmpty }
                .map { RecordingWorkspaceChoice(key: $0.directoryName, displayName: $0.displayName.isEmpty ? $0.directoryName : $0.displayName) }
                .sorted { $0.displayName.localizedCompare($1.displayName) == .orderedAscending }
        }
        return store.recentSubWorkspaces
            .filter { store.isTopLevelWorkspace($0.path) && !$0.name.isEmpty }
            .map { RecordingWorkspaceChoice(key: $0.name, displayName: $0.name) }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("视图", selection: $tab) {
                    ForEach(RecordingPanelTab.allCases) { item in
                        Text(item.title).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(JieboColor.paper)

                Group {
                    switch tab {
                    case .record:
                        recordTabView
                    case .history:
                        historyTabView
                    case .settings:
                        settingsTabView
                    }
                }
            }
            .background(JieboColor.paper)
            .navigationTitle("个人长录音")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .task(id: store.tenantId) {
                model.ensureSettingsLoaded(tenant: store.tenantId)
                if store.workspaceAgents.isEmpty && store.unlocked {
                    store.requestWorkspaceAgents(reset: true)
                }
                await model.refreshRemoteHistory(store: store)
            }
            .onChange(of: tab) { _, next in
                if next == .history {
                    Task { await model.refreshRemoteHistory(store: store) }
                } else if next == .settings {
                    model.refreshLocalSnapshot(tenant: store.tenantId)
                }
            }
            .confirmationDialog(
                "清除本机已同步的原音与文字副本？",
                isPresented: $confirmClear,
                titleVisibility: .visible
            ) {
                Button("删除已同步副本（保留未同步录音）", role: .destructive) {
                    model.clearSyncedCopies(store: store)
                }
            } message: {
                Text("仅清理已确认同步完成的本机文件，未同步或失败的录音会被保留。若未开启原音同步，清理后将无法在手机上回听原音。")
            }
            .confirmationDialog(
                "删除这条本机未同步录音？",
                isPresented: Binding(
                    get: { pendingDeleteLocal != nil },
                    set: { if !$0 { pendingDeleteLocal = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let item = pendingDeleteLocal {
                    Button("彻底删除本机文件", role: .destructive) {
                        Task { await model.deleteLocalCopy(sessionId: item.sessionId, tenant: store.tenantId) }
                        pendingDeleteLocal = nil
                    }
                }
            } message: {
                Text("这条录音尚未同步成功，删除后无法恢复。")
            }
        }
    }

    // MARK: - 1. 录音页

    private var recordTabView: some View {
        ScrollView {
            VStack(spacing: 14) {
                if !model.settings.configured && model.folder == nil {
                    firstRunGuideCard
                }

                recordingHeroCard

                if !model.warningBanner.isEmpty {
                    bannerBox(icon: "exclamationmark.triangle.fill", text: model.warningBanner, fg: JieboColor.warnFg, bg: JieboColor.warnBg)
                }

                if model.folder == nil {
                    preStartConfigCard
                } else if let meta = model.activeMeta {
                    lockedSessionMetaCard(meta)
                }

                actionControlsCard

                if !model.status.isEmpty {
                    bannerBox(
                        icon: model.status.contains("失败") || model.status.contains("中断") ? "exclamationmark.circle.fill" : "info.circle.fill",
                        text: model.status,
                        fg: model.status.contains("失败") || model.status.contains("中断") ? JieboColor.danger : JieboColor.ink2,
                        bg: model.status.contains("失败") || model.status.contains("中断") ? JieboColor.dangerBg : JieboColor.white
                    )
                }

                liveTranscriptCard
            }
            .padding(16)
        }
        .background(JieboColor.paper)
    }

    private var firstRunGuideCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundStyle(JieboColor.pine)
                Text("首次使用默认策略")
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(JieboColor.ink)
            }
            Text("当前默认：本机 Apple 模型边录边转、原音留在本机、停止后自动发给个人助理（可乐）整理，不自动写入个人记忆或新建提醒。")
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.ink2)
            HStack(spacing: 10) {
                Button("按此默认开始") {
                    model.updateSettings(model.settings, tenant: store.tenantId)
                    JieboHaptic.selection()
                }
                .font(JieboFont.text(.footnote, weight: .semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(JieboColor.pine, in: RoundedRectangle(cornerRadius: JieboRadius.sm))
                .foregroundStyle(JieboColor.fillFg)
                .buttonStyle(.plain)

                Button("前往调整设置") {
                    tab = .settings
                }
                .font(JieboFont.text(.footnote, weight: .medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(JieboColor.well, in: RoundedRectangle(cornerRadius: JieboRadius.sm))
                .foregroundStyle(JieboColor.ink)
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(JieboColor.white, in: RoundedRectangle(cornerRadius: JieboRadius.md))
        .overlay(RoundedRectangle(cornerRadius: JieboRadius.md).stroke(JieboColor.line, lineWidth: JieboStroke.outline))
    }

    private var recordingHeroCard: some View {
        VStack(spacing: 12) {
            HStack {
                stateBadge
                Spacer()
                Text(policySummaryLine)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                    .lineLimit(1)
            }

            Text(RecordingFormatting.formatClock(model.elapsedSeconds))
                .font(.system(size: 40, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .foregroundStyle(model.recording ? JieboColor.ink : JieboColor.ink2)
                .padding(.vertical, 4)

            AudioLevelMeterView(level: model.audioLevel, active: model.recording)
                .frame(height: 18)

            HStack(spacing: 12) {
                Label(model.recording ? "锁屏可继续收音" : (model.folder != nil ? "已暂停，不收音" : "停止后自动整理交付"), systemImage: model.recording ? "lock.open.fill" : "waveform")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.ink2)
                Spacer()
                if model.folder != nil {
                    Text(model.activeMeta?.syncAudio == true ? "原音+文字同步" : "原音留本机")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
            }
        }
        .padding(16)
        .background(JieboColor.white, in: RoundedRectangle(cornerRadius: JieboRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: JieboRadius.lg).stroke(model.recording ? JieboColor.danger : JieboColor.line, lineWidth: JieboStroke.outline))
    }

    private var stateBadge: some View {
        let (label, fg, bg): (String, Color, Color) = {
            if model.recording { return ("正在录音", JieboColor.danger, JieboColor.dangerBg) }
            if model.folder != nil { return ("已暂停", JieboColor.warnFg, JieboColor.warnBg) }
            return ("准备就绪", JieboColor.ok, JieboColor.okBg)
        }()
        return HStack(spacing: 6) {
            Circle()
                .fill(fg)
                .frame(width: 8, height: 8)
                .opacity(model.recording && !reduceMotion ? 0.9 : 1)
            Text(label)
                .font(JieboFont.text(.caption, weight: .semibold))
                .foregroundStyle(fg)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(bg, in: Capsule())
    }

    private var policySummaryLine: String {
        let sync = model.settings.syncAudio ? "同步原音" : "仅传文字"
        return "\(model.settings.asrPolicy.shortLabel) · \(sync) · \(model.settings.networkPolicy.shortLabel)"
    }

    private var preStartConfigCard: some View {
        @Bindable var bindModel = model
        return VStack(alignment: .leading, spacing: 12) {
            Text("本次录音归属与标题")
                .font(JieboFont.text(.subheadline, weight: .semibold))
                .foregroundStyle(JieboColor.ink)

            TextField("可选标题，例如：周三产品评审、客户沟通", text: $bindModel.draftTitle)
                .font(JieboFont.text(.body))
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(JieboColor.paper, in: RoundedRectangle(cornerRadius: JieboRadius.sm))
                .overlay(RoundedRectangle(cornerRadius: JieboRadius.sm).stroke(JieboColor.line, lineWidth: 1))

            Picker("归属", selection: $bindModel.draftRouteKind) {
                ForEach(RecordingRouteKind.allCases) { kind in
                    Text(kind.title).tag(kind)
                }
            }
            .pickerStyle(.segmented)

            if model.draftRouteKind == .workspace {
                if workspaceChoices.isEmpty {
                    Text("未读取到一级项目工作区，请联网同步后重试或改选个人助理。")
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.warnFg)
                } else {
                    HStack {
                        Text("目标工作区")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.ink2)
                        Spacer()
                        Menu {
                            ForEach(workspaceChoices) { choice in
                                Button {
                                    model.draftWorkspaceKey = choice.key
                                    model.draftWorkspaceDisplayName = choice.displayName
                                } label: {
                                    if model.draftWorkspaceKey == choice.key {
                                        Label(choice.displayName, systemImage: "checkmark")
                                    } else {
                                        Text(choice.displayName)
                                    }
                                }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Text(model.draftWorkspaceDisplayName.isEmpty ? (model.draftWorkspaceKey.isEmpty ? "请选择工作区" : model.draftWorkspaceKey) : model.draftWorkspaceDisplayName)
                                    .font(JieboFont.text(.subheadline, weight: .medium))
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(JieboFont.text(.caption2))
                            }
                            .foregroundStyle(JieboColor.pine)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(JieboColor.well, in: RoundedRectangle(cornerRadius: JieboRadius.sm))
                        }
                    }
                    Text("停止后将自动生成带时间戳 Markdown 归档到该工作区，并在可乐收件箱发回执。")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
            } else {
                Text("停止后自动在个人私有空间整理，结果送达可乐收件箱；不会自动写入其他工作区。")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
            }
        }
        .padding(14)
        .background(JieboColor.white, in: RoundedRectangle(cornerRadius: JieboRadius.md))
        .overlay(RoundedRectangle(cornerRadius: JieboRadius.md).stroke(JieboColor.line, lineWidth: JieboStroke.outline))
    }

    private func lockedSessionMetaCard(_ meta: LocalRecordingMeta) -> some View {
        HStack(spacing: 10) {
            Image(systemName: meta.routeKind == .workspace ? "folder.fill" : "person.crop.circle.fill")
                .foregroundStyle(JieboColor.pine)
            VStack(alignment: .leading, spacing: 2) {
                Text(meta.title.isEmpty ? "进行中的长录音" : meta.title)
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(JieboColor.ink)
                Text("归属已锁定：\(meta.routeDisplayName) · \(meta.networkPolicy.shortLabel)")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
            }
            Spacer()
            if meta.partial {
                Text("含中断")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(JieboColor.warnBg, in: Capsule())
                    .foregroundStyle(JieboColor.warnFg)
            }
        }
        .padding(12)
        .background(JieboColor.white, in: RoundedRectangle(cornerRadius: JieboRadius.md))
        .overlay(RoundedRectangle(cornerRadius: JieboRadius.md).stroke(JieboColor.line, lineWidth: JieboStroke.outline))
    }

    private var actionControlsCard: some View {
        VStack(spacing: 10) {
            if model.recording {
                HStack(spacing: 12) {
                    Button {
                        model.pause()
                        JieboHaptic.impact(.light)
                    } label: {
                        Label("暂停录音", systemImage: "pause.fill")
                            .font(JieboFont.text(.headline))
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(JieboColor.warnBg, in: RoundedRectangle(cornerRadius: JieboRadius.md))
                            .foregroundStyle(JieboColor.warnFg)
                    }
                    .buttonStyle(PressScaleButtonStyle())

                    Button {
                        Task { await model.stop(store: store) }
                    } label: {
                        Label("停止并整理", systemImage: "stop.fill")
                            .font(JieboFont.text(.headline))
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(JieboColor.danger, in: RoundedRectangle(cornerRadius: JieboRadius.md))
                            .foregroundStyle(Color.white)
                    }
                    .buttonStyle(PressScaleButtonStyle())
                    .disabled(model.starting)
                }
            } else if model.folder != nil {
                HStack(spacing: 12) {
                    Button {
                        Task { await model.start(store: store) }
                    } label: {
                        Label("继续录音", systemImage: "mic.fill")
                            .font(JieboFont.text(.headline))
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(JieboColor.pine, in: RoundedRectangle(cornerRadius: JieboRadius.md))
                            .foregroundStyle(JieboColor.fillFg)
                    }
                    .buttonStyle(PressScaleButtonStyle())
                    .disabled(model.starting)

                    Button {
                        Task { await model.stop(store: store) }
                    } label: {
                        Label("停止并整理", systemImage: "checkmark.circle.fill")
                            .font(JieboFont.text(.headline))
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(JieboColor.well, in: RoundedRectangle(cornerRadius: JieboRadius.md))
                            .foregroundStyle(JieboColor.ink)
                    }
                    .buttonStyle(PressScaleButtonStyle())
                    .disabled(model.starting)
                }
            } else {
                Button {
                    Task { await model.start(store: store) }
                } label: {
                    HStack(spacing: 8) {
                        if model.starting {
                            ProgressView().tint(JieboColor.fillFg)
                        } else {
                            Image(systemName: "record.circle.fill")
                        }
                        Text(model.starting ? "正在准备麦克风…" : "开始长录音")
                    }
                    .font(JieboFont.text(.headline))
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(JieboColor.pine, in: RoundedRectangle(cornerRadius: JieboRadius.md))
                    .foregroundStyle(JieboColor.fillFg)
                }
                .buttonStyle(PressScaleButtonStyle())
                .disabled(model.starting)
            }
        }
    }

    private var liveTranscriptCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("本机实时转写预览")
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(JieboColor.ink)
                Spacer()
                Text("每 20 秒封段识别")
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
            }

            if model.preview.isEmpty {
                Text(model.recording
                     ? "正在持续保存原音，首个 20 秒分段封口后将显示中文识别预览…"
                     : "开始录音后，这里会实时展示 Apple 本机模型识别出的文字预览。")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
            } else {
                Text(model.preview)
                    .font(JieboFont.text(.body))
                    .foregroundStyle(JieboColor.ink)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(14)
        .background(JieboColor.white, in: RoundedRectangle(cornerRadius: JieboRadius.md))
        .overlay(RoundedRectangle(cornerRadius: JieboRadius.md).stroke(JieboColor.line, lineWidth: JieboStroke.outline))
    }

    // MARK: - 2. 历史页

    private var pendingLocalItems: [LocalRecordingSummary] {
        model.localRecords.filter { $0.phase != .accepted }
    }

    private var localSessionIdSet: Set<String> {
        Set(model.localRecords.map(\.sessionId))
    }

    private var historyTabView: some View {
        List {
            if !pendingLocalItems.isEmpty {
                Section {
                    ForEach(pendingLocalItems) { item in
                        localPendingRow(item)
                            .listRowBackground(JieboColor.white)
                    }
                } header: {
                    Text("本机待同步 / 进行中")
                }
            }

            Section {
                if let err = model.historyError {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("拉取云端录音记录失败")
                            .font(JieboFont.text(.subheadline, weight: .semibold))
                            .foregroundStyle(JieboColor.danger)
                        Text(err)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                    }
                    .listRowBackground(JieboColor.white)
                } else if model.loadingHistory && model.remoteSessions.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("正在加载录音历史…")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.dim)
                    }
                    .listRowBackground(JieboColor.white)
                } else if model.remoteSessions.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("暂无已同步的录音整理记录")
                            .font(JieboFont.text(.subheadline, weight: .medium))
                            .foregroundStyle(JieboColor.ink2)
                        Text("停止录音后，系统会自动转写、整理并出现在这里。")
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.dim)
                    }
                    .padding(.vertical, 6)
                    .listRowBackground(JieboColor.white)
                } else {
                    ForEach(model.remoteSessions) { session in
                        NavigationLink {
                            RecordingDetailView(
                                store: store,
                                sessionId: session.sessionId,
                                initialStatus: session,
                                hasLocalAudio: localSessionIdSet.contains(session.sessionId)
                            )
                        } label: {
                            remoteSessionRow(session, hasLocalAudio: localSessionIdSet.contains(session.sessionId))
                        }
                        .listRowBackground(JieboColor.white)
                    }
                }
            } header: {
                Text("已同步与整理历史")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .refreshable {
            await model.refreshRemoteHistory(store: store)
        }
    }

    private func localPendingRow(_ item: LocalRecordingSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                    Text("\(item.routeDisplayName) · \(RecordingFormatting.formatSeconds(item.estimatedSeconds)) · \(RecordingFormatting.formatBytes(item.totalBytes))")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
                Spacer()
                localPhaseTag(item.phase)
            }

            if let err = item.transferError {
                Text(err)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.danger)
            }

            if item.phase != .recording && item.phase != .paused {
                HStack(spacing: 10) {
                    Button {
                        Task { await model.retryLocalUpload(sessionId: item.sessionId, store: store) }
                    } label: {
                        Label("重试同步", systemImage: "arrow.clockwise")
                            .font(JieboFont.text(.caption, weight: .semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(JieboColor.pine, in: Capsule())
                            .foregroundStyle(JieboColor.fillFg)
                    }
                    .buttonStyle(.borderless)

                    Button {
                        pendingDeleteLocal = item
                    } label: {
                        Text("删除本机")
                            .font(JieboFont.text(.caption, weight: .medium))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(JieboColor.dangerBg, in: Capsule())
                            .foregroundStyle(JieboColor.danger)
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func localPhaseTag(_ phase: LocalTransferPhase) -> some View {
        let (text, fg, bg): (String, Color, Color) = {
            switch phase {
            case .recording: return ("录音中", JieboColor.danger, JieboColor.dangerBg)
            case .paused: return ("已暂停", JieboColor.warnFg, JieboColor.warnBg)
            case .preparing: return ("本机转写中", JieboColor.run, JieboColor.runBg)
            case .uploading: return ("后台同步中", JieboColor.run, JieboColor.runBg)
            case .accepted: return ("已同步", JieboColor.ok, JieboColor.okBg)
            case .failed: return ("同步失败", JieboColor.danger, JieboColor.dangerBg)
            }
        }()
        return Text(text)
            .font(JieboFont.text(.caption2, weight: .semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(bg, in: Capsule())
            .foregroundStyle(fg)
    }

    private func remoteSessionRow(_ session: RecordingSessionStatusDTO, hasLocalAudio: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(session.displayTitle)
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(JieboColor.ink)
                    .lineLimit(1)
                Spacer()
                processingBadge(session)
            }

            HStack(spacing: 8) {
                Label(
                    session.route.isWorkspace ? (session.route.workspaceId ?? "工作区") : "个人助理",
                    systemImage: session.route.isWorkspace ? "folder" : "person"
                )
                Text("·")
                Text(RecordingFormatting.formatFrames(session.expectedTotalFrames))
                if session.isPartial {
                    Text("· 部分内容")
                        .foregroundStyle(JieboColor.warnFg)
                }
                if hasLocalAudio {
                    Text("· 本机可回听")
                        .foregroundStyle(JieboColor.pine)
                } else if session.audioUploaded && !session.audioExpired {
                    Text("· 云端可回听")
                        .foregroundStyle(JieboColor.pine)
                }
            }
            .font(JieboFont.text(.caption))
            .foregroundStyle(JieboColor.dim)
            .lineLimit(1)

            if let err = session.lastError {
                Text(err.message)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.danger)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }

    private func processingBadge(_ session: RecordingSessionStatusDTO) -> some View {
        let text = RecordingFormatting.processingLabel(session.processingState, transferState: session.transferState)
        let (fg, bg): (Color, Color) = {
            if session.processingState == "delivered" { return (JieboColor.ok, JieboColor.okBg) }
            if session.needsUserAction { return (JieboColor.warnFg, JieboColor.warnBg) }
            if session.processingState == "cancelled" || session.processingState == "deleted" {
                return (JieboColor.dim, JieboColor.well)
            }
            return (JieboColor.run, JieboColor.runBg)
        }()
        return Text(text)
            .font(JieboFont.text(.caption2, weight: .semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(bg, in: Capsule())
            .foregroundStyle(fg)
    }

    // MARK: - 3. 设置页

    private var settingsTabView: some View {
        let bindingSettings = Binding<PersonalRecordingSettings>(
            get: { model.settings },
            set: { model.updateSettings($0, tenant: store.tenantId) }
        )
        return Form {
            Section {
                Picker("默认归属", selection: bindingSettings.defaultRouteKind) {
                    ForEach(RecordingRouteKind.allCases) { kind in
                        Text(kind.title).tag(kind)
                    }
                }

                if model.settings.defaultRouteKind == .workspace {
                    if workspaceChoices.isEmpty {
                        Text("暂无可用一级工作区")
                            .foregroundStyle(JieboColor.dim)
                    } else {
                        Picker("默认项目工作区", selection: Binding<String>(
                            get: { model.settings.defaultWorkspaceKey },
                            set: { newKey in
                                var next = model.settings
                                next.defaultWorkspaceKey = newKey
                                next.defaultWorkspaceDisplayName = workspaceChoices.first(where: { $0.key == newKey })?.displayName ?? newKey
                                model.updateSettings(next, tenant: store.tenantId)
                            }
                        )) {
                            Text("请选择工作区").tag("")
                            ForEach(workspaceChoices) { choice in
                                Text(choice.displayName).tag(choice.key)
                            }
                        }
                    }
                }
            } header: {
                Text("整理归属")
            } footer: {
                Text("项目归属只归档带时间戳的整理 Markdown，不向工作区上传原音文件。每次开录前也可临时切换归属。")
            }
            .listRowBackground(JieboColor.white)

            Section {
                Picker("转写方式", selection: bindingSettings.asrPolicy) {
                    ForEach(RecordingAsrPolicy.allCases) { policy in
                        Text(policy.title).tag(policy)
                    }
                }
                Text(model.settings.asrPolicy.note)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)

                if let asr = model.capabilities?.asr {
                    HStack {
                        Text("服务端 ASR 供应商")
                        Spacer()
                        Text(asr.serverAdapterAvailable ? (asr.serverProvider ?? "已配置") : "未配置")
                            .foregroundStyle(asr.serverAdapterAvailable ? JieboColor.ok : JieboColor.dim)
                    }
                }

                Toggle("同时同步原音到私有空间", isOn: bindingSettings.syncAudio)
                Picker("后台上传网络", selection: bindingSettings.networkPolicy) {
                    ForEach(RecordingNetworkPolicy.allCases) { net in
                        Text(net.title).tag(net)
                    }
                }
            } header: {
                Text("转写与同步策略")
            } footer: {
                Text("关闭原音同步时，iPhone 只上传带时间戳逐字稿，原音保留在手机用于回听，最省流量与云端空间。")
            }
            .listRowBackground(JieboColor.white)

            Section {
                Picker("记忆提取方式", selection: bindingSettings.memoryPolicy) {
                    ForEach(RecordingMemoryPolicy.allCases) { mem in
                        Text(mem.title).tag(mem)
                    }
                }
                Picker("云端原音保留期", selection: bindingSettings.rawRetentionDays) {
                    Text("7 天").tag(7)
                    Text("30 天").tag(30)
                    Text("90 天").tag(90)
                }
                Picker("逐字稿与摘要保留期", selection: bindingSettings.textRetentionDays) {
                    Text("30 天").tag(30)
                    Text("90 天").tag(90)
                    Text("365 天").tag(365)
                }
            } header: {
                Text("隐私与保留期")
            } footer: {
                Text("安全边界：录音原文视为不可信数据，绝不会自动执行录音中的指令，绝不自动写入个人记忆，也绝不自动创建系统提醒。")
            }
            .listRowBackground(JieboColor.white)

            Section {
                HStack {
                    Text("本机录音总占用")
                    Spacer()
                    Text(RecordingFormatting.formatBytes(model.localTotalBytes))
                        .foregroundStyle(JieboColor.ink2)
                }
                HStack {
                    Text("其中已同步可清理")
                    Spacer()
                    Text(RecordingFormatting.formatBytes(model.localReclaimableBytes))
                        .foregroundStyle(JieboColor.ink2)
                }
                if let quota = model.capabilities?.quota {
                    HStack {
                        Text("云端私有录音空间")
                        Spacer()
                        Text("\(RecordingFormatting.formatBytes(quota.usedBytes)) / \(RecordingFormatting.formatBytes(quota.totalBytes))")
                            .foregroundStyle(JieboColor.ink2)
                    }
                }
                Button(role: .destructive) {
                    confirmClear = true
                } label: {
                    Label("清理已同步的本机副本", systemImage: "trash")
                }
                .disabled(model.localReclaimableBytes == 0)
            } header: {
                Text("存储与清理")
            }
            .listRowBackground(JieboColor.white)
        }
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
    }

    private func bannerBox(icon: String, text: String, fg: Color, bg: Color) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(fg)
                .padding(.top, 2)
            Text(text)
                .font(JieboFont.text(.footnote))
                .foregroundStyle(fg)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(bg, in: RoundedRectangle(cornerRadius: JieboRadius.md))
    }
}

// MARK: - 动态音量条

private struct AudioLevelMeterView: View {
    let level: Double
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let bars = 16

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<bars, id: \.self) { idx in
                let threshold = Double(idx + 1) / Double(bars)
                let lit = active && level >= threshold * 0.85
                Capsule()
                    .fill(lit ? (idx >= 12 ? JieboColor.danger : JieboColor.pine) : JieboColor.well)
                    .frame(maxWidth: .infinity)
                    .frame(height: lit ? 16 : 6)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.08), value: lit)
            }
        }
        .accessibilityLabel(active ? "正在收音，音量约 \(Int(level * 100))%" : "当前未收音")
    }
}

// MARK: - 录音结果详情页（摘要、出处回听、记忆确认、逐字稿与删除）

struct RecordingDetailView: View {
    let store: ChatStore
    let sessionId: String
    let initialStatus: RecordingSessionStatusDTO
    let hasLocalAudio: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var status: RecordingSessionStatusDTO
    @State private var result: RecordingResultDTO?
    @State private var loading = true
    @State private var actionBusy = false
    @State private var errorMessage: String?
    @State private var toastMessage: String?
    @State private var transcriptQuery = ""
    @State private var showDeleteSheet = false
    @State private var deleteLinkedMemories = false

    private var player: RecordingAudioPlayer { .shared }

    init(
        store: ChatStore,
        sessionId: String,
        initialStatus: RecordingSessionStatusDTO,
        hasLocalAudio: Bool
    ) {
        self.store = store
        self.sessionId = sessionId
        self.initialStatus = initialStatus
        self.hasLocalAudio = hasLocalAudio
        self._status = State(initialValue: initialStatus)
    }

    private var canPlayAudio: Bool {
        hasLocalAudio || (result?.audioAvailable == true && result?.audioExpired != true) || (status.audioUploaded && !status.audioExpired)
    }

    private var filteredSegments: [RecordingTranscriptSegmentDTO] {
        guard let segs = result?.segments else { return [] }
        let q = transcriptQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty { return segs }
        return segs.filter { $0.text.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        List {
            // 播放器控制条（仅在播放本条录音时出现）
            if player.activeSessionId == sessionId {
                Section {
                    playbackBar
                        .listRowBackground(JieboColor.white)
                } header: {
                    Text("原音回听")
                }
            }

            if let msg = player.statusMessage {
                Section {
                    Text(msg)
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.warnFg)
                        .listRowBackground(JieboColor.warnBg)
                }
            }

            // 元信息与三层状态
            Section {
                metaHeaderSection
                    .listRowBackground(JieboColor.white)
            } header: {
                Text("状态与出处信息")
            }

            if let err = errorMessage {
                Section {
                    Text(err)
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.danger)
                        .listRowBackground(JieboColor.dangerBg)
                }
            }

            if let toast = toastMessage {
                Section {
                    Text(toast)
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.ok)
                        .listRowBackground(JieboColor.okBg)
                }
            }

            // 异常与过程操作
            if status.processingState == "partial_pending" || status.needsUserAction || status.isInProgress {
                Section {
                    lifecycleActionButtons
                        .listRowBackground(JieboColor.white)
                } header: {
                    Text("处理操作")
                }
            }

            if loading && result == nil {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("正在加载整理结果…")
                            .font(JieboFont.text(.subheadline))
                            .foregroundStyle(JieboColor.dim)
                    }
                    .listRowBackground(JieboColor.white)
                }
            } else if let result {
                // 缺失区间提醒
                if !result.missingRanges.isEmpty {
                    Section {
                        ForEach(result.missingRanges) { gap in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(RecordingFormatting.formatFrames(gap.startFrame)) – \(RecordingFormatting.formatFrames(gap.endFrame))")
                                    .font(JieboFont.mono(13))
                                    .foregroundStyle(JieboColor.warnFg)
                                Text(gap.reason)
                                    .font(JieboFont.text(.footnote))
                                    .foregroundStyle(JieboColor.ink2)
                            }
                            .listRowBackground(JieboColor.warnBg)
                        }
                    } header: {
                        Text("缺失区间（本场为部分内容）")
                    }
                }

                // 摘要与关键结论
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        if result.usedFallbackSummary == true {
                            Text("当前为基础分段摘要，可点击下方重试生成深度整理。")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.warnFg)
                        }
                        Text(result.summary)
                            .font(JieboFont.text(.body))
                            .foregroundStyle(JieboColor.ink)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 4)
                    .listRowBackground(JieboColor.white)

                    ForEach(result.claims) { claim in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(claim.text)
                                .font(JieboFont.text(.subheadline))
                                .foregroundStyle(JieboColor.ink)
                            if !claim.citations.isEmpty {
                                citationStrip(claim.citations)
                            }
                        }
                        .padding(.vertical, 3)
                        .listRowBackground(JieboColor.white)
                    }
                } header: {
                    Text("整理摘要与关键结论")
                }

                // 待确认记忆建议（绝不自动写入）
                if !result.memoryCandidates.isEmpty {
                    Section {
                        ForEach(result.memoryCandidates) { candidate in
                            memoryCandidateRow(candidate)
                                .listRowBackground(JieboColor.white)
                        }
                    } header: {
                        Text("待确认记忆建议")
                    } footer: {
                        Text("以上内容来自录音整理，未自动写入个人记忆。请先核对说话人与内容，再手动确认或忽略。")
                    }
                }

                // 提及的行动项（绝不自动建提醒）
                if !result.reminderCandidates.isEmpty {
                    Section {
                        ForEach(result.reminderCandidates) { item in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(item.text)
                                    .font(JieboFont.text(.subheadline))
                                    .foregroundStyle(JieboColor.ink)
                                if let time = item.suggestedTimeText, !time.isEmpty {
                                    Text("原文时间：\(time)")
                                        .font(JieboFont.text(.caption))
                                        .foregroundStyle(JieboColor.dim)
                                }
                                if !item.evidenceRefs.isEmpty {
                                    citationStrip(item.evidenceRefs)
                                }
                            }
                            .padding(.vertical, 3)
                            .listRowBackground(JieboColor.white)
                        }
                    } header: {
                        Text("提及的行动项（未自动建提醒）")
                    }
                }

                // 分段要点
                if !result.sections.isEmpty {
                    Section {
                        ForEach(result.sections) { sec in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(sec.title)
                                        .font(JieboFont.text(.subheadline, weight: .semibold))
                                        .foregroundStyle(JieboColor.ink)
                                    Spacer()
                                    timestampButton(frame: sec.startFrame)
                                }
                                Text(sec.summary)
                                    .font(JieboFont.text(.footnote))
                                    .foregroundStyle(JieboColor.ink2)
                            }
                            .padding(.vertical, 3)
                            .listRowBackground(JieboColor.white)
                        }
                    } header: {
                        Text("分段要点")
                    }
                }

                // 带时间戳逐字稿
                Section {
                    TextField("搜索逐字稿关键词", text: $transcriptQuery)
                        .font(JieboFont.text(.subheadline))
                        .listRowBackground(JieboColor.white)

                    ForEach(filteredSegments) { seg in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 8) {
                                timestampButton(frame: seg.startFrame)
                                if let spk = seg.speakerLocalId, !spk.isEmpty {
                                    Text("\(spk) · 待确认")
                                        .font(JieboFont.text(.caption2))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(JieboColor.well, in: Capsule())
                                        .foregroundStyle(JieboColor.dim)
                                }
                                Spacer()
                            }
                            Text(seg.text)
                                .font(JieboFont.text(.body))
                                .foregroundStyle(JieboColor.ink)
                                .textSelection(.enabled)
                        }
                        .padding(.vertical, 3)
                        .listRowBackground(JieboColor.white)
                    }
                } header: {
                    Text("带时间戳逐字稿（\(filteredSegments.count) 段）")
                }
            } else {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("整理尚未完成")
                            .font(JieboFont.text(.subheadline, weight: .semibold))
                            .foregroundStyle(JieboColor.ink)
                        Text("当前阶段：\(RecordingFormatting.processingLabel(status.processingState, transferState: status.transferState))。可下拉刷新查看最新进展。")
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                    }
                    .padding(.vertical, 4)
                    .listRowBackground(JieboColor.white)
                }
            }

            // 删除区域
            Section {
                Button(role: .destructive) {
                    showDeleteSheet = true
                } label: {
                    Label("删除这条录音", systemImage: "trash")
                }
                .disabled(actionBusy)
                .listRowBackground(JieboColor.white)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle(result?.title ?? status.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await loadLatest()
        }
        .task {
            await loadLatest()
        }
        .sheet(isPresented: $showDeleteSheet) {
            deleteConfirmationSheet
        }
    }

    private var playbackBar: some View {
        HStack(spacing: 12) {
            Button {
                player.togglePause()
            } label: {
                Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(JieboColor.pine)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(player.isPlaying ? "暂停播放" : "继续播放")

            VStack(alignment: .leading, spacing: 2) {
                Text(player.isPlaying ? "正在回听原音" : "回听已暂停")
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .foregroundStyle(JieboColor.ink)
                Text("\(RecordingFormatting.formatSeconds(player.currentSeconds)) / \(RecordingFormatting.formatSeconds(player.totalSeconds))")
                    .font(JieboFont.mono(12))
                    .foregroundStyle(JieboColor.dim)
            }

            Spacer()

            Button("停止") {
                player.stop()
            }
            .font(JieboFont.text(.caption, weight: .semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(JieboColor.well, in: Capsule())
            .foregroundStyle(JieboColor.ink)
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }

    private var metaHeaderSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(status.route.isWorkspace ? "项目工作区：\(status.route.workspaceId ?? "")" : "个人助理（可乐）",
                      systemImage: status.route.isWorkspace ? "folder.fill" : "person.crop.circle")
                    .font(JieboFont.text(.subheadline, weight: .medium))
                    .foregroundStyle(JieboColor.ink)
                Spacer()
                Text(RecordingFormatting.formatFrames(status.expectedTotalFrames))
                    .font(JieboFont.mono(13))
                    .foregroundStyle(JieboColor.ink2)
            }

            HStack(spacing: 8) {
                pill(hasLocalAudio ? "本机保留原音" : "本机无原音副本",
                     fg: hasLocalAudio ? JieboColor.ok : JieboColor.dim,
                     bg: hasLocalAudio ? JieboColor.okBg : JieboColor.well)
                pill(RecordingFormatting.transferLabel(status.transferState),
                     fg: JieboColor.ink2,
                     bg: JieboColor.well)
                pill(RecordingFormatting.processingLabel(status.processingState, transferState: status.transferState),
                     fg: status.processingState == "delivered" ? JieboColor.ok : JieboColor.run,
                     bg: status.processingState == "delivered" ? JieboColor.okBg : JieboColor.runBg)
            }

            if status.isPartial || result?.coverage == "partial" {
                Text("注意：本场录音存在中断或缺失段落，仅代表部分内容，不视为整场完整记录。")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.warnFg)
            }

            if let result {
                Text("转写来源：\(RecordingFormatting.transcriptSourceLabel(result.transcriptSource)) · 录制时间：\(RecordingFormatting.shortDateTime(status.startedAt))")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
            }
        }
        .padding(.vertical, 4)
    }

    private func pill(_ text: String, fg: Color, bg: Color) -> some View {
        Text(text)
            .font(JieboFont.text(.caption2, weight: .medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(bg, in: Capsule())
            .foregroundStyle(fg)
    }

    private var lifecycleActionButtons: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let err = status.lastError {
                Text(err.message)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.danger)
            }
            HStack(spacing: 10) {
                if status.processingState == "partial_pending" {
                    Button("按部分内容继续整理") {
                        Task { await performAcceptPartial() }
                    }
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(JieboColor.pine, in: RoundedRectangle(cornerRadius: JieboRadius.sm))
                    .foregroundStyle(JieboColor.fillFg)
                    .buttonStyle(.borderless)
                    .disabled(actionBusy)
                }

                if status.processingState == "needs_attention" || status.processingState == "cancelled" {
                    Button("重试整理") {
                        Task { await performRetry() }
                    }
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(JieboColor.pine, in: RoundedRectangle(cornerRadius: JieboRadius.sm))
                    .foregroundStyle(JieboColor.fillFg)
                    .buttonStyle(.borderless)
                    .disabled(actionBusy)
                }

                if status.isInProgress {
                    Button("取消整理") {
                        Task { await performCancel() }
                    }
                    .font(JieboFont.text(.subheadline, weight: .medium))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(JieboColor.dangerBg, in: RoundedRectangle(cornerRadius: JieboRadius.sm))
                    .foregroundStyle(JieboColor.danger)
                    .buttonStyle(.borderless)
                    .disabled(actionBusy)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func citationStrip(_ citations: [RecordingCitationDTO]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(citations) { ref in
                    timestampButton(frame: ref.startFrame)
                }
            }
        }
    }

    private func timestampButton(frame: Int) -> some View {
        Button {
            Task {
                await player.play(
                    sessionId: sessionId,
                    targetFrame: frame,
                    tenant: store.tenantId,
                    token: store.tokenDraft,
                    remoteAudioAvailable: (result?.audioAvailable == true && result?.audioExpired != true) || (status.audioUploaded && !status.audioExpired)
                )
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: canPlayAudio ? "play.fill" : "clock")
                    .font(.system(size: 10))
                Text(RecordingFormatting.formatFrames(frame))
                    .font(JieboFont.mono(12))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(canPlayAudio ? JieboColor.okBg : JieboColor.well, in: Capsule())
            .foregroundStyle(canPlayAudio ? JieboColor.pine : JieboColor.dim)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("跳转到 \(RecordingFormatting.formatFrames(frame)) 回听")
    }

    private func memoryCandidateRow(_ candidate: RecordingMemoryCandidateDTO) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                if let topic = candidate.topic, !topic.isEmpty {
                    Text(topic)
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(JieboColor.well, in: Capsule())
                        .foregroundStyle(JieboColor.ink2)
                }
                Text(RecordingFormatting.subjectLabel(candidate.subject))
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(candidate.subject == "third_party" ? JieboColor.warnFg : JieboColor.dim)
                Spacer()
                if candidate.confirmation == "confirmed" {
                    Text("已写入记忆")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.ok)
                } else if candidate.confirmation == "dismissed" {
                    Text("已忽略")
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                }
            }

            Text(candidate.text)
                .font(JieboFont.text(.subheadline))
                .foregroundStyle(JieboColor.ink)

            if !candidate.evidenceRefs.isEmpty {
                citationStrip(candidate.evidenceRefs)
            }

            if candidate.confirmation == "pending" {
                HStack(spacing: 10) {
                    Button("确认写入记忆") {
                        Task { await handleMemory(candidateId: candidate.candidateId, confirm: true) }
                    }
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(JieboColor.pine, in: Capsule())
                    .foregroundStyle(JieboColor.fillFg)
                    .buttonStyle(.borderless)
                    .disabled(actionBusy)

                    Button("忽略") {
                        Task { await handleMemory(candidateId: candidate.candidateId, confirm: false) }
                    }
                    .font(JieboFont.text(.caption, weight: .medium))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(JieboColor.well, in: Capsule())
                    .foregroundStyle(JieboColor.ink2)
                    .buttonStyle(.borderless)
                    .disabled(actionBusy)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var deleteConfirmationSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Text("删除后将清除服务端录音索引、逐字稿与云端原音，并同步移除此 iPhone 上的本机原音副本。")
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.ink2)
                    Toggle("同时删除由本条录音确认写入的个人记忆", isOn: $deleteLinkedMemories)
                }
                .listRowBackground(JieboColor.white)

                Section {
                    Button(role: .destructive) {
                        Task { await performDelete() }
                    } label: {
                        Text(actionBusy ? "正在删除…" : "确认彻底删除")
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                    .disabled(actionBusy)
                }
                .listRowBackground(JieboColor.white)
            }
            .scrollContentBackground(.hidden)
            .background(JieboColor.paper)
            .navigationTitle("删除录音")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { showDeleteSheet = false }
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - 操作逻辑

    private func loadLatest() async {
        guard !store.tokenDraft.isEmpty else { return }
        loading = true
        errorMessage = nil
        defer { loading = false }

        do {
            let latestStatus = try await RecordingAPI.fetchSession(token: store.tokenDraft, sessionId: sessionId)
            status = latestStatus
            let outcome = try await RecordingAPI.fetchResult(token: store.tokenDraft, sessionId: sessionId)
            switch outcome {
            case .ready(let payload):
                result = payload
            case .pending(let pendingStatus):
                status = pendingStatus
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func handleMemory(candidateId: String, confirm: Bool) async {
        actionBusy = true
        errorMessage = nil
        toastMessage = nil
        defer { actionBusy = false }
        do {
            let updated = try await RecordingAPI.updateMemoryCandidate(
                token: store.tokenDraft,
                sessionId: sessionId,
                candidateId: candidateId,
                confirm: confirm
            )
            if var current = result,
               let idx = current.memoryCandidates.firstIndex(where: { $0.candidateId == candidateId }) {
                current.memoryCandidates[idx] = updated
                result = current
            }
            toastMessage = confirm ? "已确认并写入个人记忆" : "已忽略该记忆建议"
            JieboHaptic.notification(.success)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performRetry() async {
        actionBusy = true
        errorMessage = nil
        defer { actionBusy = false }
        do {
            status = try await RecordingAPI.retrySession(token: store.tokenDraft, sessionId: sessionId, expectedRevision: status.revision)
            toastMessage = "已重新提交整理队列"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performCancel() async {
        actionBusy = true
        errorMessage = nil
        defer { actionBusy = false }
        do {
            status = try await RecordingAPI.cancelSession(token: store.tokenDraft, sessionId: sessionId, expectedRevision: status.revision)
            toastMessage = "已取消整理任务"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performAcceptPartial() async {
        actionBusy = true
        errorMessage = nil
        defer { actionBusy = false }
        do {
            status = try await RecordingAPI.acceptPartial(token: store.tokenDraft, sessionId: sessionId, expectedRevision: status.revision)
            toastMessage = "已确认按部分内容继续整理"
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func performDelete() async {
        actionBusy = true
        errorMessage = nil
        defer { actionBusy = false }
        do {
            _ = try await RecordingAPI.deleteSession(
                token: store.tokenDraft,
                sessionId: sessionId,
                expectedRevision: status.revision,
                deleteLinkedMemories: deleteLinkedMemories
            )
            await PersonalRecording.shared.deleteLocalCopy(sessionId: sessionId, tenant: store.tenantId)
            await PersonalRecording.shared.refreshRemoteHistory(store: store)
            showDeleteSheet = false
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
            showDeleteSheet = false
        }
    }
}
