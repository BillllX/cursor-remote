import Foundation

@MainActor
final class GatewayClient {
    var onOpen: (() -> Void)?
    var onMessage: ((ServerMessage) -> Void)?
    /// 带后台预解码负载的消息回调；设置后优先于 onMessage，避免主线程重解析大数组。
    var onPredecodedMessage: ((ServerMessage, PredecodedPayload?) -> Void)?
    var onClose: (() -> Void)?
    /// 连接仍可用、仅费用属性从受限恢复正常；主 actor 上同步通知各 Store 恢复延后任务。
    var onBackgroundTrafficRestored: (() -> Void)?
    /// outbox 拒收时的回调（原因文案，给 banner）
    var onDrop: ((String, ClientMessage) -> Void)?

    /// outbox 单条 payload 上限：超过的消息入队也大概率发不出去，只费内存
    private static let outboxPayloadLimit = 8 * 1024 * 1024
    /// 离线入队前仅对估算超过该阈值的消息做后台精确大小校验，普通小消息零编码开销。
    private static let outboxProbeThreshold = 4 * 1024 * 1024
    /// 单次主线程 drain 帧预算（120Hz 单帧 8.33ms，保留 5ms+ 给布局与提交）
    private static let drainFrameBudgetSeconds: CFAbsoluteTime = 0.003
    /// 单条接收上限。hello 声明 900KB，网关按声明裁剪；这里多留一倍余量，偶尔超一点不至于断线。
    /// 系统默认只有 1MiB，超过就报错断开，重连后再请求同一份数据，陷入循环
    private static let receiveLimit = 2 * 1024 * 1024
    private static let pingInterval: TimeInterval = 25
    /// 两次心跳都没有任何回音就当连接已死：跨境链路或切网后 socket 可能半死不报错
    private static let silenceLimit: TimeInterval = 60
    /// 回前台探活：发 ping 后这么久没收到任何消息就重连
    private static let probeWait: TimeInterval = 8

    /// 离线待发项：不在主线程预序列化，flush 时经后台串行 WireEncoder 保序编码发送
    private struct Queued {
        let id = UUID()
        let message: ClientMessage
    }

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var delegate: SocketDelegate?
    /// 解码和套接字回调不走主线程。收包顺序由这只盒子串起来，再按帧预算交给主线程
    private let pump = SocketPump()
    /// 出站 JSON 序列化与 UTF-8 编码均走独立串行 FIFO 队列，严守协议帧序且不阻塞主线程
    private let wireEncoder = WireEncoder(payloadLimit: GatewayClient.outboxPayloadLimit)
    private var drainTask: Task<Void, Never>?
    private var pendingDrain: [PumpedMessage?] = []
    private var pendingDrainIndex = 0
    private var pingTimer: Timer?
    private var retryTimer: Timer?
    private var stableTimer: Timer?
    private var pathRestoreTask: Task<Void, Never>?
    private var generation = 0
    private var failureCount = 0
    private var closedByUser = false
    private var outbox: [Queued] = []
    private var url: URL = GatewayConfig.production
    private var didAnnounceOpen = false
    /// 最近一次收到任何消息（含 pong）的时间
    private var lastInbound = Date()
    private var probeTimer: Timer?
    private let trafficMeter = GatewayTrafficMeter()
    private(set) var networkCost = GatewayNetworkCost.unavailable
    #if canImport(Network)
    private let pathObserver = GatewayPathObserver()
    private var pathObserverStarted = false
    /// NWPath 还没回报过。这段时间先允许拨号，避免首屏一直等路径、会话停在加载。
    private var pathKnown = false
    /// 这次套接字是在路径确认前拨出的。路径第一次回报时，半开的连接只替换一次。
    private var earlySocket = false
    #endif

    func connect(url: URL) {
        self.url = url
        closedByUser = false
        startPathObserverIfNeeded()
        requestOpen(immediately: true)
    }

