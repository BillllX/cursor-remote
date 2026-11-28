import SwiftUI
import UIKit
import ImageIO
import os

private let workbenchScrollSignposter = OSSignposter(
    subsystem: Bundle.main.bundleIdentifier ?? "Jiebo",
    category: "WorkbenchScroll"
)

extension ThreadView {
    var thread: some View {
        // 外层先量出视口宽。不锁宽的话，计划里的长行会按「不折行」的理想高度去撑滚动区，看起来到底了，下面还有一大段。
        GeometryReader { geo in
        ScrollViewReader { proxy in
            ScrollView {
                // 不用 LazyVStack：流式增高时未实现的底部锚点会让 scrollTo 落空，跟随就断。
                VStack(alignment: .leading, spacing: 18) {
                    if let chat = threadChat, chat.turns.isEmpty, chat.turnsComplete,
                       !(chatId == nil && store.coldStartPlaceholder) {
                        // 未加载完的壳（!turnsComplete）不算空会话——由下方遮罩覆盖
                        if chrome == .embedded {
                            assistantEmptyState
                        } else {
                            emptyState
                        }
                    }
                    if let chat = threadChat, !chat.turnsComplete, !chat.turns.isEmpty,
                       store.loadingChatIds.contains(chat.id), !store.refreshingChatIds.contains(chat.id) {
                        // 只在真的往前翻页时出现；显示本机缓存、增量补齐期间由导航栏的同步转圈提示
                        // 分页加载更早内容的轻提示（不抢滚动，对齐「分段加载」的可感知性）
                        HStack(spacing: 8) {
                            if earlierLoadBlockedTitle == nil {
                                ProgressView().controlSize(.small)
                            }
                            Text(earlierLoadBlockedTitle ?? "正在加载更早的内容…")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.ink2)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                    }
                    let allTurns = store.uniquedTurns(for: resolvedChatId)
                    let renderLimit = renderedTurnLimit(for: resolvedChatId, total: allTurns.count)
                    let defaultStart = max(0, allTurns.count - renderLimit)
                    let savedStart = stickToBottom ? nil : readingWindowStart.flatMap { id in
                        allTurns.firstIndex { $0.id == id }
                    }
                    let hiddenCount = min(defaultStart, savedStart ?? defaultStart)
                    let turns = Array(allTurns.dropFirst(hiddenCount))
                    let inviteTurnId = calendarInviteTurnId(turns)
                    if hiddenCount > 0 {
                        let batch = min(hiddenCount, Self.renderedTurnStep)
                        Button {
                            loadEarlierTurns(proxy: proxy, allTurns: allTurns, limit: allTurns.count - hiddenCount)
                        } label: {
                            Text(batch < hiddenCount ? "显示更早 \(batch) 轮（还有 \(hiddenCount) 轮）" : "显示更早 \(hiddenCount) 轮")
                                .font(JieboFont.text(.footnote, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background {
                            GeometryReader { geo in
                                Color.clear
                                    .onChange(of: geo.frame(in: .named("threadScroll")).minY) { _, minY in
                                        // VStack 会一次性建好子视图，不能用 onAppear；看哨兵是否进入视口顶部触发带，且每次进视口只拉一批
                                        let visible = isTopSentinelInTriggerZone(minY)
                                        guard homeActive, visible, !stickToBottom else {
                                            if !visible { scrollMetrics.earlierMemoryArmed = true }
                                            return
                                        }
                                        guard scrollMetrics.earlierMemoryArmed else { return }
                                        scrollMetrics.earlierMemoryArmed = false
                                        loadEarlierTurns(proxy: proxy, allTurns: allTurns, limit: allTurns.count - hiddenCount)
                                    }
                            }
                        }
                    }
                    if hiddenCount == 0, store.diskBodyCursors[resolvedChatId] != nil {
                        Button {
                            loadDiskEarlier(proxy: proxy, allTurns: allTurns)
                        } label: {
                            Text(store.diskPrependIds.contains(resolvedChatId) ? "正在加载更早内容…" : "加载更早内容")
                                .font(JieboFont.text(.footnote, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(store.diskPrependIds.contains(resolvedChatId))
                        .background {
                            GeometryReader { marker in
                                Color.clear
                                    .onChange(of: marker.frame(in: .named("threadScroll")).minY) { _, minY in
                                        let visible = isTopSentinelInTriggerZone(minY)
                                        guard homeActive, visible, !stickToBottom else {
                                            if !visible { scrollMetrics.earlierDiskArmed = true }
                                            return
                                        }
                                        guard scrollMetrics.earlierDiskArmed else { return }
                                        scrollMetrics.earlierDiskArmed = false
                                        loadDiskEarlier(proxy: proxy, allTurns: allTurns)
                                    }
                            }
                        }
                    } else if hiddenCount == 0,
                       let partial = store.partialHistories[resolvedChatId],
                       partial.nextFrom > 0
                    {
                        Button {
                            if store.unlocked, store.linkState == .offline {
                                store.retryConnection()
                            } else {
                                loadNetworkEarlier(proxy: proxy, allTurns: allTurns)
                            }
                        } label: {
                            Text(earlierNetworkTitle)
                                .font(JieboFont.text(.footnote, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(earlierNetworkDisabled)
                        .background {
                            GeometryReader { marker in
                                Color.clear
                                    .onChange(of: marker.frame(in: .named("threadScroll")).minY) { _, minY in
                                        let visible = isTopSentinelInTriggerZone(minY)
                                        guard homeActive, visible, !stickToBottom else {
                                            if !visible { scrollMetrics.earlierNetworkArmed = true }
                                            return
                                        }
                                        guard scrollMetrics.earlierNetworkArmed else { return }
                                        scrollMetrics.earlierNetworkArmed = false
                                        loadNetworkEarlier(proxy: proxy, allTurns: allTurns)
                                    }
                            }
                        }
                    }
                    ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                        if let gap = timeSeparator(before: turn, previous: index > 0 ? turns[index - 1] : nil) {
                            Text(gap)
                                .font(JieboFont.text(.caption, weight: .medium))
                                .foregroundStyle(JieboColor.dim)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 4)
                                .accessibilityAddTraits(.isHeader)
                        }
                        pinnedTurn(
                            turn,
                            index: index,
                            turns: turns,
                            inviteTurnId: inviteTurnId,
                            proxy: proxy
                        )
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("thread-end")
                }
                .padding(.horizontal, chrome == .embedded ? 16 : 24)
                .padding(.top, 12)
                .padding(.bottom, 28)
                .frame(width: geo.size.width, alignment: .topLeading)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.automatic, for: .vertical)
            .coordinateSpace(name: "threadScroll")
            // 可视高度 = 这一层 GeometryReader 的高度减去 bottom safe area。
            // safeAreaInset 挂在这一层外面，输入框算进 inset，这里不要再减一次。
            .onAppear {
                let height = geo.size.height - geo.safeAreaInsets.bottom
                viewportHeight = height
                guard stickToBottom, height > 1, pinnedMinHeight <= 1, let id = threadChat?.turns.last?.id else { return }
                pinToTurn(id, proxy: proxy, height: height)
            }
            .onChange(of: geo.size.height - geo.safeAreaInsets.bottom) { _, h in viewportHeight = h }
            .overlay(alignment: .bottom) {
                Group {
                    if !stickToBottom {
                        Button {
                            stickToBottom = true
                            readingWindowStart = nil
                            if let last = threadChat?.turns.last?.id, last != pinnedTurnId {
                                pinToTurn(last, proxy: proxy, height: viewportHeight)
                            } else {
                                revealLatest(proxy, animated: true)
                            }
                        } label: {
                            ZStack(alignment: .topTrailing) {
                                Image(systemName: "arrow.down")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(JieboColor.ink)
                                    .frame(width: 44, height: 44)
                                    .jieboGlass(in: Circle(), interactive: true)
                                if threadChat?.turns.last?.running == true {
                                    Circle()
                                        .fill(JieboColor.run)
                                        .frame(width: 9, height: 9)
                                        .offset(x: 1, y: 1)
                                }
                            }
                            .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(threadChat?.turns.last?.running == true ? "有新内容正在生成" : "")
                        .padding(.bottom, 10)
                        .transition(.jieboPanel(from: .bottom, reduceMotion: reduceMotion).combined(with: .opacity))
                        .accessibilityLabel("滚动到最新消息")
                    }
                }
                .animation(JieboMotion.fade(reduceMotion), value: stickToBottom)
            }
            .overlay {
                // P8 slim：会话内容分页加载遮罩（只盖住对话区，侧栏/输入框可操作）
                Group {
                    if loadingVisible {
                        VStack(spacing: 12) {
                            ProgressView().controlSize(.large)
                            Text(chrome == .embedded ? "正在打开" : "正在加载会话…")
                                .font(JieboFont.text(.footnote, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(JieboColor.paper.opacity(0.92))
                        .transition(.opacity)
                    }
                }
                .animation(JieboMotion.fade(reduceMotion), value: loadingVisible)
            }
            .task(id: showThreadLoading) {
                // 本机缓存通常几十毫秒就读完：等一小会儿再盖遮罩，免得冷启动先闪一下。
                // 助理页的空壳本身就是空白，立刻写「正在打开」。
                guard showThreadLoading else {
                    loadingVisible = false
                    return
                }
                if chrome == .embedded {
                    loadingVisible = true
                    return
                }
                try? await Task.sleep(for: .milliseconds(350))
                if !Task.isCancelled, showThreadLoading { loadingVisible = true }
            }
            .modifier(StartAtBottom())
            .modifier(EmbeddedScrollPhase(enabled: true) {
                releaseFollow(userGesture: true)
            })
            .modifier(UnstickDrag(embedded: true) {
                releaseFollow(userGesture: true)
            })
            .onChange(of: threadChat?.turns.count) { _, _ in
                guard homeActive, scenePhase == .active else { return }
                if let anchor = earlierNetworkAnchorId {
                    restoreEarlierNetworkAnchor(anchor, proxy: proxy)
                    return
                }
                guard stickToBottom, let id = threadChat?.turns.last?.id, id != pinnedTurnId else { return }
                pinToTurn(id, proxy: proxy, height: viewportHeight)
            }
            .onChange(of: store.loadingChatIds.contains(resolvedChatId)) { _, loading in
                if !loading, earlierNetworkAnchorId != nil { earlierNetworkAnchorId = nil }
            }
            .background {
                ThreadStreamScrollObserver(box: store.activeTurnBox(for: resolvedChatId)) {
                    guard homeActive, scenePhase == .active, pinExceeded, stickToBottom else { return }
                    scheduleStreamScroll(proxy)
                }
            }
            .onChange(of: threadChat?.turns.last?.running) { _, running in
                // 流式时不追；停更后代码和表格还会长高，超出钉顶才再贴一次底
                guard homeActive, running == false, pinExceeded, stickToBottom else { return }
                scheduleStreamScroll(proxy)
            }
            .onChange(of: viewportHeight) { _, newHeight in
                guard stickToBottom, newHeight > 1 else { return }
                if pinnedTurnId != nil, pinnedMinHeight <= 1 {
                    pinnedMinHeight = newHeight
                    if let id = pinnedTurnId {
                        pinToTurn(id, proxy: proxy, height: newHeight)
                    }
                } else if pinnedTurnId != nil, newHeight > pinnedMinHeight {
                    pinnedMinHeight = newHeight
                }
            }
            .onChange(of: homeActive && scenePhase == .active) { _, active in
                if !active {
                    scrollMetrics.lastActiveTurnId = threadChat?.turns.last?.id
                    scrollMetrics.lastActiveLiveTail = store.liveTailRevision(for: resolvedChatId)
                    scrollMetrics.lastActiveHeightRevision = scrollMetrics.pinHeightRevision
                    scrollMetrics.lastActiveViewportHeight = viewportHeight
                    cancelStreamScroll()
                    return
                }
                guard active, stickToBottom,
                      let last = threadChat?.turns.last?.id, viewportHeight > 1 else { return }
                // 仅在真正新增了轮次、或后台期间末轮正文/视口尺寸发生变化时补滚；静止会话切回前台零程序滚动。
                if last != pinnedTurnId {
                    pinToTurn(last, proxy: proxy, height: viewportHeight)
                } else if pinExceeded {
                    let tailChanged = last != scrollMetrics.lastActiveTurnId
                        || store.liveTailRevision(for: resolvedChatId) != scrollMetrics.lastActiveLiveTail
                        || scrollMetrics.pinHeightRevision != scrollMetrics.lastActiveHeightRevision
                        || abs(viewportHeight - scrollMetrics.lastActiveViewportHeight) > 0.5
                        || threadChat?.turns.last?.running == true
                    if tailChanged {
                        scheduleStreamScroll(proxy)
                    }
                }
            }
            .onChange(of: resolvedChatId) { _, id in
                // 切会话把最后一轮顶对齐，避免把钉顶留白滚进视口。
                cancelStreamScroll()
                scrollMetrics.followTask?.cancel()
                scrollMetrics.resetForChatSwitch()
                loadingEarlierBatch = false
                earlierNetworkAnchorId = nil
                readingWindowStart = nil
                stickToBottom = true
                motionChatId = id
                if let last = threadChat?.turns.last?.id, viewportHeight > 1 {
                    pinToTurn(last, proxy: proxy, height: viewportHeight)
                } else {
                    pinnedTurnId = threadChat?.turns.last?.id
                    pinExceeded = false
                }
            }
            .onAppear {
                guard motionChatId != resolvedChatId else { return }
                motionChatId = resolvedChatId
                stickToBottom = true
                if let last = threadChat?.turns.last?.id, viewportHeight > 1 {
                    pinToTurn(last, proxy: proxy, height: viewportHeight)
                } else {
                    pinnedTurnId = threadChat?.turns.last?.id
                    pinExceeded = false
                }
            }
        }
        }
    }

    func renderedTurnLimit(for chatId: String, total: Int) -> Int {
        let stored = renderedTurnLimitByChat[chatId] ?? Self.initialRenderedTurns
        return min(total, max(Self.initialRenderedTurns, stored))
    }

    /// 最小高度加在内容列外面，背景里的 GeometryReader 量到的是内容高度，不是撑开后的外框。
    @ViewBuilder
    func pinnedTurn(_ turn: Turn, index: Int, turns: [Turn], inviteTurnId: String?, proxy: ScrollViewProxy) -> some View {
        let pinned = pinnedTurnId == turn.id
        let isFirst = index == 0
        TurnView(
            turn: turn,
            canAnswer: index == turns.count - 1 && !turn.running && !turn.queued,
            embedded: chrome == .embedded,
            isLastAssistant: turn.id == turns.last?.id,
            canRestorePrompt: turn.id == turns.last?.id
                && !turn.running
                && !turn.queued
                && !(turn.error ?? "").isEmpty
                && {
                    let trimmed = turn.user.trimmingCharacters(in: .whitespacesAndNewlines)
                    return !trimmed.isEmpty && trimmed != "（附图）"
                }(),
            waitingForLink: turn.running
                && turn.assistant.isEmpty
                && turn.thinking.isEmpty
                && turn.tools.isEmpty
                && turn.pendingTool == nil
                && !store.connected
                && !store.runningChatIds.contains(resolvedChatId),
            reviewMark: store.localTurnReviews[turn.id],
            restoring: store.restoringTurnIds.contains(turn.id),
            captured: TodoReceipt.captured(in: turn, todos: store.assistantState?.todos),
            calendarInvite: turn.id == inviteTurnId ? store.assistantState?.calendar : nil
        )
        .equatable()
        .background {
            if pinned || isFirst {
                GeometryReader { geo in
                    Color.clear
                        .onAppear {
                            let minY = geo.frame(in: .named("threadScroll")).minY
                            if isFirst {
                                scrollMetrics.firstTurnId = turn.id
                                scrollMetrics.firstTurnMinY = minY
                            }
                            if pinned {
                                notePinContentHeight(geo.size.height, proxy: proxy)
                                notePinnedMinY(minY)
                            }
                        }
                        .onChange(of: geo.size.height) { _, height in
                            if pinned { notePinContentHeight(height, proxy: proxy) }
                        }
                        .onChange(of: geo.frame(in: .named("threadScroll")).minY) { _, y in
                            if isFirst {
                                scrollMetrics.firstTurnId = turn.id
                                scrollMetrics.firstTurnMinY = y
                            }
                            if pinned { notePinnedMinY(y) }
                        }
                }
            }
        }
        .overlay(alignment: .top) {
            Color.clear
                .frame(height: 1)
                .id("turn-top-\(turn.id)")
        }
        .frame(minHeight: pinned ? pinnedMinHeight : 0, alignment: .top)
        .id(turn.id)
        .transition(.opacity.combined(with: .offset(y: 10)))
    }

    /// 顶部哨兵仅在进入视口上沿触发带时自动拉页，避免短对话在屏幕下半区就误触发连续分页。
    func isTopSentinelInTriggerZone(_ minY: CGFloat) -> Bool {
        let upper = viewportHeight > 1 ? min(120, max(64, viewportHeight * 0.28)) : 96
        return minY >= -12 && minY < upper
    }

    /// 把这一轮顶对齐到可视区上方。height 还没量到时只记下 id，等 viewportHeight 再滚。
    func pinToTurn(_ id: String, proxy: ScrollViewProxy, height: CGFloat) {
        cancelStreamScroll()
        pinnedTurnId = id
        pinExceeded = false
        scrollMetrics.pinnedContentHeight = 0
        scrollMetrics.pinRecaptureBaseline = false
        scrollMetrics.pinBaselineMinY = nil
        scrollMetrics.pinBaselineReady = false
        stickToBottom = true
        guard height > 1 else { return }
        pinnedMinHeight = height
        armScrollGuard()
        scrollMetrics.followTask?.cancel()
        scrollMetrics.followTask = Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled, pinnedTurnId == id else { return }
            scrollWithoutAnimation(proxy, id: id, anchor: .top)
            try? await Task.sleep(for: .milliseconds(50))
            guard !Task.isCancelled, pinnedTurnId == id else { return }
            scrollMetrics.pinBaselineMinY = scrollMetrics.pinnedTurnMinY
            scrollMetrics.pinBaselineReady = true
        }
    }

    func revealLatest(_ proxy: ScrollViewProxy, animated: Bool) {
        cancelStreamScroll()
        armScrollGuard()
        let scroll = {
            if pinExceeded {
                proxy.scrollTo("thread-end", anchor: .bottom)
            } else if let id = pinnedTurnId {
                proxy.scrollTo(id, anchor: .top)
            }
        }
        if animated {
            withAnimation(JieboMotion.standard(reduceMotion)) { scroll() }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { scroll() }
        }
        scrollMetrics.followTask?.cancel()
        scrollMetrics.followTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled else { return }
            scrollMetrics.pinBaselineMinY = scrollMetrics.pinnedTurnMinY
            scrollMetrics.pinBaselineReady = true
        }
    }

    /// 超出钉顶之后才贴底。贴底后的下一次 minY 当作新基线，上滑 24pt 就能松开。
    func scrollToEndNow(_ proxy: ScrollViewProxy) {
        guard stickToBottom else { return }
        workbenchScrollSignposter.emitEvent("Scroll to end")
        scrollMetrics.pinRecaptureBaseline = true
        scrollWithoutAnimation(proxy, id: "thread-end", anchor: .bottom)
    }

    func scheduleStreamScroll(_ proxy: ScrollViewProxy) {
        guard scrollMetrics.streamScrollTask == nil else { return }
        scrollMetrics.streamScrollGeneration &+= 1
        let generation = scrollMetrics.streamScrollGeneration
        scrollMetrics.streamScrollTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(16))
            guard !Task.isCancelled, generation == scrollMetrics.streamScrollGeneration else { return }
            scrollMetrics.streamScrollTask = nil
            guard homeActive, scenePhase == .active, pinExceeded, stickToBottom else { return }
            scrollToEndNow(proxy)
        }
    }

    func cancelStreamScroll() {
        scrollMetrics.streamScrollGeneration &+= 1
        scrollMetrics.streamScrollTask?.cancel()
        scrollMetrics.streamScrollTask = nil
    }

    func scrollWithoutAnimation(_ proxy: ScrollViewProxy, id: String, anchor: UnitPoint) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            proxy.scrollTo(id, anchor: anchor)
        }
    }

    func armScrollGuard() {
        scrollMetrics.pinScrollGuardUntil = Date().addingTimeInterval(0.32)
    }

    func releaseFollow(userGesture: Bool = false) {
        guard stickToBottom, userGesture || Date() >= scrollMetrics.pinScrollGuardUntil else { return }
        let turns = store.uniquedTurns(for: resolvedChatId)
        readingWindowStart = turns.suffix(renderedTurnLimit(for: resolvedChatId, total: turns.count)).first?.id
        cancelStreamScroll()
        scrollMetrics.followTask?.cancel()
        stickToBottom = false
    }

    func notePinContentHeight(_ height: CGFloat, proxy: ScrollViewProxy) {
        guard pinnedMinHeight > 1 else { return }
        let grew = height > scrollMetrics.pinnedContentHeight + 0.5
        scrollMetrics.pinnedContentHeight = height
        let exceededNow = height > pinnedMinHeight + 0.5
        if exceededNow && !pinExceeded {
            pinExceeded = true
        }
        if grew {
            scrollMetrics.pinHeightRevision &+= 1
            if homeActive, scenePhase == .active, (pinExceeded || exceededNow), stickToBottom {
                scheduleStreamScroll(proxy)
            }
        }
    }

    /// iOS 17 没有滚动相位。基线是最近一次定位后的位置：钉顶时在轮顶，贴底后改到贴底位置。
    func notePinnedMinY(_ y: CGFloat) {
        scrollMetrics.pinnedTurnMinY = y
        guard Date() >= scrollMetrics.pinScrollGuardUntil else { return }
        if scrollMetrics.pinRecaptureBaseline {
            scrollMetrics.pinBaselineMinY = y
            scrollMetrics.pinRecaptureBaseline = false
            scrollMetrics.pinBaselineReady = true
            return
        }
        guard scrollMetrics.pinBaselineReady else { return }
        if scrollMetrics.pinBaselineMinY == nil {
            scrollMetrics.pinBaselineMinY = y
            return
        }
        if let baseline = scrollMetrics.pinBaselineMinY, y > baseline + 24 {
            releaseFollow()
        }
    }

    /// 按 1pt 顶锚恢复某轮在视口中的原相对偏移，消除直接贴 .top 带来的 60~100pt 跳动。
    func scrollToTurnTop(_ proxy: ScrollViewProxy, turnId: String, targetMinY: CGFloat) {
        let span = max(1, viewportHeight - 1)
        let clamped = min(max(targetMinY, 0), span)
        let unitY = viewportHeight > 1 ? clamped / span : 0
        scrollWithoutAnimation(proxy, id: "turn-top-\(turnId)", anchor: UnitPoint(x: 0.5, y: unitY))
    }

    /// 在列表顶部 prepend 更早轮次后，按原视口偏移锚定原先最上面那一轮，避免整页跳动
    func loadEarlierTurns(proxy: ScrollViewProxy, allTurns: [Turn], limit: Int) {
        guard !loadingEarlierBatch else { return }
        let hidden = allTurns.count - limit
        guard hidden > 0 else { return }
        loadingEarlierBatch = true
        let anchorId = Array(allTurns.suffix(limit)).first?.id
        let savedMinY = (anchorId != nil && scrollMetrics.firstTurnId == anchorId) ? scrollMetrics.firstTurnMinY : 0
        let next = min(allTurns.count, limit + Self.renderedTurnStep)
        renderedTurnLimitByChat[resolvedChatId] = next
        if !stickToBottom { readingWindowStart = allTurns.suffix(next).first?.id }
        cancelStreamScroll()
        scrollMetrics.followTask?.cancel()
        scrollMetrics.followTask = Task { @MainActor in
            defer { loadingEarlierBatch = false }
            guard let anchorId else { return }
            await Task.yield()
            guard !Task.isCancelled else { return }
            scrollToTurnTop(proxy, turnId: anchorId, targetMinY: savedMinY)
        }
    }

    /// 内存里的尾部已经露完，再从磁盘往前读一页。不把半截标成全文。
    func loadDiskEarlier(proxy: ScrollViewProxy, allTurns: [Turn]) {
        let targetChatId = resolvedChatId
        guard !loadingEarlierBatch,
              store.diskBodyCursors[targetChatId] != nil,
              !store.diskPrependIds.contains(targetChatId)
        else { return }
        let anchor = allTurns.first?.id
        let savedMinY = (anchor != nil && scrollMetrics.firstTurnId == anchor) ? scrollMetrics.firstTurnMinY : 0
        let previous = allTurns.count
        loadingEarlierBatch = true
        Task { @MainActor in
            let added = await store.prependCachedTurns(targetChatId)
            guard resolvedChatId == targetChatId else {
                loadingEarlierBatch = false
                return
            }
            guard added else {
                loadingEarlierBatch = false
                return
            }
            let total = store.uniquedTurns(for: targetChatId).count
            renderedTurnLimitByChat[targetChatId] = min(total, previous + Self.renderedTurnStep)
            loadingEarlierBatch = false
            guard let anchor else { return }
            scrollMetrics.earlierAnchorMinY = savedMinY
            earlierNetworkAnchorId = anchor
            restoreEarlierNetworkAnchor(anchor, proxy: proxy)
        }
    }

    func loadNetworkEarlier(proxy: ScrollViewProxy, allTurns: [Turn]) {
        guard earlierNetworkAnchorId == nil,
              !store.loadingChatIds.contains(resolvedChatId),
              let anchor = allTurns.first?.id
        else { return }
        scrollMetrics.earlierAnchorMinY = (scrollMetrics.firstTurnId == anchor) ? scrollMetrics.firstTurnMinY : 0
        earlierNetworkAnchorId = anchor
        store.loadPreviousHistory(resolvedChatId)
        if !store.loadingChatIds.contains(resolvedChatId) {
            earlierNetworkAnchorId = nil
            scrollMetrics.earlierAnchorMinY = 0
        }
    }

    func restoreEarlierNetworkAnchor(_ anchor: String, proxy: ScrollViewProxy) {
        let savedMinY = scrollMetrics.earlierAnchorMinY
        cancelStreamScroll()
        scrollMetrics.followTask?.cancel()
        scrollMetrics.followTask = Task { @MainActor in
            defer {
                earlierNetworkAnchorId = nil
                scrollMetrics.earlierAnchorMinY = 0
            }
            await Task.yield()
            guard !Task.isCancelled else { return }
            scrollToTurnTop(proxy, turnId: anchor, targetMinY: savedMinY)
        }
    }
}

/// 隔离流式贴底监听子视图：只订阅单会话 ActiveTurnBox.streamRevision，不触发外层 ThreadView 重算。
private struct ThreadStreamScrollObserver: View {
    let box: ActiveTurnBox
    let onStreamChange: () -> Void

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .onChange(of: box.streamRevision) { _, _ in
                onStreamChange()
            }
    }
}

/// 打开会话时直接停在底部，不先从顶上画一帧再跳下去。
/// 只管初始位置：不带 for: 的 defaultScrollAnchor 还会在内容变高时贴底。
/// 不要加 .sizeChanges，否则钉顶会被系统重新贴到底部。
private struct StartAtBottom: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.defaultScrollAnchor(.bottom, for: .initialOffset)
        } else {
            content
        }
    }
}

/// iOS 17 没有滚动相位，手指下拖超过 16pt 就松开跟随。
/// iOS 18 起改看相位，不再叠这层手势。iPhone 和 iPad 同一套。
private struct UnstickDrag: ViewModifier {
    var embedded: Bool
    var onRelease: () -> Void

    @ViewBuilder
    func body(content: Content) -> some View {
        if embedded {
            if #available(iOS 18.0, *) {
                content
            } else {
                content.simultaneousGesture(drag)
            }
        } else {
            content.simultaneousGesture(drag)
        }
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 12).onChanged { value in
            guard value.translation.height > 16 else { return }
            onRelease()
        }
    }
}

/// iOS 18+：用户拖动、跟踪、减速时松开跟随。程序滚动后的短窗口由调用方挡住。
private struct EmbeddedScrollPhase: ViewModifier {
    var enabled: Bool
    var onUserScroll: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), enabled {
            content.onScrollPhaseChange { _, phase in
                switch phase {
                case .interacting, .tracking, .decelerating:
                    onUserScroll()
                default:
                    break
                }
            }
        } else {
            content
        }
    }
}
