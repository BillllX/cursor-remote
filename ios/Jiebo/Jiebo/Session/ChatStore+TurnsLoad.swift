import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    /// P8 slim：会话 turns 未加载时启动分页加载（幂等）。from=nil 拉最后一页，
    /// 之后按响应的 from/hasMore 一页页向前翻（见 .chatTurns 处理）。
    /// 顺序：内存没有基线先读本机缓存 → 基线版本等于 chatRevs 直接补齐 → 有基线走增量补齐 → 都没有走全量分页
    func ensureTurnsLoaded(_ chatId: String) {
        guard let index = chats.firstIndex(where: { $0.id == chatId }),
              !chats[index].turnsComplete,
              !loadingChatIds.contains(chatId),
              !cacheReadingIds.contains(chatId) else { return }
        // 内存里没有可当基线的正文：先查本机缓存（每会话每次启动查一次），读完回到这里再决定
        if bodyRevs[chatId] == nil, chatId != "boot", !tenantId.isEmpty, !cacheCheckedIds.contains(chatId) {
            readBodyCache(chatId)
            return
        }
        // 冷启动缓存列表里的会话：服务端还没确认，只显示本机缓存，不发请求
        guard !cachedOnlyIds.contains(chatId) else { return }
        // 基线就是服务端当前版本：直接视为完整，不发请求
        if let bodyRev = bodyRevs[chatId], bodyRev == chatRevs[chatId] {
            chats[index].turnsComplete = true
            chats[index].serverPreview = nil
            loadStartRevs[chatId] = nil
            loadStartSegs[chatId] = nil
            completeTurnsLoad(chatId)
            return
        }
        let segCompare = compareSegs(chatId)
        // 段哈希全部一致：服务端正文没变，基线版本对齐到当前版本，同样不发请求
        if case .same = segCompare, let serverRev = chatRevs[chatId] {
            bodyRevs[chatId] = serverRev
            bodySegs[chatId] = serverSegs[chatId]
            chats[index].turnsComplete = true
            chats[index].serverPreview = nil
            loadStartRevs[chatId] = nil
            loadStartSegs[chatId] = nil
            completeTurnsLoad(chatId)
            return
        }
        // 没登录时 send 会被丢掉，loadingChatIds 却留着，之后就再也不会重启分页
        guard unlocked else { return }
        loadEpochs[chatId] = (loadEpochs[chatId] ?? 0) + 1 // 新分页链起新代际
        loadingChatIds.insert(chatId)
        loadStartRevs[chatId] = chatRevs[chatId]
        loadStartSegs[chatId] = currentServerSegs(chatId)
        if bodyRevs[chatId] != nil {
            // 有旧正文基线：增量补齐。基线留着显示、不并页，turnsComplete 保持 false——
            // json() 不带 turns，补齐完成前旧正文不会随 sync_chat 盖掉服务端的新回合
            var refresh = BodyRefresh(base: chats[index].turns.filter { !ChatStore.isLiveTurn($0) })
            if case .changed(let segment) = segCompare {
                refresh.minFrom = min(segment * ChatStore.serverSegmentSize, refresh.base.count)
            }
            bodyRefreshes[chatId] = refresh
            refreshingChatIds.insert(chatId)
        }
        sendLoadChat(chatId, from: nil)
    }

    /// 发一页 load_chat 并重新计时。超时按断线同一套规则作废这条分页链，换新 nonce 从末页重拉，
    /// 迟到的旧页凭 nonce 丢弃，不会和新页拼在一起
    func sendLoadChat(_ chatId: String, from: Int?) {
        let epoch = loadEpochs[chatId] ?? 0
        send(.loadChat(chatId: chatId, from: from, nonce: epoch))
        loadTimeouts[chatId]?.cancel()
        loadTimeouts[chatId] = Task { [weak self] in
            try? await Task.sleep(for: ChatStore.loadPageTimeout)
            guard let self, !Task.isCancelled,
                  self.loadingChatIds.contains(chatId),
                  (self.loadEpochs[chatId] ?? 0) == epoch else { return }
            self.loadTimeouts[chatId] = nil
            self.abortTurnsLoad(chatId)
            let streak = (self.loadTimeoutStreak[chatId] ?? 0) + 1
            self.loadTimeoutStreak[chatId] = streak
            // 回包迟迟不到多半是连接半死：先探活，断了会重连，重连后的 stored_state 会重启分页
            self.client.probe()
            if streak <= 2, self.client.isOpen {
                self.ensureTurnsLoaded(chatId)
            } else if chatId == self.activeId {
                self.flash(self.client.isOpen ? "聊天记录加载超时，稍后切回这个会话再试" : "聊天记录加载超时，正在重连…")
            }
        }
    }

    func clearLoadTimeout(_ chatId: String) {
        loadTimeouts.removeValue(forKey: chatId)?.cancel()
    }

    /// 作废一条在途分页链：剥掉已 prepend 的页前缀（保留本地新发后缀），清掉加载与增量补齐状态。
    /// 断线和分页超时共用；增量补齐没有并页，基线原样留着显示
    func abortTurnsLoad(_ id: String) {
        clearLoadTimeout(id)
        if loadingChatIds.contains(id), let index = chats.firstIndex(where: { $0.id == id }) {
            let pageCount = loadedPageTurnCounts[id] ?? 0
            if pageCount > 0, pageCount <= chats[index].turns.count {
                chats[index].turns = Array(chats[index].turns.dropFirst(pageCount))
            } else if pageCount > chats[index].turns.count {
                chats[index].turns = []
            }
        }
        loadingChatIds.remove(id)
        loadedPageTurnCounts[id] = nil
        bodyRefreshes[id] = nil
        refreshingChatIds.remove(id)
        loadStartRevs[id] = nil
        loadStartSegs[id] = nil
    }

    /// 本地「活的」回合：补齐时以本地为准，不让服务端的旧副本盖掉
    static func isLiveTurn(_ turn: Turn) -> Bool {
        turn.running || turn.queued || turn.pendingTool != nil
    }

    /// 服务端段哈希，只在它就是 chatRevs 当前版本的哈希时返回
    func currentServerSegs(_ chatId: String) -> SegHashes? {
        guard let segs = serverSegs[chatId], segs.rev == chatRevs[chatId] else { return nil }
        return segs
    }

    /// 基线正文的段哈希和服务端当前段哈希比对
    func compareSegs(_ chatId: String) -> SegCompare {
        guard gatewayFeatures.contains("seg_hashes"),
              let bodyRev = bodyRevs[chatId],
              let body = bodySegs[chatId], body.rev == bodyRev,
              let server = currentServerSegs(chatId)
        else { return .unknown }
        let shared = min(body.hashes.count, server.hashes.count)
        if let index = (0 ..< shared).first(where: { body.hashes[$0] != server.hashes[$0] }) {
            return .changed(index)
        }
        return body.hashes.count == server.hashes.count ? .same : .changed(shared)
    }

    /// slim 行带的 segHashes 记成服务端段哈希（版本取 chatRevs，调用前先更新 chatRevs）
    func noteServerSegs(_ row: JSONValue) {
        guard let object = row.object, let id = object["id"]?.string else { return }
        if let hashes = object["segHashes"]?.array?.compactMap(\.string), let rev = chatRevs[id] {
            serverSegs[id] = SegHashes(rev: rev, hashes: hashes)
        } else {
            serverSegs[id] = nil
        }
    }

    /// 后台读本机正文缓存，命中就装成基线（bodyRevs 记缓存版本），然后回到 ensureTurnsLoaded
    func readBodyCache(_ chatId: String) {
        let tenant = tenantId
        let epoch = cacheEpoch
        cacheReadingIds.insert(chatId)
        Task { @MainActor [weak self] in
            let body = await ChatCache.loadBody(tenant: tenant, chatId: chatId)
            guard let self, self.cacheEpoch == epoch, self.tenantId == tenant else { return }
            self.cacheReadingIds.remove(chatId)
            self.cacheCheckedIds.insert(chatId)
            if let body, !self.deletedIds.contains(chatId), self.bodyRevs[chatId] == nil,
               !self.loadingChatIds.contains(chatId),
               let index = self.chats.firstIndex(where: { $0.id == chatId }),
               !self.chats[index].turnsComplete
            {
                // 读缓存期间本地新加的回合（发消息、快照）接在缓存正文后面。直接改 chats，不走 patch：不是本地编辑
                let cachedIds = Set(body.turns.map(\.id))
                let local = self.chats[index].turns.filter { !cachedIds.contains($0.id) }
                self.chats[index].turns = body.turns + local
                self.bodyRevs[chatId] = body.rev
                self.bodySegs[chatId] = body.serverSegs.map { SegHashes(rev: body.rev, hashes: $0) }
            }
            self.ensureTurnsLoaded(chatId)
        }
    }

    /// 正文版本落后：保留旧正文作补齐基线，标成未完整（json() 不再带 turns，旧正文不会回推）。
    /// rev 是调用方知道的旧版本，只给「完整但还没记版本」的正文兜底；基线版本未知就退回老做法清空重拉
    func markNeedsRefresh(_ id: String, rev: Int?) {
        guard let index = chats.firstIndex(where: { $0.id == id }) else { return }
        if chats[index].turnsComplete, bodyRevs[id] == nil, let rev { bodyRevs[id] = rev }
        if bodyRevs[id] == nil { chats[index].turns = [] }
        chats[index].turnsComplete = false
    }

    /// truncate_turns 回执。截成且发出时正文就是服务端那一版：本地截断结果与服务端一致，版本跟着前进。
    /// 没截成（回合不在或正在跑）：本地截掉的回合服务端还在，本地正文作废、按服务端补齐（活的回合保留）
    func settleTruncate(_ id: String, prior: Int?, chatRev: Int, truncated: Bool) {
        let base = truncateBases.removeValue(forKey: id)
        guard chats.contains(where: { $0.id == id }) else { return }
        if truncated, chats.first(where: { $0.id == id })?.turnsComplete == true, bodyRevs[id] == base, prior == base {
            bodyRevs[id] = chatRev
            bodySegs[id] = nil
            return
        }
        // 版本未知也要留基线：markNeedsRefresh 没基线会清空正文，连重试中的那一轮一起丢掉
        if !truncated || bodyRevs[id] == nil { bodyRevs[id] = Int.min }
        bodySegs[id] = nil
        markNeedsRefresh(id, rev: bodyRevs[id])
        if id == activeId { ensureTurnsLoaded(id) }
    }

    /// 增量补齐的一页。acc 覆盖服务端 [from, total)；from 落进基线后比对 base[from] 与这页第一条：
    /// 一致 → base[..<from] + acc 完成；不一致 → 退回全量，继续翻到第一页后用 acc 整体替换。
    /// 有 minFrom（段哈希判出的第一个变动位置）时 acc 必须覆盖到它才接缝：from > minFrom 继续往前翻；
    /// from == minFrom == base.count 是纯追加，直接 base + acc
    func applyRefreshPage(chatId: String, rows: [JSONValue], from: Int, hasMore: Bool) {
        guard var refresh = bodyRefreshes[chatId] else { return }
        let page = rows.compactMap(Turn.from)
        let known = Set(refresh.acc.map(\.id))
        refresh.acc = page.filter { !known.contains($0.id) } + refresh.acc
        let reached = refresh.minFrom.map { from <= $0 } ?? true
        if !refresh.fallback, reached, from >= 0, from == refresh.base.count, refresh.minFrom == from {
            finishRefresh(chatId, server: refresh.base + refresh.acc)
            return
        }
        if !refresh.fallback, reached, from >= 0, from < refresh.base.count {
            if let first = page.first, refresh.base[from].id == first.id {
                finishRefresh(chatId, server: Array(refresh.base.prefix(from)) + refresh.acc)
                return
            }
            refresh.fallback = true
        }
        if hasMore {
            bodyRefreshes[chatId] = refresh
            sendLoadChat(chatId, from: from) // 继续向前翻 turns[..<from]
        } else {
            finishRefresh(chatId, server: refresh.acc)
        }
    }

    /// 增量补齐完成：服务端正文为准，本地活的回合同 id 用本地、服务端没有的追加在末尾；
    /// 补齐期间本地新加的回合（不在基线里）也接在末尾
    func finishRefresh(_ chatId: String, server: [Turn]) {
        let refresh = bodyRefreshes.removeValue(forKey: chatId)
        clearLoadTimeout(chatId)
        loadTimeoutStreak[chatId] = nil
        refreshingChatIds.remove(chatId)
        loadingChatIds.remove(chatId)
        loadedPageTurnCounts[chatId] = nil
        guard let index = chats.firstIndex(where: { $0.id == chatId }) else { return }
        let baseIds = Set((refresh?.base ?? []).map(\.id))
        // 有待回推的本地回合时，基线里服务端没有的回合也留着（可能就是本地发的、还没落盘）
        let keepLocal = localTurnsPendingSync.contains(chatId)
        // 基线前缀和补来的页是直接拼的：接缝判断错一次就会同一轮出现两遍
        var result = Turn.uniqued(server)
        var position: [String: Int] = [:]
        for (offset, turn) in result.enumerated() { position[turn.id] = offset }
        for turn in chats[index].turns {
            let live = ChatStore.isLiveTurn(turn)
            if let offset = position[turn.id] {
                if live { result[offset] = turn }
            } else if live || keepLocal || !baseIds.contains(turn.id) {
                result.append(turn)
            }
        }
        chats[index].turns = result
        chats[index].turnsComplete = true
        chats[index].serverPreview = nil
        completeTurnsLoad(chatId)
    }

    /// 正文齐了（全量分页、增量补齐、基线版本一致）之后的公共收尾。调用前已置 turnsComplete = true
    func completeTurnsLoad(_ chatId: String) {
        let startSegs = loadStartSegs.removeValue(forKey: chatId)
        if let rev = loadStartRevs.removeValue(forKey: chatId) ?? chatRevs[chatId] {
            bodyRevs[chatId] = rev
            bodySegs[chatId] = [startSegs, serverSegs[chatId], bodySegs[chatId]].compactMap { $0 }.first { $0.rev == rev }
        }
        // 加载期间发过消息：补齐时已按 keepLocal 留下本地新回合（正文由网关转录落盘，不靠回推），解除本地优先
        localTurnsPendingSync.remove(chatId)
        if let pending = pendingHistory.removeValue(forKey: chatId), !pending.isEmpty {
            applyHistory(chatId: chatId, incoming: pending)
        }
        if let snap = pendingSnapshots.removeValue(forKey: chatId) {
            snapshotHold.remove(chatId)
            if case .runSnapshot(
                _, let turnId, let phase, let status, let userText, let assistant, let thinking,
                let tools, let task, let runModel, let runMode, let awaitingApproval, let queued, let duration, let clipped
            ) = snap, !clipped {
                applyRunSnapshot(
                    chatId: chatId,
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
            }
            let chunks = heldDeltas.removeValue(forKey: chatId) ?? []
            if !chunks.isEmpty {
                let extra = chunks.joined()
                patch(chatId) { chat in
                    var next = chat
                    if let index = next.turns.indices.last {
                        next.turns[index].assistant += extra
                    }
                    return next
                }
            }
        }
        scheduleBodyCache(chatId)
        // 加载途中服务端版本又前进了（别端在写）：这份正文留作基线，当前会话立刻再补一次
        if !hasLocalPriority(chatId), let bodyRev = bodyRevs[chatId], let serverRev = chatRevs[chatId], bodyRev != serverRev {
            markNeedsRefresh(chatId, rev: bodyRev)
            if chatId == activeId { ensureTurnsLoaded(chatId) }
        }
    }

    /// 去抖 1.5s 写本机正文缓存。只写「完整、没有活的回合、没有截断回合、版本已知且与服务端一致、
    /// 本地没有待上传改动」的正文——缓存里的正文必须就是 chatRevs 那个版本的服务端全文
    func scheduleBodyCache(_ chatId: String) {
        guard chatId != "boot", !tenantId.isEmpty else { return }
        let tenant = tenantId
        bodyCacheTasks[chatId]?.cancel()
        bodyCacheTasks[chatId] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(1500))
            guard let self, !Task.isCancelled, self.tenantId == tenant else { return }
            self.bodyCacheTasks[chatId] = nil
            guard let chat = self.chats.first(where: { $0.id == chatId }),
                  chat.turnsComplete,
                  !self.cachedOnlyIds.contains(chatId),
                  !self.deletedIds.contains(chatId),
                  !self.hasLocalPriority(chatId),
                  !self.inflightChatIds.contains(chatId),
                  let rev = self.chatRevs[chatId], self.bodyRevs[chatId] == rev,
                  !Turn.hasDuplicateIds(chat.turns),
                  !chat.turns.contains(where: { turn in
                      ChatStore.isLiveTurn(turn)
                          || turn.extra["clipped"]?.bool == true
                          || turn.tools.contains(where: { $0.status == "running" })
                  })
            else { return }
            let segs = self.bodySegs[chatId].flatMap { $0.rev == rev ? $0.hashes : nil }
            ChatCache.saveBody(tenant: tenant, chatId: chatId, rev: rev, turns: chat.turns.map { $0.json() }, serverSegs: segs)
        }
    }

    /// 会话删除/截断：作废本机正文缓存和内存里的版本记录
    func forgetBodyCache(_ chatId: String) {
        bodyCacheTasks.removeValue(forKey: chatId)?.cancel()
        bodyRevs[chatId] = nil
        bodySegs[chatId] = nil
        guard chatId != "boot", !tenantId.isEmpty else { return }
        ChatCache.remove(tenant: tenantId, chatId: chatId)
    }

    /// 去抖写列表缓存（applyStoredState / applyStoredDigest 之后）。只存服务端认得的会话（有 chatRev），
    /// 元数据不带 turns，preview 用当前显示的摘要
    func scheduleListCache() {
        guard !tenantId.isEmpty, appliedStore else { return }
        let tenant = tenantId
        listCacheTask?.cancel()
        listCacheTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(1500))
            guard let self, !Task.isCancelled, self.tenantId == tenant, self.cachedOnlyIds.isEmpty else { return }
            let rows: [JSONValue] = self.chats.compactMap { chat in
                guard chat.id != "boot", !self.deletedIds.contains(chat.id), self.chatRevs[chat.id] != nil else { return nil }
                var slim = chat
                slim.turnsComplete = false // json() 不写 turns 键
                guard var object = slim.json().object else { return nil }
                let preview = chat.preview.trimmingCharacters(in: .whitespacesAndNewlines)
                if !preview.isEmpty { object["preview"] = .string(String(preview.prefix(200))) }
                return .object(object)
            }
            ChatCache.saveList(tenant: tenant, stateRev: self.stateRev, chatRevs: self.chatRevs, chats: rows)
        }
    }

    /// 冷启动：后台读 list.json，stored_state 还没到就先把会话列表画出来（只读，见 cachedOnlyIds）
    func loadCachedList() {
        let tenant = tenantId
        guard !tenant.isEmpty else { return }
        let epoch = cacheEpoch
        Task { @MainActor [weak self] in
            guard let list = await ChatCache.loadList(tenant: tenant) else { return }
            guard let self, self.cacheEpoch == epoch, self.tenantId == tenant, !self.appliedStore,
                  self.activeId == "boot", self.chats.count == 1, self.chats[0].id == "boot",
                  self.chats[0].turns.isEmpty
            else { return }
            var seen = Set<String>()
            let rows = list.chats.compactMap(ChatSession.from).filter { chat in
                chat.id != "boot" && !self.deletedIds.contains(chat.id) && seen.insert(chat.id).inserted
            }
            guard !rows.isEmpty else { return }
            let ids = Set(rows.map(\.id))
            // 只在能确定的情况下占 activeId：上次活跃会话就在缓存里，或从没记过、落到助理会话。
            // 其余留在 boot，等 stored_state 后由 restoreLastActiveIfNeeded 照常恢复
            let stored = self.lastChatKey.flatMap { UserDefaults.standard.string(forKey: $0) }
            var target: String?
            if let stored, ids.contains(stored) {
                target = stored
            } else if stored == nil, let assistantId = self.assistantChatId, ids.contains(assistantId) {
                target = assistantId
            }
            if self.assistantOnly, let assistantId = self.assistantChatId, target != assistantId {
                target = ids.contains(assistantId) ? assistantId : nil
            }
            guard let targetId = target, var chat = rows.first(where: { $0.id == targetId }) else {
                self.cachedOnlyIds = ids
                self.chats += rows
                return
            }
            // 正文和列表一起亮出来：分两步的话中间会先闪一下「正在加载会话」
            let body = await ChatCache.loadBody(tenant: tenant, chatId: targetId)
            guard self.cacheEpoch == epoch, self.tenantId == tenant, !self.appliedStore,
                  self.activeId == "boot", self.chats.count == 1, self.chats[0].id == "boot",
                  self.chats[0].turns.isEmpty, !self.cacheReadingIds.contains(targetId)
            else { return }
            self.cacheCheckedIds.insert(targetId)
            if let body, !self.deletedIds.contains(targetId) {
                chat.turns = body.turns
                self.bodyRevs[targetId] = body.rev
                self.bodySegs[targetId] = body.serverSegs.map { SegHashes(rev: body.rev, hashes: $0) }
            }
            var merged = rows
            if let index = merged.firstIndex(where: { $0.id == targetId }) { merged[index] = chat }
            self.cachedOnlyIds = ids
            self.chats = merged
            self.activeId = targetId
            self.cwd = chat.cwd ?? self.cwd
            self.mode = chat.mode
            self.ensureTurnsLoaded(targetId) // 缓存行：只用本机正文，不发请求
        }
    }

    /// iPhone 冷启动：助理会话还没从本机缓存或服务端装进来，当前停在 boot 占位上。
    /// 这时既不是空会话，也不该亮「正在加载」，对话区留白，超过一小会儿才转圈
    var coldStartPlaceholder: Bool {
        assistantOnly && activeId == "boot" && !appliedStore && assistantChatId != nil
    }
}
