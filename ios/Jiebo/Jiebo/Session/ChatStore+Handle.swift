import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    func handle(_ message: ServerMessage) {
        let chatId = message.chatId?.nilIfEmpty ?? activeId
        switch message {
        case .textDelta, .thinkingDelta, .toolStarted, .toolCompleted, .toolOutput, .task:
            markProgress(chatId)
        case .status(_, let status, _) where status == "RUNNING" || status == "CREATING":
            markProgress(chatId)
        case .done, .error:
            if chatId == stallChatId {
                stallTask?.cancel()
                clearStallHint()
            }
        default:
            break
        }
        if chatId != activeId && chatId != chatHomeThreadChatId {
            switch message {
            case .textDelta, .thinkingDelta, .toolStarted, .done, .error, .approval:
                patch(chatId) { chat in
                    guard !chat.unread else { return chat }
                    var next = chat
                    next.unread = true
                    return next
                }
            default:
                break
            }
        }

        switch message {
        case .ready(let nextCwd, let hasKey, let serverModel, let serverModels, _, let running, let queued, let root, let readyTenantId, let readyTenantName, let admin, let readyLoops, let readyAssistantName, let readyAssistantChatId, let readyFeatures):
            if let nextTenant = readyTenantId?.nilIfEmpty {
                if !tenantId.isEmpty, tenantId != nextTenant {
                    resetTenantSession()
                }
                if tenantId != nextTenant {
                    tenantId = nextTenant
                    UserDefaults.standard.set(nextTenant, forKey: tenantKey)
                }
            }
            isAdmin = admin // P9：管理员才显示统计入口（须在 resetTenantSession 之后，否则被其清回 false）
            gatewayFeatures = Set(readyFeatures) // 每次 ready 整体覆盖：换账号或连到旧网关都不留上一次的能力
            if !admin { cursorBill = nil }
            if let name = readyTenantName?.nilIfEmpty {
                tenantName = name
            }
            let reconnected = unlocked
            unlocked = true
            verifying = false
            verifyTask?.cancel()
            authError = ""
            if reconnected { flash("已重新连上服务器") }
            let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            if !token.isEmpty, KeychainStore.token() != token { KeychainStore.save(token) }
            hasApiKey = hasKey
            workspaceRoot = root ?? workspaceRoot.nilIfEmpty ?? nextCwd
            if let name = readyAssistantName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                assistantName = name
            } else {
                assistantName = AssistantDefaults.name
            }
            assistantChatId = readyAssistantChatId
            if let key = assistantChatKey {
                if let readyAssistantChatId {
                    UserDefaults.standard.set(readyAssistantChatId, forKey: key)
                } else {
                    UserDefaults.standard.removeObject(forKey: key)
                }
            }
            if let readyAssistantChatId { deletedIds.remove(readyAssistantChatId) }
            let current = chats.first { $0.id == activeId }
            cwd = current?.cwd ?? nextCwd
            let preferred = current?.sessionModel ?? lastModel.nilIfEmpty ?? model
            var catalog = serverModels.isEmpty ? [serverModel.nilIfEmpty ?? ModelCatalog.defaultModel] : serverModels
            catalog = ModelCatalog.withCurrentModel(catalog, current: preferred)
            catalog = ModelCatalog.withCurrentModel(catalog, current: model)
            models = catalog
            runningChatIds = running
            queuedChatIds = queued
            loops = Dictionary(readyLoops.filter { $0.status != "stopped" && $0.status != "idle" }.map { ($0.chatId, $0) }, uniquingKeysWith: { _, new in new })
            let nextModel = ModelCatalog.resolve(
                preferred: preferred,
                ids: catalog,
                fallback: serverModel.nilIfEmpty ?? ModelCatalog.defaultModel
            )
            model = nextModel
            if !preferred.isEmpty || nextModel != ModelCatalog.defaultModel {
                rememberModel(nextModel)
            }
            markLive(running: running, queued: queued)
            for id in running where !sawSnapshot.contains(id) {
                awaitSnapshot.insert(id)
            }
            if let current, current.id != "boot", current.model != nextModel {
                patch(current.id) { chat in
                    var next = chat
                    next.model = nextModel
                    return next
                }
                send(.setModel(model: nextModel, chatId: current.id))
            }
            client.flushOutbox()
            send(.listWorkspaces)
            requestWorkspaceAgents()
            requestFileIndex()
            requestAssistant(memory: assistantState?.memory != nil)
            fulfillPendingAssistantOpen()
            imSink?.connectionReady(features: gatewayFeatures)
        case .auth(let ok, let messageText):
            if !ok {
                unlocked = false
                resumingLogin = false
                verifying = false
                verifyTask?.cancel()
                authError = messageText ?? "访问码不对。"
                KeychainStore.delete()
            }
        case .adminStats(let rows, _, let bill):
            adminStats = rows
            adminStatsAt = Date()
            cursorBill = bill
        case .loopState(let chatId, let status, let goal, let intervalSec, let tick, let maxTicks, let lastSummary, let nextAt):
            guard !chatId.isEmpty else { break }
            loops[chatId] = LoopSnapshot(
                chatId: chatId,
                status: status,
                goal: goal,
                intervalSec: intervalSec,
                tick: tick,
                maxTicks: maxTicks,
                lastSummary: lastSummary,
                nextAt: nextAt
            )
        case .loopTick(let chatId, let tick, let status, let summary):
            guard var row = loops[chatId] else { break }
            row.tick = tick
            row.lastSummary = summary
            if status == "stopped" { row.status = "stopped" }
            loops[chatId] = row
        case .storedState(let rows, let rev, let deleted, let serverRevs):
            applyStoredState(rows: rows, rev: rev, deleted: deleted, chatRevs: serverRevs)
        case .storedStateDeferred(let rev):
            // stored_state 太大（超 maxMessageBytes）走 HTTP /state；rev 不新就跳过。
            // 但 digest 在途时（load_chats 单条超限的回落）digest 已抬过 rev，不能被短路挡住
            // digest 发的 load_state 回包超限也走这里：同样不能被短路挡住
            if pendingChatLoads.isEmpty, !stateReloadPending, let rev, appliedStore, rev <= confirmedRev { break }
            // Kimi 评审 M2：digest 判出的变更会话单条超接收上限——HTTP 回落拿的是 slim 壳
            // （且 rev 已被 digest 收敛，applyStoredState 会早退整帧丢弃），壳合并保留本地
            // 旧 turns 会造成永久 stale。把待拉会话标成待补齐：旧正文留作基线，内容改走 load_chat
            // 增量补齐（分页有字节双上限，超大会话也能载），HTTP 全量只负责刷新元数据/chatRevs
            for id in pendingChatLoads {
                guard !hasLocalPriority(id), // 本地脏/有未回推新 turn 的本地优先，等回推
                      chats.contains(where: { $0.id == id }) else { continue }
                dropChatState(id) // 在途分页作废（旧内容的页），迟到页由 .chatTurns 校验丢弃
                markNeedsRefresh(id, rev: chatRevs[id])
            }
            pendingChatLoads = []
            if stateReloadPending {
                armStateReloadTimeout(20) // HTTP 拉取比 WS 回包慢，安全网放宽
            } else {
                digestTimeoutTask?.cancel()
            }
            scheduleStateFetch()
            ensureTurnsLoaded(activeId) // active 被降级就立即重启分页
        case .syncAck(let rev, let ackRevs, let reviewOnly, let truncated):
            // P4b 回执：确认服务端收下了这些会话。保留回执只对齐版本，不把在途正文同步当成已落盘。
            serverSupportsP4 = true
            for (id, chatRev) in ackRevs {
                let prior = chatRevs[id]
                chatRevs[id] = chatRev
                if let truncated {
                    settleTruncate(id, prior: prior, chatRev: chatRev, truncated: truncated)
                    continue
                }
                guard !reviewOnly else { continue }
                inflightChatIds.remove(id)
                let base = inflightBases.removeValue(forKey: id)
                guard chats.first(where: { $0.id == id })?.turnsComplete == true else { continue }
                if bodyRevs[id] == base, prior == base {
                    // 上传的只是元数据：发出时正文就是服务端那一版，期间也没有别处写入，正文版本跟着前进
                    bodyRevs[id] = chatRev
                    if let segs = bodySegs[id] { bodySegs[id] = SegHashes(rev: chatRev, hashes: segs.hashes) }
                    scheduleBodyCache(id)
                } else if bodyRevs[id] != chatRev {
                    // 本地优先期间别处改过正文：现在不脏了，按新版本补齐
                    markNeedsRefresh(id, rev: bodyRevs[id] ?? Int.min)
                    if id == activeId { ensureTurnsLoaded(id) }
                }
            }
            if let rev, rev > stateRev { stateRev = rev }
            if let rev, rev > confirmedRev { confirmedRev = rev }
            if !dirtyChatIds.isEmpty { scheduleSync() } // ack 期间又改了的继续推
        case .storedDigest(let rev, let deleted, let serverRevs, let rejected):
            serverSupportsP4 = true
            applyStoredDigest(rev: rev, deleted: deleted, serverRevs: serverRevs, rejected: rejected)
        case .storedChat(let value, let rev):
            serverSupportsP4 = true
            if let id = value.object?["id"]?.string { pendingChatLoads.remove(id) } // 解析失败也别白等安全网
            guard let remote = ChatSession.from(value), !deletedIds.contains(remote.id) else { break }
            pendingChatLoads.remove(remote.id)
            let priorRev = chatRevs[remote.id]
            if let rev { chatRevs[remote.id] = rev }
            if !remote.turnsComplete { noteServerSegs(value) }
            // 本地优先（脏/有未回推新 turn）的会话不应用服务器版，稍后重推
            if !hasLocalPriority(remote.id) {
                cachedOnlyIds.remove(remote.id) // 服务端版本到了，不再是只读缓存行
                if let index = chats.firstIndex(where: { $0.id == remote.id }) {
                    var mergedChat = remote
                    mergedChat.draft = chats[index].draft.isEmpty ? remote.draft : chats[index].draft
                    // P8 slim：元数据壳（无 turns 键）不得清空已加载正文——只更新元数据；
                    // 全量到达则取消在途分页（迟到页由 loadingChatIds 校验丢弃）
                    var staleRev: Int?
                    if !remote.turnsComplete {
                        mergedChat.turns = chats[index].turns
                        mergedChat.turnsComplete = chats[index].turnsComplete
                        // slim_chats：壳的版本比已加载正文新 → 正文留作基线、标成待补齐（同 applyStoredState 的 slim 行）
                        if mergedChat.turnsComplete, let rev, let oldRev = bodyRevs[remote.id] ?? priorRev, oldRev != rev {
                            staleRev = oldRev
                        }
                    } else {
                        dropChatState(remote.id) // 全量到达取消在途分页 + 清暂存（迟到页由校验丢弃）
                        bodyRevs[remote.id] = rev
                        bodySegs[remote.id] = nil
                        scheduleBodyCache(remote.id)
                    }
                    chats[index] = mergedChat
                    if let staleRev { markNeedsRefresh(remote.id, rev: staleRev) }
                } else {
                    chats.append(remote)
                }
                if remote.id == activeId {
                    applySession(chats.first { $0.id == remote.id } ?? remote)
                    ensureTurnsLoaded(remote.id)
                }
            }
            if pendingChatLoads.isEmpty { scheduleSync() } // 对账完毕，把本地脏的推上去
            fulfillPendingAssistantOpen()
        case .workspaces(_, let items):
            workspaces = items
            if workspaceRoot.isEmpty, let first = items.first { workspaceRoot = first.path }
        case .workspaceCreated(let path, let name):
            if !workspaces.contains(where: { $0.path == path }) {
                let index = workspaces.firstIndex(where: { !$0.user }) ?? workspaces.count
                workspaces.insert(WorkspaceItem(path: path, name: name), at: index)
            }
            startChat(in: path)
        case .workspaceRenamed(let from, let newPath, let name):
            // 网关已把会话的目录改到新路径；本地照改（不标脏，不用再传回去），再对账拿新的版本号
            let fromKey = normPath(from)
            let moveCwd: (String?) -> String? = { value in
                guard let value, !value.isEmpty else { return value }
                let key = normPath(value)
                if key == fromKey { return newPath }
                if key.hasPrefix(fromKey + "/") { return newPath + String(key.dropFirst(fromKey.count)) }
                return value
            }
            for index in chats.indices {
                let moved = moveCwd(chats[index].cwd)
                if moved != chats[index].cwd { chats[index].cwd = moved }
            }
            cwd = moveCwd(cwd) ?? cwd
            flash("已改名为「\(name)」")
            requestStateReload()
        case .workspaceRemoved(_, let name, let mode):
            flash(mode == "deleted" ? "已删除工作区「\(name)」" : "「\(name)」里有文件，已从列表隐藏（文件没动）")
        case .workspaceAgents(let items, let ticket, let reset, let more, let after, let cursor):
            if reset {
                // 广播更新也会从第一页重新开始；旧的“已完整加载”不能沿用，
                // 否则角标会按残缺列表重算，推送深链也会过早放弃找后续页。
                workspaceAgentsLoaded = false
                workspaceAgents = items
            } else {
                guard after == workspaceAgentsPendingCursor else { break }
                var byPath = Dictionary(uniqueKeysWithValues: workspaceAgents.map { ($0.path, $0) })
                for item in items { byPath[item.path] = item }
                workspaceAgents = byPath.values.sorted { $0.directoryName < $1.directoryName }
            }
            workspaceAvatarTicket = ticket
            workspaceAgentsPendingCursor = nil
            if more, let cursor, !cursor.isEmpty {
                workspaceAgentsPendingCursor = cursor
                requestWorkspaceAgents(reset: false)
            } else {
                workspaceAgentsLoaded = true
            }
            if let path = pendingWorkspacePath,
               chatHomeDestination == .workspace(path),
               let item = items.first(where: { $0.path == path }),
               let chatId = item.mainChatId
            {
                enterWorkspaceThread(path: path, chatId: chatId)
            }
        case .workspaceAgentOpened(let path, let chatId):
            if chatHomeDestination == .workspace(path) {
                enterWorkspaceThread(path: path, chatId: chatId)
            }
        case .workspaceAgentUpdate(let chatId, let unread, let readSeq, let finishedSeq):
            guard let index = workspaceAgents.firstIndex(where: { $0.mainChatId == chatId }) else { break }
            workspaceAgents[index].unread = unread
            workspaceAgents[index].readSeq = max(workspaceAgents[index].readSeq, readSeq)
            workspaceAgents[index].finishedSeq = max(workspaceAgents[index].finishedSeq, finishedSeq)
        case .session(let id, let agentId, let sessionCwd):
            let target = id.nilIfEmpty ?? activeId
            patch(target) { chat in
                var next = chat
                if !sessionCwd.isEmpty { next.cwd = sessionCwd }
                // agentId 空串也要落（对齐网页 agentId || undefined）：gateway 在换工作区/新会话/
                // 宽容化 resume 时会回空 agentId，表示「旧 agent 已回收」——不清掉就会拿着陈旧的
                // agentId 反复 resume 失败（旧网关：「不能恢复别人的会话」）
                next.agentId = agentId.nilIfEmpty
                return next
            }
            if target == activeId, !sessionCwd.isEmpty { cwd = sessionCwd }
        case .runMeta(let id, let runModel, let runMode):
            patchRunning(id) { turn in
                var next = turn
                if !runModel.isEmpty { next.model = runModel }
                if let runMode { next.mode = runMode }
                return next
            }
        case .textDelta(let id, let text):
            if awaitSnapshot.contains(id) { break }
            if snapshotHold.contains(id) {
                heldDeltas[id, default: []].append(text)
                break
            }
            patchRunning(id) { turn in
                var next = turn
                next.assistant += text
                return next
            }
        case .thinkingDelta(let id, let text):
            if awaitSnapshot.contains(id) || snapshotHold.contains(id) { break }
            patchRunning(id) { turn in
                var next = turn
                next.thinking += text
                return next
            }
            showThinkingIds.insert(id)
        case .toolStarted(let id, let callId, let name, let args, let parent, let agent, let toolModel, let toolAt):
            if awaitSnapshot.contains(id) || snapshotHold.contains(id) { break }
            patchRunning(id) { turn in
                var next = turn
                let priorAt = next.tools.first { $0.callId == callId }?.at
                next.tools.removeAll { $0.callId == callId }
                next.tools.append(ToolCall(callId: callId, name: name, args: args, result: nil, status: "running", parentCallId: parent, agent: agent, model: toolModel, at: priorAt ?? toolAt))
                return next
            }
        case .toolCompleted(let id, let callId, let name, let status, let result, let parent, let agent, let toolModel):
            if awaitSnapshot.contains(id) || snapshotHold.contains(id) { break }
            var toolArgs: JSONValue?
            patchOpen(id) { turn in
                var next = turn
                let existing = next.tools.first { $0.callId == callId }
                if existing?.status == "error", status == "completed" { return turn }
                toolArgs = existing?.args
                next.tools.removeAll { $0.callId == callId }
                next.tools.append(ToolCall(
                    callId: callId,
                    name: name,
                    args: existing?.args,
                    result: result,
                    status: status,
                    parentCallId: existing?.parentCallId ?? parent,
                    agent: existing?.agent ?? agent,
                    model: existing?.model ?? toolModel,
                    at: existing?.at
                ))
                return next
            }
            // 改动只进文件卡片，不再自动开预览页签
            if id == activeId, status == "completed",
               ToolKind.from(name: name, args: toolArgs).isMutating
            {
                // P7：mutating 工具完成后重拉文件索引——git 徽章/文件树不 stale。
                // 新 gateway 在 mutating tool 完成时已 pushWorkspace 主动推 files，这里是兜底旧网关
                //（对齐网页 tool-completed 后重发 list_files；此前只在 select/ready/undone 拉取）
                if id == activeId || id == chatHomeThreadChatId {
                    requestFileIndex(chatId: id)
                }
            }
        case .toolOutput(let id, let callId, let stream, let chunk, let stdout, let stderr):
            if awaitSnapshot.contains(id) || snapshotHold.contains(id) { break }
            patchRunning(id) { turn in
                var next = turn
                if let index = next.tools.firstIndex(where: { $0.callId == callId }) {
                    next.tools[index].result = mergeOutput(next.tools[index].result, stream: stream, chunk: chunk, stdout: stdout, stderr: stderr)
                } else {
                    next.tools.append(ToolCall(
                        callId: callId,
                        name: "shell",
                        args: nil,
                        result: mergeOutput(nil, stream: stream, chunk: chunk, stdout: stdout, stderr: stderr),
                        status: "running",
                        parentCallId: nil,
                        agent: nil,
                        model: nil,
                        at: nil
                    ))
                }
                return next
            }
        case .task(let id, let text):
            if awaitSnapshot.contains(id) || snapshotHold.contains(id) { break }
            patchRunning(id) { turn in
                var next = turn
                next.task = text
                return next
            }
        case .approval(let id, let callId, let name, let args):
            if awaitSnapshot.contains(id) || snapshotHold.contains(id) { break }
            patchRunning(id) { turn in
                var next = turn
                next.pendingTool = PendingTool(callId: callId, name: name, args: args)
                return next
            }
        case .status(let id, let status, let text):
            if let text, !text.isEmpty { flash(text) }
            if status == "RUNNING" || status == "CREATING" {
                let target = id ?? activeId
                // slim 会话没有 turns 可标 running——运行点靠 runningChatIds 驱动，必须回填
                if !runningChatIds.contains(target) {
                    runningChatIds.append(target)
                    touchChat(target)
                }
                patch(target) { chat in
                    guard let index = chat.turns.lastIndex(where: { !$0.user.isEmpty || $0.running }) else { return chat }
                    var next = chat
                    if !next.turns[index].running {
                        next.turns[index].running = true
                        next.turns[index].queued = false
                        next.turns[index].status = status
                    }
                    return next
                }
            } else if status == "FINISHED" || status == "ERROR" || status == "CANCELLED" || status == "EXPIRED" {
                let target = id ?? activeId
                runningChatIds.removeAll { $0 == target }
                queuedChatIds.removeAll { $0 == target }
                let settled = (status == "ERROR" || status == "EXPIRED") ? "error" : (status == "CANCELLED" ? "cancelled" : "finished")
                patchOpen(target) { $0.settled(status: settled) }
            }
        case .error(let id, let text):
            bannerError = friendlyError(text)
            if toolLayer == .loop, text.contains("Loop") {
                loopError = friendlyError(text)
            }
            let target = id ?? activeId
            // 网关拒绝还原（如 Agent 还在跑）走的是 error 而不是 undone
            if text.contains("还原") || text.contains("撤销") {
                settleRestore(chatId: target, paths: [], error: text)
            }
            runningChatIds.removeAll { $0 == target }
            queuedChatIds.removeAll { $0 == target }
            patchOpen(target) { turn in
                var next = turn.settled(status: "error")
                next.error = text
                return next
            }
            touchChat(target)
        case .done(let id, let status, let duration):
            runningChatIds.removeAll { $0 == id }
            queuedChatIds.removeAll { $0 == id }
            patchOpen(id) { turn in
                turn.settled(status: status, durationMs: duration)
            }
            touchChat(id)
            scheduleSync()
            scheduleBodyCache(id) // 通常还脏着，要等 sync_ack 后那次触发才真写
            if id == activeId { refreshCheckpoints() }
        case .runSnapshot(
            let id, let turnId, let phase, let status, let userText, let assistant, let thinking,
            let tools, let task, let runModel, let runMode, let awaitingApproval, let queued, let duration, let clipped
        ):
            awaitSnapshot.remove(id)
            sawSnapshot.insert(id)
            if clipped {
                snapshotHold.insert(id)
                if let index = chats.firstIndex(where: { $0.id == id }) {
                    if let turnId, !turnId.isEmpty {
                        chats[index].turns.removeAll { $0.id == turnId }
                    }
                    chats[index].turnsComplete = false
                }
                // 正文少了这一轮，不能按「版本一致」直接补齐：有基线的作废版本号（只走增量补齐），也不再读本机缓存
                if bodyRevs[id] != nil { bodyRevs[id] = Int.min }
                bodySegs[id] = nil
                cacheCheckedIds.insert(id)
                pendingSnapshots[id] = message
                ensureTurnsLoaded(id)
                break
            }
            if let chat = chats.first(where: { $0.id == id }), !chat.turnsComplete {
                pendingSnapshots[id] = message
                snapshotHold.insert(id)
                break
            }
            applyRunSnapshot(
                chatId: id,
                turnId: turnId,
                phase: phase,
                status: status,
                userText: userText,
                assistant: assistant,
                thinking: thinking,
                tools: tools,
                task: task,
                model: runModel,
                mode: runMode,
                awaitingApproval: awaitingApproval,
                queued: queued,
                durationMs: duration
            )
        case .history(let id, let rows):
            let incoming = rows.compactMap(Turn.from)
            guard !incoming.isEmpty else { break }
            // P8 slim：turns 未加载完时，history（fresh UUID）与 load_chat 页（持久 id）
            // id 空间不同，直接合并会重复/覆盖——暂存，加载完成后按老规则应用
            if let chat = chats.first(where: { $0.id == id }), !chat.turnsComplete {
                pendingHistory[id] = incoming
                break
            }
            applyHistory(chatId: id, incoming: incoming)
        case .chatTurns(let chatId, let rows, let from, let hasMore, let nonce):
            // 代际校验必须在成员资格之前（Kimi R2 M1）：deferred 降级/断线重启后旧链迟到页
            // 与重注册的新链都能过成员资格守卫；nonce 不匹配即旧代际，丢弃且不动当前加载状态。
            // 无 nonce（不回显的旧实现）按兼容放行——旧网关本就不支持 load_chat，不会到此
            if let nonce, nonce != loadEpochs[chatId] ?? 0 { break }
            // 在途校验：会话已删 / 全量 stored_chat 已取消加载 → 丢弃迟到页
            guard loadingChatIds.contains(chatId),
                  let index = chats.firstIndex(where: { $0.id == chatId }),
                  !deletedIds.contains(chatId) else {
                loadingChatIds.remove(chatId)
                bodyRefreshes[chatId] = nil
                refreshingChatIds.remove(chatId)
                break
            }
            // 增量补齐：页攒在 bodyRefreshes 里，不并进显示中的基线（同样不走 patch）
            if bodyRefreshes[chatId] != nil {
                applyRefreshPage(chatId: chatId, rows: rows, from: from, hasMore: hasMore)
                break
            }
            // 页合并直接改 chats[index]，不走 patch()——加载不是本地编辑，不能误标脏触发回推。
            // 已知限制（Kimi 评审 MINOR4）：from 是位置游标，假设服务端 turns append-only——
            // 分页中途他端增删会索引漂移（去重防重不防漏）；漂移靠 digest→stored_chat 全量
            // 替换（或 deferred 降级重载）自愈，不在这里做复杂对账
            let page = rows.compactMap(Turn.from)
            let existing = Set(chats[index].turns.map(\.id))
            let fresh = page.filter { !existing.contains($0.id) }
            chats[index].turns = fresh + chats[index].turns
            loadedPageTurnCounts[chatId] = (loadedPageTurnCounts[chatId] ?? 0) + fresh.count
            if hasMore {
                sendLoadChat(chatId, from: from) // 继续向前翻 turns[..<from]
            } else {
                clearLoadTimeout(chatId)
                loadTimeoutStreak[chatId] = nil
                chats[index].turnsComplete = true
                loadingChatIds.remove(chatId)
                loadedPageTurnCounts[chatId] = nil
                chats[index].serverPreview = nil // 正文齐了，侧栏预览回到本地计算（GLM 评审 m4）
                completeTurnsLoad(chatId) // 回推加载期间的新 turn、补暂存的 history/快照、写本机缓存
            }
        case .chatTitle(let id, let title):
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { break }
            patch(id) { chat in
                guard chat.isUntitled else { return chat }
                var next = chat
                next.title = trimmed
                return next
            }
        case .fileWritten(let path, let writtenChatId, let error):
            if let writtenChatId, !writtenChatId.isEmpty,
               writtenChatId != activeId, writtenChatId != contentChatId { break }
            let written = relToCwd(path)
            guard let index = contentSaves.firstIndex(where: { $0.path == path || $0.path == written }) else { break }
            let save = contentSaves.remove(at: index)
            guard contentPath == save.path else { break }
            if let error {
                flash(error)
            } else {
                contentOriginal = save.snapshot
                contentError = nil
                flash(contentDraft == save.snapshot ? "已保存" : "已保存。之后的修改还没写入")
            }
        case .fileUploaded(let path, let chatId, let name, let error, _, let id):
            // 超时后迟到的回包：丢弃（用户已看到失败提示，草稿不应再被污染）
            if let id, expiredUploadIds.remove(id) != nil { break }
            if let id, let pending = pendingUploads.removeValue(forKey: id) {
                if let error {
                    pending.resume(throwing: UploadError.http(0, error))
                } else {
                    pending.resume(returning: path)
                }
                break
            }
            // 别的客户端上传的：把 @path 补进对应会话草稿（对齐网页端）
            if let error {
                // 仅当能归属到现存会话时才显示（防切租户后晚到的错误条写进新会话）
                if let cid = chatId?.nilIfEmpty, chats.contains(where: { $0.id == cid }) {
                    bannerError = error
                }
            } else if !path.isEmpty {
                let targetId = chatId?.nilIfEmpty ?? activeId
                // 目标会话必须存在（防切租户后晚到的回包写进新会话）
                if chats.contains(where: { $0.id == targetId }) {
                    appendMention(path, to: targetId)
                    flash("已上传 \(name ?? path)")
                }
            }
        case .fileContent(let path, let msgChatId, let content, let error, let diff, let kind, let mime, let size, let url, let headUrl, let media, let reqId, let replySha):
            // 带 reqId 的是旁路读取（缩略图等），不进内容层也不进页签
            if let reqId {
                if reqId.hasPrefix("thumb:") {
                    ThumbnailStore.shared.handleReply(reqId: reqId, path: path, kind: kind, content: content, url: url, media: media, error: error)
                }
                break
            }
            let forActive = msgChatId?.isEmpty != false || msgChatId == activeId
            let forContent = msgChatId == contentChatId && contentChatId != nil
            let forPinned = previewTabs.contains { $0.path == path && $0.fromCard && $0.chatId != nil && $0.chatId == msgChatId }
            if !forActive, !forContent, !forPinned { break }
            if replySha == nil, forContent || forActive, contentPath == path, diff, contentDiff {
                contentLoading = false
                if let error {
                    contentError = error
                } else if let content {
                    contentOversized = false
                    contentKind = .text
                    contentOriginal = content
                    contentDraft = content
                } else if kind == "image" || kind == "svg" || contentKind == .image || contentKind == .svg {
                    contentLoading = false
                    contentError = nil
                } else {
                    contentError = "读不到这次改动"
                }
            } else if replySha == nil, forContent || forActive, contentPath == path, !diff, (contentKind == .text || contentKind == .markdown) {
                if let error {
                    contentLoading = false
                    contentError = error
                } else if let content {
                    acceptContentText(content)
                } else if let url, !url.isEmpty {
                    contentLoadEpoch += 1
                    hydrateContentText(path: path, urlString: url, epoch: contentLoadEpoch)
                } else {
                    contentLoading = false
                    contentError = "读不到这个文件"
                }
            }
            guard let index = previewTabs.firstIndex(where: { $0.path == path }) else { break }
            // 卡片页签只认自己会话的回包；其余页签沿用「当前会话」口径
            let owner = previewTabs[index].fromCard ? previewTabs[index].chatId : nil
            if let owner {
                guard (msgChatId?.nilIfEmpty ?? activeId) == owner else { break }
            } else if !forActive {
                break
            }
            // 回显的 sha 与页签当前要的版本不一致：换版本前发出的迟到回包，丢掉
            guard replySha == previewTabs[index].readSha else { break }
            var tab = previewTabs[index]
            tab.loading = false
            if let error {
                if tab.diff && error == "没有未提交的改动" {
                    // 对齐网页：diff 没内容时自动回落全文重拉；清掉旧 diff 文本避免回落期以代码视图闪渲染
                    tab.diff = false
                    tab.content = nil
                    tab.error = nil
                    tab.loading = true
                    previewTabs[index] = tab
                    sendTabRead(tab)
                    break
                }
                // 对齐网页：「读不了/不是文件/不在工作区」改写为友好文案 + notice
                if error.contains("读不了") || error.contains("不是文件") || error.contains("不在工作区") {
                    if tab.content == nil { tab.error = "文件已不在当前工作区，换工作区后再打开，或关掉这个预览。" }
                    flash("\(path) 已不在工作区")
                } else if tab.content == nil {
                    tab.error = error // 已有内容时静默保留旧内容（对齐网页）
                }
            } else {
                tab.error = nil
                if let kind, let parsed = PreviewKind(rawValue: kind) { tab.kind = parsed }
                tab.diff = diff
                tab.url = url
                tab.headUrl = headUrl
                tab.media = media
                tab.mime = mime
                tab.size = size
                tab.chatId = msgChatId ?? owner ?? activeId // 票据签发会话（签名绑 chatId，视图拼 mediaSrc 要用它）
                if let content { tab.content = content }
            }
            previewTabs[index] = tab
            // 大文本（markdown/html/canvas 超限时）可能只回 url 不回 content：走 HTTP 票据水合；
            // diff 页签不水合；媒体类（needsMediaURL）由媒体视图直接加载 URL，不能当文本拉
            if tab.error == nil && !tab.diff && tab.content == nil && tab.mediaURL != nil && !tab.kind.needsMediaURL {
                hydratePreviewText(path: tab.path)
            }
        case .files(let query, let paths, let mention, let truncated, let filesChatId, let status):
            // 工作台和聊天主页各有明确线程；只接收其中一个正在显示的请求。
            let responseChatId = filesChatId?.nilIfEmpty ?? activeId
            if mention {
                guard responseChatId == mentionRequestChatId else { break }
                // 过期查询的结果直接丢（对齐网页端 query 比对）
                guard query == mentionQuery else { break }
                // 合并本地索引与服务端结果（对齐网页 mentionHits 的 remote 合并；
                // 本地索引被截断时服务端结果可能是唯一来源）
                var seen = Set<String>()
                var merged: [String] = []
                for path in paths + fileIndex where seen.insert(path).inserted {
                    merged.append(path)
                }
                mentionSuggestions = ChatStore.rankMentions(merged, query: query)
            } else {
                guard responseChatId == fileIndexRequestChatId else { break }
                fileIndex = paths
                treeTruncated = truncated
                if query.isEmpty { gitStatus = status }
            }
        case .searchHits(let query, let hits, let hitsChatId, let truncated):
            let responseChatId = hitsChatId?.nilIfEmpty ?? activeId
            guard responseChatId == searchRequestChatId else { break }
            let current = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            guard query.trimmingCharacters(in: .whitespacesAndNewlines) == current else { break }
            searchHits = hits
            searchTruncated = truncated
            searchLoading = false
        case .checkpoints(let id, let items):
            guard id.isEmpty || id == activeId || id == chatHomeThreadChatId else { break }
            checkpoints = items
            if let newest = items.first,
               newest.id != notedCheckpointId,
               Date().timeIntervalSince1970 * 1000 - newest.createdAt < 5000
            {
                notedCheckpointId = newest.id
                flash("已记下检查点 \(newest.label)")
            }
        case .restored(_, _, let label, let error, let silent):
            // 整轮 undo 遇到检查点时，网关回的是 restored
            if !silent { settleRestore(chatId: chatId, paths: [], error: error?.nilIfEmpty, restoredCheckpoint: true) }
            guard chatId == activeId || chatId == chatHomeThreadChatId else { break }
            if silent {
                requestFileIndex(chatId: chatId)
                break
            }
            if let error, !error.isEmpty {
                notice = error
            } else {
                notice = "已还原检查点 \(label?.nilIfEmpty ?? "")"
            }
            requestFileIndex(chatId: chatId)
            if chatId == activeId { reloadPreviewTabs() }
        case .turnFiles(let filesChatId, let turnId, let files):
            // 网关落盘时已经写进 turn.files：这里只同步到本机，不标脏、不回传
            mergeOrQueueTurnFiles(chatId: filesChatId, turnId: turnId, files: files)
        case .undone(_, let paths, let error):
            settleRestore(chatId: chatId, paths: paths, error: error?.nilIfEmpty)
            // 只反馈当前会话的 undo（chatId 已在 handle 入口解析为 activeId 兜底）
            guard chatId == activeId || chatId == chatHomeThreadChatId else { break }
            if let error {
                notice = error
            } else {
                notice = paths.isEmpty ? "没有可还原的改动" : "已还原 \(paths.joined(separator: ", "))"
                if let path = contentPath, paths.contains(where: { relToCwd($0) == path || $0 == path }) {
                    let was = suppressContentDiscard
                    suppressContentDiscard = true
                    closeContentLayer()
                    suppressContentDiscard = was
                }
            }
            requestFileIndex(chatId: chatId)
        case .assistantState(let state):
            var next = state
            // 别的连接触发的推送可能不带记忆：记忆页已加载过就留着旧的，等下一次带记忆的推送覆盖
            if next.memory == nil { next.memory = assistantState?.memory }
            assistantState = next
        case .assistantResult(let reqId, let op, let ok, let error, _):
            if let reqId, let waiter = assistantReplyWaiters.removeValue(forKey: reqId) {
                waiter(ok)
                break
            }
            if !ok {
                flash(error ?? "助理操作失败（\(op)）")
            } else if op == "memory_save" {
                flash("已记住")
            } else if op == "memory_purge" {
                flash("已彻底删除")
            }
        case .inboxItem(let item):
            guard assistantState != nil else { break }
            if let index = assistantState?.inbox.firstIndex(where: { $0.id == item.id }) {
                assistantState?.inbox[index] = item
            } else {
                assistantState?.inbox.insert(item, at: 0)
            }
        case .delegationState(let delegation, let approval):
            applyDelegationState(delegation, approval: approval)
        case .memoryWritten(_, let entry):
            if let index = assistantState?.memory?.entries.firstIndex(where: { $0.id == entry.id }) {
                assistantState?.memory?.entries[index] = entry
            } else if assistantState?.memory != nil {
                assistantState?.memory?.entries.insert(entry, at: 0)
            }
            flash("\(assistantName) 记住了：\(entry.topic.nilIfEmpty ?? String(entry.text.prefix(24)))")
        case .im(let event):
            imSink?.handle(event)
        case .pong, .ignored:
            break
        }
    }
}

private func mergeOutput(_ result: JSONValue?, stream: String?, chunk: String?, stdout: String?, stderr: String?) -> JSONValue {
    var record = result?.object ?? [:]
    if record["stdout"] == nil { record["stdout"] = .string("") }
    if record["stderr"] == nil { record["stderr"] = .string("") }
    if let stdout { record["stdout"] = .string(stdout) }
    if let stderr { record["stderr"] = .string(stderr) }
    if let chunk, !chunk.isEmpty {
        let key = stream == "stderr" ? "stderr" : "stdout"
        record[key] = .string((record[key]?.string ?? "") + chunk)
    }
    return .object(record)
}