    func disconnect() {
        closedByUser = true
        outbox = []
        retryTimer?.invalidate()
        pingTimer?.invalidate()
        probeTimer?.invalidate()
        stableTimer?.invalidate()
        pathRestoreTask?.cancel()
        generation += 1
        pump.gate.set(generation)
        pendingDrain.removeAll(keepingCapacity: false)
        pendingDrainIndex = 0
        didAnnounceOpen = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    func clearOutbox() {
        outbox = []
    }

    var isOpen: Bool { didAnnounceOpen && task?.state == .running }

    /// 路径未知时先连。只有已经确认不可达才停拨。
    private var socketPermitted: Bool {
        !closedByUser && (!pathKnown || networkCost.reachable)
    }

    /// 回到前台或请求迟迟没回包时调用：断着就立刻重连，不等退避计时；
    /// 看起来连着就发一个 ping，probeWait 内没有任何回音再重连
    func probe() {
        guard socketPermitted else { return }
        // 没有 task，或 task 已结束却没等到关闭回调：立刻重开（open 会顺手取消待触发的重连计时）
        guard let task, task.state == .running else {
            if self.task != nil { handleClose(generation: generation) }
            requestOpen(immediately: true)
            return
        }
        // 还在握手：交给请求自身的 30 秒超时
        guard didAnnounceOpen, probeTimer?.isValid != true else { return }
        let sentAt = Date()
        let current = generation
        transmit(.ping, on: task)
        probeTimer = Timer.scheduledTimer(withTimeInterval: Self.probeWait, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == current, self.lastInbound < sentAt else { return }
                self.dropDeadSocket()
            }
        }
    }

    /// 连接半死（不报错也收不到东西）：主动拆掉，走正常的断线重连
    private func dropDeadSocket() {
        task?.cancel(with: .goingAway, reason: nil)
        handleClose(generation: generation)
    }

    func send(_ message: ClientMessage) {
        var isHello = false
        if case .hello = message { isHello = true }
        guard let task, task.state == .running, didAnnounceOpen else {
            // hello 只在 onOpen 回调里发（握手完成后），连接未就绪时直接丢弃
            if isHello { return }
            // 上传 payload 太大，不进 outbox（调用方走超时/失败路径）
            if case .uploadFile = message { return }
            let queued = Queued(message: message)
            outbox.append(queued)
            if outbox.count > 50 { outbox.removeFirst(outbox.count - 50) }
            // 仅对可能超限的大消息在后台做精确大小校验，不阻塞主线程，同时保持同步 removePendingPrompts 可见
            if Self.mayExceedOutboxLimit(message) {
                let queuedId = queued.id
                wireEncoder.validateOutboxSize(message: message) { [weak self] reason, dropped in
                    Task { @MainActor in
                        guard let self,
                              let index = self.outbox.firstIndex(where: { $0.id == queuedId })
                        else { return }
                        self.outbox.remove(at: index)
                        if let reason {
                            self.onDrop?(reason, dropped)
                        }
                    }
                }
            }
            return
        }
        transmit(message, on: task)
    }

    /// 粗略 O(1) 估算（不构造 JSONValue），只用于判断是否需要后台精确校验 8MB 护栏。
    private static func mayExceedOutboxLimit(_ message: ClientMessage) -> Bool {
        switch message {
        case .syncState:
            return true
        case .prompt(let text, _, _, _, _, let images, _, _, _, _, _, let history, _):
            var bytes = text.utf8.count
            if let images {
                for image in images { bytes += image.data.utf8.count }
            }
            if let history {
                for item in history { bytes += item.text.utf8.count }
            }
            return bytes >= outboxProbeThreshold
        case .writeFile(_, let content, _, _):
            return content.utf8.count >= outboxProbeThreshold
        default:
            return false
        }
    }

