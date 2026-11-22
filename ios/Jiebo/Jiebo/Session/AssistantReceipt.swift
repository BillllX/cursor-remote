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
    var deliveredFile: TurnFile? = nil
    var sourceChatId: String? = nil
    var cancelled = false

    var snapshot: TurnFile? {
        deliveredFile ?? workspaceRun?.snapshots.first { $0.sha != nil } ?? artifact?.turnFile
    }

    var primaryTitle: String {
        if needsAttention { return "查看原因" }
        if let snapshot { return Self.fileTitle(snapshot.path) }
        if kind == "reminder" { return "查看提醒" }
        return "查看结果"
    }

    var statusTitle: String {
        if cancelled { return "已取消" }
        if needsAttention { return "需要你处理" }
        if kind == "reminder" { return "提醒到了" }
        if workspaceRun?.status == "no_change" { return "检查完成，暂无变化" }
        if snapshot != nil { return "成果已就绪" }
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
        func recent(_ timestamp: Double) -> Bool {
            now - timestamp <= 600_000 && timestamp <= now + 60_000
        }

        // 同一轮优先使用持久回执。旧版本的通知用结束时间关联，且不猜测产物。
        let delegations = state.delegations.compactMap { row -> AssistantReceipt? in
            guard ["done", "failed", "cancelled"].contains(row.status), let ended = row.endedAt else { return nil }
            let attempt = row.attempt ?? 1
            let notice = state.inbox.first {
                $0.delegationId == row.id && ($0.delegationReceipt?.attempt == attempt ||
                    ($0.delegationReceipt == nil && $0.createdAt >= ended))
            }
            guard notice == nil, !recentOnly || recent(ended) else { return nil }
            let file = row.status == "done" ? row.deliveredFiles?.first { $0.sha != nil } : nil
            return AssistantReceipt(id: "delegation:\(row.id):\(attempt)", kind: "delegation", title: row.title,
                                    summary: row.result ?? "可查看本次执行结果。",
                                    createdAt: ended, needsAttention: row.status == "failed",
                                    delegationId: row.id, inboxId: nil, artifact: nil, workspaceRun: nil,
                                    deliveredFile: file, sourceChatId: row.childChatId, cancelled: row.status == "cancelled")
        }
        let inbox = state.inbox.compactMap { item -> AssistantReceipt? in
            guard ["run", "reminder", "brief", "delegation"].contains(item.kind), !item.resolved, item.snoozedUntil == nil else { return nil }
            if recentOnly && (item.read || !recent(item.createdAt)) { return nil }
            let artifact = artifacts.first {
                $0.kind == "file" && $0.sha != nil && $0.sourceChatId != nil && $0.provenance?.inboxId == item.id
            }
            let delivery = item.delegationReceipt
            let file = delivery?.status == "done" ? delivery?.files.first { $0.sha != nil } : nil
            let id = item.delegationId.flatMap { delegationId in
                delivery.map { "delegation:\(delegationId):\($0.attempt)" }
            } ?? "inbox:\(item.id)"
            return AssistantReceipt(id: id, kind: item.kind, title: item.title, summary: item.body,
                                    createdAt: item.createdAt, needsAttention: item.requiresRecovery,
                                    delegationId: item.delegationId, inboxId: item.id,
                                    artifact: artifact, workspaceRun: item.workspaceRun,
                                    deliveredFile: file, sourceChatId: item.chatId,
                                    cancelled: delivery?.status == "cancelled")
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
