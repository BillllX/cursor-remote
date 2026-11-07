import SwiftUI

// MARK: - 入口（按容器宽度分栏，ToolLayer ~420pt 走单栏 drill-down）

struct MemoryCenterPanelView: View {
    @Environment(\.assistantSceneToken) private var sceneToken
    @State private var navId = "work_preference"
    @State private var middleTab = "all"
    @State private var stateFilter = "useful"
    @State private var selectedKey: String?
    @State private var searchText = ""
    @State private var searchScopeFilter = "all"
    @State private var searchKindFilter = "all"
    @State private var searchStateFilter = "all"
    @State private var searchActive = false
    @State private var managePersonalExpanded = false

    var body: some View {
        GeometryReader { geo in
            let tier = MemoryCenterLayoutMetrics.tier(containerWidth: geo.size.width)
            Group {
                switch tier {
                case .triple:
                    MemoryCenterTripleColumnBody(
                        navId: $navId,
                        middleTab: $middleTab,
                        stateFilter: $stateFilter,
                        selectedKey: $selectedKey,
                        searchText: $searchText,
                        searchScopeFilter: $searchScopeFilter,
                        searchKindFilter: $searchKindFilter,
                        searchStateFilter: $searchStateFilter,
                        searchActive: $searchActive,
                        managePersonalExpanded: $managePersonalExpanded
                    )
                case .double:
                    MemoryCenterDoubleColumnBody(
                        navId: $navId,
                        middleTab: $middleTab,
                        stateFilter: $stateFilter,
                        selectedKey: $selectedKey,
                        searchText: $searchText,
                        searchScopeFilter: $searchScopeFilter,
                        searchKindFilter: $searchKindFilter,
                        searchStateFilter: $searchStateFilter,
                        searchActive: $searchActive,
                        managePersonalExpanded: $managePersonalExpanded
                    )
                case .single:
                    MemoryCenterSingleColumnBody(
                        navId: $navId,
                        middleTab: $middleTab,
                        stateFilter: $stateFilter,
                        searchText: $searchText,
                        searchScopeFilter: $searchScopeFilter,
                        searchKindFilter: $searchKindFilter,
                        searchStateFilter: $searchStateFilter,
                        searchActive: $searchActive
                    )
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(JieboColor.paper)
        .memoryCenterLifecycle(
            navId: navId,
            searchActive: searchActive,
            searchText: searchText,
            searchScopeFilter: searchScopeFilter,
            searchKindFilter: searchKindFilter,
            searchStateFilter: searchStateFilter
        )
        .onReceive(NotificationCenter.default.publisher(for: .padSceneSearchRequested)) { note in
            guard let delivery = note.object as? PadSceneCommandDelivery,
                  delivery.sceneToken == sceneToken
            else { return }
            navId = "search"
            searchActive = true
        }
    }
}

struct MemoryCenterTripleColumnBody: View {
    @Binding var navId: String
    @Binding var middleTab: String
    @Binding var stateFilter: String
    @Binding var selectedKey: String?
    @Binding var searchText: String
    @Binding var searchScopeFilter: String
    @Binding var searchKindFilter: String
    @Binding var searchStateFilter: String
    @Binding var searchActive: Bool
    @Binding var managePersonalExpanded: Bool

    var body: some View {
        HStack(spacing: 0) {
            MemoryCenterNavColumn(
                navId: $navId,
                compact: false,
                selectedKey: $selectedKey,
                searchText: $searchText,
                searchActive: $searchActive
            )
                .frame(width: 176)
            Divider()
            MemoryCenterMiddleColumn(
                navId: $navId,
                middleTab: $middleTab,
                stateFilter: $stateFilter,
                selectedKey: $selectedKey,
                searchText: $searchText,
                searchScopeFilter: $searchScopeFilter,
                searchKindFilter: $searchKindFilter,
                searchStateFilter: $searchStateFilter,
                searchActive: $searchActive,
                managePersonalExpanded: $managePersonalExpanded,
                itemNavigation: .columnSelection
            )
            .frame(minWidth: 220, maxWidth: .infinity)
            Divider()
            MemoryCenterDetailColumn(
                navId: navId,
                middleTab: middleTab,
                selectedKey: selectedKey,
                searchActive: searchActive
            )
            .frame(width: 360)
        }
    }
}

struct MemoryCenterDoubleColumnBody: View {
    @Binding var navId: String
    @Binding var middleTab: String
    @Binding var stateFilter: String
    @Binding var selectedKey: String?
    @Binding var searchText: String
    @Binding var searchScopeFilter: String
    @Binding var searchKindFilter: String
    @Binding var searchStateFilter: String
    @Binding var searchActive: Bool
    @Binding var managePersonalExpanded: Bool

    var body: some View {
        HStack(spacing: 0) {
            MemoryCenterNavColumn(
                navId: $navId,
                compact: true,
                selectedKey: $selectedKey,
                searchText: $searchText,
                searchActive: $searchActive
            )
                .frame(minWidth: 140, idealWidth: 168, maxWidth: 200)
            Divider()
            Group {
                if searchActive, let key = selectedKey {
                    VStack(alignment: .leading, spacing: 0) {
                        MemoryCenterInlineBackBar(title: "搜索详情") { selectedKey = nil }
                        ScrollView {
                            MemoryCenterSearchDetail(selectedKey: key)
                                .padding(12)
                        }
                    }
                } else if searchActive {
                    MemoryCenterSearchList(selectedKey: $selectedKey, itemNavigation: .columnSelection)
                        .padding(12)
                } else if (navId == "personal" || navId == "work_preference"), let key = selectedKey {
                    VStack(alignment: .leading, spacing: 0) {
                        MemoryCenterInlineBackBar(title: "编辑记忆") { selectedKey = nil }
                        ScrollView {
                            MemoryCenterRememberDetail(selectedKey: key)
                                .padding(12)
                        }
                    }
                } else if let key = selectedKey,
                          let scope = MemoryCenterReducer.scopeIdForNav(navId),
                          scope != "personal"
                {
                    VStack(alignment: .leading, spacing: 0) {
                        MemoryCenterInlineBackBar(title: "条目详情") { selectedKey = nil }
                        ScrollView {
                            MemoryCenterItemDetailPane(scopeId: scope, middleTab: middleTab, selectedKey: key)
                                .padding(12)
                        }
                    }
                } else {
                    MemoryCenterMiddleColumn(
                        navId: $navId,
                        middleTab: $middleTab,
                        stateFilter: $stateFilter,
                        selectedKey: $selectedKey,
                        searchText: $searchText,
                        searchScopeFilter: $searchScopeFilter,
                        searchKindFilter: $searchKindFilter,
                        searchStateFilter: $searchStateFilter,
                        searchActive: $searchActive,
                        managePersonalExpanded: $managePersonalExpanded,
                        itemNavigation: .columnSelection
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

/// ToolLayer 窄宽（如 420pt）：单栏 NavigationStack drill-down
struct MemoryCenterSingleColumnBody: View {
    @Binding var navId: String
    @Binding var middleTab: String
    @Binding var stateFilter: String
    @Binding var searchText: String
    @Binding var searchScopeFilter: String
    @Binding var searchKindFilter: String
    @Binding var searchStateFilter: String
    @Binding var searchActive: Bool

    var body: some View {
        NavigationStack {
            MemoryCenterPhoneHome(
                navId: $navId,
                searchText: $searchText,
                searchScopeFilter: $searchScopeFilter,
                searchKindFilter: $searchKindFilter,
                searchStateFilter: $searchStateFilter,
                searchActive: $searchActive
            )
            .navigationDestination(for: PhoneRoute.self) { route in
                if case let .memoryPage(page) = route {
                    MemoryCenterPhonePage(route: page, middleTab: $middleTab, stateFilter: $stateFilter)
                }
            }
        }
    }
}

enum MemoryCenterItemNavigation {
    case columnSelection
    case drillDown(scopeId: String)
    case drillDownSearchHit
}

struct MemoryCenterInlineBackBar: View {
    let title: String
    var onBack: () -> Void

    var body: some View {
        HStack {
            Button(action: onBack) {
                Label("返回", systemImage: "chevron.left")
                    .font(JieboFont.text(.subheadline))
            }
            .buttonStyle(.plain)
            .hitTarget()
            Spacer()
            Text(title)
                .font(JieboFont.text(.subheadline, weight: .semibold))
            Spacer()
            Color.clear.frame(width: 44)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }
}

// MARK: - Lifecycle

struct MemoryCenterLifecycleModifier: ViewModifier {
    @Environment(ChatStore.self) private var store
    let navId: String
    let searchActive: Bool
    let searchText: String
    let searchScopeFilter: String
    let searchKindFilter: String
    let searchStateFilter: String

    func body(content: Content) -> some View {
        content
            .onAppear {
                store.memoryCenterSetActive(true)
                store.requestAssistant(memory: true)
                store.memoryCenterEnsureLoaded(navId: navId, searchActive: searchActive)
            }
            .onDisappear {
                store.memoryCenterSetActive(false)
                if !store.memoryCenterActive {
                    store.memoryCenterScheduleRelease()
                }
            }
            .onChange(of: navId) { _, next in
                store.memoryCenterEnsureLoaded(navId: next, searchActive: searchActive)
            }
            .onChange(of: searchActive) { _, active in
                if !active {
                    store.memoryCenterClearSearchResults()
                }
            }
            .onChange(of: searchText) { _, text in
                guard searchActive else { return }
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty {
                    store.memoryCenterClearSearchResults()
                    return
                }
                let key = memoryCenterSearchDebounceKey(
                    query: text,
                    scope: searchScopeFilter,
                    kind: searchKindFilter,
                    state: searchStateFilter
                )
                store.memoryCenterScheduleSearch(
                    query: text,
                    scope: searchScopeFilter,
                    kind: searchKindFilter,
                    state: searchStateFilter,
                    debounceKey: key
                )
            }
            .onChange(of: searchScopeFilter) { _, _ in fireSearchIfNeeded() }
            .onChange(of: searchKindFilter) { _, _ in fireSearchIfNeeded() }
            .onChange(of: searchStateFilter) { _, _ in fireSearchIfNeeded() }
    }

    private func fireSearchIfNeeded() {
        guard searchActive else { return }
        let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let key = memoryCenterSearchDebounceKey(
            query: searchText,
            scope: searchScopeFilter,
            kind: searchKindFilter,
            state: searchStateFilter
        )
        store.memoryCenterScheduleSearch(
            query: searchText,
            scope: searchScopeFilter,
            kind: searchKindFilter,
            state: searchStateFilter,
            debounceKey: key
        )
    }
}

extension View {
    /// 推进来的记忆页自己拿着活跃计数。上一页 onDisappear 不会把详情请求清掉。
    func memoryCenterScreenHold(navId: String, searchActive: Bool = false) -> some View {
        memoryCenterLifecycle(
            navId: navId,
            searchActive: searchActive,
            searchText: "",
            searchScopeFilter: "all",
            searchKindFilter: "all",
            searchStateFilter: "all"
        )
    }

    func memoryCenterLifecycle(
        navId: String,
        searchActive: Bool,
        searchText: String,
        searchScopeFilter: String,
        searchKindFilter: String,
        searchStateFilter: String
    ) -> some View {
        modifier(MemoryCenterLifecycleModifier(
            navId: navId,
            searchActive: searchActive,
            searchText: searchText,
            searchScopeFilter: searchScopeFilter,
            searchKindFilter: searchKindFilter,
            searchStateFilter: searchStateFilter
        ))
    }
}

// MARK: - 导航栏

struct MemoryTidyButton: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(store.memoryTidyBusy ? "正在梳理…" : "梳理一遍") {
                store.memoryTidy()
            }
            .disabled(store.memoryTidyBusy)
            Text("去掉重复，给新写的行补上今天，引用搬家了就改路径。不改你的原句。")
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
            if let note = store.memoryTidyNote, !note.isEmpty {
                Text(note)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.ink2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct MemoryCenterNavColumn: View {
    @Environment(ChatStore.self) private var store
    @Binding var navId: String
    var compact: Bool
    @Binding var selectedKey: String?
    @Binding var searchText: String
    @Binding var searchActive: Bool

    private var data: MemoryCenterDataState { store.memoryCenterData }
    private var folder: MemoryCenterScopeSummary? {
        MemoryCenterLabels.currentFolder(scopes: data.overview?.scopes ?? [], cwd: store.cwd, root: store.workspaceRoot)
    }
    private var folderNavId: String { folder?.id ?? "folder-missing" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                navButton("work_preference", title: "记得的我", symbol: NavigationIconId.account.symbol)
                navButton(folderNavId, title: "这个文件夹", symbol: "folder", subtitle: folder?.label)
                navButton("suggestions", title: "要你看一眼", symbol: "lightbulb", badge: store.memoryCenterSuggestionRows.count)
                Text("规则与诊断")
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                    .padding(.horizontal, 8)
                    .padding(.top, 8)
                navButton("activity", title: "最近改动", symbol: "clock")
                navButton("settings", title: "导出与导入", symbol: "square.and.arrow.up")
                navButton("diagnostics", title: "上一轮怎么选的", symbol: "text.alignleft")
                navButton("rules", title: "文件夹规则", symbol: "doc.text")
                Divider().padding(.vertical, 6)
                MemoryTidyButton()
            }
            .padding(compact ? 8 : 10)
        }
        .overlay(alignment: .topTrailing) {
            if data.loadingOverview {
                ProgressView()
                    .padding(8)
                    .accessibilityLabel("正在加载")
            }
        }
        .onAppear { store.memoryCenterLoadSuggestions() }
    }

    @ViewBuilder
    private func navButton(_ id: String, title: String, symbol: String, depth: Int = 0, subtitle: String? = nil, badge: Int = 0) -> some View {
        let selected = navId == id || (id == folderNavId && navId == folderNavId)
        Button {
            let target = id == folderNavId ? folderNavId : id
            MemoryCenterUILayoutLogic.applyNavSelection(
                selectedKey: &selectedKey,
                searchText: &searchText,
                searchActive: &searchActive,
                navId: &navId,
                targetNavId: target
            )
            if !searchActive {
                store.memoryCenterClearSearchResults()
            }
            if target == "diagnostics" || target == "rules", let folder {
                store.memoryCenterRefreshScope(folder.id)
            }
        } label: {
            HStack(spacing: 8) {
                if depth > 0 {
                    Color.clear.frame(width: CGFloat(depth) * 10)
                }
                Image(systemName: symbol)
                    .font(.footnote)
                    .foregroundStyle(JieboColor.dim)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(JieboFont.text(.subheadline, weight: selected ? .semibold : .regular))
                        .foregroundStyle(selected ? JieboColor.ink : JieboColor.ink2)
                        .lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(JieboFont.text(.caption2))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if badge > 0 {
                    Text("\(badge)")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.clay)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(JieboColor.clay.opacity(0.16))
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? JieboColor.ink.opacity(0.06) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel(badge > 0 ? "\(title)，\(badge)" : title)
        .hitTarget()
    }
}

// MARK: - 中间栏

struct MemoryCenterMiddleColumn: View {
    @Environment(ChatStore.self) private var store
    @Binding var navId: String
    @Binding var middleTab: String
    @Binding var stateFilter: String
    @Binding var selectedKey: String?
    @Binding var searchText: String
    @Binding var searchScopeFilter: String
    @Binding var searchKindFilter: String
    @Binding var searchStateFilter: String
    @Binding var searchActive: Bool
    @Binding var managePersonalExpanded: Bool
    var itemNavigation: MemoryCenterItemNavigation = .columnSelection

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MemoryCenterToolbar(
                searchText: $searchText,
                searchScopeFilter: $searchScopeFilter,
                searchKindFilter: $searchKindFilter,
                searchStateFilter: $searchStateFilter,
                searchActive: $searchActive,
                onRefresh: refresh
            )
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    content
                }
                .padding(12)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if navId == "activity" {
            MemoryCenterActivityPane()
        } else if navId == "suggestions" {
            MemoryCenterSuggestionsPane()
        } else if navId == "settings" {
            MemoryCenterImportPane()
        } else if navId == "diagnostics" {
            MemoryCenterDiagnosticsBlock(diagnostics: store.memoryCenterData.detail?.diagnostics)
        } else if navId == "rules" {
            if let detail = store.memoryCenterData.detail {
                MemoryCenterRulesList(rules: detail.rules, truncated: detail.rulesTruncated || detail.rulesPayloadTruncated)
            } else {
                MemoryCenterEmptyBlock(title: "还没有规则", hint: "先打开一个文件夹。")
            }
        } else if navId == "folder-missing" {
            MemoryCenterEmptyBlock(title: "还没打开文件夹", hint: "打开一个工作区后再看这里。")
        } else if navId == "personal" || navId == "work_preference" {
            MemoryCenterRememberMe(selectedKey: $selectedKey, itemNavigation: itemNavigation)
        } else if MemoryCenterReducer.isPlaceholderNav(navId) {
            MemoryCenterPlaceholderPane(title: "设置")
        } else if searchActive {
            MemoryCenterSearchList(selectedKey: $selectedKey, itemNavigation: itemNavigation)
        } else if navId == "overview" {
            MemoryCenterOverviewPane(onSelectScope: { id in
                navId = id
            })
        } else {
            MemoryCenterScopeItemsPane(
                scopeId: navId,
                middleTab: $middleTab,
                stateFilter: $stateFilter,
                selectedKey: $selectedKey,
                itemNavigation: itemNavigation,
                onSwitchFolder: { navId = $0 }
            )
        }
    }

    private func refresh() {
        if searchActive, !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            store.memoryCenterCancelSearchDebounce()
            store.memoryCenterSendSearch(
                query: searchText,
                scope: searchScopeFilter == "all" ? nil : searchScopeFilter,
                kind: searchKindFilter == "all" ? nil : searchKindFilter,
                state: searchStateFilter == "all" ? nil : searchStateFilter
            )
        } else if navId == "overview" {
            store.memoryCenterRefreshOverview()
        } else if let scope = MemoryCenterReducer.scopeIdForNav(navId) {
            store.memoryCenterRefreshScope(scope)
        }
    }
}

// MARK: - 详情栏

struct MemoryCenterDetailColumn: View {
    @Environment(ChatStore.self) private var store
    let navId: String
    let middleTab: String
    let selectedKey: String?
    let searchActive: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if searchActive {
                    MemoryCenterSearchDetail(selectedKey: selectedKey)
                } else if navId == "personal" || navId == "work_preference" {
                    MemoryCenterRememberDetail(selectedKey: selectedKey)
                } else if let scope = MemoryCenterReducer.scopeIdForNav(navId), scope != "personal" {
                    MemoryCenterItemDetailPane(scopeId: scope, middleTab: middleTab, selectedKey: selectedKey)
                } else {
                    MemoryCenterDetailEmptyHint(navId: navId)
                }
            }
            .padding(12)
        }
    }
}

// MARK: - 共享 UI 块

struct MemoryCenterToolbar: View {
    @Binding var searchText: String
    @Binding var searchScopeFilter: String
    @Binding var searchKindFilter: String
    @Binding var searchStateFilter: String
    @Binding var searchActive: Bool
    var onRefresh: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if searchActive {
                MemoryCenterSearchFilters(
                    scopeFilter: $searchScopeFilter,
                    kindFilter: $searchKindFilter,
                    stateFilter: $searchStateFilter
                )
            }
            Button(action: onRefresh) {
                Image(systemName: "arrow.clockwise")
                    .font(.body)
            }
            .accessibilityLabel("刷新")
            .hitTarget()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .searchable(text: $searchText, prompt: "搜索记忆")
        .onChange(of: searchText) { _, value in
            searchActive = !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
}

struct MemoryCenterSearchFilters: View {
    @Environment(ChatStore.self) private var store
    @Binding var scopeFilter: String
    @Binding var kindFilter: String
    @Binding var stateFilter: String

    private var scopePickerOptions: [(id: String, label: String)] {
        var out: [(String, String)] = []
        let scopes = store.memoryCenterData.overview?.scopes ?? []
        let ids = Set(scopes.map(\.id))
        if ids.contains("personal") { out.append(("personal", "关于我")) }
        if ids.contains("work_preference") { out.append(("work_preference", "工作偏好")) }
        for row in MemoryCenterReducer.buildScopeTreeRows(scopes: scopes) {
            out.append((row.id, row.summary.label))
        }
        if out.isEmpty {
            out.append(("personal", "关于我"))
            out.append(("work_preference", "工作偏好"))
        }
        return out
    }

    var body: some View {
        Menu {
            Picker("范围", selection: $scopeFilter) {
                Text("全部").tag("all")
                ForEach(scopePickerOptions, id: \.id) { opt in
                    Text(opt.label).tag(opt.id)
                }
            }
            Picker("种类", selection: $kindFilter) {
                Text("全部").tag("all")
                ForEach(MemoryCenterLabels.searchableKinds, id: \.self) { k in
                    Text(MemoryCenterLabels.kindLabel(k)).tag(k)
                }
            }
            Picker("状态", selection: $stateFilter) {
                ForEach(MemoryCenterLabels.stateFilters, id: \.self) { s in
                    Text(s == "all" ? "全部" : MemoryCenterLabels.stateLabel(s)).tag(s)
                }
            }
        } label: {
            Label("筛选", systemImage: "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("搜索筛选")
    }
}

struct MemoryCenterOverviewPane: View {
    @Environment(ChatStore.self) private var store
    var onSelectScope: (String) -> Void
    var linkScopes = false
    /// 手机浏览列表已经列出文件夹时，总览不再重复列一遍。
    var showsFolders = true
    var scopeListMiddleTab: Binding<String>?
    var scopeListStateFilter: Binding<String>?

    private var data: MemoryCenterDataState { store.memoryCenterData }

    var body: some View {
        if let err = data.overviewError.nilIfEmpty {
            MemoryCenterErrorBlock(message: err) { store.memoryCenterRefreshOverview() }
        } else if data.loadingOverview, data.overview == nil {
            MemoryCenterLoadingBlock(label: "正在加载…")
        } else if let overview = data.overview {
            MemoryCenterOverviewCards(
                overview: overview,
                truncated: data.overviewPayloadTruncated,
                onSelectScope: onSelectScope,
                linkScopes: linkScopes,
                showsFolders: showsFolders,
                scopeListMiddleTab: scopeListMiddleTab,
                scopeListStateFilter: scopeListStateFilter
            )
        } else if let title = store.memoryCenterReadPendingTitle {
            MemoryCenterEmptyBlock(title: title, hint: "")
        } else {
            MemoryCenterEmptyBlock(title: "暂无总览", hint: "点刷新重试。")
        }
    }
}

struct MemoryCenterOverviewCards: View {
    let overview: MemoryCenterOverview
    let truncated: Bool
    var onSelectScope: (String) -> Void
    var linkScopes = false
    var showsFolders = true
    var scopeListMiddleTab: Binding<String>?
    var scopeListStateFilter: Binding<String>?

    var body: some View {
        let pending = MemoryCenterReducer.overviewPendingTotal(scopes: overview.scopes)
        VStack(alignment: .leading, spacing: 14) {
            if truncated {
                MemoryCenterBanner(text: "总览 payload 已截断", tone: .warn)
            }
            if overview.scopesTruncated {
                MemoryCenterBanner(text: "文件夹范围列表已截断", tone: .warn)
            }
            AssistantSection("个人") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("有效 \(overview.personal.validEntries) · 失效 \(overview.personal.invalidEntries)")
                    Text("核心 \(overview.personal.coreFieldLines) 行 · 工作偏好 \(overview.personal.workPreferenceLines) 行")
                    if overview.personal.paused {
                        StatusTag(text: "已暂停", fg: JieboColor.clay, bg: JieboColor.clay.opacity(0.15))
                    }
                    Text("Token：核心 \(overview.personal.coreTokens)/\(overview.personal.coreBudget)")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
                .assistantCard()
            }
            if showsFolders {
            AssistantSection("文件夹") {
                Text("范围 \(MemoryCenterReducer.workspaceScopesForOverview(scopes: overview.scopes).count) · 待处理 \(pending)")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                ForEach(MemoryCenterReducer.workspaceScopesForOverview(scopes: overview.scopes)) { scope in
                    if linkScopes,
                       let middleTab = scopeListMiddleTab,
                       let stateFilter = scopeListStateFilter
                    {
                        NavigationLink {
                            MemoryCenterPhoneScopeList(
                                scopeId: scope.id,
                                scopeLabel: scope.label,
                                middleTab: middleTab,
                                stateFilter: stateFilter
                            )
                        } label: {
                            MemoryCenterScopeHealthRow(scope: scope)
                        }
                        .buttonStyle(.plain)
                        .hitTarget()
                    } else {
                        Button {
                            onSelectScope(scope.id)
                        } label: {
                            MemoryCenterScopeHealthRow(scope: scope)
                        }
                        .buttonStyle(.plain)
                        .hitTarget()
                    }
                }
            }
            }
        }
    }
}

struct MemoryCenterScopeHealthRow: View {
    let scope: MemoryCenterScopeSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(scope.label)
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                Spacer()
                if let health = MemoryCenterLabels.scopeHealthText(health: scope.health, error: scope.error, code: scope.errorCode) {
                    StatusTag(text: health, fg: JieboColor.clay, bg: JieboColor.clay.opacity(0.12))
                }
            }
            Text(folderStatusLine(scope))
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
            if scope.pendingCount > 0 {
                Text("待处理 \(scope.pendingCount)")
                    .font(JieboFont.text(.caption, weight: .medium))
                    .foregroundStyle(JieboColor.run)
            }
        }
        .assistantCard()
        .accessibilityElement(children: .combine)
    }

    private func folderStatusLine(_ scope: MemoryCenterScopeSummary) -> String {
        if MemoryCenterLabels.isAbsentMemoryFile(error: scope.error, code: scope.errorCode) { return "还没有记忆" }
        var parts = ["\(scope.memoryCount) 条"]
        if scope.missingRefs > 0 { parts.append("缺引用 \(scope.missingRefs)") }
        return parts.joined(separator: " · ")
    }
}

struct MemoryCenterScopeItemsPane: View {
    @Environment(ChatStore.self) private var store
    let scopeId: String
    @Binding var middleTab: String
    @Binding var stateFilter: String
    @Binding var selectedKey: String?
    var itemNavigation: MemoryCenterItemNavigation = .columnSelection
    var onSwitchFolder: ((String) -> Void)? = nil

    private var data: MemoryCenterDataState { store.memoryCenterData }

    var body: some View {
        if let err = data.scopeError.nilIfEmpty {
            MemoryCenterErrorBlock(message: err) { store.memoryCenterRefreshScope(scopeId) }
        } else if data.loadingScope, MemoryCenterReducer.detailForScope(data.detail, scopeId: scopeId) == nil {
            MemoryCenterLoadingBlock(label: "正在加载…")
        } else if let detail = MemoryCenterReducer.detailForScope(data.detail, scopeId: scopeId) {
            MemoryCenterScopeItemsContent(
                scopeId: scopeId,
                detail: detail,
                middleTab: $middleTab,
                stateFilter: $stateFilter,
                selectedKey: $selectedKey,
                itemNavigation: itemNavigation,
                onSwitchFolder: onSwitchFolder
            )
        } else if let title = store.memoryCenterReadPendingTitle {
            MemoryCenterEmptyBlock(title: title, hint: "")
        } else {
            MemoryCenterEmptyBlock(title: "暂无详情", hint: "选择文件夹或刷新。")
        }
    }

}

struct MemoryCenterScopeItemsContent: View {
    @Environment(ChatStore.self) private var store
    let scopeId: String
    let detail: MemoryCenterScopeDetail
    @Binding var middleTab: String
    @Binding var stateFilter: String
    @Binding var selectedKey: String?
    var itemNavigation: MemoryCenterItemNavigation = .columnSelection
    var onSwitchFolder: ((String) -> Void)? = nil
    @State private var showCreate = false

    var body: some View {
            VStack(alignment: .leading, spacing: 10) {
                if store.memoryCenterData.detailPayloadTruncated {
                    MemoryCenterBanner(text: "有一部分没列全", tone: .warn)
                }
                if let error = detail.scope.error?.nilIfEmpty,
                   !MemoryCenterLabels.isAbsentMemoryFile(error: error, code: detail.scope.errorCode) {
                    MemoryCenterBanner(text: error, tone: .warn)
                }
                if detail.scope.kind == "workspace_memory" {
                    HStack {
                        Text(detail.items.isEmpty ? "这个文件夹还没有记忆" : detail.scope.label)
                            .font(JieboFont.display(22))
                            .foregroundStyle(JieboColor.ink)
                        Spacer(minLength: 8)
                        Menu("换文件夹") {
                            ForEach(MemoryCenterReducer.buildScopeTreeRows(scopes: store.memoryCenterData.overview?.scopes ?? [])) { row in
                                Button(row.summary.label) { onSwitchFolder?(row.id) }
                            }
                        }
                        .font(JieboFont.text(.subheadline))
                        ActionButton(title: "记一条", kind: .primary) { showCreate = true }
                            .disabled(store.memoryCenterData.mutating)
                    }
                    if detail.items.isEmpty {
                        Text("记一条，下次在这个文件夹里就会记得。")
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.dim)
                    }
                    Picker("列表范围", selection: $stateFilter) {
                        ForEach(MemoryCenterLabels.folderMenus, id: \.self) { menu in
                            Text(MemoryCenterLabels.folderMenuLabel(menu)).tag(menu)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityLabel("会用到的")
                }
                MemoryCenterItemsList(
                    items: MemoryCenterLabels.filterFolder(detail.items, menu: stateFilter),
                    diagnostics: detail.diagnostics,
                    selectedKey: $selectedKey,
                    itemNavigation: itemNavigation,
                    emptyTitle: detail.items.isEmpty ? "这个文件夹还没有记忆" : "这个筛选里没有",
                    emptyHint: detail.items.isEmpty ? "记一条，下次在这个文件夹里就会记得。" : "换一个，或看全部。"
                )
                .onAppear {
                    guard case .columnSelection = itemNavigation, selectedKey == nil else { return }
                    if let first = detail.items.first(where: { !$0.missingRefs.isEmpty }) {
                        selectedKey = MemoryCenterReducer.itemKey(scopeId: first.scopeId, id: first.id)
                    }
                }
                if detail.itemsTruncated {
                    MemoryCenterBanner(text: "有一部分没列全", tone: .warn)
                }
            }
            .sheet(isPresented: $showCreate) {
                MemoryCenterWorkspaceCreateSheet(scopeId: scopeId)
            }
    }

}

struct MemoryCenterItemsList: View {
    let items: [WorkspaceMemoryItem]
    let diagnostics: InjectionDiagnostics?
    @Binding var selectedKey: String?
    var itemNavigation: MemoryCenterItemNavigation = .columnSelection
    var emptyTitle = "没有条目"
    var emptyHint = "试试别的筛选或标签。"

    var body: some View {
        if items.isEmpty {
            MemoryCenterEmptyBlock(title: emptyTitle, hint: emptyHint)
        } else {
            ForEach(items, id: \.stableId) { item in
                let key = MemoryCenterReducer.itemKey(scopeId: item.scopeId, id: item.id)
                switch itemNavigation {
                case .columnSelection:
                    Button {
                        selectedKey = key
                    } label: {
                        MemoryCenterItemRow(item: item, diagnostics: diagnostics, selected: selectedKey == key)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selectedKey == key ? .isSelected : [])
                    .hitTarget()
                case .drillDown(let scopeId):
                    NavigationLink(value: PhoneRoute.memoryPage(.item(scopeId: scopeId, key: key))) {
                        MemoryCenterItemRow(item: item, diagnostics: diagnostics, selected: false)
                    }
                    .buttonStyle(.plain)
                    .hitTarget()
                case .drillDownSearchHit:
                    EmptyView()
                }
            }
        }
    }
}

struct MemoryCenterItemRow: View {
    let item: WorkspaceMemoryItem
    let diagnostics: InjectionDiagnostics?
    var selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(item.section?.nilIfEmpty ?? item.text)
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .lineLimit(1)
                if let word = MemoryCenterLabels.listStatusWord(pinned: item.pinned, effectiveState: item.effectiveState, missingRefs: item.missingRefs) {
                    StatusTag(
                        text: word,
                        fg: word == "待你确认" ? JieboColor.clay : JieboColor.ink2,
                        bg: word == "待你确认" ? JieboColor.clay.opacity(0.12) : JieboColor.ink.opacity(0.08)
                    )
                }
            }
            Text(item.text)
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.ink2)
                .lineLimit(2)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? JieboColor.pine.opacity(0.08) : JieboColor.ink.opacity(0.03))
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
    }
}

struct MemoryCenterItemDetailPane: View {
    @Environment(ChatStore.self) private var store
    let scopeId: String
    let middleTab: String
    let selectedKey: String?

