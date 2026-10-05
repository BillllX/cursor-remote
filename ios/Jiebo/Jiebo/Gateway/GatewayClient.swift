import Foundation

@MainActor
final class GatewayClient {
    var onOpen: (() -> Void)?
    var onMessage: ((ServerMessage) -> Void)?
    var onClose: (() -> Void)?
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
    private var pingTimer: Timer?
    private var retryTimer: Timer?
    private var generation = 0
    private var closedByUser = false
    private var outbox: [Queued] = []
    private var url: URL = GatewayConfig.production
    private var didAnnounceOpen = false
    /// 最近一次收到任何消息（含 pong）的时间
    private var lastInbound = Date()
    private var probeTimer: Timer?

    func connect(url: URL) {
        self.url = url
        closedByUser = false
        open()
    }

    func disconnect() {
        closedByUser = true
        outbox = []
        retryTimer?.invalidate()
        pingTimer?.invalidate()
        probeTimer?.invalidate()
        generation += 1
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

    /// 回到前台或请求迟迟没回包时调用：断着就立刻重连，不等退避计时；
    /// 看起来连着就发一个 ping，probeWait 内没有任何回音再重连
    func probe() {
        guard !closedByUser else { return }
        // 没有 task，或 task 已结束却没等到关闭回调：立刻重开（open 会顺手取消待触发的重连计时）
        guard let task, task.state == .running else {
            open()
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

    private func open() {
        retryTimer?.invalidate()
        pingTimer?.invalidate()
        probeTimer?.invalidate()
        generation += 1
        didAnnounceOpen = false
        let current = generation
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()

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

        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: .main)
        self.session = session
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        let socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = Self.receiveLimit
        task = socket
        socket.resume()
        listen(socket, generation: current)
    }

    private func handleOpen(generation: Int) {
        guard self.generation == generation, !didAnnounceOpen else { return }
        didAnnounceOpen = true
        lastInbound = Date()
        startPing()
        onOpen?()
    }

    private func listen(_ socket: URLSessionWebSocketTask, generation: Int) {
        socket.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.generation == generation, self.task === socket else { return }
                switch result {
                case .success(let message):
                    self.lastInbound = Date()
                    if !self.didAnnounceOpen {
                        self.handleOpen(generation: generation)
                    }
                    let data: Data
                    switch message {
                    case .data(let value):
                        data = value
                    case .string(let value):
                        data = Data(value.utf8)
                    @unknown default:
                        self.listen(socket, generation: generation)
                        return
                    }
                    if let decoded = try? ServerMessage.decode(from: data) {
                        self.onMessage?(decoded)
                    }
                    self.listen(socket, generation: generation)
                case .failure:
                    self.handleClose(generation: generation)
                }
            }
        }
    }

    private func handleClose(generation: Int) {
        // task 置空即已处理过：主动拆连接后 didClose、didCompleteWithError 还会各来一次
        guard self.generation == generation, task != nil else { return }
        pingTimer?.invalidate()
        probeTimer?.invalidate()
        task = nil
        didAnnounceOpen = false
        onClose?()
        guard !closedByUser else { return }
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.open()
            }
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
            if error != nil {
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
