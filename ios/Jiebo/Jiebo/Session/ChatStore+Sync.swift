import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    /// stored_digest 对账：发 load_state 拿 slim 元数据和最新 chatRevs（约 20KB），不下载整条正文。
    /// 回包前先不推 sync（同原来等 load_chats）；5s 安全网防网关没回
    func requestStateReload(timeout: Double = 5) {
        stateReloadPending = true
        send(.loadState)
        armStateReloadTimeout(timeout)
    }

    func armStateReloadTimeout(_ seconds: Double) {
        digestTimeoutTask?.cancel()
        digestTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, !Task.isCancelled, self.stateReloadPending else { return }
            self.stateReloadPending = false
            self.scheduleSync()
        }
    }

    func scheduleSync() {
        if chats.count == 1, chats[0].id == "boot" { return }
        let tenantAtSchedule = tenantId
        syncTask?.cancel()
        syncTask = Task {
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled, unlocked, tenantAtSchedule == tenantId else { return }
            if chats.count == 1, chats[0].id == "boot" { return }
            // digest 对账在途：先不推，等对账合并完（storedChat / load_state 回包后这里会被再触发）
            guard pendingChatLoads.isEmpty, !stateReloadPending else { return }
            // 旧网关没有 ack/digest，增量状态机跑不起来：退回全量 sync_state（老行为）。
            // 不动 dirty/inflight——dirty 保持非空，每次编辑都触发全量，与 P4 前一致。
            guard serverSupportsP4 else {
                // 防御：slim 壳（!turnsComplete）只会来自支持 P4 的新网关，正常到不了这里；
                // 真出现说明状态不一致——sync_state 是全量替换，缺 turns 键会把服务端正文抹掉，宁可不推。
                // 冷启动缓存列表还挂着（服务端状态没到）同理：全量替换会拿缓存行盖掉服务端
                guard cachedOnlyIds.isEmpty,
                      !chats.contains(where: { !$0.turnsComplete && $0.id != "boot" }) else { return }
                stateRev += 1
                send(.syncState(chats: .array(chats.map { $0.json() }), rev: stateRev))
                return
            }
            let dirty = dirtyChatIds.subtracting(inflightChatIds)
            guard !dirty.isEmpty else { return }
            stateRev += 1
            // P4b：只上传脏会话（流式期间从全量 2MB 降到单会话）
            for id in dirty {
                guard let chat = chats.first(where: { $0.id == id }), !cachedOnlyIds.contains(id) else {
                    dirtyChatIds.remove(id) // 本地已删（delete_session 已单独通知）/ 只读的缓存行
                    continue
                }
                dirtyChatIds.remove(id)
                inflightChatIds.insert(id)
                inflightBases[id] = chatRevs[id]
                send(.syncChat(chat: chat.metaJSON(), rev: stateRev))
            }
        }
    }

    /// stored_state 应用逻辑（WS 直推与 HTTP /state 拉取共用）
    func applyStoredState(rows: [JSONValue], rev: Int?, deleted: [String], chatRevs serverRevs: [String: Int]?) {
        defer { fulfillPendingAssistantOpen() }
        if serverRevs != nil { serverSupportsP4 = true }
        // digest 已把 stateRev 抬到服务端版本，它要的 load_state 回包 rev 不会更新，不能早退
        if appliedStore, !stateReloadPending, let rev, rev <= confirmedRev {
            // rev 不新（如断线重连后服务端还没收到我们的 sync_chat）：
            // 内容不应用，但断线时倒回 dirty 的在途会话必须有人重推，否则会永久搁置
            if !dirtyChatIds.isEmpty { scheduleSync() }
            ensureTurnsLoaded(activeId) // 断线丢失的在途分页在此重启（onClose 已清 loadingChatIds）
            return
        }
        deleted.filter { !isAssistantChat($0) }.forEach { deletedIds.insert($0) }
        appliedStore = true
        if let rev, rev > stateRev { stateRev = rev }
        if let rev, rev > confirmedRev { confirmedRev = rev }
        // 在途推送不在这里倒回：断线由 onClose 回收，被拒由 rejected digest 回收；
        // load_state 回包期间在途的推送回执照常会到，倒回只会重复推送
        let oldRevs = chatRevs
        chatRevs = serverRevs ?? [:] // 服务端视图全量替换
        // 段哈希跟着全量替换（只有 slim 行带，版本取刚换上的 chatRevs）
        serverSegs = [:]
        for row in rows { noteServerSegs(row) }
        if stateReloadPending {
            stateReloadPending = false
            digestTimeoutTask?.cancel()
        }
        // 冷启动缓存列表只读：以服务端为准整份替换，不参与 merge 的本地优先，也不进下面的差异标脏。
        // 已从本机缓存装进来的正文/草稿先摘下，合并后挂回作补齐基线（版本仍记在 bodyRevs）。
        // 当前会话是缓存行时退回 boot，交给下面的 restoreLastActiveIfNeeded 照常恢复
        var cachedBodies: [String: (turns: [Turn], draft: String)] = [:]
        if !cachedOnlyIds.isEmpty {
            // 缓存行不标脏，这里只是把输入框里的字记到行上，随基线挂回
            if cachedOnlyIds.contains(activeId) { persistDraft() }
            for chat in chats where cachedOnlyIds.contains(chat.id) {
                cachedBodies[chat.id] = (turns: chat.turns, draft: chat.draft)
                dirtyChatIds.remove(chat.id)
                dropChatState(chat.id)
            }
            let cachedIds = cachedOnlyIds
            chats.removeAll { cachedIds.contains($0.id) }
            cachedOnlyIds = []
            if !chats.contains(where: { $0.id == activeId }) {
                if !chats.contains(where: { $0.id == "boot" }) { chats.insert(ChatSession.blank(id: "boot"), at: 0) }
                activeId = "boot"
            }
        }
        let remote = rows.compactMap(ChatSession.from).filter { !deletedIds.contains($0.id) }
        guard !remote.isEmpty else {
            // 服务端全空（新租户/被清空）：清掉已被删的本地会话（保留脏的/boot），脏会话触发重推
            let kept = chats.filter { !deletedIds.contains($0.id) || hasLocalPriority($0.id) || $0.id == "boot" }
            if kept.count != chats.count {
                let keptIds = Set(kept.map(\.id))
                for chat in chats where !keptIds.contains(chat.id) {
                    dropChatState(chat.id)
                    forgetBodyCache(chat.id)
                }
                chats = kept
            }
            for id in cachedBodies.keys { forgetBodyCache(id) }
            scheduleListCache()
            restoreLastActiveIfNeeded() // P9：远端为空也先尝试恢复（本地脏会话可能就是上次活跃的）
            if !chats.contains(where: { $0.id == activeId }), let first = chats.first {
                swapActive(to: first.id)
            }
            // restore/fallback 之后统一 applySession（GLM R1 M1：漏调会让草稿/模式/工作区不载入，
            // 用户再输入时 persistDraft 把空草稿写回恢复的会话——数据丢失）
            if let keep = chats.first(where: { $0.id == activeId }) {
                applySession(keep)
            }
            if !dirtyChatIds.isEmpty { scheduleSync() }
            ensureTurnsLoaded(activeId)
            return
        }
        // 合并前记住服务端原始行（按 id），用于合并后的差异标脏
        var rowsById: [String: JSONValue] = [:]
        for row in rows {
            guard let id = row.object?["id"]?.string else { continue }
            rowsById[id] = row
        }
        // merge 只保留远端 id：本地独有的脏会话（离线新建未上传）必须追加保留，否则被静默丢弃
        let remoteIds = Set(remote.map(\.id))
        let localOnlyDirty = chats.filter {
            dirtyChatIds.contains($0.id) && !remoteIds.contains($0.id) && !deletedIds.contains($0.id)
        }
        let preMergeIds = Set(chats.map(\.id))
        chats = merge(local: chats, remote: remote) + localOnlyDirty
        let keptIds = Set(chats.map(\.id))
        for id in preMergeIds where !keptIds.contains(id) { // 远端删除的会话清分页/暂存和本机缓存
            dropChatState(id)
            forgetBodyCache(id)
        }
        for (id, cached) in cachedBodies {
            guard let index = chats.firstIndex(where: { $0.id == id }) else {
                forgetBodyCache(id) // 服务端已经没有这条：缓存的正文不能再复活
                continue
            }
            guard !chats[index].turnsComplete else { continue }
            // 尾段没有 bodyRevs，但也要挂回来，否则一连上服务器当前会话会先空掉
            if chats[index].turns.isEmpty, bodyRevs[id] != nil || displayOnlyIds.contains(id) {
                chats[index].turns = cached.turns
            }
            if chats[index].draft.isEmpty { chats[index].draft = cached.draft }
        }
        // 合并结果与服务端不一致的（本地优先胜出的/本地独有的）标脏，随后 sync_chat 增量重推。
        // 比较前把服务端行过一遍 from→json 归一化默认值，避免字段缺失造成的假差异。
        for chat in chats where chat.id != "boot" {
            if dirtyChatIds.contains(chat.id) { continue } // 已脏（含倒回的在途），无需再判
            guard let row = rowsById[chat.id], !deletedIds.contains(chat.id) else {
                dirtyChatIds.insert(chat.id) // 本地独有（新建未同步）
                continue
            }
            // rev 未变且本地不脏 → 内容必然一致，跳过序列化比较（全量 diff 的短路）
            if let oldRev = oldRevs[chat.id], oldRev == chatRevs[chat.id] { continue }
            // P8 slim：一方缺 turns（元数据壳）时按元数据比较——壳 json() 不写 turns 键，
            // 本地完整版带 turns，直接比必假差异 → sync_chat 风暴
            if var serverChat = ChatSession.from(row) {
                var localChat = chat
                if !serverChat.turnsComplete || !localChat.turnsComplete {
                    serverChat.turns = []
                    serverChat.turnsComplete = false
                    localChat.turns = []
                    localChat.turnsComplete = false
                }
                if serverChat.json() != localChat.json() {
                    dirtyChatIds.insert(chat.id)
                }
            }
        }
        // P8 slim 对账：slim 行看不到 turns——断线期间别端正文变更（chatRev 前进）本地感知不到，
        // 已加载会话的 turns 已陈旧：标记待补齐（脏会话本地优先跳过；壳本来就未完成无需处理）。
        // 旧正文留作基线继续显示，当前会话随后由 ensureTurnsLoaded 增量补齐，其他会话打开时再补。
        // 网关只在内容真变时才前进 chatRevs，纯元数据/未读类本地脏不会误触发。
        let stalePartialIds = partialHistories.compactMap { id, partial in
            partial.chatRev != chatRevs[id] && !hasLocalPriority(id) ? id : nil
        }
        for id in stalePartialIds {
            markNeedsRefresh(id, rev: nil)
        }
        for chat in chats where chat.id != "boot" && chat.turnsComplete && !hasLocalPriority(chat.id) {
            guard let row = rowsById[chat.id], row.object?["turns"] == nil else { continue } // 只看 slim 行
            guard let oldRev = bodyRevs[chat.id] ?? oldRevs[chat.id], let newRev = chatRevs[chat.id], newRev != oldRev else { continue }
            markNeedsRefresh(chat.id, rev: oldRev)
        }
        if !dirtyChatIds.isEmpty { scheduleSync() }
        restoreLastActiveIfNeeded() // P9：默认回落前先恢复上次活跃会话
        if chats.contains(where: { $0.id == activeId }) == false, let first = chats.first {
            swapActive(to: first.id)
        }
        if let keep = chats.first(where: { $0.id == activeId }) {
            applySession(keep)
        }
        ensureTurnsLoaded(activeId) // P8 slim：active 是壳就启动分页（含重连后在途丢失的重启）
        markLive(running: runningChatIds, queued: queuedChatIds)
        scheduleListCache()
    }

    /// P4c：stored_digest 目录对账——有差异就重拉一份 slim stored_state（load_state），正文走增量补齐；本地脏的保留优先
    func applyStoredDigest(rev: Int?, deleted: [String], serverRevs: [String: Int], rejected: Bool) {
        // 被拒的 inflight 回到脏集合（服务端没收下，本地优先稍后重推）。
        // 别处写入后的广播不影响本端在途推送，回执照常会到，不能倒回：倒回会重复推送，期间还把会话当本地优先
        if rejected {
            dirtyChatIds.formUnion(inflightChatIds)
            inflightChatIds = []
        }
        deleted.filter { !isAssistantChat($0) }.forEach { deletedIds.insert($0) }
        appliedStore = true
        if let rev, rev > stateRev { stateRev = rev }
        if let rev, rev > confirmedRev { confirmedRev = rev }
        let digestIds = Set(serverRevs.keys)
        // 清掉已删除会话的版本号残留（保留脏会话的）
        chatRevs = chatRevs.filter { digestIds.contains($0.key) || dirtyChatIds.contains($0.key) }
        // 本地有、digest 没有 → 已被别处删除；本地脏的/从未同步过的（无 rev）保留
        let kept = chats.filter { chat in
            digestIds.contains(chat.id)
                || hasLocalPriority(chat.id)
                || chatRevs[chat.id] == nil
                || chat.id == "boot"
                || isAssistantChat(chat.id)
        }
        if kept.count != chats.count {
            let keptIds = Set(kept.map(\.id))
            for chat in chats where !keptIds.contains(chat.id) {
                dropChatState(chat.id)
                forgetBodyCache(chat.id)
            }
            chats = kept
            if !chats.contains(where: { $0.id == activeId }), let first = chats.first {
                swapActive(to: first.id)
                applySession(chats.first { $0.id == activeId }) // 同上：swapActive 可能改道到助理会话
            }
        }
        // 对齐网页 stored_digest：先拿旧 rev 判目录是否 stale，再写入服务端 chatRevs。
        // 别端写入后网关会 broadcast digest——已加载正文须按 rev 增量补齐（不能只改元数据）。
        // 本地优先会话仍保留本地 rev / 正文，不参与远端覆盖。
        var listStale = !cachedOnlyIds.isEmpty
        for (id, serverRev) in serverRevs where !listStale {
            guard !deletedIds.contains(id) else { continue }
            let missing = !chats.contains(where: { $0.id == id })
            if missing || chatRevs[id] != serverRev { listStale = true }
        }
        for (id, serverRev) in serverRevs {
            guard !deletedIds.contains(id) else { continue }
            let prior = chatRevs[id]
            guard prior != serverRev else { continue }
            // 本地优先的也要记下服务端版本：回执据此发现期间别处改过正文，等不脏了再补齐
            chatRevs[id] = serverRev
            guard !hasLocalPriority(id) else { continue }
            if let index = chats.firstIndex(where: { $0.id == id }), chats[index].turnsComplete {
                let baseRev = bodyRevs[id] ?? prior
                if baseRev != serverRev {
                    markNeedsRefresh(id, rev: baseRev)
                    if id == activeId { ensureTurnsLoaded(id) }
                }
            }
        }
        scheduleListCache()
        if !listStale {
            if !dirtyChatIds.isEmpty { scheduleSync() }
            return
        }
        requestStateReload()
    }

    func scheduleStateFetch() {
        stateFetchTask?.cancel()
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        let tenantAtStart = tenantId
        stateFetchTask = Task { [weak self] in
            // 首次 300ms 去抖；失败后按 2s、5s、15s 退避重试。网络错误和 5xx 才重试，4xx 重试也没用
            let delays: [Duration] = [.milliseconds(300), .seconds(2), .seconds(5), .seconds(15)]
            for (attempt, delay) in delays.enumerated() {
                try? await Task.sleep(for: delay)
                guard let self, !Task.isCancelled else { return }
                let outcome = await Self.fetchState(token: token)
                guard !Task.isCancelled, self.tenantId == tenantAtStart else { return }
                switch outcome {
                case .success(let object):
                    self.applyStoredState(
                        rows: object["chats"]?.array ?? [],
                        rev: object["rev"]?.int,
                        deleted: object["deletedIds"]?.array?.compactMap(\.string) ?? [],
                        chatRevs: object["chatRevs"]?.intMap
                    )
                    return
                case .retryable where attempt < delays.count - 1:
                    continue
                case .retryable, .fatal:
                    if self.unlocked { self.flash("会话列表没同步下来，请检查网络后重新打开 App") }
                    return
                }
            }
        }
    }

    nonisolated static func fetchState(token: String) async -> StateFetchOutcome {
        var request = URLRequest(url: GatewayConfig.stateURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 60
        do {
            let (data, response) = try await AppTrafficHTTP.data(for: request, category: "会话状态下载")
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200 ..< 300).contains(status) else { return status >= 500 || status == 0 ? .retryable : .fatal }
            guard let object = try JSONValue.parse(data).object else { return .fatal }
            return .success(object)
        } catch {
            return .retryable
        }
    }
}