    var body: some View {
        if let key = selectedKey,
           let detail = MemoryCenterReducer.detailForScope(store.memoryCenterData.detail, scopeId: scopeId),
           let item = detail.items.first(where: { MemoryCenterReducer.itemKey(scopeId: $0.scopeId, id: $0.id) == key })
        {
            MemoryCenterItemDetailView(
                item: item,
                diagnostics: detail.diagnostics,
                scopeLabel: detail.scope.label,
                scopeId: scopeId
            )
        } else {
            MemoryCenterDetailEmptyHint(navId: scopeId)
        }
    }
}

struct MemoryCenterItemDetailView: View {
    @Environment(ChatStore.self) private var store
    let item: WorkspaceMemoryItem
    let diagnostics: InjectionDiagnostics?
    let scopeLabel: String
    var scopeId: String?
    @State private var showEdit = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(item.text)
                .font(JieboFont.text(.body))
                .foregroundStyle(JieboColor.ink)
                .textSelection(.enabled)
            if item.truncated {
                MemoryCenterBanner(text: "正文已在服务端截断", tone: .warn)
            }
            if let word = MemoryCenterLabels.listStatusWord(pinned: item.pinned, effectiveState: item.effectiveState, missingRefs: item.missingRefs) {
                Text(word)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(word == "待你确认" ? JieboColor.clay : JieboColor.ink2)
            }
            if let section = item.section?.nilIfEmpty {
                Text(section).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.dim)
            }
            if let id = item.id, diagnostics?.selectedIds.contains(where: { $0.id == id }) == true {
                Text("上一轮用到了")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.pine)
            }
            if let sel = MemoryCenterReducer.selectionReasonForItem(id: item.id, diagnostics: diagnostics) {
                Text("上一轮为什么用到：\(MemoryCenterLabels.injectionReasonLabel(sel))")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.ink2)
            }
            if let skip = MemoryCenterReducer.skipReasonForItem(id: item.id, diagnostics: diagnostics) {
                Text(MemoryCenterLabels.skipReasonLabel(skip))
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
            }
            if !item.refs.isEmpty {
                Text("引用的文件：\(item.refs.joined(separator: "、"))")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.ink2)
            }
            if !item.missingRefs.isEmpty {
                Text("这些文件不在了：\(item.missingRefs.joined(separator: "、"))")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.clay)
            }
            if !scopeLabel.isEmpty {
                Text(scopeLabel).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.dim)
            }
            if item.kind == "workspace_memory", scopeId != nil, item.id != nil {
                ActionButton(title: "改", kind: .outline) { showEdit = true }
                    .disabled(store.memoryCenterData.mutating)
                    .accessibilityLabel("改")
                Text("文件夹规则在「规则与诊断」里查看，这里只改单条记忆。")
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
            }
        }
        .sheet(isPresented: $showEdit) {
            if let scopeId, item.id != nil {
                MemoryCenterWorkspaceEditSheet(scopeId: scopeId, item: item)
            }
        }
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(title)
                .font(JieboFont.text(.caption, weight: .semibold))
                .foregroundStyle(JieboColor.dim)
                .frame(width: 72, alignment: .leading)
            Text(value)
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.ink2)
        }
    }
}

