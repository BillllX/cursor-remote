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
                    let windowRange = resolvedWindowRange(for: resolvedChatId, allTurns: allTurns)
                    let hiddenCount = windowRange.lowerBound
                    let hiddenAfterCount = max(0, allTurns.count - windowRange.upperBound)
                    let turns = Array(allTurns[windowRange])
                    let lastTurnId = allTurns.last?.id
                    let inviteTurnId = calendarInviteTurnId(turns)
                    if hiddenCount > 0 {
                        let batch = min(hiddenCount, Self.renderedTurnStep)
                        Button {
                            loadEarlierTurns(proxy: proxy, allTurns: allTurns, windowRange: windowRange)
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
                                        loadEarlierTurns(proxy: proxy, allTurns: allTurns, windowRange: windowRange)
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
                            lastTurnId: lastTurnId,
                            inviteTurnId: inviteTurnId,
                            proxy: proxy
                        )
                    }
                    if hiddenAfterCount > 0 {
                        let batch = min(hiddenAfterCount, Self.renderedTurnStep)
                        Button {
                            loadNewerTurns(proxy: proxy, allTurns: allTurns, windowRange: windowRange)
                        } label: {
                            Text(batch < hiddenAfterCount ? "显示较新 \(batch) 轮（还有 \(hiddenAfterCount) 轮）" : "显示较新 \(hiddenAfterCount) 轮")
                                .font(JieboFont.text(.footnote, weight: .medium))
                                .foregroundStyle(JieboColor.ink2)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background {
                            GeometryReader { marker in
                                Color.clear
                                    .onChange(of: marker.frame(in: .named("threadScroll")).minY) { _, minY in
                                        let visible = isBottomSentinelInTriggerZone(minY)
                                        guard homeActive, visible, !stickToBottom else {
                                            if !visible { scrollMetrics.newerMemoryArmed = true }
                                            return
                                        }
                                        guard scrollMetrics.newerMemoryArmed else { return }
                                        scrollMetrics.newerMemoryArmed = false
                                        loadNewerTurns(proxy: proxy, allTurns: allTurns, windowRange: windowRange)
                                    }
                            }
                        }
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
                            let windowChanged = (renderWindowByChat[resolvedChatId] ?? TurnRenderWindow()) != TurnRenderWindow()
                            cancelStreamScroll()
                            armScrollGuard()
                            scrollMetrics.pinBaselineReady = false
                            renderWindowByChat[resolvedChatId] = TurnRenderWindow()
                            scrollMetrics.earlierMemoryArmed = true
                            scrollMetrics.newerMemoryArmed = true
                            scrollMetrics.earlierDiskArmed = true
                            scrollMetrics.earlierNetworkArmed = true
                            stickToBottom = true
                            if let last = threadChat?.turns.last?.id, last != pinnedTurnId {
                                pinToTurn(last, proxy: proxy, height: viewportHeight)
                            } else if windowChanged {
                                // 窗口曾收缩/脱离尾部：先保活守卫并等一帧尾窗重新挂载，再定位到最新
                                scrollMetrics.followTask?.cancel()
                                scrollMetrics.followTask = Task { @MainActor in
                                    await Task.yield()
                                    guard !Task.isCancelled, stickToBottom else { return }
                                    revealLatest(proxy, animated: true)
                                }
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
            .onChange(of: threadChat?.turns.first?.id) { _, firstId in
                guard homeActive, scenePhase == .active,
                      let anchor = earlierNetworkAnchorId,
                      let firstId, firstId != anchor
                else { return }
                restoreEarlierNetworkAnchor(anchor, proxy: proxy)
            }
            .onChange(of: threadChat?.turns.count) { _, _ in
                guard homeActive, scenePhase == .active else { return }
                guard earlierNetworkAnchorId == nil else { return }
                guard stickToBottom, let id = threadChat?.turns.last?.id, id != pinnedTurnId else { return }
                pinToTurn(id, proxy: proxy, height: viewportHeight)
            }
            .onChange(of: store.loadingChatIds.contains(resolvedChatId)) { _, loading in
                guard !loading, let anchor = earlierNetworkAnchorId else { return }
                if let firstId = threadChat?.turns.first?.id, firstId != anchor, homeActive, scenePhase == .active {
                    restoreEarlierNetworkAnchor(anchor, proxy: proxy)
                } else {
                    earlierNetworkAnchorId = nil
                    scrollMetrics.earlierAnchorMinY = 0
                }
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
                renderWindowByChat[id] = TurnRenderWindow()
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

    func resolvedWindowRange(for chatId: String, allTurns: [Turn]) -> Range<Int> {
        guard !allTurns.isEmpty else { return 0..<0 }
        let window = renderWindowByChat[chatId] ?? TurnRenderWindow()
        let clampedTail = min(Self.maxRenderedTurns, max(Self.initialRenderedTurns, window.tailLimit))
        if stickToBottom {
            let start = max(0, allTurns.count - clampedTail)
            return start..<allTurns.count
        }
        if let endId = window.endTurnId,
           let endIdx = allTurns.firstIndex(where: { $0.id == endId }) {
            let end = endIdx + 1
            let start: Int
            if let startId = window.startTurnId,
               let startIdx = allTurns.firstIndex(where: { $0.id == startId }),
               startIdx < end {
                start = max(startIdx, end - Self.maxRenderedTurns)
            } else {
                start = max(0, end - Self.maxRenderedTurns)
            }
            return start..<end
        }
        let defaultStart = max(0, allTurns.count - clampedTail)
        let savedStart = window.startTurnId.flatMap { id in
            allTurns.firstIndex { $0.id == id }
        }
        let start = min(defaultStart, savedStart ?? defaultStart)
        let end = min(allTurns.count, start + Self.maxRenderedTurns)
        return start..<end
    }

    /// 最小高度加在内容列外面，背景里的 GeometryReader 量到的是内容高度，不是撑开后的外框。
    @ViewBuilder
    func pinnedTurn(
        _ turn: Turn,
        index: Int,
        turns: [Turn],
        lastTurnId: String?,
        inviteTurnId: String?,
        proxy: ScrollViewProxy
    ) -> some View {
        let pinned = pinnedTurnId == turn.id
        let isFirst = index == 0
        let isLast = index == turns.count - 1
        let isGlobalLast = turn.id == lastTurnId
        TurnView(
            turn: turn,
            canAnswer: isGlobalLast && !turn.running && !turn.queued,
            embedded: chrome == .embedded,
            isLastAssistant: isGlobalLast,
            canRestorePrompt: isGlobalLast
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
            if pinned || isFirst || isLast {
                GeometryReader { geo in
                    Color.clear
                        .onAppear {
                            let frame = geo.frame(in: .named("threadScroll"))
                            if isFirst {
                                scrollMetrics.firstTurnId = turn.id
                                scrollMetrics.firstTurnMinY = frame.minY
                            }
                            if isLast {
                                scrollMetrics.lastTurnId = turn.id
                                scrollMetrics.lastTurnMaxY = frame.maxY
                            }
                            if pinned {
                                notePinContentHeight(geo.size.height, proxy: proxy)
                                notePinnedMinY(frame.minY)
                            }
                        }
                        .onChange(of: geo.size.height) { _, height in
                            if pinned { notePinContentHeight(height, proxy: proxy) }
                        }
                        .onChange(of: geo.frame(in: .named("threadScroll"))) { _, frame in
                            if isFirst {
                                scrollMetrics.firstTurnId = turn.id
                                scrollMetrics.firstTurnMinY = frame.minY
                            }
                            if isLast {
                                scrollMetrics.lastTurnId = turn.id
                                scrollMetrics.lastTurnMaxY = frame.maxY
                            }
                            if pinned { notePinnedMinY(frame.minY) }
                        }
                }
            }
        }
        .overlay(alignment: .top) {
            Color.clear
                .frame(height: 1)
                .id("turn-top-\(turn.id)")
        }
        .overlay(alignment: .bottom) {
            Color.clear
                .frame(height: 1)
                .id("turn-bottom-\(turn.id)")
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

    /// 底部哨兵进入视口底沿（含 VStack 18pt 间距）时自动向下滑窗并回收离屏顶部轮次。
    /// 保证触发瞬间末轮底边 lastTurnMaxY = minY - 18 <= viewportHeight，避免底锚被夹紧导致跳动。
    func isBottomSentinelInTriggerZone(_ minY: CGFloat) -> Bool {
        guard viewportHeight > 1 else { return false }
        return minY > 0 && minY <= viewportHeight + 18
    }

    /// 把这一轮顶对齐到可视区上方。height 还没量到时只记下 id，等 viewportHeight 再滚。
    func pinToTurn(_ id: String, proxy: ScrollViewProxy, height: CGFloat) {
        cancelStreamScroll()
        // 新发或回到最新钉顶时收敛回默认尾窗，立即释放之前上翻展开的历史视图并重装哨兵
        if renderWindowByChat[resolvedChatId] != TurnRenderWindow() {
            renderWindowByChat[resolvedChatId] = TurnRenderWindow()
        }
        scrollMetrics.earlierMemoryArmed = true
        scrollMetrics.newerMemoryArmed = true
        scrollMetrics.earlierDiskArmed = true
        scrollMetrics.earlierNetworkArmed = true
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
        let range = resolvedWindowRange(for: resolvedChatId, allTurns: turns)
        if !range.isEmpty {
            var window = renderWindowByChat[resolvedChatId] ?? TurnRenderWindow()
            if window.startTurnId == nil {
                window.startTurnId = turns[range.lowerBound].id
                renderWindowByChat[resolvedChatId] = window
            }
        }
        cancelStreamScroll()
        scrollMetrics.followTask?.cancel()
        scrollMetrics.pinBaselineReady = false
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

    /// 按 1pt 底锚恢复某轮底边在视口中的原相对偏移，供向下滑窗回收顶部旧轮时零跳动复锚。
    func scrollToTurnBottom(_ proxy: ScrollViewProxy, turnId: String, targetMaxY: CGFloat) {
        let span = max(1, viewportHeight - 1)
        let clamped = min(max(targetMaxY - 1, 0), span)
        let unitY = viewportHeight > 1 ? clamped / span : 1
        scrollWithoutAnimation(proxy, id: "turn-bottom-\(turnId)", anchor: UnitPoint(x: 0.5, y: unitY))
    }

    /// 在列表顶部 prepend 更早轮次并按 maxRenderedTurns 回收离屏尾部，按原视口偏移锚定原先最上面那一轮，避免整页跳动
    func loadEarlierTurns(proxy: ScrollViewProxy, allTurns: [Turn], windowRange: Range<Int>) {
        guard !loadingEarlierBatch, windowRange.lowerBound > 0 else { return }
        loadingEarlierBatch = true
        let anchorId = allTurns[windowRange.lowerBound].id
        let savedMinY = (scrollMetrics.firstTurnId == anchorId) ? scrollMetrics.firstTurnMinY : 0
        let nextStart = max(0, windowRange.lowerBound - Self.renderedTurnStep)
        let nextEnd = min(allTurns.count, min(windowRange.upperBound, nextStart + Self.maxRenderedTurns))
        renderWindowByChat[resolvedChatId] = TurnRenderWindow(
            startTurnId: allTurns[nextStart].id,
            endTurnId: nextEnd < allTurns.count ? allTurns[nextEnd - 1].id : nil,
            tailLimit: min(Self.maxRenderedTurns, max(Self.initialRenderedTurns, nextEnd - nextStart))
        )
        scrollMetrics.newerMemoryArmed = true
        if nextStart == 0 {
            scrollMetrics.earlierMemoryArmed = true
        }
        cancelStreamScroll()
        scrollMetrics.followTask?.cancel()
        scrollMetrics.followTask = Task { @MainActor in
            defer { loadingEarlierBatch = false }
            await Task.yield()
            guard !Task.isCancelled else { return }
            scrollToTurnTop(proxy, turnId: anchorId, targetMinY: savedMinY)
        }
    }

    /// 向下滑回较新轮次并按 maxRenderedTurns 回收离屏顶部，以原窗口末轮底边原位复锚，消除顶部回收跳动
    func loadNewerTurns(proxy: ScrollViewProxy, allTurns: [Turn], windowRange: Range<Int>) {
        guard !loadingEarlierBatch, windowRange.upperBound < allTurns.count, windowRange.upperBound > 0 else { return }
        loadingEarlierBatch = true
        let anchorId = allTurns[windowRange.upperBound - 1].id
        let savedMaxY = (scrollMetrics.lastTurnId == anchorId) ? scrollMetrics.lastTurnMaxY : viewportHeight
        let nextEnd = min(allTurns.count, windowRange.upperBound + Self.renderedTurnStep)
        let nextStart = max(0, max(windowRange.lowerBound, nextEnd - Self.maxRenderedTurns))
        renderWindowByChat[resolvedChatId] = TurnRenderWindow(
            startTurnId: allTurns[nextStart].id,
            endTurnId: nextEnd < allTurns.count ? allTurns[nextEnd - 1].id : nil,
            tailLimit: min(Self.maxRenderedTurns, max(Self.initialRenderedTurns, nextEnd - nextStart))
        )
        scrollMetrics.earlierMemoryArmed = true
        if nextEnd >= allTurns.count {
            scrollMetrics.newerMemoryArmed = true
        }
        cancelStreamScroll()
        scrollMetrics.followTask?.cancel()
        scrollMetrics.followTask = Task { @MainActor in
            defer { loadingEarlierBatch = false }
            await Task.yield()
            guard !Task.isCancelled else { return }
            scrollToTurnBottom(proxy, turnId: anchorId, targetMaxY: savedMaxY)
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
        loadingEarlierBatch = true
        Task { @MainActor in
            let added = await store.prependCachedTurns(targetChatId)
            guard resolvedChatId == targetChatId else {
                // 已切会话：onChange(of: resolvedChatId) 已复位锁，不能误清新会话正在拉取的状态
                return
            }
            guard added else {
                loadingEarlierBatch = false
                return
            }
            let updatedTurns = store.uniquedTurns(for: targetChatId)
            if let anchor, let anchorIdx = updatedTurns.firstIndex(where: { $0.id == anchor }) {
                let nextStart = max(0, anchorIdx - Self.renderedTurnStep)
                let nextEnd = min(updatedTurns.count, nextStart + Self.maxRenderedTurns)
                renderWindowByChat[targetChatId] = TurnRenderWindow(
                    startTurnId: updatedTurns[nextStart].id,
                    endTurnId: nextEnd < updatedTurns.count ? updatedTurns[nextEnd - 1].id : nil,
                    tailLimit: min(Self.maxRenderedTurns, max(Self.initialRenderedTurns, nextEnd - nextStart))
                )
            }
            scrollMetrics.earlierMemoryArmed = true
            scrollMetrics.newerMemoryArmed = true
            scrollMetrics.earlierDiskArmed = true
            cancelStreamScroll()
            scrollMetrics.followTask?.cancel()
            scrollMetrics.followTask = Task { @MainActor in
                defer { loadingEarlierBatch = false }
                guard let anchor else { return }
                await Task.yield()
                guard !Task.isCancelled else { return }
                scrollToTurnTop(proxy, turnId: anchor, targetMinY: savedMinY)
            }
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
        earlierNetworkAnchorId = nil
        scrollMetrics.earlierAnchorMinY = 0
        let updatedTurns = store.uniquedTurns(for: resolvedChatId)
        if let anchorIdx = updatedTurns.firstIndex(where: { $0.id == anchor }), anchorIdx > 0 {
            let nextStart = max(0, anchorIdx - Self.renderedTurnStep)
            let nextEnd = min(updatedTurns.count, nextStart + Self.maxRenderedTurns)
            renderWindowByChat[resolvedChatId] = TurnRenderWindow(
                startTurnId: updatedTurns[nextStart].id,
                endTurnId: nextEnd < updatedTurns.count ? updatedTurns[nextEnd - 1].id : nil,
                tailLimit: min(Self.maxRenderedTurns, max(Self.initialRenderedTurns, nextEnd - nextStart))
            )
        }
        scrollMetrics.earlierMemoryArmed = true
        scrollMetrics.newerMemoryArmed = true
        scrollMetrics.earlierNetworkArmed = true
        cancelStreamScroll()
        scrollMetrics.followTask?.cancel()
        scrollMetrics.followTask = Task { @MainActor in
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
