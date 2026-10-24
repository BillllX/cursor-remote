import SwiftUI

// MARK: - 入口（按容器宽度分栏，ToolLayer ~420pt 走单栏 drill-down）

struct MemoryCenterPanelView: View {
    @Environment(\.assistantSceneToken) private var sceneToken
    @State private var navId = "overview"
    @State private var middleTab = "pinned"
    @State private var stateFilter = "all"
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
                .frame(minWidth: 160, idealWidth: 200, maxWidth: 240)
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
            .frame(minWidth: 240, idealWidth: 300, maxWidth: 360)
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
                store.memoryCenterResetIfInactive()
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

struct MemoryCenterNavColumn: View {
    @Environment(ChatStore.self) private var store
    @Binding var navId: String
    var compact: Bool
    @Binding var selectedKey: String?
    @Binding var searchText: String
    @Binding var searchActive: Bool

    private var data: MemoryCenterDataState { store.memoryCenterData }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                navButton("overview", title: "总览", symbol: NavigationIconId.overview.symbol)
                navButton("personal", title: "关于我", symbol: NavigationIconId.account.symbol)
                navButton("work_preference", title: "工作偏好", symbol: "briefcase")
                AssistantSection("工作区") {
                    ForEach(MemoryCenterReducer.buildScopeTreeRows(scopes: data.overview?.scopes ?? [])) { row in
                        navButton(row.id, title: row.summary.label, symbol: "folder", depth: row.depth)
                    }
                }
                navButton("activity", title: "活动", symbol: "clock")
                navButton("suggestions", title: "整理建议", symbol: "lightbulb")
                navButton("settings", title: "设置", symbol: NavigationIconId.account.symbol)
            }
            .padding(10)
        }
        .overlay(alignment: .topTrailing) {
            if data.loadingOverview {
                ProgressView()
                    .padding(8)
                    .accessibilityLabel("正在加载总览")
            }
        }
    }

    @ViewBuilder
    private func navButton(_ id: String, title: String, symbol: String, depth: Int = 0, placeholder: Bool = false) -> some View {
        let selected = navId == id
        Button {
            MemoryCenterUILayoutLogic.applyNavSelection(
                selectedKey: &selectedKey,
                searchText: &searchText,
                searchActive: &searchActive,
                navId: &navId,
                targetNavId: id
            )
            if !searchActive {
                store.memoryCenterClearSearchResults()
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
                Text(title)
                    .font(JieboFont.text(.subheadline, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? JieboColor.ink : JieboColor.ink2)
                    .lineLimit(2)
                Spacer(minLength: 0)
                if placeholder {
                    Text("后续")
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? JieboColor.ink.opacity(0.06) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(placeholder)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel(placeholder ? "\(title)，后续阶段" : title)
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
        } else if MemoryCenterReducer.isPlaceholderNav(navId) {
            MemoryCenterPlaceholderPane(title: "设置")
        } else if searchActive {
            MemoryCenterSearchList(selectedKey: $selectedKey, itemNavigation: itemNavigation)
        } else if navId == "overview" {
            MemoryCenterOverviewPane(onSelectScope: { id in
                navId = id
            })
        } else if navId == "personal" {
            MemoryCenterPersonalSummaryPane(manageExpanded: $managePersonalExpanded)
        } else {
            MemoryCenterScopeItemsPane(
                scopeId: navId,
                middleTab: $middleTab,
                stateFilter: $stateFilter,
                selectedKey: $selectedKey,
                itemNavigation: itemNavigation
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
                Text("全部范围").tag("all")
                ForEach(scopePickerOptions, id: \.id) { opt in
                    Text(opt.label).tag(opt.id)
                }
            }
            Picker("种类", selection: $kindFilter) {
                Text("全部种类").tag("all")
                ForEach(MemoryCenterLabels.searchableKinds, id: \.self) { k in
                    Text(MemoryCenterLabels.kindLabel(k)).tag(k)
                }
            }
            Picker("状态", selection: $stateFilter) {
                ForEach(MemoryCenterLabels.stateFilters, id: \.self) { s in
                    Text(s == "all" ? "全部状态" : MemoryCenterLabels.stateLabel(s)).tag(s)
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
    var scopeListMiddleTab: Binding<String>?
    var scopeListStateFilter: Binding<String>?

    private var data: MemoryCenterDataState { store.memoryCenterData }

    var body: some View {
        if let err = data.overviewError.nilIfEmpty {
            MemoryCenterErrorBlock(message: err) { store.memoryCenterRefreshOverview() }
        } else if data.loadingOverview, data.overview == nil {
            MemoryCenterLoadingBlock(label: "正在加载总览…")
        } else if let overview = data.overview {
            MemoryCenterOverviewCards(
                overview: overview,
                truncated: data.overviewPayloadTruncated,
                onSelectScope: onSelectScope,
                linkScopes: linkScopes,
                scopeListMiddleTab: scopeListMiddleTab,
                scopeListStateFilter: scopeListStateFilter
            )
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
    var scopeListMiddleTab: Binding<String>?
    var scopeListStateFilter: Binding<String>?

    var body: some View {
        let pending = MemoryCenterReducer.overviewPendingTotal(scopes: overview.scopes)
        VStack(alignment: .leading, spacing: 14) {
            if truncated {
                MemoryCenterBanner(text: "总览 payload 已截断", tone: .warn)
            }
            if overview.scopesTruncated {
                MemoryCenterBanner(text: "工作区范围列表已截断", tone: .warn)
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
            AssistantSection("工作区") {
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

struct MemoryCenterScopeHealthRow: View {
    let scope: MemoryCenterScopeSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(scope.label)
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                Spacer()
                if let health = MemoryCenterLabels.scopeHealthText(health: scope.health, error: scope.error) {
                    StatusTag(text: health, fg: JieboColor.clay, bg: JieboColor.clay.opacity(0.12))
                }
            }
            Text("活跃 \(scope.hot) · 冷门 \(scope.cold) · 完成 \(scope.done) · 过期 \(scope.expired) · 常驻 \(scope.pinned)")
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
            Text("缺引用 \(scope.missingRefs) · 本轮注入 \(scope.injectionSelected) · 预算 \(scope.tokenBudget) token")
                .font(JieboFont.text(.caption2))
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
}

struct MemoryCenterPersonalSummaryPane: View {
    @Environment(ChatStore.self) private var store
    @Binding var manageExpanded: Bool

    private var data: MemoryCenterDataState { store.memoryCenterData }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let overview = data.overview {
                MemoryCenterOverviewCards(overview: overview, truncated: data.overviewPayloadTruncated) { _ in }
            }
            DisclosureGroup(isExpanded: $manageExpanded) {
                AssistantMemoryPane()
            } label: {
                Text("管理个人记忆")
                    .font(JieboFont.text(.subheadline, weight: .semibold))
            }
            .accessibilityHint("展开后可编辑核心档案与条目")
        }
    }
}

struct MemoryCenterScopeItemsPane: View {
    @Environment(ChatStore.self) private var store
    let scopeId: String
    @Binding var middleTab: String
    @Binding var stateFilter: String
    @Binding var selectedKey: String?
    var itemNavigation: MemoryCenterItemNavigation = .columnSelection

    private var data: MemoryCenterDataState { store.memoryCenterData }

    var body: some View {
        if let err = data.scopeError.nilIfEmpty {
            MemoryCenterErrorBlock(message: err) { store.memoryCenterRefreshScope(scopeId) }
        } else if data.loadingScope, MemoryCenterReducer.detailForScope(data.detail, scopeId: scopeId) == nil {
            MemoryCenterLoadingBlock(label: "正在加载范围…")
        } else if let detail = MemoryCenterReducer.detailForScope(data.detail, scopeId: scopeId) {
            MemoryCenterScopeItemsContent(
                scopeId: scopeId,
                detail: detail,
                middleTab: $middleTab,
                stateFilter: $stateFilter,
                selectedKey: $selectedKey,
                itemNavigation: itemNavigation
            )
        } else {
            MemoryCenterEmptyBlock(title: "暂无详情", hint: "选择工作区或刷新。")
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
    @State private var showCreate = false

    var body: some View {
            VStack(alignment: .leading, spacing: 10) {
                if store.memoryCenterData.detailPayloadTruncated {
                    MemoryCenterBanner(text: "详情 payload 已截断", tone: .warn)
                }
                if detail.scope.kind == "workspace_memory" {
                    Button("新增记忆") { showCreate = true }
                        .buttonStyle(.borderedProminent)
                        .disabled(store.memoryCenterData.mutating)
                        .accessibilityLabel("新增记忆")
                }
                Picker("列表", selection: $middleTab) {
                    Text("常驻").tag("pinned")
                    Text("本轮注入").tag("injection")
                    Text("全部").tag("all")
                    Text("规则").tag("rules")
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("条目列表类型")

                if middleTab != "rules" {
                    Picker("状态", selection: $stateFilter) {
                        ForEach(MemoryCenterLabels.stateFilters, id: \.self) { s in
                            Text(s == "all" ? "全部" : MemoryCenterLabels.stateLabel(s)).tag(s)
                        }
                    }
                    .pickerStyle(.menu)
                }

                if middleTab == "rules" {
                    MemoryCenterRulesList(rules: detail.rules, truncated: detail.rulesTruncated || detail.rulesPayloadTruncated)
                } else {
                    MemoryCenterItemsList(
                        items: filteredItems(detail: detail),
                        diagnostics: detail.diagnostics,
                        selectedKey: $selectedKey,
                        itemNavigation: itemNavigation
                    )
                    if detail.itemsTruncated {
                        MemoryCenterBanner(text: "条目列表已截断", tone: .warn)
                    }
                }
                MemoryCenterDiagnosticsBlock(diagnostics: detail.diagnostics)
            }
            .sheet(isPresented: $showCreate) {
                MemoryCenterWorkspaceCreateSheet(scopeId: scopeId)
            }
    }

    private func filteredItems(detail: MemoryCenterScopeDetail) -> [WorkspaceMemoryItem] {
        switch middleTab {
        case "pinned":
            return MemoryCenterReducer.filterItemsByState(
                items: MemoryCenterReducer.pinnedOnlyItems(detail.items),
                stateFilter: stateFilter
            )
        case "injection":
            return MemoryCenterReducer.filterItemsByState(
                items: MemoryCenterReducer.injectionRoundItems(items: detail.items, diagnostics: detail.diagnostics),
                stateFilter: stateFilter
            )
        default:
            return MemoryCenterReducer.filterItemsByState(items: detail.items, stateFilter: stateFilter)
        }
    }
}

struct MemoryCenterItemsList: View {
    let items: [WorkspaceMemoryItem]
    let diagnostics: InjectionDiagnostics?
    @Binding var selectedKey: String?
    var itemNavigation: MemoryCenterItemNavigation = .columnSelection

    var body: some View {
        if items.isEmpty {
            MemoryCenterEmptyBlock(title: "没有条目", hint: "试试别的筛选或标签。")
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
                    NavigationLink {
                        MemoryCenterPhoneItemDetail(itemKey: key, scopeId: scopeId)
                    } label: {
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
                Text(item.section?.nilIfEmpty ?? MemoryCenterLabels.kindLabel(item.kind))
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                    .lineLimit(1)
                StatusTag(
                    text: MemoryCenterLabels.effectiveStateLabel(item.effectiveState),
                    fg: JieboColor.ink2,
                    bg: JieboColor.ink.opacity(0.08)
                )
                if item.pinned {
                    StatusTag(text: "常驻", fg: JieboColor.pine, bg: JieboColor.pine.opacity(0.12))
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
            MemoryCenterDetailDl {
                row("层级", item.layer)
                row("种类", MemoryCenterLabels.kindLabel(item.kind))
                row("作用域", scopeLabel)
                row("状态", MemoryCenterLabels.effectiveStateLabel(item.effectiveState))
                if item.pinned { row("常驻", "是") }
                if let section = item.section?.nilIfEmpty { row("章节", section) }
                if let at = item.at?.nilIfEmpty { row("记录时间", at) }
                if let from = item.from?.nilIfEmpty { row("来源", from) }
                if let expires = item.expires?.nilIfEmpty { row("过期", expires) }
                if let used = item.used?.nilIfEmpty { row("最近使用", used) }
                if let uses = item.uses { row("使用次数", "\(uses)") }
                if !item.refs.isEmpty { row("引用", item.refs.joined(separator: ", ")) }
                if !item.missingRefs.isEmpty { row("缺失引用", item.missingRefs.joined(separator: ", ")) }
            }
            if let sel = MemoryCenterReducer.selectionReasonForItem(id: item.id, diagnostics: diagnostics) {
                Text("选中原因：\(MemoryCenterLabels.injectionReasonLabel(sel))")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.pine)
            }
            if let skip = MemoryCenterReducer.skipReasonForItem(id: item.id, diagnostics: diagnostics) {
                Text("跳过原因：\(MemoryCenterLabels.skipReasonLabel(skip))")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
            }
            if item.kind == "workspace_memory", scopeId != nil, item.id != nil {
                Button("编辑…") { showEdit = true }
                    .buttonStyle(.bordered)
                    .disabled(store.memoryCenterData.mutating)
                    .accessibilityLabel("编辑工作区记忆")
                Text("规则文件只读；规则层编辑后续开放。")
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
            MemoryCenterLoadingBlock(label: "正在搜索…")
        } else if let search = data.search {
            Text("搜索不会续期记忆的使用计数。")
                .font(JieboFont.text(.caption2))
                .foregroundStyle(JieboColor.dim)
            if search.truncated || search.payloadTruncated {
                MemoryCenterBanner(text: "搜索结果已截断", tone: .warn)
            }
            if search.hits.isEmpty {
                MemoryCenterEmptyBlock(title: "无匹配", hint: "换个关键词或筛选。")
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
                        NavigationLink {
                            MemoryCenterSearchHitDetail(itemKey: key)
                        } label: {
                            MemoryCenterSearchHitRow(hit: hit, selected: false)
                        }
                        .buttonStyle(.plain)
                        .hitTarget()
                    }
                }
            }
        } else {
            MemoryCenterEmptyBlock(title: "输入关键词", hint: "300ms 后自动搜索。")
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
                StatusTag(text: MemoryCenterLabels.kindLabel(hit.kind), fg: JieboColor.ink2, bg: JieboColor.ink.opacity(0.08))
                StatusTag(text: scopeLabel, fg: JieboColor.ink2, bg: JieboColor.ink.opacity(0.08))
                StatusTag(text: MemoryCenterLabels.effectiveStateLabel(hit.effectiveState), fg: JieboColor.ink2, bg: JieboColor.ink.opacity(0.08))
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
                Text("匹配：\(MemoryCenterLabels.formatSearchMatchReasons(hit.reasons)) · 搜索不续期")
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
                Button("打开 \(hit.scopeId) 并加载") {
                    store.memoryCenterClearSearchResults()
                    store.memoryCenterSendGet(scopeId: hit.scopeId, replaceSameKind: true)
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
            MemoryCenterEmptyBlock(title: "没有规则文件", hint: "")
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
            AssistantSection("注入诊断") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("策略：\(diagnostics.strategy)")
                    Text("已选 \(diagnostics.selected) / 共 \(diagnostics.total) · 预算跳过 \(diagnostics.skippedBudget)")
                    Text("常驻 \(diagnostics.pinnedSelected) · 相关 \(diagnostics.relevantSelected) · 冷召回 \(diagnostics.coldRecalled)")
                    Text("终态跳过 \(diagnostics.terminalSkipped)")
                    if diagnostics.selectedIdsTruncated || diagnostics.skippedReasonsTruncated || diagnostics.truncated {
                        MemoryCenterBanner(text: "诊断 payload 已截断", tone: .warn)
                    }
                }
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
                .assistantCard()
            }
        }
    }
}

// MARK: - iPhone 页面

struct MemoryCenterPhoneHome: View {
    @Environment(ChatStore.self) private var store
    @Binding var navId: String
    @Binding var middleTab: String
    @Binding var stateFilter: String
    @Binding var searchText: String
    @Binding var searchScopeFilter: String
    @Binding var searchKindFilter: String
    @Binding var searchStateFilter: String
    @Binding var searchActive: Bool

    var body: some View {
        List {
            MemoryCenterPhoneHealthSection()
            Section("浏览") {
                NavigationLink {
                    MemoryCenterPhoneScopeList(
                        scopeId: "overview",
                        scopeLabel: "总览",
                        middleTab: $middleTab,
                        stateFilter: $stateFilter
                    )
                } label: {
                    Label("总览", systemImage: "square.grid.2x2")
                }
                NavigationLink {
                    MemoryCenterPhoneScopeList(
                        scopeId: "personal",
                        scopeLabel: "关于我",
                        middleTab: $middleTab,
                        stateFilter: $stateFilter
                    )
                } label: {
                    Label("关于我", systemImage: NavigationIconId.account.symbol)
                }
                NavigationLink {
                    MemoryCenterPhoneScopeList(
                        scopeId: "work_preference",
                        scopeLabel: "工作偏好",
                        middleTab: $middleTab,
                        stateFilter: $stateFilter
                    )
                } label: {
                    Label("工作偏好", systemImage: "briefcase")
                }
                NavigationLink {
                    MemoryCenterPhoneManagePersonal()
                } label: {
                    Label("管理个人记忆", systemImage: "pencil")
                }
                ForEach(MemoryCenterReducer.buildScopeTreeRows(scopes: store.memoryCenterData.overview?.scopes ?? [])) { row in
                    NavigationLink {
                        MemoryCenterPhoneScopeList(
                            scopeId: row.id,
                            scopeLabel: row.summary.label,
                            middleTab: $middleTab,
                            stateFilter: $stateFilter
                        )
                    } label: {
                        Text(String(repeating: " ", count: row.depth * 2) + row.summary.label)
                    }
                }
            }
            if searchActive {
                Section("搜索") {
                    NavigationLink {
                        MemoryCenterPhoneSearchResults()
                    } label: {
                        Label("查看搜索结果", systemImage: "magnifyingglass")
                    }
                }
            }
        }
        .navigationTitle("记忆")
        .searchable(text: $searchText, prompt: "搜索记忆")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                MemoryCenterSearchFilters(
                    scopeFilter: $searchScopeFilter,
                    kindFilter: $searchKindFilter,
                    stateFilter: $searchStateFilter
                )
            }
        }
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
            } else if !store.memoryCenterData.overviewError.isEmpty {
                MemoryCenterErrorBlock(message: store.memoryCenterData.overviewError) {
                    store.memoryCenterRefreshOverview()
                }
            }
        } header: {
            Text("健康")
        }
    }
}

struct MemoryCenterPhoneScopeList: View {
    @Environment(ChatStore.self) private var store
    let scopeId: String
    let scopeLabel: String
    @Binding var middleTab: String
    @Binding var stateFilter: String
    @State private var selectedKey: String?

    var body: some View {
        ScrollView {
            if scopeId == "overview" {
                MemoryCenterOverviewPane(
                    onSelectScope: { _ in },
                    linkScopes: true,
                    scopeListMiddleTab: $middleTab,
                    scopeListStateFilter: $stateFilter
                )
                .padding(12)
            } else if scopeId == "personal" {
                VStack(alignment: .leading, spacing: 12) {
                    MemoryCenterPersonalSummaryPane(manageExpanded: .constant(false))
                    NavigationLink {
                        MemoryCenterPhoneManagePersonal()
                    } label: {
                        Label("管理个人记忆", systemImage: "pencil")
                            .font(JieboFont.text(.subheadline, weight: .semibold))
                    }
                    .hitTarget()
                }
                .padding(12)
            } else {
                MemoryCenterScopeItemsPane(
                    scopeId: scopeId,
                    middleTab: $middleTab,
                    stateFilter: $stateFilter,
                    selectedKey: $selectedKey,
                    itemNavigation: .drillDown(scopeId: scopeId)
                )
                .padding(12)
            }
        }
        .navigationTitle(scopeLabel)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            store.memoryCenterEnsureLoaded(navId: scopeId, searchActive: false)
        }
    }
}

struct MemoryCenterPhoneManagePersonal: View {
    var body: some View {
        ScrollView {
            AssistantMemoryPane()
                .padding(14)
        }
        .navigationTitle("管理个人记忆")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct MemoryCenterSearchHitDetail: View {
    let itemKey: String

    var body: some View {
        ScrollView {
            MemoryCenterSearchDetail(selectedKey: itemKey)
                .padding(12)
        }
        .navigationTitle("条目")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct MemoryCenterPhoneItemDetail: View {
    @Environment(ChatStore.self) private var store
    let itemKey: String
    let scopeId: String

    var body: some View {
        ScrollView {
            MemoryCenterItemDetailPane(scopeId: scopeId, middleTab: "all", selectedKey: itemKey)
                .padding(12)
        }
        .navigationTitle("条目")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct MemoryCenterPhoneSearchResults: View {
    @State private var selectedKey: String?

    var body: some View {
        ScrollView {
            MemoryCenterSearchList(selectedKey: $selectedKey, itemNavigation: .drillDownSearchHit)
                .padding(12)
        }
        .navigationTitle("搜索结果")
        .navigationBarTitleDisplayMode(.inline)
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
