import SwiftUI
import UIKit
import ImageIO

extension ThreadView {
    var thread: some View {
        // 外层先量出视口宽。不锁宽的话，计划里的长行会按「不折行」的理想高度去撑滚动区，看起来到底了，下面还有一大段。
        GeometryReader { geo in
        ScrollViewReader { proxy in
            ScrollView {
                // 不用 LazyVStack：流式增高时未实现的底部锚点会让 scrollTo 落空，跟随就断。
                VStack(alignment: .leading, spacing: 18) {
                    if let chat = store.active, chat.turns.isEmpty, chat.turnsComplete, !store.coldStartPlaceholder {
                        // 未加载完的壳（!turnsComplete）不算空会话——由下方遮罩覆盖
                        if chrome == .embedded {
                            assistantEmptyState
                        } else {
                            emptyState
                        }
                    }
                    if let chat = store.active, !chat.turnsComplete, !chat.turns.isEmpty,
                       store.loadingChatIds.contains(chat.id), !store.refreshingChatIds.contains(chat.id) {
                        // 只在真的往前翻页时出现；显示本机缓存、增量补齐期间由导航栏的同步转圈提示
                        // 分页加载更早内容的轻提示（不抢滚动，对齐「分段加载」的可感知性）
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("正在加载更早的内容…")
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(JieboColor.ink2)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                    }
                    let allTurns = Turn.uniqued(store.active?.turns ?? [])
                    let renderLimit = renderedTurnLimit(for: store.activeId, total: allTurns.count)
                    let hiddenCount = max(0, allTurns.count - renderLimit)
                    let turns = Array(allTurns.suffix(renderLimit))
                    let inviteTurnId = calendarInviteTurnId(turns)
                    if hiddenCount > 0 {
                        let batch = min(hiddenCount, Self.renderedTurnStep)
                        Button {
                            loadEarlierTurns(proxy: proxy, allTurns: allTurns, limit: renderLimit)
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
                                        // VStack 会一次性建好子视图，不能用 onAppear；看哨兵是否进视口
                                        guard minY >= -12, minY < viewportHeight - 48 else { return }
                                        guard !stickToBottom else { return }
                                        loadEarlierTurns(proxy: proxy, allTurns: allTurns, limit: renderLimit)
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
                            inviteTurnId: inviteTurnId
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
            .coordinateSpace(name: "threadScroll")
            // 可视高度 = 这一层 GeometryReader 的高度减去 bottom safe area。
            // safeAreaInset 挂在这一层外面，输入框算进 inset，这里不要再减一次。
            .onAppear {
                let height = geo.size.height - geo.safeAreaInsets.bottom
                viewportHeight = height
                guard height > 1, pinnedMinHeight <= 1, let id = store.active?.turns.last?.id else { return }
                pinToTurn(id, proxy: proxy, height: height)
            }
            .onChange(of: geo.size.height - geo.safeAreaInsets.bottom) { _, h in viewportHeight = h }
            .overlay(alignment: .bottom) {
                Group {
                    if !stickToBottom {
                        Button {
                            stickToBottom = true
                            revealLatest(proxy, animated: true)
                        } label: {
                            ZStack(alignment: .topTrailing) {
                                Image(systemName: "arrow.down")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(JieboColor.ink)
                                    .frame(width: 44, height: 44)
                                    .jieboGlass(in: Circle(), interactive: true)
                                if store.active?.turns.last?.running == true {
                                    Circle()
                                        .fill(JieboColor.run)
                                        .frame(width: 9, height: 9)
                                        .offset(x: 1, y: 1)
                                }
                            }
                            .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(store.active?.turns.last?.running == true ? "有新内容正在生成" : "")
                        .padding(.bottom, 10)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
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
                            Text("正在加载会话…")
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
                // 本机缓存通常几十毫秒就读完：等一小会儿再盖遮罩，免得冷启动先闪一下
                guard showThreadLoading else {
                    loadingVisible = false
                    return
                }
                try? await Task.sleep(for: .milliseconds(350))
                if !Task.isCancelled, showThreadLoading { loadingVisible = true }
            }
            .modifier(StartAtBottom())
            .modifier(EmbeddedScrollPhase(enabled: true) {
                releaseFollow()
            })
            .modifier(UnstickDrag(embedded: true) {
                releaseFollow()
            })
            .onChange(of: store.active?.turns.count) { _, _ in
                guard let id = store.active?.turns.last?.id else { return }
                pinToTurn(id, proxy: proxy, height: viewportHeight)
            }
            .onChange(of: liveTail) { _, _ in
                guard pinExceeded, stickToBottom else { return }
                scrollToEndNow(proxy)
            }
            .onChange(of: store.active?.turns.last?.running) { _, running in
                // 流式时不追；停更后代码和表格还会长高，超出钉顶才再贴一次底
                guard running == false, pinExceeded, stickToBottom else { return }
                scrollToEndNow(proxy)
                followTask?.cancel()
                followTask = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(80))
                    guard !Task.isCancelled, stickToBottom, pinExceeded else { return }
                    scrollToEndNow(proxy)
                }
            }
            .onChange(of: viewportHeight) { _, newHeight in
                guard newHeight > 1 else { return }
                if pinnedTurnId != nil, pinnedMinHeight <= 1 {
                    pinnedMinHeight = newHeight
                    if let id = pinnedTurnId {
                        pinToTurn(id, proxy: proxy, height: newHeight)
                    }
                } else if pinnedTurnId != nil, newHeight > pinnedMinHeight {
                    pinnedMinHeight = newHeight
                }
            }
            .onChange(of: store.activeId) { _, id in
                // 切会话把最后一轮顶对齐，避免把钉顶留白滚进视口。
                followTask?.cancel()
                stickToBottom = true
                motionChatId = id
                if let last = store.active?.turns.last?.id, viewportHeight > 1 {
                    pinToTurn(last, proxy: proxy, height: viewportHeight)
                } else {
                    pinnedTurnId = store.active?.turns.last?.id
                    pinExceeded = false
                    pinBaselineReady = false
                    pinBaselineMinY = nil
                }
            }
            .onAppear {
                motionChatId = store.activeId
                stickToBottom = true
                if let last = store.active?.turns.last?.id, viewportHeight > 1 {
                    pinToTurn(last, proxy: proxy, height: viewportHeight)
                } else {
                    pinnedTurnId = store.active?.turns.last?.id
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
    func pinnedTurn(_ turn: Turn, index: Int, turns: [Turn], inviteTurnId: String?) -> some View {
        let pinned = pinnedTurnId == turn.id
        TurnView(
            turn: turn,
            canAnswer: index == turns.count - 1 && !turn.running && !turn.queued,
            embedded: chrome == .embedded,
            isLastAssistant: turn.id == turns.last?.id,
            reviewMark: store.localTurnReviews[turn.id],
            restoring: store.restoringTurnIds.contains(turn.id),
            captured: TodoReceipt.captured(in: turn, todos: store.assistantState?.todos),
            calendarInvite: turn.id == inviteTurnId ? store.assistantState?.calendar : nil
        )
        .equatable()
        .background {
            if pinned {
                GeometryReader { geo in
                    Color.clear
                        .onAppear {
                            notePinContentHeight(geo.size.height)
                            notePinnedMinY(geo.frame(in: .named("threadScroll")).minY)
                        }
                        .onChange(of: geo.size.height) { _, height in
                            notePinContentHeight(height)
                        }
                        .onChange(of: geo.frame(in: .named("threadScroll")).minY) { _, y in
                            notePinnedMinY(y)
                        }
                }
            }
        }
        .frame(minHeight: pinned ? pinnedMinHeight : 0, alignment: .top)
        .id(turn.id)
        .transition(.opacity.combined(with: .offset(y: 10)))
    }

    /// 把这一轮顶对齐到可视区上方。height 还没量到时只记下 id，等 viewportHeight 再滚。
    func pinToTurn(_ id: String, proxy: ScrollViewProxy, height: CGFloat) {
        pinnedTurnId = id
        pinExceeded = false
        pinRecaptureBaseline = false
        pinBaselineMinY = nil
        pinBaselineReady = false
        stickToBottom = true
        guard height > 1 else { return }
        pinnedMinHeight = height
        armScrollGuard()
        followTask?.cancel()
        followTask = Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled, pinnedTurnId == id else { return }
            scrollWithoutAnimation(proxy, id: id, anchor: .top)
            try? await Task.sleep(for: .milliseconds(50))
            guard !Task.isCancelled, pinnedTurnId == id else { return }
            scrollingProgrammatically = false
            pinBaselineMinY = pinnedTurnMinY
            pinBaselineReady = true
        }
    }

    func revealLatest(_ proxy: ScrollViewProxy, animated: Bool) {
        armScrollGuard()
        let scroll = {
            if pinExceeded {
                proxy.scrollTo("thread-end", anchor: .bottom)
            } else if let id = pinnedTurnId {
                proxy.scrollTo(id, anchor: .top)
            }
        }
        if animated {
            withAnimation(.easeOut(duration: 0.25)) { scroll() }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { scroll() }
        }
        followTask?.cancel()
        followTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled else { return }
            scrollingProgrammatically = false
            pinBaselineMinY = pinnedTurnMinY
            pinBaselineReady = true
        }
    }

    /// 超出钉顶之后才贴底。贴底后的下一次 minY 当作新基线，上滑 24pt 就能松开。
    func scrollToEndNow(_ proxy: ScrollViewProxy) {
        guard stickToBottom else { return }
        pinRecaptureBaseline = true
        scrollingProgrammatically = true
        scrollWithoutAnimation(proxy, id: "thread-end", anchor: .bottom)
        scrollingProgrammatically = false
    }

    func scrollWithoutAnimation(_ proxy: ScrollViewProxy, id: String, anchor: UnitPoint) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            proxy.scrollTo(id, anchor: anchor)
        }
    }

    func armScrollGuard() {
        scrollingProgrammatically = true
        pinScrollGuardUntil = Date().addingTimeInterval(0.32)
    }

    func releaseFollow() {
        guard Date() >= pinScrollGuardUntil else { return }
        followTask?.cancel()
        scrollingProgrammatically = false
        stickToBottom = false
    }

    func notePinContentHeight(_ height: CGFloat) {
        guard pinnedMinHeight > 1 else { return }
        if height > pinnedMinHeight + 0.5 {
            pinExceeded = true
        }
    }

    /// iOS 17 没有滚动相位。基线是最近一次定位后的位置：钉顶时在轮顶，贴底后改到贴底位置。
    func notePinnedMinY(_ y: CGFloat) {
        pinnedTurnMinY = y
        guard Date() >= pinScrollGuardUntil else { return }
        if pinRecaptureBaseline {
            pinBaselineMinY = y
            pinRecaptureBaseline = false
            pinBaselineReady = true
            return
        }
        guard pinBaselineReady else { return }
        if pinBaselineMinY == nil {
            pinBaselineMinY = y
            return
        }
        if let baseline = pinBaselineMinY, y > baseline + 24 {
            releaseFollow()
        }
    }

    /// 在列表顶部 prepend 更早轮次后，锚定原先最上面那一轮，避免整页跳动
    func loadEarlierTurns(proxy: ScrollViewProxy, allTurns: [Turn], limit: Int) {
        guard !loadingEarlierBatch else { return }
        let hidden = allTurns.count - limit
        guard hidden > 0 else { return }
        loadingEarlierBatch = true
        let anchorId = Array(allTurns.suffix(limit)).first?.id
        let next = min(allTurns.count, limit + Self.renderedTurnStep)
        renderedTurnLimitByChat[store.activeId] = next
        followTask?.cancel()
        followTask = Task { @MainActor in
            defer { loadingEarlierBatch = false }
            guard let anchorId else { return }
            scrollingProgrammatically = true
            for delay in [0, 48, 120, 260] {
                try? await Task.sleep(for: .milliseconds(delay))
                guard !Task.isCancelled else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    proxy.scrollTo(anchorId, anchor: .top)
                }
            }
            scrollingProgrammatically = false
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