struct MemoryCenterSearchList: View {
    @Environment(ChatStore.self) private var store
    @Binding var selectedKey: String?
    var itemNavigation: MemoryCenterItemNavigation = .columnSelection

    var body: some View {
        let data = store.memoryCenterData
        if let err = data.searchError.nilIfEmpty {
            MemoryCenterErrorBlock(message: err) {
                store.memoryCenterRetrySearch()
            }
        } else if data.loadingSearch, data.search == nil {
            MemoryCenterLoadingBlock(label: "正在找…")
        } else if let search = data.search {
            if search.truncated || search.payloadTruncated {
                MemoryCenterBanner(text: "搜索结果已截断", tone: .warn)
            }
            if search.hits.isEmpty {
                MemoryCenterEmptyBlock(title: "没找到", hint: "换个词，或到筛选里放宽。")
            } else {
                ForEach(search.hits, id: \.stableId) { hit in
                    let key = MemoryCenterReducer.itemKey(scopeId: hit.scopeId, id: hit.id)
                    switch itemNavigation {
                    case .columnSelection:
                        Button {
                            selectedKey = key
                        } label: {
                            MemoryCenterSearchHitRow(hit: hit, selected: selectedKey == key)
                        }
                        .buttonStyle(.plain)
                        .hitTarget()
                    case .drillDown, .drillDownSearchHit:
                        NavigationLink(value: PhoneRoute.memoryPage(.searchHit(key: key))) {
                            MemoryCenterSearchHitRow(hit: hit, selected: false)
                        }
                        .buttonStyle(.plain)
                        .hitTarget()
                    }
                }
            }
        } else if let title = store.memoryCenterSearchBlockedTitle {
            MemoryCenterEmptyBlock(title: title, hint: "")
        } else {
            MemoryCenterEmptyBlock(title: "正在找…", hint: "")
        }
    }
}

