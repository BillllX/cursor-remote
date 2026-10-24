import SwiftUI

/// 产物中心只展示网关从既有事实源派生的 Artifact，不在本地另建索引。
struct ArtifactCenterView: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
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
                        Section(group.title) {
                            ForEach(group.items) { artifact in
                                ArtifactRow(artifact: artifact, onContinue: {
                                    router.popToRoot()
                                    _ = store.continueArtifact(artifact)
                                })
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .background(JieboColor.paper)
            }
        }
        .navigationTitle("产物中心")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top, spacing: 0) {
            filters
        }
        .task { store.requestAssistant() }
    }

    /// 筛选属于控制层，使用 Liquid Glass；产物卡片本身保持实体表面。
    private var filters: some View {
        HStack(spacing: 10) {
            Picker("呈现方式", selection: $presentation) {
                ForEach(ArtifactPresentation.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.menu)
            Picker("产物类型", selection: $kindFilter) {
                ForEach(ArtifactKindFilter.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.menu)
        }
        .font(JieboFont.text(.subheadline, weight: .medium))
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .jieboGlass(in: Capsule(), interactive: true)
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
        case .all: return "全部类型"
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
    @Environment(\.sceneSessionState) private var sceneSession
    let artifact: Artifact
    let onContinue: () -> Void
    @State private var excerptExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: artifact.symbol)
                    .font(JieboFont.text(.title3, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 4) {
                    Text(artifact.title)
                        .font(JieboFont.text(.body, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                    if let path = artifact.path {
                        Text(path)
                            .font(JieboFont.monoText(.caption))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(2)
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
        HStack(spacing: 16) {
            if let file = artifact.turnFile, let chatId = artifact.sourceChatId {
                Button("预览") {
                    store.openTurnFile(file, chatId: chatId)
                    sceneSession?.presentPreview(from: store)
                }
                    .buttonStyle(.plain)
                Button("分享") {
                    store.exportPreview(path: file.path, content: nil, chatId: chatId)
                }
                .buttonStyle(.plain)
            }
            if let url = artifact.safeURL {
                Link("打开", destination: url)
            }
            Spacer(minLength: 0)
            Button("让小驳继续处理", action: onContinue)
                .buttonStyle(.plain)
        }
        .font(JieboFont.text(.subheadline, weight: .semibold))
        .foregroundStyle(JieboColor.pine)
    }
}

private extension Artifact {
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
        if provenance?.inboxId != nil { return "助理收件箱" }
        if provenance?.turnId != nil { return "会话回合" }
        return "捕获"
    }
}