    /// 这句话还没交给服务器。从待发队列拿掉，返回真正拿掉的回合。重连后这些不会再发出去。
    @discardableResult
    func removePendingPrompts(chatId: String, turnIds: Set<String>) -> Set<String> {
        guard !turnIds.isEmpty else { return [] }
        var removed = Set<String>()
        outbox.removeAll { item in
            guard case .prompt(_, _, _, let id, _, _, _, _, _, _, _, _, let turnId) = item.message,
                  id == chatId, let turnId, turnIds.contains(turnId)
            else { return false }
            removed.insert(turnId)
            return true
        }
        return removed
    }

    func flushOutbox() {
        guard let task, task.state == .running, didAnnounceOpen else { return }
        let pending = outbox
        outbox = []
        for item in pending {
            transmit(item.message, on: task)
        }
    }

    /// 所有 retry / probe / path 回调最终都走这里；主 actor + task 守卫保证同一时刻只有一次 open。
    private func requestOpen(immediately: Bool) {
        guard socketPermitted, task == nil else { return }
        if immediately { retryTimer?.invalidate() }
        open()
    }

    private func open() {
        guard socketPermitted, task == nil else { return }
        retryTimer?.invalidate()
        pingTimer?.invalidate()
        probeTimer?.invalidate()
        generation += 1
        pump.gate.set(generation)
        pendingDrain.removeAll(keepingCapacity: false)
        pendingDrainIndex = 0
        didAnnounceOpen = false
        earlySocket = !pathKnown
        let current = generation
        let delegate = SocketDelegate()
        delegate.onOpen = { [weak self] in
            Task { @MainActor in
                self?.handleOpen(generation: current)
            }
        }
        delegate.onClose = { [weak self] in
            Task { @MainActor in
                self?.handleClose(generation: current)
            }
        }
        self.delegate = delegate

        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: pump.callbacks)
        self.session = session
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        let socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = Self.receiveLimit
        task = socket
        socket.resume()
        pump.start(socket: socket, generation: current, trafficMeter: trafficMeter) { [weak self] in
            Task { @MainActor in self?.scheduleDrain() }
        } onFail: { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                self.handleClose(generation: current)
            }
        }
    }

    /// 串行唤醒主线程按帧时间预算消费 inbox：单条保底前进，超 3ms 让出当前帧给 UI 渲染，严守到达序。
    private func scheduleDrain() {
        guard drainTask == nil else { return }
        drainTask = Task { @MainActor [weak self] in
            await self?.runDrainLoop()
        }
    }

    private func runDrainLoop() async {
        defer { drainTask = nil }
        var sliceStart = CFAbsoluteTimeGetCurrent()
        var processedInSlice = 0
        while true {
            if pendingDrainIndex >= pendingDrain.count {
                pendingDrain.removeAll(keepingCapacity: false)
                pendingDrainIndex = 0
                let batch = pump.inbox.take()
                if batch.isEmpty { return }
                pendingDrain = batch.map(Optional.some)
            }
            let maybeItem = pendingDrain[pendingDrainIndex]
            pendingDrain[pendingDrainIndex] = nil // 立即释放已消费的大帧（如 storedState），跨帧 yield 时不滞留内存
            pendingDrainIndex += 1
            guard let item = maybeItem, item.generation == generation, task != nil else { continue }
            lastInbound = Date()
            if !didAnnounceOpen {
                handleOpen(generation: item.generation)
            }
            if let onPredecodedMessage {
                onPredecodedMessage(item.message, item.predecoded)
            } else {
                onMessage?(item.message)
            }
            processedInSlice += 1
            let hasMore = pendingDrainIndex < pendingDrain.count || pump.inbox.hasItems
            if hasMore,
               processedInSlice >= 1,
               CFAbsoluteTimeGetCurrent() - sliceStart >= Self.drainFrameBudgetSeconds {
                await Task.yield()
                sliceStart = CFAbsoluteTimeGetCurrent()
                processedInSlice = 0
            }
        }
    }

    private func handleOpen(generation: Int) {
        guard self.generation == generation, !didAnnounceOpen else { return }
        didAnnounceOpen = true
        lastInbound = Date()
        startPing()
        stableTimer?.invalidate()
        stableTimer = Timer.scheduledTimer(withTimeInterval: GatewayRetryPolicy.stableResetAfter, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == generation, self.isOpen else { return }
                self.failureCount = 0
            }
        }
        onOpen?()
    }

    private func handleClose(generation: Int, countFailure: Bool = true) {
        // task 置空即已处理过：主动拆连接后 didClose、didCompleteWithError 还会各来一次
        guard self.generation == generation, task != nil else { return }
        pingTimer?.invalidate()
        probeTimer?.invalidate()
        stableTimer?.invalidate()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        delegate = nil
        didAnnounceOpen = false
        pendingDrain.removeAll(keepingCapacity: false)
        pendingDrainIndex = 0
        onClose?()
        guard socketPermitted else { return }
        if countFailure { failureCount += 1 }
        retryTimer?.invalidate()
        let delay = GatewayRetryPolicy.delay(failureCount: failureCount, random: Double.random(in: 0 ... 1))
        retryTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.requestOpen(immediately: false)
            }
        }
    }

    private func startPathObserverIfNeeded() {
        #if canImport(Network)
        guard !pathObserverStarted else { return }
        pathObserverStarted = true
        pathObserver.onChange = { [weak self] cost in
            Task { @MainActor in self?.pathChanged(cost) }
        }
        pathObserver.start()
        #else
        networkCost = GatewayNetworkCost(
            reachable: true,
            isExpensive: false,
            isConstrained: false,
            transport: .other
        )
        MobileDataRuntime.networkCost = networkCost
        AppTrafficMeter.shared.setTransport(.other)
        #endif
    }

    private func pathChanged(_ next: GatewayNetworkCost) {
        let replaceEarly = earlySocket
        earlySocket = false
        pathKnown = true
        let transition = GatewayPathTransition.classify(from: networkCost, to: next)
        networkCost = next
        MobileDataRuntime.networkCost = next
        AppTrafficMeter.shared.setTransport(next.transport)
        if transition == .backgroundTrafficRestored {
            // 费用变化不拆 WebSocket；先发布新属性，再恢复业务队列，避免回调看到旧闸门。
            onBackgroundTrafficRestored?()
        }
        guard next.reachable else {
            pathRestoreTask?.cancel()
            retryTimer?.invalidate()
            probeTimer?.invalidate()
            stableTimer?.invalidate()
            if task != nil {
                task?.cancel(with: .goingAway, reason: nil)
                handleClose(generation: generation, countFailure: false)
            }
            return
        }
        // 路径确认前拨出的套接字经常停在半开，task 又占着，后面的 requestOpen 进不来，stored_state 就永远不到。
        if replaceEarly, task != nil, !didAnnounceOpen {
            task?.cancel(with: .goingAway, reason: nil)
            handleClose(generation: generation, countFailure: false)
            requestOpen(immediately: true)
            return
        }
        guard transition == .reachabilityRestored else { return }
        pathRestoreTask?.cancel()
        // 切网时 path 可能短时间抖动；稳定 350ms 后立即给一次机会，不等待旧退避。
        pathRestoreTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard let self, !Task.isCancelled, self.networkCost.reachable else { return }
            self.requestOpen(immediately: true)
        }
    }

    private func startPing() {
        pingTimer?.invalidate()
        let timer = Timer(timeInterval: Self.pingInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let task = self.task else { return }
                if task.state != .running || Date().timeIntervalSince(self.lastInbound) > Self.silenceLimit {
                    self.dropDeadSocket()
                    return
                }
                self.transmit(.ping, on: task)
            }
        }
        // common 模式：列表滚动时 default 模式的计时器不触发，心跳会断档
        RunLoop.main.add(timer, forMode: .common)
        pingTimer = timer
    }

    private func transmit(_ message: ClientMessage, on socket: URLSessionWebSocketTask) {
        let expectedGeneration = generation
        wireEncoder.send(
            message: message,
            socket: socket,
            generation: expectedGeneration,
            gate: pump.gate,
            trafficMeter: trafficMeter,
            onDrop: { [weak self] reason, dropped in
                Task { @MainActor in
                    guard let self, self.generation == expectedGeneration else { return }
                    self.onDrop?(reason, dropped)
                }
            },
            onSendFailure: { [weak self] failedSocket in
                Task { @MainActor in
                    guard let self else { return }
                    // 旧 socket 的异步发送错误不该拆当前连接（重连后迟到的失败回调）
                    guard failedSocket === self.task else { return }
                    self.handleClose(generation: self.generation)
                }
            }
        )
    }
}

