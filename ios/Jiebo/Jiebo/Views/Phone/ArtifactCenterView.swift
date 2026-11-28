import SwiftUI

/// 文件中心只展示网关从既有事实源派生的 Artifact，不在本地另建索引。
struct ArtifactCenterView: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    var embedded = false
    @State private var searchText = ""
    @State private var kindFilter = ArtifactKindFilter.all
    @State private var presentation = ArtifactPresentation.recent

    private func versionKey(_ file: Artifact) -> String {
        guard let path = file.path, let chat = file.sourceChatId else { return file.id }
        return chat + "\n" + path
    }

    private struct ArtifactProjection {
        let artifacts: [Artifact]
        let versionsByKey: [String: [Artifact]]
        let groups: [ArtifactGroup]
    }

    private func buildProjection() -> ArtifactProjection {
        // 单次筛选、排序、去重与历史版本归组，消除 ForEach 每行重复重算 allFiles 的 O(N² log N) 开销
        let sorted = (store.assistantState?.artifacts ?? [])
            .filter { item in
                item.kind == "file"
                    && kindFilter.matches(item)
                    && (searchText.isEmpty || item.title.localizedCaseInsensitiveContains(searchText))
            }
            .sorted { $0.createdAt > $1.createdAt }
        var unique: [Artifact] = []
        unique.reserveCapacity(sorted.count)
        var versionsByKey: [String: [Artifact]] = [:]
        versionsByKey.reserveCapacity(sorted.count)
        for item in sorted {
            let key = versionKey(item)
            if versionsByKey[key] == nil {
                unique.append(item)
                versionsByKey[key] = [item]
            } else {
                versionsByKey[key]?.append(item)
            }
        }
        let groups: [ArtifactGroup]
        switch presentation {
        case .recent:
            groups = [ArtifactGroup(id: "recent", title: "最近", items: unique)]
        case .type:
            groups = grouped(unique) { artifact in
                switch artifact.kind {
                case "file": return "文件"
                case "link": return "链接"
                default: return "捕获"
                }
            }
        case .source:
            groups = grouped(unique) { $0.sourceTypeTitle }
        }
        return ArtifactProjection(artifacts: unique, versionsByKey: versionsByKey, groups: groups)
    }

    var body: some View {
        let projection = buildProjection()
        Group {
            if store.assistantState == nil {
                AssistantLoadingView(title: "正在加载文件…")
            } else if store.assistantState?.artifacts == nil {
                ContentUnavailableView("文件中心不可用", systemImage: "square.stack.3d.up", description: Text("当前网关版本还没有提供文件投影。"))
            } else if projection.artifacts.isEmpty {
                if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ContentUnavailableView {
                        Label("没有找到文件", systemImage: "magnifyingglass")
                    } description: {
                        Text("试试其他关键词，或清除搜索查看全部文件。")
                    } actions: {
                        ActionButton(title: "清除搜索") { searchText = "" }
                    }
                } else {
                    ContentUnavailableView {
                        Label(kindFilter == .all ? "还没有文件" : "没有符合条件的文件",
                              systemImage: kindFilter == .all ? "square.stack.3d.up" : "line.3.horizontal.decrease.circle")
                    } description: {
                        Text(kindFilter == .all ? "让小驳生成文件或捕获内容后，会显示在这里。" : "试试查看全部类型的文件。")
                    } actions: {
                        if kindFilter != .all {
                            Button("清除筛选") { kindFilter = .all }
                        }
                    }
                }
            } else {
                List {
                    ForEach(projection.groups) { group in
                        Section {
                            ForEach(group.items) { artifact in
                                ArtifactRow(artifact: artifact, onContinue: {
                                    router.popToRoot()
                                    _ = store.continueArtifact(artifact)
                                })
                                let history = projection.versionsByKey[versionKey(artifact)] ?? []
                                if history.count > 1 {
                                    DisclosureGroup("历史版本（\(history.count - 1)）") {
                                        ForEach(Array(history.dropFirst())) { previous in
                                            ArtifactRow(artifact: previous, onContinue: {
                                                router.popToRoot()
                                                _ = store.continueArtifact(previous)
                                            })
                                        }
                                    }
                                    .font(JieboFont.text(.caption))
                                }
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(JieboColor.paper)
        .navigationTitle(embedded ? "助理中心" : "文件中心")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "搜索文件")
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
            if embedded { filters }
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

        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func grouped(_ items: [Artifact], by key: (Artifact) -> String) -> [ArtifactGroup] {
        let values = Dictionary(grouping: items, by: key)
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
                    let title = artifact.displayTitle
                    Text(title)
                        .font(JieboFont.text(.body, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(2)
                    if let path = artifact.path, title != Artifact.pathLeaf(path) {
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

            if let file = artifact.turnFile {
                Text(TurnFileStyle.caption(file))
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
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
                        Text(excerptExpanded ? "收起来源摘录" : excerpt)
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.ink2)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(excerptExpanded ? "收起来源摘录" : "展开来源摘录")
                    if excerptExpanded {
                        ChunkedAssistantMessage(text: ReplyText.repair(excerpt))
                            .textSelection(.enabled)
                    }
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
                            store.exportPreview(path: file.path, content: nil, chatId: chatId, sha: file.sha)
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
    static func pathLeaf(_ path: String) -> String {
        var slice = path[...]
        while slice.count > 1, slice.last == "/" {
            slice = slice.dropLast()
        }
        if let slash = slice.lastIndex(of: "/") {
            let next = slice.index(after: slash)
            if next < slice.endIndex { return String(slice[next...]) }
        }
        return String(slice)
    }

    /// 路径当标题时只留文件名。已经是人能读的名字就原样显示。
    var displayTitle: String {
        if title.contains("/") {
            return Self.pathLeaf(title)
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
