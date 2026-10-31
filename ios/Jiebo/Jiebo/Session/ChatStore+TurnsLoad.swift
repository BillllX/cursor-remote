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
        if let partial = partialHistories[chatId] {
            guard partial.chatRev == chatRevs[chatId] else {
                partialHistories[chatId] = nil
                displayOnlyIds.insert(chatId)
                return ensureTurnsLoaded(chatId)
            }
            displayOnlyIds.remove(chatId)
            let hasVisibleTurns = !chats[index].turns.isEmpty
            // 屏幕上已经有尾页时，蜂窝/低数据模式不再自动往前翻；Wi‑Fi 恢复后继续补。
            // 一个回合都没有时，这条游标不能代替第一页，否则会停在「正在加载会话」。
            if hasVisibleTurns, client.networkCost.shouldReduceBackgroundTraffic { return }
            if hasVisibleTurns {
                loadPreviousHistory(chatId)
                return
            }
            partialHistories[chatId] = nil
        }
        // 屏幕上只有首屏尾段：不要拿它接缝，也不要让分页去重把它当成权威正文
        if displayOnlyIds.contains(chatId) {
            guard unlocked else { return }
            var refresh = BodyRefresh(base: chats[index].turns.filter { !ChatStore.isLiveTurn($0) })
            refresh.fallback = true
            refresh.displayBase = true
            bodyRefreshes[chatId] = refresh
            refreshingChatIds.insert(chatId)
            loadEpochs[chatId] = (loadEpochs[chatId] ?? 0) + 1
            loadPageCounts[chatId] = 0
            loadingChatIds.insert(chatId)
            loadStartRevs[chatId] = chatRevs[chatId]
            loadStartSegs[chatId] = currentServerSegs(chatId)
            sendLoadChat(chatId, from: nil)
            return
        }
        // 基线就是服务端当前版本，并且屏幕上已经有正文：直接视为完整，不发请求。
        // 版本号对上但一个回合都没有，不能当成已加载，否则整段会话再也不会去拉。
        if !chats[index].turns.isEmpty, let bodyRev = bodyRevs[chatId], bodyRev == chatRevs[chatId] {
            chats[index].turnsComplete = true
            chats[index].serverPreview = nil
            loadStartRevs[chatId] = nil
            loadStartSegs[chatId] = nil
            completeTurnsLoad(chatId)
            return
        }
        let segCompare = compareSegs(chatId)
        // 段哈希全部一致且正文还在：服务端没变，基线版本对齐到当前版本，同样不发请求
        if !chats[index].turns.isEmpty, case .same = segCompare, let serverRev = chatRevs[chatId] {
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
        loadPageCounts[chatId] = 0
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
            } else if chatId == self.activeId || chatId == self.chatHomeThreadChatId {
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
        loadPageCounts[id] = nil
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

    /// 后台读本机正文缓存。先用尾段把空会话画出来，全文到了再换成权威正文，然后回到 ensureTurnsLoaded
    func readBodyCache(_ chatId: String) {
        let tenant = tenantId
        let epoch = cacheEpoch
        cacheReadingIds.insert(chatId)
        Task { @MainActor [weak self] in
            guard let self else { return }
            if self.canPaintTail(chatId, epoch: epoch, tenant: tenant),
               let tail = await ChatCache.loadTail(tenant: tenant, chatId: chatId) {
                self.paintTail(chatId, tail: tail, epoch: epoch, tenant: tenant)
            }
            let body = await ChatCache.loadBody(tenant: tenant, chatId: chatId)
            guard self.cacheEpoch == epoch, self.tenantId == tenant else { return }
            self.cacheReadingIds.remove(chatId)
            self.cacheCheckedIds.insert(chatId)
            if let body, !self.deletedIds.contains(chatId) {
                self.installCachedBody(chatId, body: body)
            }
            self.ensureTurnsLoaded(chatId)
        }
    }

    /// 尾段只填空会话。全文已经在的时候后到的尾段丢掉，避免闪回半截
    private func canPaintTail(_ chatId: String, epoch: Int, tenant: String) -> Bool {
        guard cacheEpoch == epoch, tenantId == tenant, !deletedIds.contains(chatId),
              bodyRevs[chatId] == nil, !loadingChatIds.contains(chatId),
              let index = chats.firstIndex(where: { $0.id == chatId })
        else { return false }
        return chats[index].turns.isEmpty && !chats[index].turnsComplete
    }

    private func paintTail(_ chatId: String, tail: ChatCache.Tail, epoch: Int, tenant: String) {
        guard canPaintTail(chatId, epoch: epoch, tenant: tenant),
              let index = chats.firstIndex(where: { $0.id == chatId })
        else { return }
        chats[index].turns = tail.turns
        chats[index].turnsComplete = false
        displayOnlyIds.insert(chatId)
        if let rev = tail.chatRev, let nextFrom = tail.nextFrom,
           nextFrom >= 0, rev == chatRevs[chatId], !cachedOnlyIds.contains(chatId)
        {
            partialHistories[chatId] = PartialHistory(nextFrom: nextFrom, chatRev: rev, loadedPages: 2)
            displayOnlyIds.remove(chatId)
        }
    }

    /// 权威正文到了：接上读缓存期间新出现的回合。只有多出来的都是正在生成的，才把它当成版本基线
    private func installCachedBody(_ chatId: String, body: ChatCache.Body) {
        guard !deletedIds.contains(chatId), bodyRevs[chatId] == nil,
              !loadingChatIds.contains(chatId), bodyRefreshes[chatId] == nil,
              let index = chats.firstIndex(where: { $0.id == chatId }),
              !chats[index].turnsComplete
        else { return }
        let cachedIds = Set(body.turns.map(\.id))
        let extra = chats[index].turns.filter { !cachedIds.contains($0.id) }
        chats[index].turns = body.turns + extra
        mergePendingTurnFiles(chatId: chatId)
        let settledExtra = extra.contains { !ChatStore.isLiveTurn($0) }
        if !settledExtra {
            bodyRevs[chatId] = body.rev
            bodySegs[chatId] = body.serverSegs.map { SegHashes(rev: body.rev, hashes: $0) }
            displayOnlyIds.remove(chatId)
            partialHistories[chatId] = nil
        }
        rememberTail(chatId)
    }

    /// 把最近 40 条已结束回合写到不会被系统清掉的目录。正在生成的回合不写，避免下次启动盖住服务端终态
    func scheduleDisplayTail(_ chatId: String) {
        guard chatId != "boot", !tenantId.isEmpty, !cachedOnlyIds.contains(chatId) else { return }
        let tenant = tenantId
        tailTasks[chatId]?.cancel()
        tailTasks[chatId] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(1500))
            guard let self, !Task.isCancelled, self.tenantId == tenant else { return }
            self.tailTasks[chatId] = nil
            self.rememberTail(chatId)
        }
    }

    func rememberTail(_ chatId: String) {
        guard chatId != "boot", !tenantId.isEmpty,
              let chat = chats.first(where: { $0.id == chatId })
        else { return }
        let settled = chat.turns.filter { !ChatStore.isLiveTurn($0) }
        let tail = Array(settled.suffix(ChatCache.tailLimit))
        guard !tail.isEmpty else { return }
        let partial = partialHistories[chatId]
        // 全部分页已到头但含 deferred 时，磁盘只留最后 40 轮；下次启动游标要回到这段尾页之前。
        let cachedNextFrom = partial.map {
            $0.nextFrom == 0 ? max(0, settled.count - tail.count) : $0.nextFrom
        }
        ChatCache.saveTail(
            tenant: tenantId,
            chatId: chatId,
            turns: tail.map { $0.json() },
            chatRev: partial?.chatRev,
            nextFrom: cachedNextFrom
        )
    }

    /// 用户抵达已加载顶部后续取一页。只有服务端版本仍与游标绑定时才续拉。
    func loadPreviousHistory(_ chatId: String) {
        guard !loadingChatIds.contains(chatId),
              !refreshingChatIds.contains(chatId),
              let partial = partialHistories[chatId],
              partial.nextFrom > 0,
              partial.chatRev == chatRevs[chatId],
              unlocked
        else { return }
        loadEpochs[chatId] = (loadEpochs[chatId] ?? 0) + 1
        loadStartRevs[chatId] = partial.chatRev
        loadStartSegs[chatId] = currentServerSegs(chatId)
        loadedPageTurnCounts[chatId] = 0
        loadPageCounts[chatId] = partial.loadedPages
        loadingChatIds.insert(chatId)
        sendLoadChat(chatId, from: partial.nextFrom)
    }

    /// 正文版本落后：保留旧正文作补齐基线，标成未完整（json() 不再带 turns，旧正文不会回推）。
    /// rev 是调用方知道的旧版本，只给「完整但还没记版本」的正文兜底；基线版本未知就退回老做法清空重拉
    func markNeedsRefresh(_ id: String, rev: Int?) {
        guard let index = chats.firstIndex(where: { $0.id == id }) else { return }
        if let partial = partialHistories[id], partial.chatRev != chatRevs[id] {
            partialHistories[id] = nil
            bodyRevs[id] = nil
            bodySegs[id] = nil
            displayOnlyIds.insert(id)
        }
        if chats[index].turnsComplete, bodyRevs[id] == nil, let rev { bodyRevs[id] = rev }
        // 首屏尾段没有版本号。清掉的话，补齐完成前界面会空
        if bodyRevs[id] == nil, !displayOnlyIds.contains(id) { chats[index].turns = [] }
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
        if id == activeId || id == chatHomeThreadChatId { ensureTurnsLoaded(id) }
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
        loadPageCounts[chatId] = nil
        guard let index = chats.firstIndex(where: { $0.id == chatId }) else { return }
        let baseIds = Set((refresh?.base ?? []).map(\.id))
        let displayBase = refresh?.displayBase == true
        // 有待回推的本地回合时，基线里服务端没有的回合也留着（可能就是本地发的、还没落盘）
        let keepLocal = localTurnsPendingSync.contains(chatId)
        // 基线前缀和补来的页是直接拼的：接缝判断错一次就会同一轮出现两遍
        var result = Turn.uniqued(server)
        var position: [String: Int] = [:]
        for (offset, turn) in result.enumerated() { position[turn.id] = offset }
        for turn in chats[index].turns {
            let live = ChatStore.isLiveTurn(turn)
            if let offset = position[turn.id] {
                if displayBase, baseIds.contains(turn.id), !live {
                    // 尾段可能是生成中途留下的半截。服务端终态为准，只把本机文件状态补回去
                    result[offset] = result[offset].mergingFiles(from: turn)
                } else if live {
                    result[offset] = turn
                } else if result[offset].deferred {
                    // deferred 是服务端当前版本的占位；只能补本机 files，不能用旧正文把占位“水合”掉。
                    result[offset] = result[offset].mergingFiles(from: turn)
                } else {
                    // turn_files 可能已合进本机，而 load_chat 页还是落盘前的副本；不能在补齐收尾时丢掉。
                    result[offset] = turn.mergingFiles(from: result[offset])
                }
            } else if live || keepLocal || !baseIds.contains(turn.id) {
                result.append(turn)
            }
        }
        if displayBase { displayOnlyIds.remove(chatId) }
        chats[index].turns = result
        mergePendingTurnFiles(chatId: chatId)
        let deferred = result.contains(where: \.deferred)
        chats[index].turnsComplete = !deferred
        if deferred, let rev = loadStartRevs[chatId] ?? chatRevs[chatId] {
            partialHistories[chatId] = PartialHistory(nextFrom: 0, chatRev: rev, loadedPages: 1)
        }
        chats[index].serverPreview = nil
        completeTurnsLoad(chatId, authoritative: !deferred)
        if deferred { rememberTail(chatId) }
    }

    /// 同一轮累计快照直接替换；跨到下一轮时把前一轮终态留在待应用队列。
    func stagePendingSnapshot(_ chatId: String, message: ServerMessage) {
        func turnId(of message: ServerMessage) -> String? {
            guard case .runSnapshot(_, let turnId, _, _, _, _, _, _, _, _, _, _, _, _, _) = message else {
                return nil
            }
            return turnId
        }
        if let previous = pendingSnapshots[chatId],
           let previousId = turnId(of: previous),
           let nextId = turnId(of: message),
           !previousId.isEmpty,
           !nextId.isEmpty,
           previousId != nextId {
            pendingSnapshotBacklog[chatId, default: []].append(previous)
        }
        pendingSnapshots[chatId] = message
    }

    /// 分页期间若运行先结束，把终态写进暂存快照，避免加载完成后又恢复成 running。
    func settlePendingSnapshot(_ chatId: String, status: String, durationMs: Double? = nil) {
        guard let pending = pendingSnapshots[chatId],
              case .runSnapshot(
                _, let turnId, _, _, let userText, let assistant, let thinking,
                let tools, let task, let runModel, let runMode, let awaitingApproval, let queued, let duration, let clipped
              ) = pending else { return }
        pendingSnapshots[chatId] = .runSnapshot(
            chatId: chatId,
            turnId: turnId,
            phase: "done",
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
            durationMs: durationMs ?? duration,
            clipped: clipped
        )
    }

    /// 正文齐了（全量分页、增量补齐、基线版本一致）之后的公共收尾。调用前已置 turnsComplete = true
    func completeTurnsLoad(_ chatId: String, authoritative: Bool = true) {
        // 基线版本相同、空会话等不经过并页路径，也必须消费先到的 turn_files。
        mergePendingTurnFiles(chatId: chatId)
        let startSegs = loadStartSegs.removeValue(forKey: chatId)
        if authoritative, let rev = loadStartRevs.removeValue(forKey: chatId) ?? chatRevs[chatId] {
            bodyRevs[chatId] = rev
            bodySegs[chatId] = [startSegs, serverSegs[chatId], bodySegs[chatId]].compactMap { $0 }.first { $0.rev == rev }
        } else {
            loadStartRevs[chatId] = nil
            bodyRevs[chatId] = nil
            bodySegs[chatId] = nil
        }
        // 加载期间发过消息：补齐时已按 keepLocal 留下本地新回合（正文由网关转录落盘，不靠回推），解除本地优先
        localTurnsPendingSync.remove(chatId)
        if let pending = pendingHistory.removeValue(forKey: chatId), !pending.isEmpty {
            applyHistory(chatId: chatId, incoming: pending)
        }
        let latestSnapshot = pendingSnapshots.removeValue(forKey: chatId)
        var snapshots = pendingSnapshotBacklog.removeValue(forKey: chatId) ?? []
        if let latestSnapshot { snapshots.append(latestSnapshot) }
        if !snapshots.isEmpty {
            snapshotHold.remove(chatId)
            var snapshotTurnId: String?
            var snapshotAssistant = ""
            for snap in snapshots {
                if case .runSnapshot(
                    _, let turnId, let phase, let status, let userText, let assistant, let thinking,
                    let tools, let task, let runModel, let runMode, let awaitingApproval, let queued, let duration, let clipped
                ) = snap {
                    snapshotTurnId = turnId
                    snapshotAssistant = assistant
                    if !clipped {
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
                    } else if phase == "done", let turnId, !turnId.isEmpty {
                        patch(chatId) { chat in
                            guard let index = chat.turns.lastIndex(where: { $0.id == turnId }) else { return chat }
                            var next = chat
                            next.turns[index] = next.turns[index].settled(
                                status: status ?? "finished",
                                durationMs: duration
                            )
                            return next
                        }
                    }
                }
            }
            let chunks = heldDeltas.removeValue(forKey: chatId) ?? []
            if !chunks.isEmpty {
                let extra = chunks.joined()
                let combined = snapshotAssistant + extra
                patch(chatId) { chat in
                    var next = chat
                    let index = snapshotTurnId.flatMap { id in
                        id.isEmpty ? nil : next.turns.lastIndex(where: { $0.id == id })
                    } ?? next.turns.lastIndex(where: \.running)
                    if let index {
                        let current = next.turns[index].assistant
                        if combined.hasPrefix(current) {
                            next.turns[index].assistant = combined
                        } else if !current.hasPrefix(combined) && !current.hasSuffix(extra) {
                            next.turns[index].assistant += extra
                        }
                    }
                    return next
                }
            }
        }
        // pending history / snapshot 可能刚创建目标回合，再消费一次。
        mergePendingTurnFiles(chatId: chatId)
        scheduleBodyCache(chatId)
        // 加载途中服务端版本又前进了（别端在写）：这份正文留作基线，当前会话立刻再补一次
        if !hasLocalPriority(chatId), let bodyRev = bodyRevs[chatId], let serverRev = chatRevs[chatId], bodyRev != serverRev {
            markNeedsRefresh(chatId, rev: bodyRev)
            if chatId == activeId || chatId == chatHomeThreadChatId { ensureTurnsLoaded(chatId) }
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
        tailTasks.removeValue(forKey: chatId)?.cancel()
        displayOnlyIds.remove(chatId)
        partialHistories[chatId] = nil
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
            guard self.coldCacheStillBoot(epoch: epoch, tenant: tenant), !self.cacheReadingIds.contains(targetId) else { return }
            self.cacheReadingIds.insert(targetId)
            // 尾段很小，先画出来。全文可能要读很多段，不能让它挡住首屏
            let tail = await ChatCache.loadTail(tenant: tenant, chatId: targetId)
            guard self.coldCacheStillBoot(epoch: epoch, tenant: tenant) else {
                self.cacheReadingIds.remove(targetId)
                return
            }
            if let tail, !self.deletedIds.contains(targetId) {
                chat.turns = tail.turns
                chat.turnsComplete = false
                self.displayOnlyIds.insert(targetId)
                if let rev = tail.chatRev, let nextFrom = tail.nextFrom, nextFrom >= 0 {
                    // 先记缓存声明的版本；stored_state 到达后 ensureTurnsLoaded 会校验，不匹配就作废重拉。
                    self.partialHistories[targetId] = PartialHistory(nextFrom: nextFrom, chatRev: rev, loadedPages: 2)
                }
            }
            var merged = rows
            if let index = merged.firstIndex(where: { $0.id == targetId }) { merged[index] = chat }
            self.cachedOnlyIds = ids
            self.chats = merged
            self.activeId = targetId
            self.cwd = chat.cwd ?? self.cwd
            self.mode = chat.mode
            let body = await ChatCache.loadBody(tenant: tenant, chatId: targetId)
            guard self.cacheEpoch == epoch, self.tenantId == tenant else {
                self.cacheReadingIds.remove(targetId)
                return
            }
            self.cacheReadingIds.remove(targetId)
            self.cacheCheckedIds.insert(targetId)
            if let body, !self.deletedIds.contains(targetId) {
                self.installCachedBody(targetId, body: body)
            }
            self.ensureTurnsLoaded(targetId) // 缓存行：只用本机正文，不发请求
        }
    }

    /// 冷启动缓存还没画上：仍停在空的 boot 占位，服务端状态也还没到
    private func coldCacheStillBoot(epoch: Int, tenant: String) -> Bool {
        cacheEpoch == epoch && tenantId == tenant && !appliedStore
            && activeId == "boot" && chats.count == 1 && chats[0].id == "boot" && chats[0].turns.isEmpty
    }

    /// iPhone 冷启动：助理会话还没从本机缓存或服务端装进来，当前停在 boot 占位上。
    /// 这时既不是空会话，也不该亮「正在加载」，对话区留白，超过一小会儿才转圈
    var coldStartPlaceholder: Bool {
        assistantOnly && activeId == "boot" && !appliedStore && assistantChatId != nil
    }

    func isHydratingTurn(_ turnId: String, chatId: String) -> Bool {
        hydratingTurnIds.contains("\(chatId)\u{0}\(turnId)")
    }

    func cancelTurnHydration(chatId: String, turnId: String) {
        turnHydrationTasks["\(chatId)\u{0}\(turnId)"]?.cancel()
    }

    /// deferred 占位按 id 原位水合。请求前后的 chatRev、响应 id 任一不一致都拒绝提交。
    func hydrateTurn(chatId: String, turnId: String) {
        let key = "\(chatId)\u{0}\(turnId)"
        guard turnHydrationTasks[key] == nil,
              turnHydrationTasks.count < ChatStore.turnHydrationLimit,
              let requestedRev = chatRevs[chatId],
              let chat = chats.first(where: { $0.id == chatId }),
              chat.turns.contains(where: { $0.id == turnId && $0.deferred }),
              let token = KeychainStore.token()?.nilIfEmpty
        else {
            if turnHydrationTasks.count >= ChatStore.turnHydrationLimit {
                flash("同时最多加载两条完整内容")
            }
            return
        }
        let epoch = cacheEpoch
        hydratingTurnIds.insert(key)
        turnHydrationTasks[key] = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.cacheEpoch == epoch {
                    self.turnHydrationTasks[key] = nil
                    self.hydratingTurnIds.remove(key)
                }
            }
            do {
                let payload = try await ChatStore.fetchTurn(
                    token: token,
                    chatId: chatId,
                    turnId: turnId
                )
                try Task.checkCancellation()
                guard self.cacheEpoch == epoch,
                      payload.chatId == chatId,
                      payload.turnId == turnId,
                      payload.chatRev == requestedRev,
                      self.chatRevs[chatId] == requestedRev,
                      var full = Turn.from(payload.turn),
                      full.id == turnId,
                      !full.deferred,
                      let index = self.chats.firstIndex(where: { $0.id == chatId }),
                      let turnIndex = self.chats[index].turns.firstIndex(where: { $0.id == turnId }),
                      self.chats[index].turns[turnIndex].deferred
                else { throw TurnHydrationError.stale }
                let placeholder = self.chats[index].turns[turnIndex]
                full.extra["deferred"] = nil
                full.extra["clipped"] = nil
                full.extra["bodyBytes"] = nil
                self.chats[index].turns[turnIndex] = full.mergingFiles(from: placeholder)
                self.mergePendingTurnFiles(chatId: chatId)
                if self.partialHistories[chatId]?.nextFrom == 0,
                   !self.chats[index].turns.contains(where: \.deferred)
                {
                    self.partialHistories[chatId] = nil
                    self.chats[index].turnsComplete = true
                    self.bodyRevs[chatId] = requestedRev
                    self.bodySegs[chatId] = self.serverSegs[chatId].flatMap {
                        $0.rev == requestedRev ? $0 : nil
                    }
                }
                self.rememberTail(chatId)
                self.scheduleBodyCache(chatId)
            } catch is CancellationError {
                return
            } catch let error as URLError where error.code == .cancelled {
                return
            } catch TurnHydrationError.stale {
                self.bannerError = "这条内容已更新，请刷新会话后再加载。"
            } catch {
                self.bannerError = "完整内容加载失败，请稍后重试。"
            }
        }
    }

    struct TurnFetchPayload {
        var chatId: String
        var turnId: String
        var chatRev: Int
        var turn: JSONValue
    }

    enum TurnHydrationError: Error { case badResponse, stale }

    nonisolated static func fetchTurn(token: String, chatId: String, turnId: String) async throws -> TurnFetchPayload {
        var request = URLRequest(url: GatewayConfig.stateTurnURL(chatId: chatId, turnId: turnId))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await AppTrafficHTTP.data(for: request, category: "会话详情下载")
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              let object = try JSONValue.parse(data).object,
              let responseChatId = object["chatId"]?.string,
              let responseTurnId = object["turnId"]?.string,
              let chatRev = object["chatRev"]?.int,
              let turn = object["turn"]
        else { throw TurnHydrationError.badResponse }
        return TurnFetchPayload(chatId: responseChatId, turnId: responseTurnId, chatRev: chatRev, turn: turn)
    }
}