/// 出站串行编码器：严格按主线程入队顺序在后台完成 JSONValue 构造、JSONSerialization 与 UTF-8 编码并发送。
private final class WireEncoder: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ai.jiebo.gateway-wire-encoder", qos: .userInitiated)
    /// 离线 outbox 大小校验独立走低优先级队列，避免在重连瞬间阻塞实时 .hello 出站。
    private let probeQueue = DispatchQueue(label: "ai.jiebo.gateway-wire-probe", qos: .utility)
    private let payloadLimit: Int

    init(payloadLimit: Int) {
        self.payloadLimit = payloadLimit
    }

    func validateOutboxSize(
        message: ClientMessage,
        onOversized: @escaping @Sendable (String?, ClientMessage) -> Void
    ) {
        let limit = payloadLimit
        probeQueue.async {
            guard let data = try? message.json().data(), data.count > limit else { return }
            if case .syncState = message {
                onOversized(nil, message)
                return
            }
            let mb = (data.count + 1_048_575) / 1_048_576
            onOversized("这条没发出去：消息太大（约 \(mb)MB）。已经放回输入框，缩短后再发。", message)
        }
    }

    func send(
        message: ClientMessage,
        socket: URLSessionWebSocketTask,
        generation: Int,
        gate: SocketGate,
        trafficMeter: GatewayTrafficMeter,
        onDrop: @escaping @Sendable (String, ClientMessage) -> Void,
        onSendFailure: @escaping @Sendable (URLSessionWebSocketTask) -> Void
    ) {
        let limit = payloadLimit
        queue.async {
            guard gate.current() == generation, socket.state == .running else { return }
            guard let data = try? message.json().data() else { return }
            if data.count > limit {
                if case .syncState = message { return }
                if case .uploadFile = message {
                    // 文件上传由调用方按分片/超时管理，不走普通 outbox 拒收文案
                } else {
                    guard gate.current() == generation else { return }
                    let mb = (data.count + 1_048_575) / 1_048_576
                    onDrop("这条没发出去：消息太大（约 \(mb)MB）。已经放回输入框，缩短后再发。", message)
                    return
                }
            }
            guard gate.current() == generation, socket.state == .running else { return }
            guard let text = String(data: data, encoding: .utf8) else { return }
            socket.send(.string(text)) { error in
                if error == nil {
                    // send completion 成功才代表 URLSession 已接收该帧，失败帧不计入上传。
                    trafficMeter.record(direction: .outbound, data: data)
                } else {
                    onSendFailure(socket)
                }
            }
        }
    }
}

