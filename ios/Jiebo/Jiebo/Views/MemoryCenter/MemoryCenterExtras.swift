import SwiftUI

struct MemoryCenterActivityPane: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let err = store.memoryCenterActivityError, !err.isEmpty {
                Text(err).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warnFg)
            }
            if store.memoryCenterActivityLoading {
                ProgressView().accessibilityLabel("加载活动")
            } else if store.memoryCenterActivityRows.isEmpty {
                MemoryCenterEmptyBlock(
                    title: store.memoryCenterReadPendingTitle ?? "还没有改动",
                    hint: store.memoryCenterReadPendingTitle == nil ? "改过的记忆会出现在这里。" : ""
                )
            }
            ForEach(store.memoryCenterActivityRows) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(Self.actionLabel(row.action)) · \(Self.scopeLabel(row.scope))").font(JieboFont.text(.subheadline, weight: .semibold))
                    Text(row.summary).font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.ink2)
                    if row.canRestore {
                        ActionButton(title: "恢复", kind: .outline) {
                            store.memoryCenterRestore(scope: row.scope, auditId: row.auditId)
                        }
                        .disabled(store.memoryCenterExtrasStorage.restoreReqByAuditId[row.auditId] != nil)
                    } else if let blocked = row.blocked {
                        Text(blocked).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.dim)
                    }
                    if let err = store.memoryCenterExtrasStorage.restoreErrorByAuditId[row.auditId], !err.isEmpty {
                        Text(err).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.warnFg)
                    }
                }
                .assistantCard()
            }
        }
        .onAppear { store.memoryCenterLoadActivity() }
    }

    private static func actionLabel(_ action: String) -> String {
        switch action {
        case "create": return "创建"
        case "update": return "更新"
        case "set_state": return "改状态"
        case "set_pinned": return "始终带上"
        case "delete": return "删除"
        case "restore": return "恢复"
        default: return action
        }
    }

    private static func scopeLabel(_ scope: String) -> String {
        switch scope {
        case "personal": return "关于我"
        case "work_preference": return "工作偏好"
        case "personal_settings": return "个人设置"
        default: return scope
        }
    }
}

struct MemoryCenterSuggestionsPane: View {
    @Environment(ChatStore.self) private var store
    @State private var confirmBulk = false

    private var bulk: [MemoryCenterSuggestionRow] {
        store.memoryCenterSuggestionRows.filter { $0.risk == "low" && $0.kind != "missing_ref" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("重复、日期和搬家后的文件，用「梳理一遍」处理。这里的卡片可以不点。")
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
            if confirmBulk {
                ActionButton(title: "返回", kind: .outline) { confirmBulk = false }
                Text("看完全文再确认。缺引用的不会进这里。")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                ForEach(bulk) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("「\(row.summary)」").font(JieboFont.text(.subheadline))
                        Text(row.reason).font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.ink2)
                        Text(MemoryCenterLabels.suggestionOutcome(row.kind))
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.clay)
                    }
                    .assistantCard()
                }
                ActionButton(title: "确认处理这些", kind: .primary) {
                    for row in bulk {
                        store.memoryCenterAnswerSuggestion(scope: row.scope, id: row.id, accept: true)
                    }
                    confirmBulk = false
                }
            } else {
            suggestionList
            if !bulk.isEmpty {
                ActionButton(title: "一次处理风险低的 \(bulk.count) 条", kind: .outline) {
                    confirmBulk = true
                }
                .padding(.top, 8)
            }
            }
        }
        .onAppear { store.memoryCenterLoadSuggestions() }
    }

    private var suggestionList: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let err = store.memoryCenterSuggestionsError, !err.isEmpty {
                Text(err).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warnFg)
            }
            if store.memoryCenterSuggestionsLoading {
                ProgressView().accessibilityLabel("加载建议")
            } else if store.memoryCenterSuggestionRows.isEmpty {
                MemoryCenterEmptyBlock(
                    title: store.memoryCenterReadPendingTitle ?? "都处理完了",
                    hint: store.memoryCenterReadPendingTitle == nil ? "" : ""
                )
            }
            ForEach(store.memoryCenterSuggestionRows) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text("「\(row.summary)」").font(JieboFont.text(.subheadline))
                    Text(row.reason).font(JieboFont.text(.footnote)).foregroundStyle(JieboColor.ink2)
                    HStack(spacing: 8) {
                        ActionButton(title: "先留着", kind: .primary) {
                            store.memoryCenterAnswerSuggestion(scope: row.scope, id: row.id, accept: false)
                        }
                        .disabled(store.memoryCenterExtrasStorage.suggestionBusyById[row.id] == true)
                        Button {
                            store.memoryCenterAnswerSuggestion(scope: row.scope, id: row.id, accept: true)
                        } label: {
                            Text(MemoryCenterLabels.suggestionOutcome(row.kind))
                                .font(JieboFont.text(.subheadline, weight: .semibold))
                                .foregroundStyle(JieboColor.clay)
                                .padding(.horizontal, 12)
                                .frame(minHeight: 36)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(store.memoryCenterExtrasStorage.suggestionBusyById[row.id] == true)
                    }
                    if let err = store.memoryCenterExtrasStorage.suggestionErrorById[row.id], !err.isEmpty {
                        Text(err).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.warnFg)
                    }
                }
                .assistantCard()
            }
        }
    }
}