struct MemoryCenterSearchHitRow: View {
    @Environment(ChatStore.self) private var store
    let hit: MemoryCenterSearchHit
    var selected: Bool

    private var scopeLabel: String {
        MemoryCenterReducer.resolveScopeLabel(
            scopeId: hit.scopeId,
            scopes: store.memoryCenterData.overview?.scopes ?? []
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(MemoryCenterLabels.searchSource(kind: hit.kind, scopeLabel: scopeLabel))
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.ink2)
                if let word = MemoryCenterLabels.listStatusWord(pinned: hit.pinned, effectiveState: hit.effectiveState, missingRefs: hit.missingRefs) {
                    StatusTag(text: word, fg: JieboColor.ink2, bg: JieboColor.ink.opacity(0.08))
                }
            }
            Text(hit.text)
                .font(JieboFont.text(.footnote))
                .lineLimit(2)
            if !hit.reasons.isEmpty {
                Text(MemoryCenterLabels.formatSearchMatchReasons(hit.reasons))
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
            }
        }
        .padding(10)
        .background(selected ? JieboColor.pine.opacity(0.08) : JieboColor.ink.opacity(0.03))
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
    }
}

struct MemoryCenterSearchDetail: View {
    @Environment(ChatStore.self) private var store
    let selectedKey: String?