private final class SocketDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    var onOpen: (() -> Void)?
    var onClose: (() -> Void)?

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocolName: String?) {
        onOpen?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        onClose?()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil {
            onClose?()
        }
    }
}

/// 套接字回调和解码都在这条串行队列上。主线程只拿走已经解码好的消息
private final class SocketPump: @unchecked Sendable {
    /// 串行：解码按到达顺序入队，不占主线程
    let callbacks: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "ai.jiebo.gateway-socket"
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    let gate = SocketGate()
    let inbox = MessageInbox()

    func start(
        socket: URLSessionWebSocketTask,
        generation: Int,
        trafficMeter: GatewayTrafficMeter,
        onWake: @escaping @Sendable () -> Void,
        onFail: @escaping @Sendable () -> Void
    ) {
        receive(
            socket: socket,
            generation: generation,
            trafficMeter: trafficMeter,
            onWake: onWake,
            onFail: onFail
        )
    }

    private func receive(
        socket: URLSessionWebSocketTask,
        generation: Int,
        trafficMeter: GatewayTrafficMeter,
        onWake: @escaping @Sendable () -> Void,
        onFail: @escaping @Sendable () -> Void
    ) {
        socket.receive { [weak self] result in
            guard let self, self.gate.current() == generation else { return }
            switch result {
            case .failure:
                onFail()
            case .success(let message):
                let data: Data
                switch message {
                case .data(let value):
                    data = value
                case .string(let value):
                    data = Data(value.utf8)
                @unknown default:
                    self.receive(
                        socket: socket,
                        generation: generation,
                        trafficMeter: trafficMeter,
                        onWake: onWake,
                        onFail: onFail
                    )
                    return
                }
                trafficMeter.record(direction: .inbound, data: data)
                if let decoded = try? ServerMessage.decode(from: data) {
                    let predecoded = Self.predecode(decoded)
                    if self.inbox.push(generation: generation, message: decoded, predecoded: predecoded) {
                        onWake()
                    }
                }
                self.receive(
                    socket: socket,
                    generation: generation,
                    trafficMeter: trafficMeter,
                    onWake: onWake,
                    onFail: onFail
                )
            }
        }
    }