struct MemoryCenterSkillsPane: View {
    @Environment(ChatStore.self) private var store
    var selectedKey: Binding<String?>? = nil
    @State private var expandedId: String?
    @State private var scopeFilter = "all"

    private var pendingProposals: [SkillFactoryProposalRow] {
        store.memoryCenterSkillProposals.filter { $0.status == "pending" }
    }

    private var visibleSkills: [SkillFactorySummaryRow] {
        store.memoryCenterSkillRows.filter { scopeFilter == "all" ? true : $0.scope == scopeFilter }
    }

    private var callableSkills: [SkillFactorySummaryRow] {
        visibleSkills.filter { $0.kind != "channel_guard" }
    }

    private var guardSkills: [SkillFactorySummaryRow] {
        visibleSkills.filter { $0.kind == "channel_guard" }
    }

    private var activeKey: String? {
        selectedKey?.wrappedValue ?? expandedId
    }

    private func pickKey(_ key: String) {
        if let selectedKey {
            selectedKey.wrappedValue = (selectedKey.wrappedValue == key) ? nil : key
        } else {
            expandedId = (expandedId == key) ? nil : key
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("对话技能 \(callableSkills.count) 项 · 后台守卫 \(guardSkills.count) 项\(pendingProposals.isEmpty ? "" : " · 待启用 \(pendingProposals.count) 项")")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                Spacer()
                Picker("技能范围", selection: $scopeFilter) {
                    Text("全部范围").tag("all")
                    Text("平台级").tag("platform")
                    Text("工作区").tag("workspace")
                    Text("仓库级").tag("repo")
                }
                .pickerStyle(.menu)
                .font(JieboFont.text(.caption))
                Button {
                    store.memoryCenterLoadSkills()
                } label: {
                    Text("刷新")
                        .font(JieboFont.text(.caption, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                        .frame(minWidth: 44, minHeight: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            if let err = store.memoryCenterSkillsError, !err.isEmpty {
                Text(err).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warnFg)
            }

            if store.memoryCenterSkillsLoading && store.memoryCenterSkillRows.isEmpty {
                ProgressView().accessibilityLabel("正在加载技能工厂")
            }

            if !pendingProposals.isEmpty {
                Text("待你确认启用的新技能（\(pendingProposals.count) 项）")
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                ForEach(pendingProposals) { prop in
                    let key = "prop:\(prop.id)"
                    let isExpanded = activeKey == key
                    let busy = store.memoryCenterExtrasStorage.skillsDecideReqById[prop.id] != nil
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("\(prop.name) (\(prop.skillId))")
                                .font(JieboFont.text(.subheadline, weight: .semibold))
                            Spacer()
                            StatusTag(text: "待批准", fg: JieboColor.warnFg, bg: JieboColor.warnBg)
                        }
                        Text(prop.summary)
                            .font(JieboFont.text(.footnote))
                            .foregroundStyle(JieboColor.ink2)
                        Text("作用文件夹：\(prop.targetDir) · 权限：\(prop.mode == "write" ? "读写" : "只读") · 已通过安全门禁（#\(String(prop.sha256.prefix(8)))）")
                            .font(JieboFont.text(.caption2))
                            .foregroundStyle(JieboColor.dim)
                        if !prop.promotedFromMemoryIds.isEmpty {
                            Text("批准后将自动把 \(prop.promotedFromMemoryIds.count) 条原工作区记忆标为「已办完」。")
                                .font(JieboFont.text(.caption2))
                                .foregroundStyle(JieboColor.pine)
                        }
                        if isExpanded && selectedKey == nil {
                            Text("落盘路径：\(prop.relSkillPath)\nSHA-256：\(prop.sha256)")
                                .font(JieboFont.text(.caption2))
                                .foregroundStyle(JieboColor.dim)
                            ScrollView(.horizontal, showsIndicators: true) {
                                Text(prop.formattedMarkdown)
                                    .font(JieboFont.mono(.caption2))
                                    .foregroundStyle(JieboColor.ink)
                                    .padding(8)
                            }
                            .background(JieboColor.mist)
                            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                        }
                        HStack(spacing: 8) {
                            ActionButton(title: isExpanded ? "收起手册" : "预览技能手册", kind: .outline) {
                                pickKey(key)
                            }
                            ActionButton(title: busy ? "处理中…" : "批准上架", kind: .primary) {
                                store.memoryCenterDecideSkillProposal(proposalId: prop.id, approve: true, expectedRev: prop.rev)
                            }
                            .disabled(busy)
                            ActionButton(title: "拒绝", kind: .outline) {
                                store.memoryCenterDecideSkillProposal(proposalId: prop.id, approve: false, expectedRev: prop.rev)
                            }
                            .disabled(busy)
                        }
                    }
                    .assistantCard()
                }
            }

            Text("对话可用技能（可在聊天中调用）")
                .font(JieboFont.text(.caption, weight: .semibold))
                .foregroundStyle(JieboColor.dim)

            ForEach(callableSkills) { sk in
                skillRowView(sk)
            }

            if !guardSkills.isEmpty {
                Text("系统后台守卫（网关自动运行）")
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                ForEach(guardSkills) { sk in
                    skillRowView(sk)
                }
            }
        }
        .onAppear { store.memoryCenterLoadSkills() }
    }

    @ViewBuilder
    private func skillRowView(_ sk: SkillFactorySummaryRow) -> some View {
        let key = "skill:\(sk.id)"
        let isSelected = activeKey == key
        let isInlineExpanded = selectedKey == nil && expandedId == key
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(sk.name)
                    .font(JieboFont.text(.subheadline, weight: .semibold))
                Spacer()
                StatusTag(
                    text: Self.healthLabel(sk.health),
                    fg: sk.health == "healthy" ? JieboColor.ok : (sk.health == "tampered" ? JieboColor.errFg : JieboColor.warnFg),
                    bg: sk.health == "healthy" ? JieboColor.ok.opacity(0.12) : (sk.health == "tampered" ? JieboColor.errBg : JieboColor.warnBg)
                )
            }
            Text(sk.summary)
                .font(JieboFont.text(.footnote))
                .foregroundStyle(JieboColor.ink2)
            HStack(spacing: 6) {
                StatusTag(text: Self.kindLabel(sk.kind), fg: JieboColor.ink2, bg: JieboColor.mist)
                StatusTag(text: Self.scopeLabel(sk.scope), fg: JieboColor.ink2, bg: JieboColor.mist)
                if sk.pinned {
                    StatusTag(text: "常驻推荐", fg: JieboColor.pine, bg: JieboColor.pine.opacity(0.12))
                }
                if sk.autoPrewarm {
                    StatusTag(text: "自动预热", fg: JieboColor.pine, bg: JieboColor.pine.opacity(0.12))
                }
                Spacer()
                Text("采用 \(sk.adoptedCount) · 查阅 \(sk.viewedCount) · 预热 \(sk.prewarmedCount)")
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
            }
            if isInlineExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    if !sk.keywords.isEmpty {
                        Text("触发词：\(sk.keywords.joined(separator: "、"))").font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.dim)
                    }
                    if !sk.requiredTools.isEmpty {
                        Text("关联工具：\(sk.requiredTools.joined(separator: ", "))").font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.dim)
                    }
                    if let reason = sk.healthReason, !reason.isEmpty {
                        Text(reason).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.warnFg)
                    }
                    if let body = sk.body, !body.isEmpty {
                        ScrollView(.horizontal, showsIndicators: true) {
                            Text(body)
                                .font(JieboFont.mono(.caption2))
                                .foregroundStyle(JieboColor.ink)
                                .padding(8)
                        }
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                    }
                    Text("技能 ID：\(sk.id) · 入口：\(sk.entry)")
                        .font(JieboFont.text(.caption2))
                        .foregroundStyle(JieboColor.dim)
                }
                .padding(.top, 4)
            }
        }
        .assistantCard()
        .overlay(
            RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                .stroke(isSelected ? JieboColor.pine.opacity(0.45) : Color.clear, lineWidth: 1.5)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            pickKey(key)
        }
    }

    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "channel_guard": return "后台守卫"
        case "native_tool": return "原生工具"
        case "manual_runbook": return "受控手册"
        case "declarative_skill": return "技能包"
        default: return kind
        }
    }

    static func scopeLabel(_ scope: String) -> String {
        switch scope {
        case "platform": return "平台级"
        case "workspace": return "工作区"
        case "repo": return "仓库级"
        default: return scope
        }
    }

    static func healthLabel(_ health: String) -> String {
        switch health {
        case "healthy": return "正常"
        case "tampered": return "哈希篡改/未锁"
        case "broken_ref": return "引用待核实"
        case "degraded": return "降级运行"
        case "disabled": return "已停用"
        default: return health
        }
    }
}

