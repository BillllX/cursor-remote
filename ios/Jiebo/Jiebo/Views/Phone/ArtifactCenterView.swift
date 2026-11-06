import SwiftUI

/// 产物中心只展示网关从既有事实源派生的 Artifact，不在本地另建索引。
struct ArtifactCenterView: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    var embedded = false
    @State private var kindFilter = ArtifactKindFilter.all
    @State private var presentation = ArtifactPresentation.recent

    private var artifacts: [Artifact] {
        (store.assistantState?.artifacts ?? []).filter { kindFilter.matches($0) }
    }

    var body: some View {
        Group {
            if store.assistantState?.artifacts == nil {
                ContentUnavailableView("产物中心不可用", systemImage: "square.stack.3d.up", description: Text("当前网关版本还没有提供产物投影。"))
            } else if artifacts.isEmpty {
                ContentUnavailableView("没有符合条件的产物", systemImage: "line.3.horizontal.decrease.circle", description: Text("换一个类型筛选，或先让小驳生成、捕获内容。"))
            } else {
                List {
                    ForEach(groups) { group in
                        Section {
                            ForEach(group.items) { artifact in
                                ArtifactRow(artifact: artifact, onContinue: {
                                    router.popToRoot()
                                    _ = store.continueArtifact(artifact)
                                })
                            }
                        } header: {
                            JieboListHeader(group.title)
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .background(JieboColor.paper)
            }
        }
        .navigationTitle(embedded ? "助理中心" : "产物中心")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !embedded {
                ToolbarItem(placement: .topBarTrailing) {
                    Picker("呈现方式", selection: $presentation) {
                        ForEach(ArtifactPresentation.allCases) { item in
                            Text(item.title).tag(item)
                        }
                    }
                    .pickerStyle(.menu)
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            filters
        }
        .task { if !embedded { store.requestAssistant() } }
    }

    /// 类型和待处理页同一套分段；呈现方式放在导航栏菜单里，不再另做一颗玻璃胶囊。
    private var filters: some View {
        VStack(spacing: 8) {
            if embedded {
                Picker("呈现方式", selection: $presentation) {
                    ForEach(ArtifactPresentation.allCases) { item in
                        Text(item.title).tag(item)
                    }
                }
                .pickerStyle(.segmented)
            }
            Picker("产物类型", selection: $kindFilter) {
                ForEach(ArtifactKindFilter.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var groups: [ArtifactGroup] {
        switch presentation {
        case .recent:
            return [ArtifactGroup(id: "recent", title: "最近", items: artifacts)]
        case .type:
            return grouped { artifact in
                switch artifact.kind {
                case "file": return "文件"
                case "link": return "链接"
                default: return "捕获"
                }
            }
        case .source:
            return grouped { $0.sourceTypeTitle }
        }
    }

    private func grouped(_ key: (Artifact) -> String) -> [ArtifactGroup] {
        let values = Dictionary(grouping: artifacts, by: key)
        return values.keys.sorted().map { title in
            ArtifactGroup(id: title, title: title, items: values[title] ?? [])
        }
    }
}

private struct ArtifactGroup: Identifiable {
    let id: String
    let title: String
    let items: [Artifact]
}

private enum ArtifactPresentation: String, CaseIterable, Identifiable {
    case recent, type, source
    var id: String { rawValue }
    var title: String {
        switch self {
        case .recent: return "最近"
        case .type: return "按类型"
        case .source: return "按来源"
        }
    }
}

private enum ArtifactKindFilter: String, CaseIterable, Identifiable {
    case all, file, link, capture
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: return "全部"
        case .file: return "文件"
        case .link: return "链接"
        case .capture: return "捕获"
        }
    }
    func matches(_ artifact: Artifact) -> Bool {
        self == .all || rawValue == artifact.kind
    }
}

private struct ArtifactRow: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    @Environment(\.sceneSessionState) private var sceneSession
    @Environment(\.openURL) private var openURL
    let artifact: Artifact
    let onContinue: () -> Void
    @State private var excerptExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: artifact.symbol)
                    .font(JieboFont.text(.callout, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 4) {
                    Text(artifact.displayTitle)
                        .font(JieboFont.text(.body, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(2)
                    if let path = artifact.path, artifact.displayTitle != (path as NSString).lastPathComponent {
                        Text(path)
                            .font(JieboFont.monoText(.caption))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } else if let url = artifact.safeURL {
                        Link(url.host ?? url.absoluteString, destination: url)
                            .font(JieboFont.text(.caption))
                    }
                }
                Spacer(minLength: 0)
            }

            sourceLine
            citation
            actions
        }
        .padding(.vertical, 6)
        .listRowBackground(JieboColor.white)
        .accessibilityElement(children: .contain)
    }

    private var sourceLine: some View {
        HStack(spacing: 6) {
            Text(artifact.sourceTypeTitle)
            if let label = artifact.provenance?.label {
                Text("·")
                Text(label)
            }
            Text("·")
            Text(Date(timeIntervalSince1970: artifact.createdAt / 1000), style: .relative)
        }
        .font(JieboFont.text(.caption))
        .foregroundStyle(JieboColor.dim)
    }

    @ViewBuilder
    private var citation: some View {
        if let citation = artifact.sourceCitation {
            VStack(alignment: .leading, spacing: 5) {
                if let url = artifact.safeURL {
                    Link(destination: url) {
                        Label(citation.title ?? "打开来源", systemImage: "link")
                    }
                    .font(JieboFont.text(.caption, weight: .medium))
                }
                if let excerpt = citation.excerpt {
                    Button {
                        excerptExpanded.toggle()
                    } label: {
                        Text(excerpt)
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.ink2)
                            .lineLimit(excerptExpanded ? nil : 2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(excerptExpanded ? "收起来源摘录" : "展开来源摘录")
                }
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            if let file = artifact.turnFile, let chatId = artifact.sourceChatId {
                ActionButton(title: "预览", kind: .outline) {
                    store.openTurnFile(file, chatId: chatId)
                    sceneSession?.presentPreview(from: store)
                }
            } else if let url = artifact.safeURL {
                ActionButton(title: "打开", kind: .outline) {
                    openURL(url)
                }
            }
            Spacer(minLength: 0)
            ActionButton(title: "让小驳继续处理", kind: .primary, action: onContinue)
            if hasSecondaryActions {
                Menu {
                    if let file = artifact.turnFile, let chatId = artifact.sourceChatId {
                        Button("分享") {
                            store.exportPreview(path: file.path, content: nil, chatId: chatId)
                        }
                    }
                    if let delegationId = artifact.provenance?.delegationId {
                        Button("查看来源委派") {
                            router.delegationDetail = DelegationRef(id: delegationId)
                        }
                    } else if let inboxId = artifact.provenance?.inboxId {
                        Button("查看来源消息") {
                            router.openInboxItem(inboxId)
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(JieboFont.text(.body, weight: .semibold))
                        .foregroundStyle(JieboColor.ink2)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("更多")
            }
        }
    }

    private var hasSecondaryActions: Bool {
        if artifact.turnFile != nil, artifact.sourceChatId != nil { return true }
        if artifact.provenance?.delegationId != nil { return true }
        if artifact.provenance?.inboxId != nil { return true }
        return false
    }
}

private extension Artifact {
    /// 路径当标题时只留文件名。已经是人能读的名字就原样显示。
    var displayTitle: String {
        if title.contains("/") {
            return (title as NSString).lastPathComponent
        }
        return title
    }

    var symbol: String {
        switch kind {
        case "file": return "doc"
        case "link": return "link"
        default: return "tray.and.arrow.down"
        }
    }

    var sourceTypeTitle: String {
        if provenance?.collabTaskId != nil { return "协作" }
        if provenance?.delegationId != nil { return "委派" }
        if provenance?.inboxId != nil { return "通知" }
        if provenance?.turnId != nil { return "会话回合" }
        return "捕获"
    }
}
