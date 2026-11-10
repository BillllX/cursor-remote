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
    @State private var expandedId: String?

    private var pendingProposals: [SkillFactoryProposalRow] {
        store.memoryCenterSkillProposals.filter { $0.status == "pending" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("已集成 \(store.memoryCenterSkillRows.count) 项能力 · 待审批草案 \(pendingProposals.count) 项")
                    .font(JieboFont.text(.caption))
                    .foregroundStyle(JieboColor.dim)
                Spacer()
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
                Text("待你审批的技能包草案（SHA-256 锁定）")
                    .font(JieboFont.text(.caption, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                ForEach(pendingProposals) { prop in
                    let isExpanded = expandedId == "prop:\(prop.id)"
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
                        Text("路径：\(prop.relSkillPath) · 模式：\(prop.mode == "write" ? "读写" : "只读") · SHA-256：\(prop.sha256)")
                            .font(JieboFont.text(.caption2))
                            .foregroundStyle(JieboColor.dim)
                        if !prop.promotedFromMemoryIds.isEmpty {
                            Text("批准后将自动把 \(prop.promotedFromMemoryIds.count) 条原工作区记忆标为「已办完」。")
                                .font(JieboFont.text(.caption2))
                                .foregroundStyle(JieboColor.pine)
                        }
                        if isExpanded {
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
                            ActionButton(title: isExpanded ? "收起全文" : "查看全文", kind: .outline) {
                                expandedId = isExpanded ? nil : "prop:\(prop.id)"
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

            Text("已集成技能与通道守卫")
                .font(JieboFont.text(.caption, weight: .semibold))
                .foregroundStyle(JieboColor.dim)

            ForEach(store.memoryCenterSkillRows) { sk in
                let isExpanded = expandedId == "skill:\(sk.id)"
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
                            StatusTag(text: "常驻摘要", fg: JieboColor.pine, bg: JieboColor.pine.opacity(0.12))
                        }
                        Spacer()
                        Text("采用 \(sk.adoptedCount) · 查阅 \(sk.viewedCount) · 预热 \(sk.prewarmedCount)")
                            .font(JieboFont.text(.caption2))
                            .foregroundStyle(JieboColor.dim)
                    }
                    if isExpanded {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("技能 ID：\(sk.id)").font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.dim)
                            Text("入口：\(sk.entry)").font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.dim)
                            if !sk.keywords.isEmpty {
                                Text("触发词：\(sk.keywords.joined(separator: "、"))").font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.dim)
                            }
                            if !sk.requiredTools.isEmpty {
                                Text("关联工具：\(sk.requiredTools.joined(separator: ", "))").font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.dim)
                            }
                            if let reason = sk.healthReason, !reason.isEmpty {
                                Text(reason).font(JieboFont.text(.caption2)).foregroundStyle(JieboColor.warnFg)
                            }
                        }
                        .padding(.top, 4)
                    }
                }
                .assistantCard()
                .contentShape(Rectangle())
                .onTapGesture {
                    expandedId = isExpanded ? nil : "skill:\(sk.id)"
                }
            }
        }
        .onAppear { store.memoryCenterLoadSkills() }
    }

    private static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "channel_guard": return "后台守卫"
        case "native_tool": return "原生工具"
        case "manual_runbook": return "受控手册"
        case "declarative_skill": return "技能包"
        default: return kind
        }
    }

    private static func scopeLabel(_ scope: String) -> String {
        switch scope {
        case "platform": return "平台级"
        case "workspace": return "工作区"
        case "repo": return "仓库级"
        default: return scope
        }
    }

    private static func healthLabel(_ health: String) -> String {
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
