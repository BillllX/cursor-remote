import Foundation

@MainActor
final class GatewayClient {
    var onOpen: (() -> Void)?
    var onMessage: ((ServerMessage) -> Void)?
    var onClose: (() -> Void)?
    /// 连接仍可用、仅费用属性从受限恢复正常；主 actor 上同步通知各 Store 恢复延后任务。
    var onBackgroundTrafficRestored: (() -> Void)?
    /// outbox 拒收时的回调（原因文案，给 banner）
    var onDrop: ((String) -> Void)?

    /// outbox 单条 payload 上限：超过的消息入队也大概率发不出去，只费内存
    private static let outboxPayloadLimit = 8 * 1024 * 1024
    /// 单条接收上限。hello 声明 900KB，网关按声明裁剪；这里多留一倍余量，偶尔超一点不至于断线。
    /// 系统默认只有 1MiB，超过就报错断开，重连后再请求同一份数据，陷入循环
    private static let receiveLimit = 2 * 1024 * 1024
    private static let pingInterval: TimeInterval = 25
    /// 两次心跳都没有任何回音就当连接已死：跨境链路或切网后 socket 可能半死不报错
    private static let silenceLimit: TimeInterval = 60
    /// 回前台探活：发 ping 后这么久没收到任何消息就重连
    private static let probeWait: TimeInterval = 8

    /// 入队项：消息 + 入队时已序列化的 payload（flush 时直接复用，避免二次序列化）
    private struct Queued {
        let message: ClientMessage
        let payload: Data
    }

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var delegate: SocketDelegate?
    /// 解码和套接字回调不走主线程。收包顺序由这只盒子串起来，再一次性交给主线程
    private let pump = SocketPump()
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
            // 序列化一次：测大小 + 存 payload（flush 时复用，避免二次序列化）
            guard let data = try? message.json().data() else { return }
            // outbox 护栏：单条超限拒绝入队
            if data.count > Self.outboxPayloadLimit {
                // syncState 静默丢弃：下一次 scheduleSync 全量重发即自愈，无需打扰用户
                if case .syncState = message { return }
                let mb = (data.count + 1_048_575) / 1_048_576
                onDrop?("这条没发出去：消息太大（约 \(mb)MB），连上后请重发。")
                return
            }
            outbox.append(Queued(message: message, payload: data))
            if outbox.count > 50 { outbox.removeFirst(outbox.count - 50) }
            return
        }
        transmit(message, on: task)
    }

    func flushOutbox() {
        guard let task, task.state == .running, didAnnounceOpen else { return }
        let pending = outbox
        outbox = []
        for item in pending {
            transmit(item.payload, on: task)
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
            Task { @MainActor in self?.drain() }
        } onFail: { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                self.handleClose(generation: current)
            }
        }
    }

    /// 把已经解码好的包按到达顺序应用到界面上。解码本身在套接字队列上完成
    private func drain() {
        while true {
            let batch = pump.inbox.take()
            if batch.isEmpty { return }
            for item in batch {
                guard item.generation == generation, task != nil else { continue }
                lastInbound = Date()
                if !didAnnounceOpen {
                    handleOpen(generation: item.generation)
                }
                onMessage?(item.message)
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
        guard let data = try? message.json().data() else { return }
        transmit(data, on: socket)
    }

    private func transmit(_ data: Data, on socket: URLSessionWebSocketTask) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { [weak self] error in
            if error == nil {
                // send completion 成功才代表 URLSession 已接收该帧，失败帧不计入上传。
                self?.trafficMeter.record(direction: .outbound, data: data)
            } else {
                Task { @MainActor in
                    guard let self else { return }
                    // 旧 socket 的异步发送错误不该拆当前连接（重连后迟到的失败回调）
                    guard socket === self.task else { return }
                    self.handleClose(generation: self.generation)
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
                if let decoded = try? ServerMessage.decode(from: data),
                   self.inbox.push(generation: generation, message: decoded) {
                    onWake()
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

private struct PumpedMessage {
    var generation: Int
    var message: ServerMessage
}

private final class MessageInbox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [PumpedMessage] = []
    private var scheduled = false

    /// 连续的正文/思考增量合成一条，少占主线程。返回 true 表示主线程还没人来取
    func push(generation: Int, message: ServerMessage) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let index = items.indices.last,
           items[index].generation == generation,
           let merged = Self.merge(items[index].message, message) {
            items[index].message = merged
        } else {
            items.append(PumpedMessage(generation: generation, message: message))
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
