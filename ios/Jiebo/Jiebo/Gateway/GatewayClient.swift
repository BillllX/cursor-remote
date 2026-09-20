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
        task = socket
        socket.resume()
        listen(socket, generation: current)
    }

    private func handleOpen(generation: Int) {
        guard self.generation == generation, !didAnnounceOpen else { return }
        didAnnounceOpen = true
        startPing()
        onOpen?()
    }

    private func listen(_ socket: URLSessionWebSocketTask, generation: Int) {
        socket.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.generation == generation, self.task === socket else { return }
                switch result {
                case .success(let message):
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
        guard self.generation == generation else { return }
        pingTimer?.invalidate()
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
        pingTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let task = self.task, task.state == .running else { return }
                self.transmit(.ping, on: task)
            }
        }
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