    var body: some View {
        if let key = selectedKey,
           let hit = store.memoryCenterData.search?.hits.first(where: {
               MemoryCenterReducer.itemKey(scopeId: $0.scopeId, id: $0.id) == key
           })
        {
            let scopeLabel = MemoryCenterReducer.resolveScopeLabel(
                scopeId: hit.scopeId,
                scopes: store.memoryCenterData.overview?.scopes ?? []
            )
            VStack(alignment: .leading, spacing: 8) {
                MemoryCenterItemDetailView(
                    item: WorkspaceMemoryItem(
                        id: hit.id,
                        kind: hit.kind,
                        layer: hit.layer,
                        scopeId: hit.scopeId,
                        section: hit.section,
                        text: hit.text,
                        refs: hit.refs,
                        missingRefs: hit.missingRefs,
                        at: nil,
                        from: nil,
                        state: hit.state,
                        effectiveState: hit.effectiveState,
                        pinned: hit.pinned,
                        used: nil,
                        uses: nil,
                        expires: nil,
                        truncated: false,
                        revision: ""
                    ),
                    diagnostics: nil,
                    scopeLabel: scopeLabel,
                    scopeId: nil
                )
                if !hit.reasons.isEmpty {
                    Text(MemoryCenterLabels.formatSearchMatchReasons(hit.reasons))
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                }
            }
        } else {
            MemoryCenterDetailEmptyHint(navId: "search")
        }
    }
}

struct MemoryCenterRulesList: View {
    let rules: [RuleFile]
    let truncated: Bool

    var body: some View {
        if rules.isEmpty {
            MemoryCenterEmptyBlock(title: "这个文件夹没有规则", hint: "")
        } else {
            ForEach(rules) { rule in
                VStack(alignment: .leading, spacing: 4) {
                    Text(rule.relPath)
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                    Text("\(rule.chars) 字 · 作用于 \(rule.appliesDir)")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                    Text(rule.body)
                        .font(JieboFont.text(.footnote))
                        .lineLimit(4)
                        .foregroundStyle(JieboColor.ink2)
                    if rule.truncated {
                        Text("正文已截断")
                            .font(JieboFont.text(.caption2))
                            .foregroundStyle(JieboColor.clay)
                    }
                }
                .assistantCard()
            }
            if truncated {
                MemoryCenterBanner(text: "规则列表已截断", tone: .warn)
            }
        }
    }
}

struct MemoryCenterDiagnosticsBlock: View {
    let diagnostics: InjectionDiagnostics?

    var body: some View {
        if let diagnostics {
            AssistantSection("上一轮怎么选的") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("带上了 \(diagnostics.selected) 条，一共 \(diagnostics.total) 条。")
                    Text("始终带上 \(diagnostics.pinnedSelected) · 和你说的有关 \(diagnostics.relevantSelected) · 很久没用但仍带上 \(diagnostics.coldRecalled)")
                    Text("这一轮太长没带上 \(diagnostics.skippedBudget) · 已经办完或过期 \(diagnostics.terminalSkipped)")
                    if diagnostics.selectedIdsTruncated || diagnostics.skippedReasonsTruncated || diagnostics.truncated {
                        MemoryCenterBanner(text: "有一部分没列全", tone: .warn)
                    }
                }
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
                .assistantCard()
            }
        } else {
            Text("上一轮没有选出记忆。")
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
        }
    }
}

// MARK: - iPhone 页面

enum MemoryCenterPhoneRoute: Hashable {
    case scope(id: String, label: String)
    case diagnostics(scopeId: String)
    case rules(scopeId: String)
    case suggestions
    case activity
    case search
    case item(scopeId: String, key: String)
    case searchHit(key: String)
    case me
    case coreField(String)
    case personalCreate
    case personalEdit(entryId: String)
    case transfer
}

struct MemoryCenterRememberMe: View {
    @Environment(ChatStore.self) private var store
    @Binding var selectedKey: String?
    var itemNavigation: MemoryCenterItemNavigation = .columnSelection