struct MemoryCenterSkillDetailPane: View {
    @Environment(ChatStore.self) private var store
    let selectedKey: String?
    @State private var editingSkillId: String?
    @State private var editName = ""
    @State private var editSummary = ""
    @State private var editKeywords = ""
    @State private var editBody = ""

    private var pendingProposals: [SkillFactoryProposalRow] {
        store.memoryCenterSkillProposals.filter { $0.status == "pending" }
    }

    private var activeProposal: SkillFactoryProposalRow? {
        if let key = selectedKey, key.hasPrefix("prop:") {
            let id = String(key.dropFirst(5))
            return store.memoryCenterSkillProposals.first { $0.id == id }
        }
        if selectedKey == nil, let first = pendingProposals.first {
            return first
        }
        return nil
    }

    private var activeSkill: SkillFactorySummaryRow? {
        if let key = selectedKey, key.hasPrefix("skill:") {
            let id = String(key.dropFirst(6))
            return store.memoryCenterSkillRows.first { $0.id == id }
        }
        return store.memoryCenterSkillRows.first { $0.kind != "channel_guard" } ?? store.memoryCenterSkillRows.first
    }

    var body: some View {
        if let prop = activeProposal {
            let busy = store.memoryCenterExtrasStorage.skillsDecideReqById[prop.id] != nil
            VStack(alignment: .leading, spacing: 10) {
                Text("待启用技能草案")
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                HStack {
                    Text("\(prop.name) (\(prop.skillId))")
                        .font(JieboFont.text(.headline, weight: .semibold))
                    Spacer()
                    StatusTag(text: "待批准", fg: JieboColor.warnFg, bg: JieboColor.warnBg)
                }
                Text(prop.summary)
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(JieboColor.ink2)
                Text("作用文件夹：\(prop.targetDir) · 权限：\(prop.mode == "write" ? "读写" : "只读")")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                if !prop.keywords.isEmpty {
                    Text("触发词：\(prop.keywords.joined(separator: "、"))")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
                if !prop.requiredTools.isEmpty {
                    Text("关联工具：\(prop.requiredTools.joined(separator: ", "))")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
                if prop.status == "pending" {
                    HStack(spacing: 8) {
                        ActionButton(title: busy ? "处理中…" : "批准上架", kind: .primary) {
                            store.memoryCenterDecideSkillProposal(proposalId: prop.id, approve: true, expectedRev: prop.rev)
                        }
                        .disabled(busy)
                        ActionButton(title: "拒绝", kind: .outline) {
                            store.memoryCenterDecideSkillProposal(proposalId: prop.id, approve: false, expectedRev: prop.rev)
                        }
                        .disabled(busy)
                    }
                }
                Text("技能手册全文（SKILL.md）")
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                Text(prop.formattedMarkdown)
                    .font(JieboFont.mono(.caption2))
                    .foregroundStyle(JieboColor.ink)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(JieboColor.mist)
                    .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                    .textSelection(.enabled)
                DisclosureGroup("底层安全锁信息（#\(String(prop.sha256.prefix(8)))）") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("落盘路径：\(prop.relSkillPath)")
                        Text("SHA-256：\(prop.sha256)")
                    }
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
                }
                .font(JieboFont.text(.caption))
            }
        } else if let sk = activeSkill {
            VStack(alignment: .leading, spacing: 10) {
                Text(sk.kind == "channel_guard" ? "平台后台守卫（系统自动运行）" : "技能详情与操作手册")
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                HStack {
                    Text(sk.name)
                        .font(JieboFont.text(.headline, weight: .semibold))
                    Spacer()
                    StatusTag(
                        text: MemoryCenterSkillsPane.healthLabel(sk.health),
                        fg: sk.health == "healthy" ? JieboColor.ok : (sk.health == "tampered" ? JieboColor.errFg : JieboColor.warnFg),
                        bg: sk.health == "healthy" ? JieboColor.ok.opacity(0.12) : (sk.health == "tampered" ? JieboColor.errBg : JieboColor.warnBg)
                    )
                }
                Text(sk.summary)
                    .font(JieboFont.text(.subheadline))
                    .foregroundStyle(JieboColor.ink2)
                HStack(spacing: 6) {
                    StatusTag(text: MemoryCenterSkillsPane.kindLabel(sk.kind), fg: JieboColor.ink2, bg: JieboColor.mist)
                    StatusTag(text: MemoryCenterSkillsPane.scopeLabel(sk.scope), fg: JieboColor.ink2, bg: JieboColor.mist)
                    if sk.pinned {
                        StatusTag(text: "常驻推荐", fg: JieboColor.pine, bg: JieboColor.pine.opacity(0.12))
                    }
                }
                Text("被采用 \(sk.adoptedCount) 次 · 查阅 \(sk.viewedCount) 次 · 自动预热 \(sk.prewarmedCount) 次")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                if !sk.keywords.isEmpty {
                    Text("触发词：\(sk.keywords.joined(separator: "、"))")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
                if !sk.globs.isEmpty {
                    Text("匹配文件：\(sk.globs.joined(separator: "、"))")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
                if !sk.requiredTools.isEmpty {
                    Text("关联工具：\(sk.requiredTools.joined(separator: ", "))")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                }
                if let reason = sk.healthReason, !reason.isEmpty {
                    Text(reason)
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.warnFg)
                }
                if sk.kind != "channel_guard", sk.health != "tampered" {
                    HStack(spacing: 8) {
                        ActionButton(title: sk.pinned ? "取消常驻" : "设为常驻", kind: .outline) {
                            store.memoryCenterUpdateSkillMeta(skillId: sk.id, entry: sk.entry, pinned: !sk.pinned)
                        }
                        if sk.mode == "read" {
                            ActionButton(title: sk.autoPrewarm ? "关闭预热" : "开启预热", kind: .outline) {
                                store.memoryCenterUpdateSkillMeta(skillId: sk.id, entry: sk.entry, autoPrewarm: !sk.autoPrewarm)
                            }
                        }
                        ActionButton(title: sk.health == "disabled" ? "恢复启用" : "停用", kind: .outline) {
                            store.memoryCenterUpdateSkillMeta(skillId: sk.id, entry: sk.entry, disabled: sk.health != "disabled")
                        }
                    }
                }
                let canEdit = sk.kind == "declarative_skill" && sk.health == "healthy" && (sk.sha256?.isEmpty == false)
                if canEdit, editingSkillId != sk.id {
                    ActionButton(title: "编辑手册与触发词", kind: .outline) {
                        editingSkillId = sk.id
                        editName = sk.name
                        editSummary = sk.summary
                        editKeywords = sk.keywords.joined(separator: ", ")
                        editBody = sk.body ?? ""
                    }
                }
                if canEdit, editingSkillId == sk.id {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("在线编辑技能包（保存自动复检五道安全门禁并重签 SHA-256）")
                            .font(JieboFont.text(.caption, weight: .semibold))
                            .foregroundStyle(JieboColor.dim)
                        TextField("技能名称", text: $editName)
                        TextField("一句话摘要", text: $editSummary)
                        TextField("触发关键词（逗号分隔）", text: $editKeywords)
                        TextField("SOP 正文", text: $editBody, axis: .vertical)
                            .lineLimit(6...14)
                        HStack(spacing: 8) {
                            ActionButton(title: "保存并重签锁", kind: .primary) {
                                let kws = editKeywords
                                    .components(separatedBy: CharacterSet(charactersIn: ",，、"))
                                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                                    .filter { !$0.isEmpty }
                                store.memoryCenterEditApprovedSkill(
                                    skill: sk,
                                    name: editName,
                                    summary: editSummary,
                                    keywords: kws,
                                    body: editBody
                                )
                                editingSkillId = nil
                            }
                            .disabled(editName.trimmingCharacters(in: .whitespaces).isEmpty || editSummary.trimmingCharacters(in: .whitespaces).isEmpty || editBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            ActionButton(title: "取消", kind: .outline) {
                                editingSkillId = nil
                            }
                        }
                    }
                    .assistantCard()
                } else {
                    Text("操作手册（SOP 正文）")
                        .font(JieboFont.text(.caption, weight: .semibold))
                        .foregroundStyle(JieboColor.dim)
                    Text(sk.body ?? "（该能力未附带独立正文）")
                        .font(JieboFont.mono(.caption2))
                        .foregroundStyle(JieboColor.ink)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(JieboColor.mist)
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
                        .textSelection(.enabled)
                }
                DisclosureGroup("底层技术信息（\(sk.id)）") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("技能 ID：\(sk.id)")
                        Text("代码/文件入口：\(sk.entry)")
                        if let sha = sk.sha256, !sha.isEmpty {
                            Text("SHA-256：\(sha)")
                        }
                    }
                    .font(JieboFont.text(.caption2))
                    .foregroundStyle(JieboColor.dim)
                }
                .font(JieboFont.text(.caption))
            }
        } else {
            Text("在左侧点选一项技能或提案，查看完整操作手册（SOP）。")
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
        }
    }
}
