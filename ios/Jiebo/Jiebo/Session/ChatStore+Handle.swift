import Foundation
import Observation
import Photos
import UIKit
import os

private let workbenchStreamSignposter = OSSignposter(
    subsystem: Bundle.main.bundleIdentifier ?? "Jiebo",
    category: "WorkbenchStream"
)

extension ChatStore {
    func handle(_ message: ServerMessage, predecoded: PredecodedPayload? = nil) {
        let chatId = message.chatId?.nilIfEmpty ?? activeId
        switch message {
        case .textDelta, .thinkingDelta, .toolStarted, .toolCompleted, .toolOutput, .task:
            markProgress(chatId)
        case .status(_, let status, _) where status == "RUNNING" || status == "CREATING":
            markProgress(chatId)
        case .done, .error:
            if chatId == stallChatId {
                stopStallWatch()
            }
        default:
            break
        }
        if chatId != activeId && chatId != chatHomeThreadChatId {
            switch message {
            case .textDelta, .thinkingDelta, .toolStarted, .toolCompleted, .toolOutput, .task, .status, .done, .error, .approval:
                // 已经未读后不要再为每个 token 走一次 patch/scheduleSync。
                if chats.first(where: { $0.id == chatId })?.unread == false {
                    patch(chatId) { chat in
                        var next = chat
                        next.unread = true
                        return next
                    }
                }
            default:
                break
            }
        }
        if message.flushesAllStreamDeltaBuffers {
            flushAllStreamDeltas(commitToChats: true)
        } else if message.flushesChatStreamDeltaBuffer {
            flushStreamDeltas(chatId, commitToChats: true)
        }

        switch message {
        case .ready(let nextCwd, let hasKey, let serverModel, let serverModels, _, let running, let queued, let root, let readyTenantId, let readyTenantName, let admin, let readyLoops, let readyAssistantName, let readyAssistantChatId, let readyFeatures):
            var changedTenant = false
            if let nextTenant = readyTenantId?.nilIfEmpty {
                if !tenantId.isEmpty, tenantId != nextTenant {
                    resetTenantSession()
                }
                if tenantId != nextTenant {
                    changedTenant = true
                    tenantId = nextTenant
                    UserDefaults.standard.set(nextTenant, forKey: tenantKey)
                }
            }
            if changedTenant { beginBootstrapLoad(for: tenantId) }
            launchSawReady = true
            AppLaunchMetrics.event("ready")
            isAdmin = admin // P9：管理员才显示统计入口（须在 resetTenantSession 之后，否则被其清回 false）
            gatewayFeatures = Set(readyFeatures) // 每次 ready 整体覆盖：换账号或连到旧网关都不留上一次的能力
            if !admin { cursorBill = nil }
            if let name = readyTenantName?.nilIfEmpty {
                tenantName = name
            }
            let reconnected = unlocked
            unlocked = true
            if gatewayFeatures.contains("workspace_share_v1") {
                workspaceSharing.sendFrame = { [weak self] value in self?.send(.project(value)) }
                Task { await workspaceSharing.refresh() }
            } else { workspaceSharing.reset() }
            gatewayReady = true
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
            // 手机共用设置中的模型偏好，重连时不让旧会话覆盖上次选择。
            let preferred = UIDevice.current.userInterfaceIdiom == .phone
                ? (lastModel.nilIfEmpty ?? current?.sessionModel ?? model)
                : (current?.sessionModel ?? lastModel.nilIfEmpty ?? model)
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
            // stored_state 可能在解锁前到过，当时 ensureTurnsLoaded 会直接返回。解锁后补拉空壳。
            if let current, !current.turnsComplete {
                ensureFollowedTurnsLoaded()
            } else if let assistant = assistantChatId,
                      chats.first(where: { $0.id == assistant })?.turnsComplete == false {
                ensureTurnsLoaded(assistant)
            }
            if activeId != "boot", chats.contains(where: { $0.id == activeId }) {
                requestFileIndex(chatId: activeId)
            }
            requestAssistant(memory: assistantMemoryDesired)
            fulfillPendingAssistantOpen()
            imSink?.connectionReady(features: gatewayFeatures)
            // 受限路径经“断网→普通 Wi‑Fi”恢复时费用边沿发生在 socket 重开前；ready 后统一补一次。
            resumeTrafficDeferredWork()
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
            if case .storedState(let decoded) = predecoded {
                applyStoredState(decoded)
            } else {
                applyStoredState(rows: rows, rev: rev, deleted: deleted, chatRevs: serverRevs)
            }
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
            ensureFollowedTurnsLoaded() // 当前屏被降级就立即重启分页，小驳也一起补
        case .syncAck(let rev, let ackRevs, let reviewOnly, let truncated):
            // P4b 回执：确认服务端收下了这些会话。保留回执只对齐版本，不把在途正文同步当成已落盘。
            serverSupportsP4 = true
            let followedIds = Set(followedBodyChatIds())
            let turnsCompleteById: [String: Bool]? = ackRevs.count > 1
                ? Dictionary(chats.map { ($0.id, $0.turnsComplete) }, uniquingKeysWith: { _, latest in latest })
                : nil
            for (id, chatRev) in ackRevs {
                let prior = chatRevs[id]
                chatRevs[id] = chatRev
                if let truncated {
                    flushStreamDeltas(id, commitToChats: true)
                    settleTruncate(id, prior: prior, chatRev: chatRev, truncated: truncated)
                    continue
                }
                if reviewOnly {
                    if !inflightChatIds.contains(id) {
                        if bodyRevs[id] == prior {
                            bodyRevs[id] = chatRev
                            scheduleBodyCache(id)
                        }
                        if let partial = partialHistories[id], partial.chatRev == prior {
                            partialHistories[id] = PartialHistory(
                                nextFrom: partial.nextFrom,
                                chatRev: chatRev,
                                loadedPages: partial.loadedPages
                            )
                        }
                        scheduleDisplayTail(id)
                    }
                    continue
                }
                inflightChatIds.remove(id)
                let base = inflightBases.removeValue(forKey: id)
                let follow = followedIds.contains(id)
                let isComplete = turnsCompleteById?[id] ?? (chats.first(where: { $0.id == id })?.turnsComplete == true)
                guard isComplete else {
                    // 尾部还没标完整。回执里的版本若已经前进，不能继续把旧尾页当成最新。
                    if follow, prior != chatRev { ensureTurnsLoaded(id) }
                    continue
                }
                if bodyRevs[id] == base, prior == base, chatRev == base {
                    // 上传的只是元数据，而且服务端版本号没动：正文仍是发出时那一版。
                    scheduleBodyCache(id)
                } else if bodyRevs[id] == base, prior == base, chatRev != base {
                    // 版本号前进了。不能把旧正文写成新版本，否则以后再也不去拉别端的新回合。
                    flushStreamDeltas(id, commitToChats: true)
                    markNeedsRefresh(id, rev: bodyRevs[id])
                    if follow { ensureTurnsLoaded(id) }
                } else if bodyRevs[id] != chatRev {
                    // 本地优先期间别处改过正文：现在不脏了，按新版本补齐
                    flushStreamDeltas(id, commitToChats: true)
                    markNeedsRefresh(id, rev: bodyRevs[id] ?? Int.min)
                    if follow { ensureTurnsLoaded(id) }
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
            let decodedChat: ChatSession?
            if case .storedChat(let readyChat) = predecoded {
                decodedChat = readyChat
            } else {
                decodedChat = ChatSession.from(value)
            }
            guard let remote = decodedChat, !deletedIds.contains(remote.id) else { break }
            flushStreamDeltas(remote.id, commitToChats: true)
            pendingChatLoads.remove(remote.id)
            let priorRev = chatRevs[remote.id]
            if let rev { chatRevs[remote.id] = rev }
            if !remote.turnsComplete { noteServerSegs(value) }
            // 本地优先（脏/有未回推新 turn）的会话不应用服务器版，稍后重推
            if !hasLocalPriority(remote.id) {
                cachedOnlyIds.remove(remote.id) // 服务端版本到了，不再是只读缓存行
                if let index = chats.firstIndex(where: { $0.id == remote.id }) {
                    var mergedChat = remote
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
                }
                if followedBodyChatIds().contains(remote.id) {
                    ensureTurnsLoaded(remote.id)
                }
            }
            if pendingChatLoads.isEmpty { scheduleSync() } // 对账完毕，把本地脏的推上去
            fulfillPendingAssistantOpen()
        case .workspaces(let root, let items):
            receiveWorkspaces(root: root, items: items)
        case .workspaceCreated(let path, let name):
            if !workspaces.contains(where: { $0.path == path }) {
                let index = workspaces.firstIndex(where: { !$0.user }) ?? workspaces.count
                workspaces.insert(WorkspaceItem(path: path, name: name), at: index)
            }
            updateCachedWorkspaces(root: workspaceRoot, items: workspaces)
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
            if let index = workspaces.firstIndex(where: { normPath($0.path) == fromKey }) {
                workspaces[index].path = newPath
                workspaces[index].name = name
                updateCachedWorkspaces(root: workspaceRoot, items: workspaces)
            }
            flash("已改名为「\(name)」")
            requestStateReload()
            requestFileIndex(chatId: activeId)
        case .workspaceRemoved(let path, let name, let mode):
            workspaces.removeAll { normPath($0.path) == normPath(path) }
            updateCachedWorkspaces(root: workspaceRoot, items: workspaces)
            flash(mode == "deleted" ? "已删除文件夹「\(name)」" : "「\(name)」里有文件，已从列表隐藏（文件没动）")
        case .workspaceAgents(let items, let ticket, let reset, let more, let after, let cursor):
            if reset {
                // 广播更新也会从第一页重新开始；旧的“已完整加载”不能沿用，
                // 否则角标会按残缺列表重算，推送深链也会过早放弃找后续页。
                workspaceAgentsLoaded = false
                workspaceAgents = items
            } else {
                guard after == workspaceAgentsPendingCursor else { break }
                var byPath = Dictionary(workspaceAgents.map { ($0.path, $0) }, uniquingKeysWith: { _, latest in latest })
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
            if !assistantOnly, isWorkspaceChat(activeId) {
                syncWorkbenchAgentViewing(chatId: activeId, active: true)
            }
            if let path = pendingWorkspacePath,
               chatHomeDestination == .workspace(path),
               let item = items.first(where: { $0.path == path }),
               let chatId = item.mainChatId
            {
                enterWorkspaceThread(path: path, chatId: chatId)
            }
        case .workspaceAgentOpened(let path, let chatId):
            if let index = workspaceAgents.firstIndex(where: { $0.path == path }) {
                workspaceAgents[index].mainChatId = chatId
            }
            ensureTurnsLoaded(chatId)
            if chatHomeDestination == .workspace(path) {
                enterWorkspaceThread(path: path, chatId: chatId)
            }
        case .workspaceAgentUpdate(let chatId, let unread, let readSeq, let finishedSeq):
            guard let index = workspaceAgents.firstIndex(where: { $0.mainChatId == chatId }) else { break }
            workspaceAgents[index].unread = unread
            workspaceAgents[index].readSeq = max(workspaceAgents[index].readSeq, readSeq)
            workspaceAgents[index].finishedSeq = max(workspaceAgents[index].finishedSeq, finishedSeq)
            if !assistantOnly, activeId == chatId || workspaceAgentForWorkbench(chatId: activeId)?.mainChatId == chatId {
                syncWorkbenchAgentViewing(chatId: activeId, active: true)
            }
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
            let prewarmed = RunMetaPrewarmStash.take(chatId: id)
            patchRunning(id) { turn in
                var next = turn
                if !runModel.isEmpty { next.model = runModel }
                if let runMode { next.mode = runMode }
                if let prewarmed { next.extra["prewarmedSkills"] = prewarmed }
                return next
            }
        case .textDelta(let id, let text):
            if awaitSnapshot.contains(id) { break }
            if snapshotHold.contains(id) {
                heldDeltas[id, default: []].append(text)
                break
            }
            // 不再遇换行立刻冲刷，保持稳定节流节奏，避免列表/代码/表格流式退化成逐 token 重排。
            enqueueStreamDelta(.text(text), chatId: id)
        case .thinkingDelta(let id, let text):
            if awaitSnapshot.contains(id) || snapshotHold.contains(id) { break }
            enqueueStreamDelta(.thinking(text), chatId: id)
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
            if status == "completed",
               ToolKind.from(name: name, args: toolArgs).isMutating,
               id == activeId || id == chatHomeThreadChatId
            {
                // compact 网关会主动广播 files；短暂等待广播，只有旧网关超时才补拉。
                scheduleFileIndexFallback(chatId: id)
            }
        case .toolOutput(let id, let callId, let stream, let chunk, let stdout, let stderr):
            if awaitSnapshot.contains(id) || snapshotHold.contains(id) { break }
            enqueueStreamDelta(
                .toolOutput(callId: callId, stream: stream, chunk: chunk, stdout: stdout, stderr: stderr),
                chatId: id
            )
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
                syncLiveBusy(target)
            } else if status == "FINISHED" || status == "ERROR" || status == "CANCELLED" || status == "EXPIRED" {
                let target = id ?? activeId
                runningChatIds.removeAll { $0 == target }
                queuedChatIds.removeAll { $0 == target }
                syncLiveBusy(target)
                let settled = (status == "ERROR" || status == "EXPIRED") ? "error" : (status == "CANCELLED" ? "cancelled" : "finished")
                settlePendingSnapshot(target, status: settled)
                patchOpen(target) { $0.settled(status: settled) }
            }
        case .error(let id, let text, let reqId):
            if let reqId {
                // 带 reqId 的 error 只服务请求级结清（旧网关 list_files）；不得当作 Agent 回合终态。
                settleFileIndexFailure(chatId: id, reqId: reqId)
                break
            }
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
            syncLiveBusy(target)
            settlePendingSnapshot(target, status: "error")
            patchOpen(target) { turn in
                var next = turn.settled(status: "error")
                next.error = text
                return next
            }
            touchChat(target)
        case .done(let id, let status, let duration):
            let assistantCompleted = id == assistantChatId && AssistantAvatarPhase.isSuccessful(status) &&
                (runningChatIds.contains(id) || assistantChat?.turns.last?.running == true)
            runningChatIds.removeAll { $0 == id }
            queuedChatIds.removeAll { $0 == id }
            syncLiveBusy(id)
            settlePendingSnapshot(id, status: status, durationMs: duration)
            patchOpen(id) { turn in
                turn.settled(status: status, durationMs: duration)
            }
            touchChat(id)
            scheduleSync()
            if assistantCompleted { assistantCompletionEvent &+= 1 }
            scheduleBodyCache(id) // 通常还脏着，要等 sync_ack 后那次触发才真写
            if id == activeId { refreshCheckpoints() }
        case .runSnapshot(
            let id, let turnId, let phase, let status, let userText, let assistant, let thinking,
            let tools, let task, let runModel, let runMode, let awaitingApproval, let queued, let duration, let clipped
        ):
            awaitSnapshot.remove(id)
            sawSnapshot.insert(id)
            // 快照是累计正文；此前暂存的增量已经被它或 clipped 前的落盘覆盖，只保留快照之后的新增量。
            if snapshotHold.contains(id) {
                heldDeltas[id] = []
            }
            // 尾页已停下时不再为了截断快照重拉整段。直接画到当前尾页上，否则这一轮会被删掉并一直挂起。
            if clipped, !historyParked(id) {
                snapshotHold.insert(id)
                if let index = chats.firstIndex(where: { $0.id == id }) {
                    if let turnId, !turnId.isEmpty {
                        chats[index].turns.removeAll { $0.id == turnId }
                    }
                    chats[index].turnsComplete = false
                    invalidateTurnListMemo(id)
                }
                // 正文少了这一轮，不能按「版本一致」直接补齐：有基线的作废版本号（只走增量补齐），也不再读本机缓存
                if bodyRevs[id] != nil { bodyRevs[id] = Int.min }
                bodySegs[id] = nil
                cacheCheckedIds.insert(id)
                stagePendingSnapshot(id, message: message)
                ensureTurnsLoaded(id)
                break
            }
            if let chat = chats.first(where: { $0.id == id }), !chat.turnsComplete, !historyParked(id) {
                stagePendingSnapshot(id, message: message)
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
            let incoming: [Turn]
            if case .turns(let readyTurns) = predecoded {
                incoming = readyTurns
            } else {
                incoming = rows.compactMap(Turn.from)
            }
            guard !incoming.isEmpty else { break }
            // P8 slim：turns 未加载完时，history（fresh UUID）与 load_chat 页（持久 id）
            // id 空间不同，直接合并会重复/覆盖——暂存，加载完成后按老规则应用
            if let chat = chats.first(where: { $0.id == id }), !chat.turnsComplete {
                pendingHistory[id] = incoming
                break
            }
            applyHistory(chatId: id, incoming: incoming)
        case .chatTurns(let chatId, let rows, let from, let hasMore, let nonce, let pageRev):
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
            // from 是位置游标，必须绑定 chatRev。旧网关没有该字段时保持兼容，但只允许自动拉全量。
            if let pageRev {
                let action = ChatPageRevisionPolicy.action(
                    authoritativeRev: chatRevs[chatId],
                    loadStartRev: loadStartRevs[chatId],
                    pageRev: pageRev
                )
                if action != .accept {
                    abortTurnsLoad(chatId)
                    partialHistories[chatId] = nil
                    displayOnlyIds.insert(chatId)
                    // 迟到页永远不能回滚权威 chatRev；有权威版本就按它换代重启，否则先等 stored_state。
                    if action == .restartAtAuthoritativeRevision {
                        ensureTurnsLoaded(chatId)
                    } else {
                        requestStateReload()
                    }
                    break
                }
                loadStartRevs[chatId] = pageRev
            } else {
                partialHistories[chatId] = nil
            }
            let decodedPage: [Turn]
            if case .turns(let readyTurns) = predecoded {
                decodedPage = readyTurns
            } else {
                decodedPage = rows.compactMap(Turn.from)
            }
            // 增量补齐：页攒在 bodyRefreshes 里，不并进显示中的基线（同样不走 patch）
            if bodyRefreshes[chatId] != nil {
                applyRefreshPage(chatId: chatId, page: decodedPage, from: from, hasMore: hasMore)
                break
            }
            // 页合并直接改 chats[index]，不走 patch()——加载不是本地编辑，不能误标脏触发回推。
            // 已知限制（Kimi 评审 MINOR4）：from 是位置游标，假设服务端 turns append-only——
            // 分页中途他端增删会索引漂移（去重防重不防漏）；漂移靠 digest→stored_chat 全量
            // 替换（或 deferred 降级重载）自愈，不在这里做复杂对账
            let page = decodedPage
            // 一次构建 id -> 索引表，同时服务文件合并与新增去重，避免 O(P * N) 线性扫描
            let existingIndexById = Dictionary(
                chats[index].turns.enumerated().map { ($0.element.id, $0.offset) },
                uniquingKeysWith: { first, _ in first }
            )
            // 缓存基线可能已有同 id 回合但没有 files；分页去重前先合文件状态。
            var fresh: [Turn] = []
            fresh.reserveCapacity(page.count)
            for remote in page {
                if let turnIndex = existingIndexById[remote.id] {
                    chats[index].turns[turnIndex] = chats[index].turns[turnIndex].mergingFiles(from: remote)
                } else {
                    fresh.append(remote)
                }
            }
            if !fresh.isEmpty {
                chats[index].turns = fresh + chats[index].turns
            }
            invalidateTurnListMemo(chatId)
            loadedPageTurnCounts[chatId] = (loadedPageTurnCounts[chatId] ?? 0) + fresh.count
            loadPageCounts[chatId] = (loadPageCounts[chatId] ?? 0) + 1
            // turn_files 可早于其所在分页；每页落入内存后立即尝试合并，不能只等最后一页。
            mergePendingTurnFiles(chatId: chatId)
            if hasMore {
                let loadedPages = loadPageCounts[chatId] ?? 1
                if let pageRev, loadedPages >= 2 {
                    // 自动和手动续拉都停在已确认尾页：不标完整、不写权威 body，也不会被 sync 回推。
                    partialHistories[chatId] = PartialHistory(nextFrom: from, chatRev: pageRev, loadedPages: loadedPages)
                    clearLoadTimeout(chatId)
                    loadingChatIds.remove(chatId)
                    loadedPageTurnCounts[chatId] = nil
                    loadPageCounts[chatId] = nil
                    loadStartRevs[chatId] = nil
                    loadStartSegs[chatId] = nil
                    chats[index].turnsComplete = false
                    displayOnlyIds.remove(chatId)
                    rememberTail(chatId)
                    applyPendingSnapshots(chatId)
                } else {
                    if let partial = partialHistories[chatId] {
                        partialHistories[chatId] = PartialHistory(
                            nextFrom: from,
                            chatRev: partial.chatRev,
                            loadedPages: loadedPages
                        )
                    }
                    sendLoadChat(chatId, from: from) // 继续向前翻 turns[..<from]
                }
            } else {
                clearLoadTimeout(chatId)
                loadTimeoutStreak[chatId] = nil
                let deferred = chats[index].turns.contains(where: \.deferred)
                chats[index].turnsComplete = !deferred
                if deferred, let pageRev {
                    partialHistories[chatId] = PartialHistory(
                        nextFrom: 0,
                        chatRev: pageRev,
                        loadedPages: loadPageCounts[chatId] ?? 1
                    )
                } else {
                    partialHistories[chatId] = nil
                }
                displayOnlyIds.remove(chatId)
                loadingChatIds.remove(chatId)
                loadedPageTurnCounts[chatId] = nil
                loadPageCounts[chatId] = nil
                chats[index].serverPreview = nil // 正文齐了，侧栏预览回到本地计算（GLM 评审 m4）
                completeTurnsLoad(chatId, authoritative: !deferred)
                if deferred { rememberTail(chatId) }
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
            let written = relToCwd(path)
            guard let index = previewSaves.firstIndex(where: { save in
                let samePath = save.path == path || save.path == written || relToCwd(save.path) == written
                let chatOk = writtenChatId?.nilIfEmpty == nil || writtenChatId == save.chatId || writtenChatId == activeId
                return samePath && chatOk
            }) else { break }
            let save = previewSaves.remove(at: index)
            if let error {
                if let tabIndex = previewTabs.firstIndex(where: { tab in
                    tab.path == save.path || tab.path == written || relToCwd(tab.path) == written
                }) {
                    previewTabs[tabIndex].content = save.previous
                }
                bannerError = friendlyError(error)
            } else {
                flash("已保存")
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
            let forPinned = previewTabs.contains { $0.path == path && $0.fromCard && $0.chatId != nil && $0.chatId == msgChatId }
            if !forActive, !forPinned { break }
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
                    if tab.content == nil { tab.error = "文件已不在当前文件夹，换个文件夹后再打开，或关掉这个预览。" }
                    flash("\(path) 已不在这个文件夹")
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
                if let content {
                    switch retainPreviewBody(content, path: path) {
                    case .inline(let kept):
                        tab.content = kept
                        tab.external = false
                    case .system:
                        tab.content = nil
                        tab.external = true
                    case .failed:
                        tab.content = nil
                        tab.external = false
                        tab.error = "这份文件比较大，系统预览没能打开"
                    }
                }
            }
            previewTabs[index] = tab
            // 大文本（markdown/html/canvas 超限时）可能只回 url 不回 content：走 HTTP 票据水合；
            // diff 页签不水合；媒体类（needsMediaURL）由媒体视图直接加载 URL，不能当文本拉
            if tab.error == nil && !tab.external && !tab.diff && tab.content == nil && tab.mediaURL != nil && !tab.kind.needsMediaURL {
                hydratePreviewText(path: tab.path)
            }
        case .files(let query, let dir, let paths, let mention, let truncated, let filesChatId, let status, let reqId, let filesError):
            // 工作台和聊天主页各有明确线程；只接收其中一个正在显示的请求。
            let responseChatId = filesChatId?.nilIfEmpty ?? activeId
            if let dir {
                if let filesError, !filesError.isEmpty {
                    loadingDirsByChat[responseChatId]?.remove(dir)
                    flash(friendlyError(filesError))
                    break
                }
                receiveDirFiles(
                    chatId: responseChatId,
                    dir: dir,
                    paths: paths,
                    truncated: truncated,
                    status: status
                )
            } else if mention {
                guard !deletedIds.contains(responseChatId) else { break }
                let activeQuery = mentionQueryByChat[responseChatId]
                guard activeQuery != nil || responseChatId == mentionRequestChatId else { break }
                // 过期查询的结果直接丢（对齐网页端 query 比对）
                guard query == activeQuery else { break }
                // 合并该会话的本地索引与服务端结果（对齐网页 mentionHits 的 remote 合并；
                // 本地索引被截断时服务端结果可能是唯一来源）
                let localPool: [String]
                if fileIndexRequestChatId == responseChatId {
                    localPool = fileIndex
                } else {
                    localPool = bootstrapSnapshot?.fileIndexes[responseChatId]?.paths ?? []
                }
                var seen = Set<String>()
                var merged: [String] = []
                merged.reserveCapacity(paths.count + localPool.count)
                for path in paths where seen.insert(path).inserted {
                    merged.append(path)
                }
                for path in localPool where seen.insert(path).inserted {
                    merged.append(path)
                }
                mentionRankTasksByChat.removeValue(forKey: responseChatId)?.cancel()
                if merged.count <= 200 {
                    mentionSuggestionsByChat[responseChatId] = ChatStore.rankMentions(merged, query: query)
                } else {
                    let expectedQuery = query
                    mentionRankTasksByChat[responseChatId] = Task { [weak self] in
                        let ranked = await Task.detached(priority: .userInitiated) {
                            ChatStore.rankMentions(merged, query: expectedQuery)
                        }.value
                        guard !Task.isCancelled, let self,
                              !self.deletedIds.contains(responseChatId),
                              self.mentionQueryByChat[responseChatId] == expectedQuery
                        else { return }
                        self.mentionRankTasksByChat[responseChatId] = nil
                        if self.mentionSuggestionsByChat[responseChatId] != ranked {
                            self.mentionSuggestionsByChat[responseChatId] = ranked
                        }
                    }
                }
            } else {
                guard query.isEmpty else { break }
                if let filesError, !filesError.isEmpty {
                    if let reqId {
                        settleFileIndexFailure(chatId: responseChatId, reqId: reqId)
                    }
                    flash(friendlyError(filesError))
                    break
                }
                receiveFileIndex(
                    chatId: responseChatId,
                    paths: paths,
                    truncated: truncated,
                    status: status,
                    reqId: reqId
                )
            }
        case .searchHits(let query, let hits, let hitsChatId, let truncated):
            let responseChatId = hitsChatId?.nilIfEmpty ?? activeId
            guard responseChatId == searchRequestChatId else { break }
            let current = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            guard query.trimmingCharacters(in: .whitespacesAndNewlines) == current else { break }
            searchHits = hits
            searchTruncated = truncated
            searchLoading = false
            searchContentNote = ""
        case .checkpoints(let id, let items):
            let targetChatId = id.nilIfEmpty ?? activeId
            guard !deletedIds.contains(targetChatId) else { break }
            checkpointsByChat[targetChatId] = items
            guard id.isEmpty || id == activeId || id == chatHomeThreadChatId else { break }
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
                scheduleFileIndexFallback(chatId: chatId)
                break
            }
            if let error, !error.isEmpty {
                notice = error
            } else {
                notice = "已还原检查点 \(label?.nilIfEmpty ?? "")"
            }
            scheduleFileIndexFallback(chatId: chatId)
            if chatId == activeId { reloadPreviewTabs() }
        case .turnFiles(let filesChatId, let turnId, let files):
            // 网关落盘时已经写进 turn.files：这里只同步到本机，不标脏、不回传
            mergeOrQueueTurnFiles(chatId: filesChatId, turnId: turnId, files: files)
        case .fileChanged(let changedChatId, let path):
            ThumbnailStore.shared.invalidateCurrent(chatId: changedChatId, path: path, store: self)
            reloadPreview(path: path, chatId: changedChatId)
            let sameWorkspace = sameCwd(chats.first(where: { $0.id == changedChatId })?.cwd, active?.cwd)
            if changedChatId == activeId || changedChatId == chatHomeThreadChatId || sameWorkspace {
                scheduleFileIndexFallback(chatId: sameWorkspace ? activeId : changedChatId)
            }
        case .undone(_, let paths, let error):
            settleRestore(chatId: chatId, paths: paths, error: error?.nilIfEmpty)
            let sourceCwd = chats.first(where: { $0.id == chatId })?.cwd
            let affectsActiveWorkspace = chatId == activeId
                || chatId == chatHomeThreadChatId
                || sameCwd(sourceCwd, active?.cwd)
            if error != nil || paths.isEmpty {
                for index in previewTabs.indices where previewTabs[index].loading
                    && previewTabs[index].diff
                    && previewTabs[index].readSha == nil
                    && (readChatId(previewTabs[index]) == chatId || (!previewTabs[index].fromCard && sameCwd(sourceCwd, previewTabs[index].cwd ?? active?.cwd))) {
                    previewTabs[index].loading = false
                }
            } else {
                for raw in paths {
                    let key = relToCwd(raw, chatId: chatId)
                    if affectsActiveWorkspace {
                        gitStatus.removeValue(forKey: key)
                        if raw != key { gitStatus.removeValue(forKey: raw) }
                    }
                    for index in previewTabs.indices {
                        let tab = previewTabs[index]
                        let matchesSession = readChatId(tab) == chatId
                        let matchesWorkspace = !tab.fromCard && sameCwd(sourceCwd, tab.cwd ?? active?.cwd)
                        guard tab.readSha == nil, matchesSession || matchesWorkspace else { continue }
                        let tabPath = tab.path
                        if tabPath == key || tabPath == raw || relToCwd(tabPath, chatId: chatId) == key {
                            previewTabs[index].diff = false
                        }
                    }
                    reloadPreview(path: raw, chatId: chatId)
                }
            }
            // 只反馈当前会话的 undo（chatId 已在 handle 入口解析为 activeId 兜底）
            guard affectsActiveWorkspace else { break }
            if let error {
                notice = error
            } else if paths.isEmpty {
                notice = "没有可还原的改动"
            } else {
                notice = "已还原 \(paths.joined(separator: ", "))"
            }
            scheduleFileIndexFallback(chatId: activeId)
        case .assistantState(let state, let reqId, let generation):
            receiveAssistantState(state, reqId: reqId, generation: generation)
        case .assistantNotModified(let revision, let reqId, let generation):
            assistantSyncNotModified(revision: revision, reqId: reqId, generation: generation)
        case .assistantResult(let reqId, let op, let ok, let error, let data):
            if memoryCenterHandleExtrasResult(reqId: reqId, op: op, ok: ok, error: error, data: data) {
                break
            }
            if memoryCenterHandleAssistantResult(reqId: reqId, op: op, ok: ok, error: error, data: data) {
                break
            }
            if op == "memory_tidy" {
                memoryTidyFinished(ok: ok, error: error, data: data)
                break
            }
            if let reqId, let waiter = assistantDataWaiters.removeValue(forKey: reqId) {
                waiter(ok, error, data)
                break
            }
            if let reqId, let waiter = assistantReplyWaiters.removeValue(forKey: reqId) {
                waiter(ok)
                break
            }
            if !ok {
                if op != "memory_center_get", op != "memory_center_search", op != "memory_center_mutate",
                   op != "memory_center_activity", op != "memory_center_restore",
                   op != "memory_center_suggestions_get", op != "memory_center_suggestion_answer",
                   op != "memory_center_export", op != "memory_center_import_preview",
                   op != "memory_center_import_apply", op != "memory_center_import_rollback",
                   op != "kb_workspace_status", op != "kb_workspace_init",
                   op != "drop_token_create", op != "drop_token_update", op != "drop_token_revoke" {
                    flash(error ?? "助理操作失败（\(op)）")
                }
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
            let previous = assistantState?.delegations.first { $0.id == delegation.id }
            applyDelegationState(delegation, approval: approval)
            if delegation.status == "done", let previous,
               (previous.attempt ?? 1) == (delegation.attempt ?? 1),
               ["queued", "running", "awaiting"].contains(previous.status) {
                assistantCompletionEvent &+= 1
            }
        case .memoryWritten(_, let entry):
            if let index = assistantState?.memory?.entries.firstIndex(where: { $0.id == entry.id }) {
                assistantState?.memory?.entries[index] = entry
            } else if assistantState?.memory != nil {
                assistantState?.memory?.entries.insert(entry, at: 0)
            }
            flash("\(assistantName) 记住了：\(entry.topic.nilIfEmpty ?? String(entry.text.prefix(24)))")
        case .deviceInvoke(let invoke):
            deviceInvokeHandler?(invoke)
        case .project(let value):
            workspaceSharing.handle(value)
        case .im(let event):
            imSink?.handle(event)
        case .pong, .ignored:
            break
        }
    }

    func enqueueStreamDelta(_ event: BufferedStreamEvent, chatId: String, flushNow: Bool = false) {
        streamDeltaBuffers[chatId, default: []].append(event)
        if flushNow {
            flushStreamDeltas(chatId)
            return
        }
        guard streamDeltaFlushTasks[chatId] == nil else { return }
        streamDeltaFlushTasks[chatId] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.streamDeltaFlushDelay)
            guard let self, !Task.isCancelled else { return }
            self.flushStreamDeltas(chatId)
        }
    }

    /// 一批流式事件只写单会话 ActiveTurnBox，不触发 chats 值数组写放大；
    /// 遇到结构性事件、落盘、停止或断线时再通过 commitToChats 原子回写进 chats。
    func flushStreamDeltas(_ chatId: String, commitToChats: Bool = false) {
        streamDeltaFlushTasks.removeValue(forKey: chatId)?.cancel()
        if let events = streamDeltaBuffers.removeValue(forKey: chatId), !events.isEmpty {
            let interval = workbenchStreamSignposter.beginInterval("Delta flush")
            defer { workbenchStreamSignposter.endInterval("Delta flush", interval) }
            applyStreamEventsToActiveBox(chatId, events: events)
        }
        if commitToChats {
            commitActiveTurnBox(chatId, bumpRevision: true)
        }
    }

    private func applyStreamEventsToActiveBox(_ chatId: String, events: [BufferedStreamEvent]) {
        guard let chat = chats.first(where: { $0.id == chatId }),
              let baseTurn = chat.turns.last(where: \.running)
        else { return }
        let box = activeTurnBox(for: chatId)
        if box.turnId != baseTurn.id {
            box.reset()
            box.turnId = baseTurn.id
            box.rawAssistant = baseTurn.assistant
            box.rawThinking = baseTurn.thinking
            box.rawAssistantHasJeom = baseTurn.assistant.contains("점")
            box.rawThinkingHasJeom = baseTurn.thinking.contains("점")
            box.assistant = box.rawAssistantHasJeom ? ReplyText.repair(baseTurn.assistant) : baseTurn.assistant
            box.thinking = box.rawThinkingHasJeom ? ReplyText.repair(baseTurn.thinking) : baseTurn.thinking
        }
        var touchedText = false
        var touchedThinking = false
        var touchedTools = false
        var addedExtraTool = false
        // 同批次多条 toolOutput 按 callId 原地累积，避免对大 stdout 反复拷贝封装 JSONValue.object
        var pendingToolRecords: [String: [String: JSONValue]] = [:]
        var pendingToolIsExtra: [String: Int] = [:]
        for event in events {
            switch event {
            case .text(let text):
                if !text.isEmpty {
                    box.rawAssistant += text
                    if !box.rawAssistantHasJeom, text.contains("점") {
                        box.rawAssistantHasJeom = true
                    }
                    touchedText = true
                }
            case .thinking(let text):
                if !text.isEmpty {
                    box.rawThinking += text
                    if !box.rawThinkingHasJeom, text.contains("점") {
                        box.rawThinkingHasJeom = true
                    }
                    touchedThinking = true
                }
            case .toolOutput(let callId, let stream, let chunk, let stdout, let stderr):
                touchedTools = true
                if pendingToolRecords[callId] == nil {
                    if let baseTool = baseTurn.tools.first(where: { $0.callId == callId }) {
                        let current = box.toolOutputs[callId] ?? baseTool.result
                        pendingToolRecords[callId] = initialOutputRecord(current)
                    } else if let idx = box.extraTools.firstIndex(where: { $0.callId == callId }) {
                        pendingToolRecords[callId] = initialOutputRecord(box.extraTools[idx].result)
                        pendingToolIsExtra[callId] = idx
                    } else {
                        let newIdx = box.extraTools.count
                        box.extraTools.append(ToolCall(
                            callId: callId,
                            name: "shell",
                            args: nil,
                            result: nil,
                            status: "running",
                            parentCallId: nil,
                            agent: nil,
                            model: nil,
                            at: nil
                        ))
                        pendingToolRecords[callId] = initialOutputRecord(nil)
                        pendingToolIsExtra[callId] = newIdx
                        addedExtraTool = true
                    }
                }
                if var record = pendingToolRecords[callId] {
                    applyOutputChunk(&record, stream: stream, chunk: chunk, stdout: stdout, stderr: stderr)
                    pendingToolRecords[callId] = record
                }
            }
        }
        for (callId, record) in pendingToolRecords {
            let value = JSONValue.object(record)
            if let extraIdx = pendingToolIsExtra[callId] {
                box.extraTools[extraIdx].result = value
            } else {
                box.toolOutputs[callId] = value
            }
        }
        if touchedText {
            box.touchedText = true
            if box.rawAssistantHasJeom {
                let repaired = ReplyText.repair(box.rawAssistant)
                if box.assistant != repaired { box.assistant = repaired }
            } else {
                // 未出现韩文异常字符时直接共享 COW 缓冲，避免流式每 50ms 对数万字全文扫描与逐字节判等
                box.assistant = box.rawAssistant
            }
        }
        if touchedThinking {
            box.touchedThinking = true
            if box.rawThinkingHasJeom {
                let repaired = ReplyText.repair(box.rawThinking)
                if box.thinking != repaired { box.thinking = repaired }
            } else {
                box.thinking = box.rawThinking
            }
        }
        if touchedTools {
            box.touchedTools = true
        }
        if touchedText || touchedThinking || touchedTools {
            if bodySegs[chatId] != nil { bodySegs[chatId] = nil }
            box.streamRevision &+= 1
        }
        if addedExtraTool, chatId == assistantChatId {
            syncAssistantAvatarTurnSnapshot()
        }
        // 兜底离线提交重连首包直接下发增量时输入栏切换到停止态；常态已忙碌 O(1) 零写入。
        if !liveBusyIds.contains(chatId) { syncLiveBusy(chatId) }
    }

    func flushAllStreamDeltas(commitToChats: Bool = false) {
        var ids = Set(streamDeltaBuffers.keys)
        if commitToChats {
            ids.formUnion(activeTurnBoxIdsWithOverlay())
        }
        for id in ids {
            flushStreamDeltas(id, commitToChats: commitToChats)
        }
    }

    func discardStreamDeltas(_ chatId: String? = nil) {
        if let chatId {
            streamDeltaFlushTasks.removeValue(forKey: chatId)?.cancel()
            streamDeltaBuffers[chatId] = nil
            clearActiveTurnBox(for: chatId)
            return
        }
        for task in streamDeltaFlushTasks.values { task.cancel() }
        streamDeltaFlushTasks = [:]
        streamDeltaBuffers = [:]
        clearAllActiveTurnBoxes()
    }

    /// 尾页已经确认停下：不在翻页、也不在增量补齐。这时新回复直接画出来，不再等整段历史翻完。
    /// 磁盘尾部同样只是屏幕上的最近一段，别端快照要画上去，不能先收进待应用队列再等一次永远不来的补齐。
    func historyParked(_ id: String) -> Bool {
        (partialHistories[id] != nil || diskBodyCursors[id] != nil)
            && !loadingChatIds.contains(id)
            && !refreshingChatIds.contains(id)
            && bodyRefreshes[id] == nil
    }
}

extension ServerMessage {
    /// 仅对涉及单个会话回合结构/终态的事件在入口提交该会话的 ActiveTurnBox；
    /// 心跳 pong、IM 事件、助理全局投影、workspaces、loop 等无关帧不得击穿流式隔离层。
    fileprivate var flushesChatStreamDeltaBuffer: Bool {
        switch self {
        case .toolStarted, .toolCompleted, .task, .approval, .runMeta,
             .status, .done, .error, .runSnapshot, .history, .chatTurns,
             .session, .turnFiles, .chatTitle:
            return true
        default:
            return false
        }
    }

    fileprivate var flushesAllStreamDeltaBuffers: Bool {
        switch self {
        case .ready, .storedState, .storedStateDeferred, .storedDigest:
            return true
        default:
            return false
        }
    }
}

private func initialOutputRecord(_ result: JSONValue?) -> [String: JSONValue] {
    var record = result?.object ?? [:]
    if record["stdout"] == nil { record["stdout"] = .string("") }
    if record["stderr"] == nil { record["stderr"] = .string("") }
    return record
}

private func applyOutputChunk(
    _ record: inout [String: JSONValue],
    stream: String?,
    chunk: String?,
    stdout: String?,
    stderr: String?
) {
    if let stdout { record["stdout"] = .string(stdout) }
    if let stderr { record["stderr"] = .string(stderr) }
    if let chunk, !chunk.isEmpty {
        let key = stream == "stderr" ? "stderr" : "stdout"
        record[key] = .string((record[key]?.string ?? "") + chunk)
    }
}