    var body: some View {
        let memory = store.assistantState?.memory
        VStack(alignment: .leading, spacing: 12) {
            if let memory {
                HStack {
                    Text(memory.paused ? "记忆已暂停" : "关于我和工作偏好每次都会带上。标了「不在这一轮」的句子还在，也能搜到。")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(memory.paused ? JieboColor.clay : JieboColor.dim)
                    Spacer()
                    if selectedKey != "create" {
                        ActionButton(title: "记一条", kind: .primary) { selectedKey = "create" }
                    }
                }
                Toggle("暂停记忆", isOn: Binding(
                    get: { memory.paused },
                    set: { store.setAssistantMemoryPaused($0) }
                ))
                .tint(JieboColor.pine)
                Text("约 \(memory.coreTokens)/\(memory.coreBudget)")
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
                ForEach(memory.orderedCoreKeys, id: \.self) { key in
                    Button {
                        selectedKey = "core:\(key)"
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(key).font(JieboFont.text(.subheadline, weight: .semibold))
                            Text((memory.coreFields[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "还没写" : memory.coreFields[key] ?? "")
                                .font(JieboFont.text(.footnote))
                                .foregroundStyle(JieboColor.ink2)
                                .lineLimit(2)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .assistantCard()
                    }
                    .buttonStyle(.plain)
                }
                ForEach(memory.entries.filter(\.isValid)) { entry in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(entry.topic.nilIfEmpty ?? "一条记忆").font(JieboFont.text(.subheadline, weight: .semibold))
                            Spacer()
                            Text(entry.inferred ? "推断" : "你说的")
                                .font(JieboFont.text(.caption2))
                                .foregroundStyle(JieboColor.dim)
                            if entry.resident == false {
                                Text("不在这一轮")
                                    .font(JieboFont.text(.caption2))
                                    .foregroundStyle(JieboColor.clay)
                            }
                        }
                        Text(entry.text).font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.ink2).lineLimit(3)
                        HStack(spacing: 12) {
                            Button("改") { selectedKey = "entry:\(entry.id)" }
                                .foregroundStyle(JieboColor.pine)
                                .frame(minHeight: 36)
                            Button("删") {
                                _ = store.queueMemoryChange("memory_purge", args: ["id": .string(entry.id)], pending: "删掉这条记忆")
                            }
                            .foregroundStyle(JieboColor.danger)
                            .frame(minHeight: 36)
                        }
                        .font(JieboFont.text(.caption, weight: .medium))
                        .buttonStyle(.plain)
                    }
                    .assistantCard()
                }
                let stale = memory.entries.filter { !$0.isValid }
                if !stale.isEmpty {
                    DisclosureGroup("已失效记忆") {
                        ForEach(stale) { entry in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(entry.topic.nilIfEmpty ?? "一条记忆")
                                    .font(JieboFont.text(.subheadline, weight: .semibold))
                                Text(entry.text)
                                    .font(JieboFont.text(.footnote))
                                    .foregroundStyle(JieboColor.dim)
                                    .lineLimit(3)
                                HStack(spacing: 12) {
                                    Button("恢复") {
                                        _ = store.queueMemoryChange("memory_restore", args: ["id": .string(entry.id)], pending: "恢复这条记忆")
                                    }
                                    .foregroundStyle(JieboColor.pine)
                                    .frame(minHeight: 36)
                                    Button("彻底删除") {
                                        _ = store.queueMemoryChange("memory_purge", args: ["id": .string(entry.id)], pending: "删掉这条记忆")
                                    }
                                    .foregroundStyle(JieboColor.danger)
                                    .frame(minHeight: 36)
                                }
                                .font(JieboFont.text(.caption, weight: .medium))
                                .buttonStyle(.plain)
                            }
                            .assistantCard()
                        }
                    }
                }
            } else {
                Text(store.assistantStatePendingTitle ?? "正在加载记忆…")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
            }
        }
        .onAppear { store.memoryCenterRefreshScope("work_preference") }
    }
}

struct MemoryCenterRememberDetail: View {
    @Environment(ChatStore.self) private var store
    let selectedKey: String?
    @State private var draft = ""
    @State private var original = ""
    @State private var entryTopic = ""
    @State private var entryText = ""
    @State private var originalEntryTopic = ""
    @State private var originalEntryText = ""

    var body: some View {
        if let key = selectedKey, key.hasPrefix("core:"), let memory = store.assistantState?.memory {
            let field = String(key.dropFirst(5))
            VStack(alignment: .leading, spacing: 8) {
                Text(field).font(JieboFont.display(22))
                TextField(field, text: $draft, axis: .vertical)
                    .lineLimit(4...10)
                ActionButton(title: "保存", kind: .primary) {
                    guard draft != original else { return }
                    guard store.queueMemoryChange("memory_core", args: [
                        "fields": .object([field: .string(draft)]),
                        "rev": .number(Double(memory.coreRev)),
                    ], pending: "改\(field)") else { return }
                    original = draft
                }
                .disabled(draft == original)
            }
            .onAppear { load(field, memory: memory) }
            .onChange(of: field) { _, _ in load(field, memory: memory) }
        } else if let key = selectedKey, key.hasPrefix("entry:"), let memory = store.assistantState?.memory {
            let entryId = String(key.dropFirst(6))
            if let entry = memory.entries.first(where: { $0.id == entryId && $0.isValid }) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("修改记忆").font(JieboFont.display(22))
                    TextField("主题，可以空着", text: $entryTopic)
                    TextField("要记住的话", text: $entryText, axis: .vertical)
                        .lineLimit(3...8)
                    ActionButton(title: "保存", kind: .primary) {
                        saveEntry(entry)
                    }
                    .disabled(!entryCanSave)
                }
                .onAppear { loadEntry(entry) }
                .onChange(of: entry.id) { _, _ in loadEntry(entry) }
                .onChange(of: entry.rev) { _, _ in loadEntry(entry) }
            } else {
                Text("这条已经不在了。")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
            }
        } else if selectedKey == "create" {
            MemoryCenterPersonalCreateForm()
        } else {
            Text("点一栏就能改。")
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.dim)
        }
    }

    private var entryCanSave: Bool {
        let body = entryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return false }
        return entryTopic != originalEntryTopic || entryText != originalEntryText
    }

    private func load(_ field: String, memory: AssistantMemory) {
        let value = memory.coreFields[field] ?? ""
        draft = value
        original = value
    }

    private func loadEntry(_ entry: AssistantMemoryEntry) {
        entryTopic = entry.topic
        entryText = entry.text
        originalEntryTopic = entry.topic
        originalEntryText = entry.text
    }

    private func saveEntry(_ entry: AssistantMemoryEntry) {
        let body = entryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, entryCanSave else { return }
        let title = entryTopic.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedTopic = title.isEmpty ? String(body.prefix(12)) : title
        guard store.queueMemoryChange("memory_edit", args: [
            "id": .string(entry.id),
            "rev": .number(Double(entry.rev)),
            "topic": .string(resolvedTopic),
            "text": .string(body),
        ], pending: "改记忆") else { return }
        entryTopic = resolvedTopic
        entryText = body
        originalEntryTopic = resolvedTopic
        originalEntryText = body
    }
}

struct MemoryCenterPersonalCreateForm: View {
    @Environment(ChatStore.self) private var store
    @State private var topic = ""
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("记一条").font(JieboFont.display(22))
            TextField("主题，可以空着", text: $topic)
            TextField("要记住的话", text: $text, axis: .vertical)
                .lineLimit(3...8)
            ActionButton(title: "保存", kind: .primary) {
                let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !body.isEmpty else { return }
                let title = topic.trimmingCharacters(in: .whitespacesAndNewlines)
                guard store.queueMemoryChange("memory_save", args: [
                    "topic": .string(title.isEmpty ? String(body.prefix(12)) : title),
                    "text": .string(body),
                ], pending: "记一条") else { return }
                topic = ""
                text = ""
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
}

struct MemoryCenterPhoneRememberMe: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        List {
            if let memory = store.assistantState?.memory {
                Section {
                    Text(memory.paused ? "记忆已暂停" : "关于我和工作偏好每次都会带上。标了「不在这一轮」的句子还在，也能搜到。约 \(memory.coreTokens)/\(memory.coreBudget)")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(memory.paused ? JieboColor.clay : JieboColor.dim)
                    Toggle("暂停记忆", isOn: Binding(
                        get: { memory.paused },
                        set: { store.setAssistantMemoryPaused($0) }
                    ))
                    .tint(JieboColor.pine)
                }
                .listRowBackground(JieboColor.white)
                Section {
                    ForEach(memory.orderedCoreKeys, id: \.self) { key in
                        NavigationLink(value: PhoneRoute.memoryPage(.coreField(key))) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(key)
                                Text((memory.coreFields[key] ?? "").isEmpty ? "还没写" : (memory.coreFields[key] ?? ""))
                                    .font(JieboFont.text(.footnote))
                                    .foregroundStyle(JieboColor.ink2)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
                .listRowBackground(JieboColor.white)
                Section {
                    ForEach(memory.entries.filter(\.isValid)) { entry in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(entry.topic.nilIfEmpty ?? "一条记忆")
                                Spacer()
                                Text(entry.inferred ? "推断" : "你说的")
                                    .font(JieboFont.text(.caption2))
                                    .foregroundStyle(JieboColor.dim)
                                if entry.resident == false {
                                    Text("不在这一轮")
                                        .font(JieboFont.text(.caption2))
                                        .foregroundStyle(JieboColor.clay)
                                }
                            }
                            Text(entry.text).font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.ink2).lineLimit(3)
                            HStack(spacing: 12) {
                                NavigationLink(value: PhoneRoute.memoryPage(.personalEdit(entryId: entry.id))) {
                                    Text("改")
                                        .foregroundStyle(JieboColor.pine)
                                }
                                .buttonStyle(.borderless)
                                Button("删") {
                                    _ = store.queueMemoryChange("memory_purge", args: ["id": .string(entry.id)], pending: "删掉这条记忆")
                                }
                                .buttonStyle(.borderless)
                                .foregroundStyle(JieboColor.danger)
                            }
                            .font(JieboFont.text(.caption, weight: .medium))
                        }
                    }
                }
                .listRowBackground(JieboColor.white)
                let stale = memory.entries.filter { !$0.isValid }
                if !stale.isEmpty {
                    Section("已失效记忆") {
                        ForEach(stale) { entry in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.topic.nilIfEmpty ?? "一条记忆")
                                Text(entry.text)
                                    .font(JieboFont.text(.footnote))
                                    .foregroundStyle(JieboColor.dim)
                                    .lineLimit(3)
                                HStack(spacing: 12) {
                                    Button("恢复") {
                                        _ = store.queueMemoryChange("memory_restore", args: ["id": .string(entry.id)], pending: "恢复这条记忆")
                                    }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(JieboColor.pine)
                                    Button("彻底删除") {
                                        _ = store.queueMemoryChange("memory_purge", args: ["id": .string(entry.id)], pending: "删掉这条记忆")
                                    }
                                    .buttonStyle(.borderless)
                                    .foregroundStyle(JieboColor.danger)
                                }
                                .font(JieboFont.text(.caption, weight: .medium))
                            }
                        }
                    }
                    .listRowBackground(JieboColor.white)
                }
            } else {
                Text(store.assistantStatePendingTitle ?? "正在加载记忆…")
                    .listRowBackground(JieboColor.white)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle("记得的我")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: PhoneRoute.memoryPage(.personalCreate)) {
                    Text("记一条")
                }
            }
        }
        .memoryCenterScreenHold(navId: "work_preference")
    }
}

