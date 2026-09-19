import Foundation

@MainActor
final class GatewayClient {
    var onOpen: (() -> Void)?
    var onMessage: ((ServerMessage) -> Void)?
    var onClose: (() -> Void)?

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var delegate: SocketDelegate?
    private var pingTimer: Timer?
    private var retryTimer: Timer?
    private var generation = 0
    private var closedByUser = false
    private var outbox: [ClientMessage] = []
    private var pendingHello: ClientMessage?
    private var url: URL = GatewayConfig.production
    private var didAnnounceOpen = false

    func connect(url: URL) {
        self.url = url
        closedByUser = false
        open()
    }

    func disconnect() {
        closedByUser = true
        pendingHello = nil
        outbox = []
        retryTimer?.invalidate()
        pingTimer?.invalidate()
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    func send(_ message: ClientMessage) {
        if case .hello = message {
            pendingHello = message
        }
        guard let task, task.state == .running else {
            if case .hello = message { return }
            outbox.append(message)
            if outbox.count > 50 { outbox.removeFirst(outbox.count - 50) }
            return
        }
        transmit(message, on: task)
    }

    func flushOutbox() {
        guard let task, task.state == .running else { return }
        let pending = outbox
        outbox = []
        for message in pending {
            if case .hello = message { continue }
            transmit(message, on: task)
        }
    }

    private func open() {
        retryTimer?.invalidate()
        pingTimer?.invalidate()
        generation += 1
        didAnnounceOpen = false
        let current = generation
        task?.cancel(with: .goingAway, reason: nil)

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
        if let hello = pendingHello {
            transmit(hello, on: socket)
        }
    }

    private func handleOpen(generation: Int) {
        guard self.generation == generation, !didAnnounceOpen else { return }
        didAnnounceOpen = true
        startPing()
        onOpen?()
        if let hello = pendingHello, let task {
            transmit(hello, on: task)
        }
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
        guard let data = try? message.json().data(), let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { [weak self] error in
            if error != nil {
                Task { @MainActor in
                    guard let self else { return }
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
