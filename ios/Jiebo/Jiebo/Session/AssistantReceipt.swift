import Foundation

/// 从已交付的实体生成入口，正文里的“已完成”不能单独产生文件按钮。
struct AssistantReceipt: Identifiable, Hashable {
    let id: String
    let kind: String
    let title: String
    let summary: String
    let createdAt: Double
    let needsAttention: Bool
    let delegationId: String?
    let inboxId: String?
    let artifact: Artifact?
    let workspaceRun: AssistantWorkspaceRun?

    var primaryTitle: String {
        if needsAttention { return "查看原因" }
        if let artifact, artifact.turnFile != nil { return Self.fileTitle(artifact.path ?? "") }
        if let path = workspaceRun?.files.first { return Self.fileTitle(path) }
        if kind == "reminder" { return "查看提醒" }
        return "查看结果"
    }

    var statusTitle: String {
        if needsAttention { return "需要你处理" }
        if kind == "reminder" { return "提醒到了" }
        if workspaceRun?.status == "no_change" { return "检查完成，暂无变化" }
        if artifact != nil || workspaceRun?.files.isEmpty == false { return "成果已就绪" }
        return "有一条新结果"
    }

    private static func fileTitle(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html": return "查看看板"
        case "md", "pdf": return "查看文档"
        case "png", "jpg", "jpeg", "webp": return "查看图片"
        default: return "打开文件"
        }
    }

    static func results(in state: AssistantState?, now: Double, recentOnly: Bool = true) -> [AssistantReceipt] {
        guard let state else { return [] }
        let artifacts = state.artifacts ?? []
        let delegations = state.delegations.compactMap { row -> AssistantReceipt? in
            guard row.status == "done" || row.status == "failed", let ended = row.endedAt else { return nil }
            let notice = state.inbox.first { $0.delegationId == row.id && $0.createdAt >= ended - 1000 }
            if recentOnly && (now - ended > 600_000 || ended > now + 60_000 || notice?.read == true) { return nil }
            let artifact = row.status == "done" ? artifacts.filter {
                $0.kind == "file" && $0.sha != nil && $0.sourceChatId != nil &&
                ($0.provenance?.delegationId == row.id || $0.sourceChatId == row.childChatId)
            }.max { $0.createdAt < $1.createdAt } : nil
            return AssistantReceipt(id: "delegation:\(row.id):\(row.attempt ?? 1)", kind: "delegation", title: row.title,
                                    summary: row.result ?? (row.status == "done" ? "执行完成，可查看本次结果。" : "执行未完成，请查看原因。"),
                                    createdAt: ended, needsAttention: row.status == "failed",
                                    delegationId: row.id, inboxId: notice?.id, artifact: artifact, workspaceRun: nil)
        }
        let inbox = state.inbox.compactMap { item -> AssistantReceipt? in
            guard ["run", "reminder", "brief", "delegation"].contains(item.kind), !item.resolved, item.snoozedUntil == nil else { return nil }
            if let id = item.delegationId, state.delegations.contains(where: { $0.id == id }) { return nil }
            if recentOnly && (item.read || now - item.createdAt > 600_000 || item.createdAt > now + 60_000) { return nil }
            let artifact = artifacts.first {
                $0.kind == "file" && $0.sha != nil && $0.sourceChatId != nil && $0.provenance?.inboxId == item.id
            }
            return AssistantReceipt(id: "inbox:\(item.id)", kind: item.kind, title: item.title, summary: item.body,
                                    createdAt: item.createdAt, needsAttention: item.attention == "recovery" || item.workspaceRun?.status == "failed" || item.workspaceRun?.status == "partial",
                                    delegationId: item.delegationId, inboxId: item.id,
                                    artifact: artifact, workspaceRun: item.workspaceRun)
        }
        return (delegations + inbox).sorted {
            if $0.needsAttention != $1.needsAttention { return $0.needsAttention }
            return $0.createdAt > $1.createdAt
        }
    }
}

/// 只记录本人已看到的结果，按网关和租户隔离。重建视图不重播，前后台切换不重播。
enum AssistantReceiptMemory {
    static func scope(server: String, tenant: String) -> String {
        "jiebo.receipt.\(server).\(tenant)"
    }

    static func contains(_ id: String, scope: String, defaults: UserDefaults = .standard) -> Bool {
        (defaults.stringArray(forKey: scope) ?? []).contains(id)
    }

    static func record(_ id: String, scope: String, defaults: UserDefaults = .standard) {
        let previous = defaults.stringArray(forKey: scope) ?? []
        guard !previous.contains(id) else { return }
        defaults.set(Array((previous + [id]).suffix(200)), forKey: scope)
    }
}