struct MemoryCenterPhoneCoreField: View {
    let field: String
    @Environment(ChatStore.self) private var store
    @State private var draft = ""
    @State private var original = ""

    var body: some View {
        Form {
            TextField(field, text: $draft, axis: .vertical)
                .lineLimit(4...12)
                .listRowBackground(JieboColor.white)
            Button("保存") { save() }
                .disabled(draft == original)
                .listRowBackground(JieboColor.white)
        }
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle(field)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { reload() }
    }

    private func reload() {
        let value = store.assistantState?.memory?.coreFields[field] ?? ""
        draft = value
        original = value
    }

    private func save() {
        guard let memory = store.assistantState?.memory, draft != original else { return }
        guard store.queueMemoryChange("memory_core", args: [
            "fields": .object([field: .string(draft)]),
            "rev": .number(Double(memory.coreRev)),
        ], pending: "改\(field)") else { return }
        original = draft
    }
}

struct MemoryCenterPhonePersonalCreate: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var topic = ""
    @State private var text = ""

    var body: some View {
        Form {
            TextField("主题，可以空着", text: $topic)
                .listRowBackground(JieboColor.white)
            TextField("要记住的话", text: $text, axis: .vertical)
                .lineLimit(3...8)
                .listRowBackground(JieboColor.white)
            Button("保存") {
                let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !body.isEmpty else { return }
                let title = topic.trimmingCharacters(in: .whitespacesAndNewlines)
                guard store.queueMemoryChange("memory_save", args: [
                    "topic": .string(title.isEmpty ? String(body.prefix(12)) : title),
                    "text": .string(body),
                ], pending: "记一条") else { return }
                dismiss()
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .listRowBackground(JieboColor.white)
        }
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle("记一条")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct MemoryCenterPhonePersonalEdit: View {
    let entryId: String
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var topic = ""
    @State private var text = ""
    @State private var originalTopic = ""
    @State private var originalText = ""

    private var entry: AssistantMemoryEntry? {
        store.assistantState?.memory?.entries.first(where: { $0.id == entryId && $0.isValid })
    }

    private var canSave: Bool {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return false }
        return topic != originalTopic || text != originalText
    }

    var body: some View {
        Form {
            if let entry {
                TextField("主题，可以空着", text: $topic)
                    .listRowBackground(JieboColor.white)
                TextField("要记住的话", text: $text, axis: .vertical)
                    .lineLimit(3...8)
                    .listRowBackground(JieboColor.white)
                Button("保存") {
                    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !body.isEmpty, canSave else { return }
                    let title = topic.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard store.queueMemoryChange("memory_edit", args: [
                        "id": .string(entry.id),
                        "rev": .number(Double(entry.rev)),
                        "topic": .string(title.isEmpty ? String(body.prefix(12)) : title),
                        "text": .string(body),
                    ], pending: "改记忆") else { return }
                    dismiss()
                }
                .disabled(!canSave)
                .listRowBackground(JieboColor.white)
                .onAppear {
                    topic = entry.topic
                    text = entry.text
                    originalTopic = entry.topic
                    originalText = entry.text
                }
            } else {
                Text("这条已经不在了。")
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.dim)
                    .listRowBackground(JieboColor.white)
            }
        }
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle("修改记忆")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// 记忆下一级。打电话的栈和窄宽单栏各自注册，页面本身不再套导航栈。
struct MemoryCenterPhonePage: View {
    @Environment(ChatStore.self) private var store
    let route: MemoryCenterPhoneRoute
    @Binding var middleTab: String
    @Binding var stateFilter: String

    var body: some View {
        switch route {
        case let .diagnostics(scopeId):
            ScrollView {
                MemoryCenterDiagnosticsBlock(diagnostics: store.memoryCenterData.detail?.diagnostics)
                    .padding(12)
            }
            .background(JieboColor.paper)
            .navigationTitle("上一轮怎么选的")
            .memoryCenterScreenHold(navId: scopeId)
        case let .rules(scopeId):
            ScrollView {
                if let detail = store.memoryCenterData.detail {
                    MemoryCenterRulesList(rules: detail.rules, truncated: detail.rulesTruncated)
                        .padding(12)
                }
            }
            .background(JieboColor.paper)
            .navigationTitle("文件夹规则")
            .memoryCenterScreenHold(navId: scopeId)
        case let .scope(id, label):
            if id == "folder-missing" {
                MemoryCenterEmptyBlock(title: "还没打开文件夹", hint: "打开一个工作区后再看这里。")
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(JieboColor.paper)
                    .navigationTitle("这个文件夹")
            } else {
                MemoryCenterPhoneScopeList(
                    scopeId: id,
                    scopeLabel: label,
                    middleTab: $middleTab,
                    stateFilter: $stateFilter
                )
            }
        case .suggestions:
            MemoryCenterPhoneSuggestions()
        case .activity:
            MemoryCenterPhoneActivity()
        case .search:
            MemoryCenterPhoneSearchResults()
        case let .item(scopeId, key):
            MemoryCenterPhoneItemDetail(itemKey: key, scopeId: scopeId)
        case let .searchHit(key):
            MemoryCenterSearchHitDetail(itemKey: key)
        case .me:
            MemoryCenterPhoneRememberMe()
        case let .coreField(field):
            MemoryCenterPhoneCoreField(field: field)
        case .personalCreate:
            MemoryCenterPhonePersonalCreate()
        case let .personalEdit(entryId):
            MemoryCenterPhonePersonalEdit(entryId: entryId)
        case .transfer:
            ScrollView { MemoryCenterImportPane().padding(12) }
                .background(JieboColor.paper)
                .navigationTitle("导出与导入")
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// 小驳和设置页没有现成的筛选状态，下一级自己记。
struct MemoryCenterPhonePageHost: View {
    let route: MemoryCenterPhoneRoute
    @State private var middleTab = "all"
    @State private var stateFilter = "useful"

    var body: some View {
        MemoryCenterPhonePage(route: route, middleTab: $middleTab, stateFilter: $stateFilter)
    }
}

struct MemoryCenterPhoneHome: View {
    @Environment(ChatStore.self) private var store
    @Binding var navId: String
    @Binding var searchText: String
    @Binding var searchScopeFilter: String
    @Binding var searchKindFilter: String
    @Binding var searchStateFilter: String
    @Binding var searchActive: Bool

    private var folder: MemoryCenterScopeSummary? {
        MemoryCenterLabels.currentFolder(
            scopes: store.memoryCenterData.overview?.scopes ?? [],
            cwd: store.cwd,
            root: store.workspaceRoot
        )
    }

    var body: some View {
        List {
            if !searchActive {
                Section {
                    MemoryTidyButton()
                }
                .listRowBackground(JieboColor.white)
            }
            if searchActive {
                Section {
                    MemoryCenterSearchList(selectedKey: .constant(nil), itemNavigation: .drillDownSearchHit)
                }
                .listRowBackground(JieboColor.white)
            } else {
                Section("核心与文件夹") {
                    NavigationLink(value: PhoneRoute.memoryPage(.me)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("记得的我")
                            Text("关于我 · 工作偏好")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.dim)
                        }
                    }
                    NavigationLink(value: PhoneRoute.memoryPage(.scope(id: folder?.id ?? "folder-missing", label: folder?.label ?? "这个文件夹"))) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("这个文件夹")
                            Text(folder?.label ?? "还没打开文件夹")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.dim)
                        }
                    }
                    NavigationLink(value: PhoneRoute.memoryPage(.suggestions)) {
                        HStack {
                            Text("要你看一眼")
                            Spacer()
                            if !store.memoryCenterSuggestionRows.isEmpty {
                                Text("\(store.memoryCenterSuggestionRows.count)")
                                    .font(JieboFont.text(.caption, weight: .semibold))
                                    .foregroundStyle(JieboColor.clay)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(JieboColor.clay.opacity(0.16))
                                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                            }
                        }
                    }
                }
                .listRowBackground(JieboColor.white)
                Section("规则与诊断") {
                    if let folder {
                        NavigationLink(value: PhoneRoute.memoryPage(.rules(scopeId: folder.id))) {
                            Text("文件夹规则")
                        }
                        NavigationLink(value: PhoneRoute.memoryPage(.diagnostics(scopeId: folder.id))) {
                            Text("上一轮怎么选的")
                        }
                    } else {
                        Text("先打开一个文件夹，才能看规则和上一轮怎么选的。")
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.dim)
                    }
                    NavigationLink(value: PhoneRoute.memoryPage(.activity)) {
                        Text("最近改动")
                    }
                    NavigationLink(value: PhoneRoute.memoryPage(.transfer)) {
                        Text("导出与导入")
                    }
                }
                .listRowBackground(JieboColor.white)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle("记忆")
        .searchable(text: $searchText, prompt: "搜索记忆")
        .refreshable {
            store.memoryCenterRefreshOverview()
            store.memoryCenterLoadSuggestions()
        }
        .toolbar {
            if searchActive {
                ToolbarItem(placement: .topBarTrailing) {
                    MemoryCenterSearchFilters(
                        scopeFilter: $searchScopeFilter,
                        kindFilter: $searchKindFilter,
                        stateFilter: $searchStateFilter
                    )
                }
            }
        }
        .onAppear { store.memoryCenterLoadSuggestions() }
        .onChange(of: searchText) { _, value in
            searchActive = !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
}

struct MemoryCenterPhoneHealthSection: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        Section {
            if let overview = store.memoryCenterData.overview {
                VStack(alignment: .leading, spacing: 6) {
                    Text("个人有效 \(overview.personal.validEntries) · 失效 \(overview.personal.invalidEntries)")
                    Text("待处理 \(MemoryCenterReducer.overviewPendingTotal(scopes: overview.scopes))")
                    if overview.personal.paused {
                        StatusTag(text: "记忆已暂停", fg: JieboColor.clay, bg: JieboColor.clay.opacity(0.12))
                    }
                }
                .font(JieboFont.text(.footnote))
            } else if store.memoryCenterData.loadingOverview {
                HStack {
                    ProgressView()
                    Text("正在加载…")
                }
            } else if let title = store.memoryCenterReadPendingTitle {
                Text(title)
                    .font(JieboFont.text(.footnote))
                    .foregroundStyle(JieboColor.ink2)
            } else if !store.memoryCenterData.overviewError.isEmpty {
                MemoryCenterErrorBlock(message: store.memoryCenterData.overviewError) {
                    store.memoryCenterRefreshOverview()
                }
            }
        } header: {
            Text("健康")
        }
        .listRowBackground(JieboColor.white)
    }
}

struct MemoryCenterPhoneScopeList: View {
    @Environment(ChatStore.self) private var store
    let scopeId: String
    let scopeLabel: String
    @Binding var middleTab: String
    @Binding var stateFilter: String
    @State private var selectedKey: String?
    @State private var currentId = ""
    @State private var currentLabel = ""

    private var shownId: String { currentId.isEmpty ? scopeId : currentId }
    private var shownLabel: String { currentLabel.isEmpty ? scopeLabel : currentLabel }

    var body: some View {
        ScrollView {
            if shownId == "overview" {
                MemoryCenterOverviewPane(
                    onSelectScope: { _ in },
                    showsFolders: false
                )
                .padding(12)
            } else if shownId == "personal" || shownId == "work_preference" {
                MemoryCenterPhoneRememberMe()
            } else {
                MemoryCenterScopeItemsPane(
                    scopeId: shownId,
                    middleTab: $middleTab,
                    stateFilter: $stateFilter,
                    selectedKey: $selectedKey,
                    itemNavigation: .drillDown(scopeId: shownId),
                    onSwitchFolder: { id in
                        currentId = id
                        currentLabel = MemoryCenterReducer.resolveScopeLabel(
                            scopeId: id,
                            scopes: store.memoryCenterData.overview?.scopes ?? []
                        )
                        selectedKey = nil
                    }
                )
                .padding(12)
            }
        }
        .background(JieboColor.paper)
        .navigationTitle(shownLabel)
        .navigationBarTitleDisplayMode(.inline)
        .memoryCenterScreenHold(navId: shownId)
    }
}

struct MemoryCenterPhoneSuggestions: View {
    var body: some View {
        ScrollView {
            MemoryCenterSuggestionsPane()
                .padding(12)
        }
        .navigationTitle("要你看一眼")
        .navigationBarTitleDisplayMode(.inline)
        .background(JieboColor.paper)
    }
}

struct MemoryCenterPhoneActivity: View {
    var body: some View {
        ScrollView {
            MemoryCenterActivityPane()
                .padding(12)
        }
        .navigationTitle("最近改动")
        .navigationBarTitleDisplayMode(.inline)
        .background(JieboColor.paper)
    }
}

struct MemoryCenterSearchHitDetail: View {
    let itemKey: String

    var body: some View {
        ScrollView {
            MemoryCenterSearchDetail(selectedKey: itemKey)
                .padding(12)
        }
        .background(JieboColor.paper)
        .navigationTitle("条目")
        .navigationBarTitleDisplayMode(.inline)
        .memoryCenterScreenHold(navId: "overview", searchActive: true)
    }
}

struct MemoryCenterPhoneItemDetail: View {
    let itemKey: String
    let scopeId: String

    var body: some View {
        ScrollView {
            MemoryCenterItemDetailPane(scopeId: scopeId, middleTab: "all", selectedKey: itemKey)
                .padding(12)
        }
        .background(JieboColor.paper)
        .navigationTitle("条目")
        .navigationBarTitleDisplayMode(.inline)
        .memoryCenterScreenHold(navId: scopeId)
    }
}

struct MemoryCenterPhoneSearchResults: View {
    @State private var selectedKey: String?

    var body: some View {
        ScrollView {
            MemoryCenterSearchList(selectedKey: $selectedKey, itemNavigation: .drillDownSearchHit)
                .padding(12)
        }
        .background(JieboColor.paper)
        .navigationTitle("搜索结果")
        .navigationBarTitleDisplayMode(.inline)
        .memoryCenterScreenHold(navId: "overview", searchActive: true)
    }
}

// MARK: - 状态块

enum MemoryCenterBannerTone { case warn, info }

struct MemoryCenterBanner: View {
    let text: String
    var tone: MemoryCenterBannerTone = .info

    var body: some View {
        Text(text)
            .font(JieboFont.text(.caption, weight: .medium))
            .foregroundStyle(tone == .warn ? JieboColor.clay : JieboColor.dim)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(JieboColor.clay.opacity(tone == .warn ? 0.1 : 0.05))
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .accessibilityLabel(text)
    }
}

struct MemoryCenterLoadingBlock: View {
    let label: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(label)
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.dim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .accessibilityElement(children: .combine)
    }
}

struct MemoryCenterErrorBlock: View {
    let message: String
    var retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message)
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.clay)
            ActionButton(title: "重试", kind: .primary, action: retry)
        }
        .assistantCard()
        .accessibilityElement(children: .combine)
    }
}

struct MemoryCenterEmptyBlock: View {
    let title: String
    let hint: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(JieboFont.text(.subheadline, weight: .semibold))
            if !hint.isEmpty {
                Text(hint)
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
    }
}

struct MemoryCenterPlaceholderPane: View {
    let title: String

    var body: some View {
        MemoryCenterEmptyBlock(title: title, hint: "后续阶段开放。")
    }
}

struct MemoryCenterDetailEmptyHint: View {
    let navId: String

    var body: some View {
        MemoryCenterEmptyBlock(
            title: "选择条目",
            hint: navId == "search" ? "点选搜索结果查看详情。" : "在中间列表选一条记忆。"
        )
    }
}

struct MemoryCenterDetailDl<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            content
        }
        .assistantCard()
    }
}
