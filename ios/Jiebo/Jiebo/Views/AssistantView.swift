import SwiftUI
import UIKit

extension AssistantDelegation {
    var statusLabel: String {
        switch status {
        case "queued": return "排队中"
        case "cancelled": return "已取消"
        case "running": return "进行中"
        case "awaiting": return "待批"
        case "done": return "完成"
        case "failed": return interrupted == true ? "已中断" : "失败"
        default: return status
        }
    }

    var statusColors: (fg: Color, bg: Color) {
        switch status {
        case "running": return (JieboColor.run, JieboColor.runBg)
        case "queued", "awaiting": return (JieboColor.warnFg, JieboColor.warnBg)
        case "done": return (JieboColor.ok, JieboColor.okBg)
        case "failed": return (JieboColor.danger, JieboColor.dangerBg)
        default: return (JieboColor.dim, JieboColor.mist)
        }
    }
}



struct DelegationQueueAction: View {
    @Environment(ChatStore.self) private var store
    @State private var pending = false
    @State private var error: String?
    @State private var rename = false
    @State private var path = ""
    let item: AssistantDelegation
    var fullWidth = false

    var body: some View {
        if item.status == "queued" || (item.interrupted == true && item.parentChatId != nil && item.parentChatId == store.assistantChatId) {
            let cancelling = item.status == "queued"
            ActionButton(title: pending ? "正在处理…" : cancelling ? "取消排队" : "恢复委派", kind: .outline, fullWidth: fullWidth) {
                pending = true
                error = nil
                Task { @MainActor in
                    let reply = await store.assistantOpData(cancelling ? "delegation_cancel" : "delegation_recover", args: [
                        "delegationId": .string(item.id),
                        "attempt": .number(Double(item.attempt ?? 1)),
                        "queuedOnly": .bool(cancelling),
                    ])
                    if !reply.ok {
                        error = reply.error ?? "暂未收到回执，请核对委派状态。"
                        store.requestAssistant(force: true)
                    }
                    pending = false
                }
            }
            .disabled(pending || !store.connected || !store.unlocked)
            if cancelling && item.waitReason == "等待同一产物更新完成", let files = item.expectedFiles, files.count == 1 {
                DisclosureGroup("另存新版本", isExpanded: $rename) {
                    TextField("新的工作区相对路径", text: $path)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    ActionButton(title: "另存并继续", kind: .outline, fullWidth: fullWidth) {
                        pending = true
                        error = nil
                        Task { @MainActor in
                            let reply = await store.assistantOpData("delegation_retarget", args: [
                                "delegationId": .string(item.id),
                                "attempt": .number(Double(item.attempt ?? 1)),
                                "outputPath": .string(path),
                            ])
                            if reply.ok { rename = false } else { error = reply.error ?? "操作未完成。" }
                            pending = false
                        }
                    }
                    .disabled(pending || !store.connected || !store.unlocked || path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if let error { AssistantMutedText(error) }
        }
    }
}