    /// 在套接字串行后台队列提前把重型 JSONValue 载荷转为强类型值，既严守协议序又避免阻塞主线程。
    private static func predecode(_ message: ServerMessage) -> PredecodedPayload? {
        switch message {
        case .storedState(let rows, let rev, let deleted, let chatRevs):
            return .storedState(DecodedStoredState.decode(rows: rows, rev: rev, deletedIds: deleted, chatRevs: chatRevs))
        case .storedChat(let value, _):
            return ChatSession.from(value).map(PredecodedPayload.storedChat)
        case .chatTurns(_, let rows, _, _, _, _), .history(_, let rows):
            return .turns(rows.compactMap(Turn.from))
        default:
            return nil
        }
    }
}

private final class SocketGate: @unchecked Sendable {
    private let lock = NSLock()
    private var generation = 0

    func set(_ value: Int) {
        lock.lock()
        generation = value
        lock.unlock()
    }

    func current() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return generation
    }
}

private struct PumpedMessage: Sendable {
    var generation: Int
    var message: ServerMessage
    var predecoded: PredecodedPayload?
}

private final class MessageInbox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [PumpedMessage] = []
    private var scheduled = false

    var hasItems: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !items.isEmpty
    }

    /// 连续的正文/思考增量合成一条，少占主线程。返回 true 表示主线程还没人来取
    func push(generation: Int, message: ServerMessage, predecoded: PredecodedPayload? = nil) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let index = items.indices.last,
           items[index].generation == generation,
           let merged = Self.merge(items[index].message, message) {
            items[index].message = merged
        } else {
            items.append(PumpedMessage(generation: generation, message: message, predecoded: predecoded))
        }
        let wake = !scheduled
        scheduled = true
        return wake
    }

    func take() -> [PumpedMessage] {
        lock.lock()
        defer { lock.unlock() }
        let batch = items
        items.removeAll()
        if batch.isEmpty { scheduled = false }
        return batch
    }

    private static func merge(_ old: ServerMessage, _ new: ServerMessage) -> ServerMessage? {
        switch (old, new) {
        case (.textDelta(let id, let left), .textDelta(let next, let right)) where id == next:
            return .textDelta(chatId: id, text: left + right)
        case (.thinkingDelta(let id, let left), .thinkingDelta(let next, let right)) where id == next:
            return .thinkingDelta(chatId: id, text: left + right)
        default:
            return nil
        }
    }
}
