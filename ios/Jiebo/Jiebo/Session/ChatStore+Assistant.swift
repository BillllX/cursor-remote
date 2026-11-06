import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    // MARK: 个人助理

    /// 入口角标：未读收件箱 + 待批
    var assistantBadgeCount: Int {
        guard let state = assistantState else { return 0 }
        return state.unreadInbox + state.approvals.count
    }

    /// 停在审批上的委派子会话里，父会话是 parentId 的那些
    /// 待批已经出现在哪。用来把「等待你的确认」写成能找到按钮的一句。
    enum ApprovalHint: Equatable {
        case inComposer
        case aboveComposer
        case openInbox
        case backToAssistant

        var title: String {
            switch self {
            case .inComposer: "在输入框里批准或拒绝"
            case .aboveComposer: "在输入框上方批准或拒绝"
            case .openInbox: "待批在待处理，点按打开"
            case .backToAssistant: "回到小驳，在输入框上方确认"
            }
        }
    }

    enum ApprovalSurface {
        case phoneAssistant
        case padThread
        case phoneWorkbench
    }

    func approvalHint(for chatId: String, surface: ApprovalSurface) -> ApprovalHint? {
        guard assistantAvatarPhase == .approval else { return nil }
        if chats.first(where: { $0.id == chatId })?.turns.contains(where: { $0.pendingTool != nil }) == true {
            return .inComposer
        }
        if !assistantApprovals(forParent: chatId).isEmpty {
            return .aboveComposer
        }
        switch surface {
        case .phoneAssistant: return .aboveComposer
        case .padThread: return .openInbox
        case .phoneWorkbench: return .backToAssistant
        }
    }

    /// 后台模型没就绪时的原因。没有单独原因就用这句。
    var backgroundAttentionReason: String? {
        guard let background = assistantState?.background, !background.ok else { return nil }
        return background.reason?.nilIfEmpty ?? "后台模型未就绪"
    }

    /// 手机首页可以换行，把原因和下一步写在一起。
    var backgroundAttentionTitle: String? {
        guard let reason = backgroundAttentionReason else { return nil }
        return "\(reason)，点按再检查"
    }

    func assistantApprovals(forParent parentId: String) -> [AssistantApproval] {
        guard let state = assistantState, !parentId.isEmpty else { return [] }
        let delegationIds = Set(state.delegations.filter { $0.parentChatId == parentId }.map(\.id))
        return state.approvals.filter { approval in
            if let delegationId = approval.delegationId, delegationIds.contains(delegationId) { return true }
            return approval.parentChatId == parentId
        }
    }

    func requestAssistant(memory: Bool? = nil, force: Bool = false, freshnessWindow: TimeInterval? = nil) {
        if let memory { assistantMemoryDesired = memory }
        let desiredMemory = memory ?? assistantMemoryDesired
        guard connected, unlocked, gatewayReady else { return }
        if let freshnessWindow,
           !RefreshFreshnessPolicy.shouldRefresh(
               lastSuccess: assistantLastSuccessAt,
               now: Date(),
               window: freshnessWindow
           ) {
            return
        }
        guard assistantSyncGate.begin(memory: desiredMemory, force: force) else { return }
        // A revision learned from a non-memory projection cannot prove the memory payload is cached.
        let memoryIsCurrent = assistantState?.memory != nil
            && assistantMemoryRevision == assistantState?.revision
        let knownRevision = desiredMemory && !memoryIsCurrent ? nil : assistantState?.revision
        assistantRequestGeneration &+= 1
        let generation = assistantRequestGeneration
        let reqId = UUID().uuidString
        assistantInFlightGeneration = generation
        assistantInFlightReqId = reqId
        send(.assistantGet(memory: desiredMemory, knownRevision: knownRevision, reqId: reqId, generation: generation))
        assistantSyncTimeoutTask?.cancel()
        assistantSyncTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, !Task.isCancelled,
                  self.assistantSyncGate.inFlight,
                  self.assistantInFlightGeneration == generation
            else { return }
            self.assistantSyncFailed(timedOut: true)
        }
    }

    func receiveAssistantState(_ incoming: AssistantState, reqId: String?, generation: Int?) {
        let solicited = assistantResponseIsCurrent(reqId: reqId, generation: generation)
        if reqId != nil || generation != nil {
            guard solicited else { return }
            assistantTaggedResponsesSeen = true
        }
        if solicited,
           let currentRevision = assistantState?.revision,
           let incomingRevision = incoming.revision,
           incomingRevision < currentRevision {
            // 服务端恢复了旧备份或重建了 revision 代际：丢弃本地条件令牌后接受权威全量。
            clearCachedAssistant()
            assistantState = nil
            assistantMemoryRevision = nil
        }
        let carriesMemory = incoming.memory != nil
        switch AssistantStateReconcile.resolve(current: assistantState, incoming: incoming) {
        case .ignored:
            return
        case .apply(let next):
            assistantState = next
            if carriesMemory { assistantMemoryRevision = next.revision }
            assistantName = next.name
            assistantStateRevision &+= 1
            assistantNetworkConfirmed = true
            assistantLastSuccessAt = Date()
            updateCachedAssistant(next, memoryRevision: assistantMemoryRevision)
            AppLaunchMetrics.event("assistant_apply")
        }

        // A normal broadcast can advance the non-memory projection while a memory request is
        // outstanding. Only a memory-bearing state (or not_modified/failure) settles that request.
        guard solicited,
              assistantSyncGate.shouldSettleState(carriesMemory: carriesMemory, accepted: true)
        else { return }
        finishAssistantSync()
    }

    private func finishAssistantSync() {
        let wasInFlight = assistantSyncGate.inFlight
        assistantSyncTimeoutTask?.cancel()
        assistantSyncTimeoutTask = nil
        let followup = assistantSyncGate.complete()
        assistantInFlightGeneration = nil
        assistantInFlightReqId = nil
        if wasInFlight { noteConditionalSyncComplete() }
        if let followup { requestAssistant(memory: followup.memory, force: followup.force) }
    }

    func assistantSyncNotModified(revision: Int, reqId: String?, generation: Int?) {
        guard assistantResponseIsCurrent(reqId: reqId, generation: generation) else { return }
        if reqId != nil || generation != nil { assistantTaggedResponsesSeen = true }
        if let current = assistantState?.revision, revision < current {
            clearCachedAssistant()
            assistantState = nil
            assistantMemoryRevision = nil
            _ = assistantSyncGate.fail()
            assistantInFlightGeneration = nil
            assistantInFlightReqId = nil
            requestAssistant(force: true)
            return
        }
        if var state = assistantState,
           state.revision.map({ revision >= $0 }) ?? true,
           state.revision != revision {
            state.revision = revision
            if var object = state.rawJSON.object {
                object["revision"] = .number(Double(revision))
                state.rawJSON = .object(object)
            }
            assistantState = state
            updateCachedAssistant(state, memoryRevision: assistantMemoryRevision)
        }
        assistantNetworkConfirmed = true
        assistantLastSuccessAt = Date()
        assistantStateRevision &+= 1
        finishAssistantSync()
    }

    private func assistantResponseIsCurrent(reqId: String?, generation: Int?) -> Bool {
        if reqId == nil, generation == nil {
            // 旧网关不回显请求标识；见过新协议回包后，无标识消息只按广播处理。
            return assistantSyncGate.inFlight && !assistantTaggedResponsesSeen
        }
        return reqId == assistantInFlightReqId && generation == assistantInFlightGeneration
    }

    func assistantSyncFailed(timedOut: Bool = false) {
        let wasInFlight = assistantSyncGate.inFlight
        assistantSyncTimeoutTask?.cancel()
        assistantSyncTimeoutTask = nil
        let followup = assistantSyncGate.fail()
        assistantInFlightGeneration = nil
        assistantInFlightReqId = nil
        if wasInFlight {
            if timedOut { AppLaunchMetrics.event("assistant_sync_timeout") }
            AppLaunchMetrics.event("conditional_sync_failed")
        }
        if let followup {
            requestAssistant(memory: followup.memory, force: followup.force)
        }
    }

    /// 停止委派。还没登录不发。没连上时排队并说明，返回 false，调用方不要写成正在停止。已经连上才返回 true。
    @discardableResult
    func cancelDelegation(_ id: String) -> Bool {
        guard unlocked else {
            flash("还没登录。这次不会排队，登录后再停。")
            return false
        }
        assistantOp("delegation_cancel", args: ["delegationId": .string(id)])
        guard client.isOpen else {
            flash(linkState == .offline
                ? "已断开。停止这项委派会在连上后发出。"
                : "正在连接。停止这项委派会在连上后发出。")
            return false
        }
        return true
    }

    /// 添加、修改或删除待办。还没登录不发，调用方不要清掉输入。没连上时排队，并说明连上后才发出。
    @discardableResult
    func queueTodoChange(_ op: String, args: [String: JSONValue], pending: String) -> Bool {
        guard unlocked else {
            flash("还没登录。这次不会排队，登录后再改。")
            return false
        }
        assistantOp(op, args: args)
        guard !client.isOpen else { return true }
        flash(linkState == .offline
            ? "已断开。\(pending)会在连上后发出。"
            : "正在连接。\(pending)会在连上后发出。")
        return true
    }

    /// 完成或重新打开待办。还没登录不改。没连上时先在这台设备改，并说明连上后才告诉服务器。
    func setTodoDone(_ id: String, done: Bool) {
        guard unlocked else {
            flash("还没登录。这次不会排队，登录后再改。")
            return
        }
        assistantOp(done ? "todo_done" : "todo_undo", args: ["id": .string(id)])
        if let index = assistantState?.todos.firstIndex(where: { $0.id == id }) {
            assistantState?.todos[index].done = done
            assistantState?.todos[index].doneAt = done ? Date().timeIntervalSince1970 * 1000 : nil
        }
        guard !client.isOpen else { return }
        let marked = done ? "标成完成" : "标成未完成"
        flash(linkState == .offline
            ? "已断开。这台设备已把这条待办\(marked)，连上后才会告诉服务器。"
            : "正在连接。这台设备已把这条待办\(marked)，连上后才会告诉服务器。")
    }

    /// 测试通知不进待发队列。还没登录、没连上，或服务器没配推送时不发，也不写成已经发出。
    func sendTestPush() {
        guard unlocked else {
            flash("还没登录。这次不会发测试通知，登录后再试。")
            return
        }
        guard client.isOpen else {
            flash(linkState == .offline
                ? "已断开。这次不会发测试通知，点按重连后再试。"
                : "正在连接。这次不会发测试通知，连上后再试。")
            return
        }
        if assistantState?.pushApns == false {
            flash("服务器未配置推送，这次发不出去。")
            return
        }
        assistantOp("push_test")
        flash("已发送测试通知，几秒内应该收到")
    }

    /// 委派过程读不了。nil 表示已经连上，界面可以写正在读取。
    func delegationProcessPendingTitle(chatId: String?) -> String? {
        guard unlocked else { return "还没登录。登录后再看过程。" }
        guard client.isOpen else {
            return linkState == .offline
                ? "已断开。点按重连后再看过程。"
                : "正在连接。连上后再看过程。"
        }
        if let chatId, !chatId.isEmpty, cachedOnlyIds.contains(chatId) {
            return "这条过程还没对上服务器，稍后再看。"
        }
        return nil
    }

    /// 助理状态还没到。nil 表示已经连上，界面可以写正在加载。
    var assistantStatePendingTitle: String? {
        guard unlocked else { return "还没登录。登录后再看。" }
        guard client.isOpen else {
            return linkState == .offline
                ? "已断开。点按重连后再看。"
                : "正在连接。连上后再看。"
        }
        guard gatewayReady else { return "正在打开，稍后再看。" }
        return nil
    }

    func assistantOp(_ op: String, args: [String: JSONValue] = [:]) {
        send(.assistantOp(op: op, args: args, reqId: UUID().uuidString))
    }

    /// 发 assistant_op 并等网关的 assistant_result（按 reqId 配对）。没连上直接 false；超时或断线也是 false
    func assistantOpReply(_ op: String, args: [String: JSONValue] = [:], timeout: Duration) async -> Bool {
        guard connected, unlocked else { return false }
        let reqId = UUID().uuidString
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            assistantReplyWaiters[reqId] = { ok in continuation.resume(returning: ok) }
            send(.assistantOp(op: op, args: args, reqId: reqId))
            // 强引用：store 活到超时，保证 continuation 一定被 resume
            Task { @MainActor in
                try? await Task.sleep(for: timeout)
                self.assistantReplyWaiters.removeValue(forKey: reqId)?(false)
            }
        }
    }

    /// 要带回 data 的操作（知识库状态、口令）。超时或断线回 false
    func assistantOpData(
        _ op: String,
        args: [String: JSONValue] = [:],
        timeout: Duration = .seconds(20)
    ) async -> (ok: Bool, error: String?, data: JSONValue?) {
        guard connected, unlocked else { return (false, "还没连上", nil) }
        let reqId = UUID().uuidString
        return await withCheckedContinuation { continuation in
            assistantDataWaiters[reqId] = { ok, error, data in
                continuation.resume(returning: (ok, error, data))
            }
            send(.assistantOp(op: op, args: args, reqId: reqId))
            Task { @MainActor in
                try? await Task.sleep(for: timeout)
                guard let waiter = self.assistantDataWaiters.removeValue(forKey: reqId) else { return }
                waiter(false, "没有等到服务器回应", nil)
            }
        }
    }

    /// 断线：在等的回包不会来了
    func failAssistantReplyWaiters() {
        let waiters = assistantReplyWaiters
        assistantReplyWaiters = [:]
        for waiter in waiters.values { waiter(false) }
        let dataWaiters = assistantDataWaiters
        assistantDataWaiters = [:]
        for waiter in dataWaiters.values { waiter(false, "已断开", nil) }
    }

    func answerAssistantApproval(_ approval: AssistantApproval, allow: Bool) {
        guard noteApprovalDelivery(chatId: approval.chatId) else { return }
        assistantOp("approval_answer", args: [
            "chatId": .string(approval.chatId),
            "callId": .string(approval.callId),
            "allow": .bool(allow),
        ])
        assistantState?.approvals.removeAll { $0.id == approval.id }
    }

    func openAssistantInboxItem(_ item: AssistantInboxItem) {
        if !item.read {
            markInboxRead(item)
        }
        if let chatId = item.chatId {
            openAssistantChat(chatId)
        } else {
            toolLayer = nil
            openAssistantChat()
        }
        if let prompt = item.actionPrompt, let assistantChatId {
            submit(chatId: assistantChatId, text: prompt)
        }
    }

    /// iPhone 兼容入口：保持原有切到小驳主会话的行为。
    @discardableResult
    func continueArtifact(_ artifact: Artifact) -> Bool {
        continueArtifact(artifact, selectAssistant: true)
    }

    /// iPad 续作入口：由 PadRouter 切域，不触碰工作台 activeId。
    @discardableResult
    func continueArtifactOnPad(_ artifact: Artifact) -> Bool {
        continueArtifact(artifact, selectAssistant: false)
    }

    /// 产物续作始终定向助理主会话，并保留用户正在输入的草稿。
    private func continueArtifact(_ artifact: Artifact, selectAssistant: Bool) -> Bool {
        guard connected, unlocked else {
            flashNotHandedOff()
            return false
        }
        guard let assistantChatId,
              chats.contains(where: { $0.id == assistantChatId })
        else {
            flashAssistantChatMissing()
            return false
        }
        let source = artifact.provenance?.label ?? {
            if let turn = artifact.sourceTurnId { return "会话回合 \(turn)" }
            if let inbox = artifact.provenance?.inboxId { return "通知 \(inbox)" }
            return "产物中心"
        }()
        let target: String
        if let path = artifact.path {
            target = "文件夹相对路径：\(path)"
        } else if let url = artifact.safeURL?.absoluteString {
            target = "来源 URL：\(url)"
        } else {
            target = "捕获记录：\(artifact.title)（ID：\(artifact.provenance?.captureId ?? artifact.id)）"
        }
        let prompt = """
        请继续加工这个产物，并先确认你理解它的来源。
        产物：\(artifact.title)
        来源：\(source)
        \(target)
        """
        let savedDraft = draft(for: assistantChatId)
        if selectAssistant { openAssistantChat() }
        submit(chatId: assistantChatId, text: prompt)
        saveDraft(savedDraft, forChat: assistantChatId)
        flash("已交给小驳继续处理")
        return true
    }

    /// 执行统一任务投影附带的既有动作；只允许协议已经定义的操作。
    func performPersonalTaskAction(_ action: PersonalTaskAction) {
        switch action.op {
        case "todo_done", "todo_undo":
            guard let id = action.id else { return }
            setTodoDone(id, done: action.op == "todo_done")
        case "schedule_set":
            guard let id = action.id, let enabled = action.enabled else { return }
            assistantSetScheduleEnabled(id, enabled: enabled)
        case "delegation_cancel":
            guard let delegationId = action.delegationId else { return }
            cancelDelegation(delegationId)
        case "approval_answer":
            guard let chatId = action.chatId, let callId = action.callId, let allow = action.allow else { return }
            guard noteApprovalDelivery(chatId: chatId) else { return }
            assistantOp("approval_answer", args: [
                "chatId": .string(chatId),
                "callId": .string(callId),
                "allow": .bool(allow),
            ])
            assistantState?.approvals.removeAll { $0.chatId == chatId && $0.callId == callId }
        default:
            flash("这个操作需要更新后才能执行")
        }
    }

    /// iPad 收件箱动作：固定提交到小驳主会话，不选择工作台会话。
    @discardableResult
    func handlePadInboxItem(_ item: AssistantInboxItem) -> Bool {
        if !item.read {
            markInboxRead(item)
        }
        guard let prompt = item.actionPrompt else { return true }
        guard let assistantChatId, chats.contains(where: { $0.id == assistantChatId }) else {
            if !connected || !unlocked {
                flashNotHandedOff()
            } else {
                flashAssistantChatMissing()
            }
            return false
        }
        let savedDraft = draft(for: assistantChatId)
        submit(chatId: assistantChatId, text: prompt)
        saveDraft(savedDraft, forChat: assistantChatId)
        return true
    }

    /// 主会话还不能收。没有会话就再拉一次；有 id 但本机还没有，就等它到了再打开。这次不会排队。
    private func flashAssistantChatMissing() {
        if assistantChatId == nil, gatewayReady {
            flash("这个服务器还没有助理功能，请先升级服务器")
            return
        }
        if assistantChatId == nil {
            requestAssistant(force: true)
            flash("正在打开小驳主会话。这次不会排队，打开后再交给小驳。")
            return
        }
        pendingAssistantOpen = true
        flash("小驳主会话还没同步到这台设备。这次不会排队，到了会打开小驳，然后再交给它。")
    }

    /// 交给小驳没发出去。跟顶栏同一套连接状态，并写明这次不会排队。
    private func flashNotHandedOff() {
        if !unlocked {
            flash("还没登录。这次不会排队，登录后再交给小驳。")
        } else if linkState == .offline {
            flash("已断开。这次不会排队，点按重连后再交给小驳。")
        } else {
            flash("正在连接。这次不会排队，连上后再交给小驳。")
        }
    }

    /// 语义拖放只在实体仍存在且在线时提交；Prompt 没有服务端幂等回执，不能伪装成离线已入队。
    @discardableResult
    func continuePadTransfer(_ transfer: PadSemanticTransfer) -> Bool {
        guard transfer.isValid else {
            flash("拖入的项目已经失效")
            return false
        }
        guard connected, unlocked else {
            flashNotHandedOff()
            return false
        }
        let projection = PadAssistantProjection(state: assistantState)
        guard projection.contains(transfer) else {
            requestAssistant(force: true)
            flash("这个项目已经变了，没有交给小驳。列表会再拉一次，然后重新拖。")
            return false
        }
        if transfer.kind == .artifact,
           let artifact = projection.artifacts.first(where: { $0.id == transfer.stableID }) {
            return continueArtifactOnPad(artifact)
        }
        guard let assistantChatId, chats.contains(where: { $0.id == assistantChatId }) else {
            flashAssistantChatMissing()
            return false
        }
        let kind: String
        switch transfer.kind {
        case .task: kind = "任务"
        case .inbox: kind = "待处理事项"
        case .draft: kind = "行动卡"
        case .artifact: kind = "产物"
        }
        let prompt = "请继续处理这项\(kind)：\(transfer.title)\n稳定 ID：\(transfer.stableID)"
        let savedDraft = draft(for: assistantChatId)
        submit(chatId: assistantChatId, text: prompt)
        saveDraft(savedDraft, forChat: assistantChatId)
        flash("已交给小驳继续处理")
        return true
    }

    func isAssistantChat(_ id: String?) -> Bool {
        guard let id, let assistantChatId else { return false }
        return id == assistantChatId
    }

    var assistantChat: ChatSession? {
        guard let assistantChatId else { return nil }
        return chats.first { $0.id == assistantChatId }
    }

    var assistantChatActive: Bool { isAssistantChat(activeId) }

    /// 置顶入口的一行摘要：最后一条消息；正文没加载时用网关下发的摘要
    var assistantPreview: String {
        guard let chat = assistantChat else { return "" }
        let turn = chat.turns.last
        let last: String = turn?.assistant.nilIfEmpty ?? turn?.user.nilIfEmpty ?? chat.serverPreview?.nilIfEmpty ?? ""
        return last.split(whereSeparator: \.isNewline).joined(separator: " ")
    }

    /// 切到助理会话。旧网关没有助理会话时只提示，不再打开工作台里的助理层。
    func openAssistantEntry() {
        guard assistantChatId != nil else {
            flash("这个服务器还没有助理功能，请先升级服务器")
            return
        }
        openAssistantChat()
    }

    /// 切到助理会话。本机还没同步到就记下意图，会话到了再切（不在本地新建）
    func openAssistantChat() {
        guard let id = assistantChatId, chats.contains(where: { $0.id == id }) else {
            pendingAssistantOpen = true
            return
        }
        pendingAssistantOpen = false
        select(id)
    }

    func fulfillPendingAssistantOpen() {
        guard pendingAssistantOpen, let id = assistantChatId, chats.contains(where: { $0.id == id }) else { return }
        pendingAssistantOpen = false
        select(id)
    }

    /// 打开助理关联的会话（委派子会话、收件箱条目）。本机还没同步到的会话不切，避免 activeId 指向空壳
    func openAssistantChat(_ chatId: String) {
        guard chats.contains(where: { $0.id == chatId }) else {
            flash("这个会话还没同步到本机")
            return
        }
        toolLayer = nil
        select(chatId)
    }

    /// 保存、修改、遗忘或删除记忆。还没登录不发，调用方不要清掉输入。没连上时排队，并说明连上后才发出。
    @discardableResult
    func queueMemoryChange(_ op: String, args: [String: JSONValue], pending: String) -> Bool {
        guard unlocked else {
            flash("还没登录。这次不会排队，登录后再改。")
            return false
        }
        assistantOp(op, args: args)
        guard !client.isOpen else { return true }
        flash(linkState == .offline
            ? "已断开。\(pending)会在连上后发出。"
            : "正在连接。\(pending)会在连上后发出。")
        return true
    }

    /// 暂停记忆。还没登录不改开关。没连上时先在这台设备改，并说明连上后才告诉服务器。
    func setAssistantMemoryPaused(_ paused: Bool) {
        guard unlocked else {
            flash("还没登录。这次不会排队，登录后再改。")
            return
        }
        assistantOp("memory_settings", args: ["paused": .bool(paused)])
        assistantState?.memory?.paused = paused
        guard !client.isOpen else { return }
        flash(linkState == .offline
            ? "已断开。这台设备已改了暂停记忆，连上后才会告诉服务器。"
            : "正在连接。这台设备已改了暂停记忆，连上后才会告诉服务器。")
    }

    func applyDelegationState(_ delegation: AssistantDelegation, approval: AssistantApproval?) {
        guard var state = assistantState else { return }
        if let index = state.delegations.firstIndex(where: { $0.id == delegation.id }) {
            state.delegations[index] = delegation
        } else {
            state.delegations.insert(delegation, at: 0)
        }
        if let approval {
            if let index = state.approvals.firstIndex(where: { $0.id == approval.id }) {
                state.approvals[index] = approval
            } else {
                state.approvals.append(approval)
            }
        }
        if delegation.status != "awaiting" {
            state.approvals.removeAll { $0.delegationId == delegation.id }
        }
        assistantState = state
    }
}
