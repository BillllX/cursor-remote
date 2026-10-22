import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    /// 快照是累计全文：按 turnId 替换，不拼到旧正文后面。done 时无论正文是否更长都收尾。
    func applyRunSnapshot(
        chatId: String,
        turnId: String?,
        phase: String,
        status: String?,
        userText: String,
        assistant: String,
        thinking: String,
        tools: [JSONValue],
        task: String?,
        model: String?,
        mode: AgentMode?,
        awaitingApproval: JSONValue?,
        queued: [JSONValue],
        durationMs: Double?
    ) {
        patch(chatId) { chat in
            var next = chat
            let skipBody = (turnId ?? "").isEmpty && userText.isEmpty && assistant.isEmpty
            if !skipBody {
                var index = turnId.flatMap { id in next.turns.firstIndex(where: { $0.id == id }) }
                if index == nil, (turnId ?? "").isEmpty, !userText.isEmpty {
                    let fp = Self.userFingerprint(userText)
                    index = next.turns.indices.reversed().first(where: { Self.userFingerprint(next.turns[$0].user) == fp })
                }
                let parsedTools = tools.compactMap(Self.toolFromSnapshot)
                if let index {
                    var row = next.turns[index]
                    if assistant.count >= row.assistant.count { row.assistant = assistant }
                    if thinking.count >= row.thinking.count { row.thinking = thinking }
                    if parsedTools.count >= row.tools.count {
                        var priorAt: [String: Int] = [:]
                        for tool in row.tools where priorAt[tool.callId] == nil { priorAt[tool.callId] = tool.at }
                        row.tools = parsedTools.map { tool in
                            var item = tool
                            if item.at == nil { item.at = priorAt[item.callId] }
                            return item
                        }
                    }
                    if let task { row.task = task }
                    if let model { row.model = model }
                    if let mode { row.mode = mode }
                    row.running = phase == "running"
                    row.queued = false
                    if phase == "running", let awaitingApproval, let object = awaitingApproval.object {
                        row.pendingTool = PendingTool(
                            callId: object["callId"]?.string ?? "",
                            name: object["name"]?.string ?? "",
                            args: object["args"]
                        )
                    } else {
                        row.pendingTool = nil
                    }
                    if phase == "done" {
                        row = row.settled(status: status ?? "finished", durationMs: durationMs)
                    }
                    next.turns[index] = row
                } else {
                    var row = Turn.blank(user: userText, model: model, mode: mode, running: phase == "running")
                    if let turnId, !turnId.isEmpty { row.id = turnId }
                    row.assistant = assistant
                    row.thinking = thinking
                    row.tools = parsedTools
                    row.task = task
                    row.queued = false
                    if phase == "running", let awaitingApproval, let object = awaitingApproval.object {
                        row.pendingTool = PendingTool(
                            callId: object["callId"]?.string ?? "",
                            name: object["name"]?.string ?? "",
                            args: object["args"]
                        )
                    }
                    if phase == "done" {
                        row = row.settled(status: status ?? "finished", durationMs: durationMs)
                    }
                    next.turns.append(row)
                }
            }
            for item in queued {
                guard let object = item.object else { continue }
                let queuedId = object["turnId"]?.string
                let queuedText = object["userText"]?.string ?? ""
                if let queuedId, next.turns.contains(where: { $0.id == queuedId }) { continue }
                if (queuedId ?? "").isEmpty {
                    let fp = Self.userFingerprint(queuedText)
                    if !fp.isEmpty, next.turns.contains(where: { Self.userFingerprint($0.user) == fp && ($0.queued || $0.running) }) {
                        continue
                    }
                }
                var row = Turn.blank(user: queuedText, model: nil, mode: nil, running: false)
                if let queuedId, !queuedId.isEmpty { row.id = queuedId }
                row.running = false
                row.queued = true
                next.turns.append(row)
            }
            return next
        }
    }

    static func userFingerprint(_ text: String) -> String {
        let collapsed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return String(collapsed.prefix(240))
    }

    static func toolFromSnapshot(_ value: JSONValue) -> ToolCall? {
        guard let row = value.object else { return nil }
        return ToolCall(
            callId: row["callId"]?.string ?? UUID().uuidString.lowercased(),
            name: row["name"]?.string ?? "",
            args: row["args"],
            result: row["result"],
            status: row["status"]?.string ?? "completed",
            parentCallId: row["parentCallId"]?.string,
            agent: row["agent"]?.string,
            model: row["model"]?.string,
            at: row["at"]?.int
        )
    }

    /// 已结束的回合按用户原文从后往前配对，取更长的助手正文。进行中的回合留给快照。
    func applyHistory(chatId id: String, incoming: [Turn]) {
        patch(id) { chat in
            var next = chat
            next.turns = Self.mergeHistory(local: chat.turns, incoming: incoming)
            return next
        }
    }

    static func mergeHistory(local: [Turn], incoming: [Turn]) -> [Turn] {
        let localHas = local.contains {
            !$0.user.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !$0.assistant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !$0.tools.isEmpty
                || $0.filesSource != .none
        }
        if !localHas { return incoming }
        var merged = local
        var used = Set<Int>()
        var prefix: [Turn] = []
        var seenLocal = false
        for remote in incoming {
            let finger = userFingerprint(remote.user)
            let index = merged.indices.reversed().first {
                !used.contains($0)
                    && (merged[$0].id == remote.id
                        || (!finger.isEmpty && userFingerprint(merged[$0].user) == finger))
            }
            if let index {
                used.insert(index)
                seenLocal = true
                if merged[index].running { continue }
                var row = merged[index]
                if remote.assistant.count > row.assistant.count { row.assistant = remote.assistant }
                if remote.thinking.count > row.thinking.count { row.thinking = remote.thinking }
                row.tools = mergeHistoryTools(local: row.tools, remote: remote.tools)
                row = row.mergingFiles(from: remote)
                merged[index] = row
            } else if !finger.isEmpty, !seenLocal {
                var row = remote
                row.running = false
                row.queued = false
                prefix.append(row)
            }
        }
        return prefix + merged
    }

    static func mergeHistoryTools(local: [ToolCall], remote: [ToolCall]) -> [ToolCall] {
        var out = local
        for tool in remote {
            if let index = out.firstIndex(where: { $0.callId == tool.callId || ($0.name == tool.name && $0.args == tool.args) }) {
                if out[index].result == nil, tool.result != nil {
                    out[index].result = tool.result
                    if tool.status != "running" { out[index].status = tool.status }
                }
            } else {
                var copy = tool
                if copy.status == "running" { copy.status = "completed" }
                out.append(copy)
            }
        }
        return out
    }

    func applySession(_ chat: ChatSession?) {
        guard let chat else { return }
        draft = chat.draft
        mode = chat.mode
        if let sessionModel = chat.sessionModel {
            let catalog = ModelCatalog.withCurrentModel(models, current: sessionModel)
            model = ModelCatalog.resolve(preferred: sessionModel, ids: catalog, fallback: model)
        }
        if let path = chat.cwd, !path.isEmpty {
            cwd = path
            if !isAssistantChat(chat.id) {
                send(.setWorkspace(cwd: path, chatId: chat.id, create: nil))
            }
        }
        if let agentId = chat.agentId, !agentId.isEmpty, !runningChatIds.contains(chat.id) {
            send(.resumeSession(chatId: chat.id, agentId: agentId))
        }
    }

    func markLive(running: [String], queued: [String]) {
        let keep = Set(running + queued)
        chats = chats.map { chat in
            var next = chat
            if !keep.contains(chat.id) {
                next.turns = next.turns.map { turn in
                    turn.running || turn.tools.contains(where: { $0.status == "running" })
                        ? turn.settled(status: turn.status ?? "cancelled")
                        : turn
                }
            }
            return next
        }
    }

    /// 会话从列表消失（远端删除/全量替换取消分页）时清理其分页/暂存状态（Kimi 评审 MINOR5）
    func dropChatState(_ id: String) {
        discardStreamDeltas(id)
        turnRenderRevisions[id] = nil
        clearLoadTimeout(id)
        loadingChatIds.remove(id)
        loadedPageTurnCounts[id] = nil
        pendingHistory[id] = nil
        localTurnsPendingSync.remove(id)
        // 增量补齐随之作废；bodyRevs 不动——降级场景还要拿基线和它的版本接着补
        bodyRefreshes[id] = nil
        refreshingChatIds.remove(id)
        loadStartRevs[id] = nil
        loadStartSegs[id] = nil
    }

    /// 本地优先门闩：显式脏 + 加载期间发过消息（Grok R2 M1——后者 turns 未齐时 sync 不带正文，
    /// ack 会把显式脏清掉，但本地新 turn 必须等分页完成后全量回推；此期间远端全量/降级/拉取
    /// 都不得覆盖本地，否则新 turn 被抹且回推标记丢失）
    func hasLocalPriority(_ id: String) -> Bool {
        dirtyChatIds.contains(id) || localTurnsPendingSync.contains(id)
    }

    /// 保留 base 的正文与顺序，只从同 id 的另一份回合补文件状态。
    static func mergingTurnFiles(base: [Turn], other: [Turn]) -> [Turn] {
        let otherById = Dictionary(uniqueKeysWithValues: Turn.uniqued(other).map { ($0.id, $0) })
        return base.map { turn in
            guard turn.filesSource != .authoritative, let remote = otherById[turn.id] else { return turn }
            return turn.mergingFiles(from: remote)
        }
    }

    func merge(local: [ChatSession], remote: [ChatSession]) -> [ChatSession] {
        let localById = Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) })
        return remote.map { chat in
            guard let current = localById[chat.id] else { return chat }
            // P8 slim：远端是元数据壳（无 turns 键）→ 只合元数据，本地 turns/加载状态不动。
            // 不能走下方权重比较——壳的权重恒 0，本地有内容就永远本地胜出，会吞掉别端的元数据更新
            if !chat.turnsComplete {
                // 脏会话本地全赢（含改名类元数据编辑，否则被壳静默吞掉）；
                // 仅待回推（pendingSync）的壳走下方正常合并即可——它本就保本地 turns/加载状态，
                // 元数据跟远端走，完成回推时不会带旧元数据误覆盖
                if dirtyChatIds.contains(chat.id) { return current }
                var slim = chat
                slim.turns = current.turns
                slim.turnsComplete = current.turnsComplete
                slim.draft = current.draft.isEmpty ? chat.draft : current.draft
                slim.agentId = current.agentId ?? chat.agentId
                return slim
            }
            // 远端全量、本地是壳：直接采用远端（本地没有可保留的正文）。
            // 本地优先例外：脏/待回推新 turn 的壳被远端全量（含真空会话的 turns:[] 行）覆盖会
            // 丢本地内容且 localTurnsPendingSync 无释放路径（Kimi R2 MINOR1）
            if !current.turnsComplete {
                if hasLocalPriority(chat.id) {
                    var keep = current
                    keep.turns = Self.mergingTurnFiles(base: current.turns, other: chat.turns)
                    return keep
                }
                var next = chat
                next.turns = Self.mergingTurnFiles(base: chat.turns, other: current.turns)
                next.cwd = current.cwd ?? chat.cwd
                next.draft = current.draft.isEmpty ? chat.draft : current.draft
                next.agentId = current.agentId ?? chat.agentId
                return next
            }
            let localWeight = current.turns.reduce(0) { $0 + $1.user.count + $1.assistant.count }
            let remoteWeight = chat.turns.reduce(0) { $0 + $1.user.count + $1.assistant.count }
            if current.turns.contains(where: \.running) || localWeight > remoteWeight {
                var keep = current
                keep.turns = Self.mergingTurnFiles(base: current.turns, other: chat.turns)
                keep.agentId = current.agentId ?? chat.agentId
                keep.cwd = current.cwd ?? chat.cwd
                keep.draft = current.draft.isEmpty ? chat.draft : current.draft
                return keep
            }
            var next = chat
            next.turns = Self.mergingTurnFiles(base: chat.turns, other: current.turns)
            next.cwd = current.cwd ?? chat.cwd
            next.draft = current.draft.isEmpty ? chat.draft : current.draft
            next.agentId = current.agentId ?? chat.agentId
            return next
        }
    }

    func patch(_ id: String, _ update: (ChatSession) -> ChatSession) {
        guard let index = chats.firstIndex(where: { $0.id == id }) else { return }
        let before = chats[index]
        chats[index] = update(before)
        mergePendingTurnFiles(chatId: id, bumpRevision: false)
        let turnsChanged = chats[index].turns != before.turns
        // 本地改过的正文不再是那份服务端段哈希对应的内容（清掉后不再比，流式增量只比一次）
        if bodySegs[id] != nil, turnsChanged { bodySegs[id] = nil }
        if turnsChanged { turnRenderRevisions[id, default: 0] &+= 1 }
        // P4b：增量上传只推脏会话。冷启动缓存列表的行只读，不标脏（首个 stored_state 会整份替换）
        if id != "boot", !cachedOnlyIds.contains(id) { dirtyChatIds.insert(id) }
        scheduleSync()
    }

    /// turn_files 是网关最终结果，不回推；目标回合尚未由 snapshot/history 建好时先保留。
    func mergeOrQueueTurnFiles(chatId: String, turnId: String, files: [TurnFile]) {
        pendingTurnFiles.store(chatId: chatId, turnId: turnId, files: files)
        mergePendingTurnFiles(chatId: chatId)
    }

    func mergePendingTurnFiles(chatId: String, bumpRevision: Bool = true) {
        guard let chatIndex = chats.firstIndex(where: { $0.id == chatId }) else { return }
        let available = Set(chats[chatIndex].turns.map(\.id))
        let ready = pendingTurnFiles.take(chatId: chatId, availableTurnIds: available)
        guard !ready.isEmpty else { return }
        for (turnId, files) in ready {
            guard let turnIndex = chats[chatIndex].turns.firstIndex(where: { $0.id == turnId }) else { continue }
            let turn = chats[chatIndex].turns[turnIndex]
            chats[chatIndex].turns[turnIndex].files = turn.filesSource == .authoritative
                ? Turn.stableAuthoritativeFiles(current: turn.files, incoming: files)
                : (files.isEmpty ? [] : Turn.stableAuthoritativeFiles(current: turn.cardFiles, incoming: files))
            chats[chatIndex].turns[turnIndex].filesSource = .authoritative
        }
        if bumpRevision { turnRenderRevisions[chatId, default: 0] &+= 1 }
        bodySegs[chatId] = nil
        scheduleBodyCache(chatId)
    }

    func patchRunning(_ id: String, _ update: (Turn) -> Turn) {
        patch(id) { chat in
            var next = chat
            if let index = next.turns.lastIndex(where: \.running) {
                next.turns[index] = update(next.turns[index])
            }
            return next
        }
    }

    func patchOpen(_ id: String, _ update: (Turn) -> Turn) {
        patch(id) { chat in
            var next = chat
            if let index = next.turns.lastIndex(where: { $0.running || $0.tools.contains(where: { $0.status == "running" }) }) {
                next.turns[index] = update(next.turns[index])
            }
            return next
        }
    }

    func markProgress(_ chatId: String) {
        // 只给正在看的对话挂表：后台对话的进展不该重置前台的计时
        guard chatId == activeId else { return }
        lastProgress = Date()
        clearStallHint()
        armStallWatch(chatId)
    }

    func clearStallHint() {
        if stallSeconds != 0 { stallSeconds = 0 }
    }

    func armStallWatch(_ chatId: String) {
        stallTask?.cancel()
        stallChatId = chatId
        stallTask = Task { @MainActor in
            var noticed = false
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                let live = chats.first { $0.id == chatId }?.turns.contains(where: { $0.running || $0.tools.contains(where: { $0.status == "running" }) }) == true
                guard live else { clearStallHint(); return }
                // 只盯正在看的这个对话：后台对话的提示没地方显示
                let idle = Int(Date().timeIntervalSince(lastProgress))
                if chatId == activeId, idle >= 4 {
                    stallSeconds = idle
                } else {
                    clearStallHint()
                }
                if idle >= 90, !noticed {
                    noticed = true
                    notice = "这一轮没有新进展。如果一直转圈，点停止再发一次。"
                }
            }
        }
    }
}
