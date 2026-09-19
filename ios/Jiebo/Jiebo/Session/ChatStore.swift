import Foundation
import Observation

@Observable
@MainActor
final class ChatStore {
    var connected = false
    var unlocked = false
    var verifying = false
    var authError = ""
    var notice = ""
    var bannerError = ""
    var tokenDraft = ""
    var chats: [ChatSession] = [ChatSession.blank(id: "boot")]
    var activeId = "boot"
    var cwd = ""
    var workspaceRoot = ""
    var workspaces: [WorkspaceItem] = []
    var workspaceSheetOpen = false
    var creatingWorkspace = false
    var newWorkspaceName = ""
    var model = ModelCatalog.defaultModel
    var models: [String] = [ModelCatalog.defaultModel]
    var mode: AgentMode = .agent
    var hasApiKey = true
    var draft = ""
    var showThinkingIds: Set<String> = []

    var active: ChatSession? { chats.first { $0.id == activeId } }
    var busy: Bool { active?.turns.contains(where: \.running) == true }
    var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private let client = GatewayClient()
    private var started = false
    private var stateRev = 0
    private var appliedStore = false
    private var deletedIds = Set<String>()
    private var lastModel = ""
    private var runningChatIds: [String] = []
    private var queuedChatIds: [String] = []
    private var syncTask: Task<Void, Never>?
    private var verifyTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?
    private var stallTask: Task<Void, Never>?
    private var lastProgress = Date()

    func start() {
        guard !started else { return }
        started = true
        if let saved = KeychainStore.token() {
            tokenDraft = saved
        }
        lastModel = UserDefaults.standard.string(forKey: ModelCatalog.lastModelKey) ?? ""
        wireClient()
        client.connect(url: GatewayConfig.url)
    }

    func login() {
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        tokenDraft = token
        authError = ""
        verifying = true
        armVerifyTimeout()
        client.connect(url: GatewayConfig.url)
        send(.hello(token: token))
    }

    func logout() {
        KeychainStore.delete()
        unlocked = false
        verifying = false
        tokenDraft = ""
        authError = ""
        bannerError = ""
        notice = ""
        chats = [ChatSession.blank(id: "boot")]
        activeId = "boot"
        draft = ""
        appliedStore = false
        stateRev = 0
        client.disconnect()
    }

    func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        ensureActiveChat()
        let chatId = activeId
        let untitled = chats.first { $0.id == chatId }?.isUntitled ?? true
        let turn = Turn.blank(user: text, model: model, mode: mode, running: !busy)
        draft = ""
        bannerError = ""
        notice = ""
        patch(chatId) { chat in
            var next = chat
            next.draft = ""
            next.unread = false
            next.turns.append(turn)
            return next
        }
        send(.prompt(
            text: text,
            model: model,
            mode: mode,
            chatId: chatId,
            files: nil,
            images: nil,
            confirmWrites: active?.confirmWrites,
            autoApprove: nil,
            fresh: nil,
            nameChat: untitled
        ))
        markProgress(chatId)
    }

    func stop() {
        send(.cancel(chatId: activeId))
        patch(activeId) { chat in
            var next = chat
            next.turns = next.turns.map { turn in
                turn.running || turn.tools.contains(where: { $0.status == "running" })
                    ? turn.settled(status: "cancelled")
                    : turn
            }
            return next
        }
        stallTask?.cancel()
    }

    func chooseModel(_ id: String) {
        model = id
        rememberModel(id)
        patch(activeId) { chat in
            var next = chat
            next.model = id
            return next
        }
        send(.setModel(model: id, chatId: activeId))
    }

    func chooseMode(_ value: AgentMode) {
        mode = value
        patch(activeId) { chat in
            var next = chat
            next.mode = value
            return next
        }
    }

    func openNewChat() {
        send(.listWorkspaces)
        creatingWorkspace = false
        newWorkspaceName = ""
        workspaceSheetOpen = true
    }

    func startChat(in path: String) {
        let next = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return }
        workspaceSheetOpen = false
        creatingWorkspace = false
        persistDraft()
        if let existing = chats.first(where: { $0.isUntitled && $0.turns.isEmpty && samePath($0.cwd ?? workspaceRoot, next) }) {
            select(existing.id)
            patch(existing.id) { chat in
                var nextChat = chat
                nextChat.cwd = next
                nextChat.mode = .agent
                nextChat.model = chat.model ?? self.model
                return nextChat
            }
            cwd = next
            mode = .agent
            send(.setWorkspace(cwd: next, chatId: existing.id, create: nil))
            return
        }
        let chat = ChatSession.blank(cwd: next, model: lastModel.nilIfEmpty ?? model, mode: .agent)
        chats.insert(chat, at: 0)
        activeId = chat.id
        cwd = next
        mode = .agent
        if let nextModel = chat.model {
            model = nextModel
        }
        draft = ""
        send(.newSession(chatId: chat.id, cwd: next))
        if let nextModel = chat.model {
            send(.setModel(model: nextModel, chatId: chat.id))
        }
        scheduleSync()
    }

    func createWorkspace() {
        let name = newWorkspaceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        send(.createWorkspace(name: name))
        newWorkspaceName = ""
        creatingWorkspace = false
    }

    func select(_ id: String) {
        guard id != activeId else { return }
        persistDraft()
        activeId = id
        patch(id) { chat in
            var next = chat
            next.unread = false
            return next
        }
        applySession(chats.first { $0.id == id })
    }

    func deleteChat(_ id: String) {
        if let doomed = chats.first(where: { $0.id == id }), doomed.turns.contains(where: \.running) {
            send(.cancel(chatId: id))
        }
        send(.deleteSession(chatId: id))
        deletedIds.insert(id)
        var rest = chats.filter { $0.id != id }
        if rest.isEmpty {
            let chat = ChatSession.blank(cwd: cwd.nilIfEmpty ?? workspaceRoot, model: lastModel.nilIfEmpty ?? model, mode: mode)
            rest = [chat]
            send(.newSession(chatId: chat.id, cwd: chat.cwd))
            if let nextModel = chat.model {
                send(.setModel(model: nextModel, chatId: chat.id))
            }
        }
        chats = rest
        if id == activeId, let first = rest.first {
            activeId = first.id
            applySession(first)
        }
        scheduleSync()
    }

    func replyToApproval(allow: Bool) {
        guard let chat = active, let pending = chat.turns.last(where: { $0.pendingTool != nil })?.pendingTool else { return }
        send(.approvalReply(chatId: chat.id, callId: pending.callId, allow: allow))
        patchRunning(chat.id) { turn in
            var next = turn
            next.pendingTool = nil
            return next
        }
    }

    func saveDraft(_ value: String) {
        draft = value
        guard let index = chats.firstIndex(where: { $0.id == activeId }) else { return }
        if chats[index].draft != value {
            chats[index].draft = value
        }
    }

    private func wireClient() {
        client.onOpen = { [weak self] in
            guard let self else { return }
            self.connected = true
            if self.authError.hasPrefix("还没连上") { self.authError = "" }
            let token = KeychainStore.token() ?? self.tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            if !token.isEmpty {
                if !self.unlocked { self.verifying = true }
                self.armVerifyTimeout()
                self.client.send(.hello(token: token))
            }
        }
        client.onClose = { [weak self] in
            guard let self else { return }
            self.connected = false
            if !self.unlocked {
                self.verifying = false
            } else {
                self.flash("正在重连服务器…")
            }
        }
        client.onMessage = { [weak self] message in
            self?.handle(message)
        }
    }

    private func handle(_ message: ServerMessage) {
        let chatId = message.chatId?.nilIfEmpty ?? activeId
        switch message {
        case .textDelta, .thinkingDelta, .toolStarted, .toolCompleted, .toolOutput, .task:
            markProgress(chatId)
        case .status(_, let status, _) where status == "RUNNING" || status == "CREATING":
            markProgress(chatId)
        case .done, .error:
            stallTask?.cancel()
        default:
            break
        }
        if chatId != activeId {
            switch message {
            case .textDelta, .thinkingDelta, .toolStarted, .done, .error, .approval:
                patch(chatId) { chat in
                    guard !chat.unread else { return chat }
                    var next = chat
                    next.unread = true
                    return next
                }
            default:
                break
            }
        }

        switch message {
        case .ready(let nextCwd, let hasKey, let serverModel, let serverModels, _, let running, let queued, let root, _, _):
            let reconnected = unlocked
            unlocked = true
            verifying = false
            verifyTask?.cancel()
            authError = ""
            if reconnected { flash("已重新连上服务器") }
            let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            if !token.isEmpty { KeychainStore.save(token) }
            hasApiKey = hasKey
            workspaceRoot = root ?? workspaceRoot.nilIfEmpty ?? nextCwd
            let current = chats.first { $0.id == activeId }
            cwd = current?.cwd ?? nextCwd
            models = serverModels.isEmpty ? [serverModel.nilIfEmpty ?? ModelCatalog.defaultModel] : serverModels
            runningChatIds = running
            queuedChatIds = queued
            let nextModel = ModelCatalog.resolve(
                preferred: current?.sessionModel ?? lastModel.nilIfEmpty ?? model,
                ids: models,
                fallback: serverModel
            )
            model = nextModel
            rememberModel(nextModel)
            markLive(running: running, queued: queued)
            if let current, current.model != nextModel {
                patch(current.id) { chat in
                    var next = chat
                    next.model = nextModel
                    return next
                }
                send(.setModel(model: nextModel, chatId: current.id))
            }
            send(.listWorkspaces)
            client.flushOutbox()
        case .auth(let ok, let messageText):
            if !ok {
                unlocked = false
                verifying = false
                verifyTask?.cancel()
                authError = messageText ?? "密码不对。"
                KeychainStore.delete()
            }
        case .storedState(let rows, let rev, let deleted):
            deleted.forEach { deletedIds.insert($0) }
            if appliedStore, let rev, rev <= stateRev { break }
            appliedStore = true
            if let rev, rev > stateRev { stateRev = rev }
            let remote = rows.compactMap(ChatSession.from).filter { !deletedIds.contains($0.id) }
            guard !remote.isEmpty else { break }
            chats = merge(local: chats, remote: remote)
            if chats.contains(where: { $0.id == activeId }) == false, let first = chats.first {
                activeId = first.id
            }
            if let keep = chats.first(where: { $0.id == activeId }) {
                applySession(keep)
            }
            markLive(running: runningChatIds, queued: queuedChatIds)
        case .workspaces(_, let items):
            workspaces = items
            if workspaceRoot.isEmpty, let first = items.first { workspaceRoot = first.path }
        case .workspaceCreated(let path, let name):
            if !workspaces.contains(where: { $0.path == path }) {
                workspaces.insert(WorkspaceItem(path: path, name: name), at: 0)
            }
            startChat(in: path)
        case .session(let id, let agentId, let sessionCwd):
            let target = id.nilIfEmpty ?? activeId
            patch(target) { chat in
                var next = chat
                if !sessionCwd.isEmpty { next.cwd = sessionCwd }
                if !agentId.isEmpty { next.agentId = agentId }
                return next
            }
            if target == activeId, !sessionCwd.isEmpty { cwd = sessionCwd }
        case .runMeta(let id, let runModel, let runMode):
            patchRunning(id) { turn in
                var next = turn
                if !runModel.isEmpty { next.model = runModel }
                if let runMode { next.mode = runMode }
                return next
            }
        case .textDelta(let id, let text):
            patchRunning(id) { turn in
                var next = turn
                next.assistant += text
                return next
            }
        case .thinkingDelta(let id, let text):
            patchRunning(id) { turn in
                var next = turn
                next.thinking += text
                return next
            }
            showThinkingIds.insert(id)
        case .toolStarted(let id, let callId, let name, let args, let parent, let agent, let toolModel):
            patchRunning(id) { turn in
                var next = turn
                next.tools.removeAll { $0.callId == callId }
                next.tools.append(ToolCall(callId: callId, name: name, args: args, result: nil, status: "running", parentCallId: parent, agent: agent, model: toolModel))
                return next
            }
        case .toolCompleted(let id, let callId, let name, let status, let result, let parent, let agent, let toolModel):
            patchOpen(id) { turn in
                var next = turn
                let existing = next.tools.first { $0.callId == callId }
                if existing?.status == "error", status == "completed" { return turn }
                next.tools.removeAll { $0.callId == callId }
                next.tools.append(ToolCall(
                    callId: callId,
                    name: name,
                    args: existing?.args,
                    result: result,
                    status: status,
                    parentCallId: existing?.parentCallId ?? parent,
                    agent: existing?.agent ?? agent,
                    model: existing?.model ?? toolModel
                ))
                return next
            }
        case .toolOutput(let id, let callId, let stream, let chunk, let stdout, let stderr):
            patchRunning(id) { turn in
                var next = turn
                if let index = next.tools.firstIndex(where: { $0.callId == callId }) {
                    next.tools[index].result = mergeOutput(next.tools[index].result, stream: stream, chunk: chunk, stdout: stdout, stderr: stderr)
                } else {
                    next.tools.append(ToolCall(
                        callId: callId,
                        name: "shell",
                        args: nil,
                        result: mergeOutput(nil, stream: stream, chunk: chunk, stdout: stdout, stderr: stderr),
                        status: "running",
                        parentCallId: nil,
                        agent: nil,
                        model: nil
                    ))
                }
                return next
            }
        case .task(let id, let text):
            patchRunning(id) { turn in
                var next = turn
                next.task = text
                return next
            }
        case .approval(let id, let callId, let name, let args):
            patchRunning(id) { turn in
                var next = turn
                next.pendingTool = PendingTool(callId: callId, name: name, args: args)
                return next
            }
        case .status(let id, let status, let text):
            if let text, !text.isEmpty { flash(text) }
            if status == "RUNNING" || status == "CREATING" {
                patch(id ?? activeId) { chat in
                    guard let index = chat.turns.lastIndex(where: { !$0.user.isEmpty || $0.running }) else { return chat }
                    var next = chat
                    if !next.turns[index].running {
                        next.turns[index].running = true
                        next.turns[index].queued = false
                        next.turns[index].status = status
                    }
                    return next
                }
            }
        case .error(let id, let text):
            bannerError = friendlyError(text)
            patchOpen(id ?? activeId) { turn in
                var next = turn.settled(status: "error")
                next.error = text
                return next
            }
        case .done(let id, let status, let duration):
            patchOpen(id) { turn in
                turn.settled(status: status, durationMs: duration)
            }
            scheduleSync()
        case .history(let id, let rows):
            let incoming = rows.compactMap(Turn.from)
            guard !incoming.isEmpty else { break }
            patch(id) { chat in
                var next = chat
                if next.turns.isEmpty {
                    next.turns = incoming
                } else if incoming.count > next.turns.count {
                    next.turns = incoming
                }
                return next
            }
        case .chatTitle(let id, let title):
            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { break }
            patch(id) { chat in
                guard chat.isUntitled else { return chat }
                var next = chat
                next.title = trimmed
                return next
            }
        case .pong, .ignored:
            break
        }
    }

    private func send(_ message: ClientMessage) {
        if case .hello = message {
            client.send(message)
            return
        }
        guard unlocked else { return }
        client.send(message)
    }

    private func ensureActiveChat() {
        if chats.isEmpty {
            let chat = ChatSession.blank(cwd: cwd.nilIfEmpty ?? workspaceRoot, model: model, mode: mode)
            chats = [chat]
            activeId = chat.id
            send(.newSession(chatId: chat.id, cwd: chat.cwd))
        }
    }

    private func persistDraft() {
        patch(activeId) { chat in
            var next = chat
            next.draft = self.draft
            next.model = self.model
            next.mode = self.mode
            next.cwd = chat.cwd ?? self.cwd
            return next
        }
    }

    private func applySession(_ chat: ChatSession?) {
        guard let chat else { return }
        draft = chat.draft
        mode = chat.mode
        if let sessionModel = chat.sessionModel {
            model = ModelCatalog.resolve(preferred: sessionModel, ids: models, fallback: model)
        }
        if let path = chat.cwd, !path.isEmpty {
            cwd = path
            send(.setWorkspace(cwd: path, chatId: chat.id, create: nil))
        }
        if let agentId = chat.agentId, !agentId.isEmpty {
            send(.resumeSession(chatId: chat.id, agentId: agentId))
        }
    }

    private func markLive(running: [String], queued: [String]) {
        let keep = Set(running + queued)
        let queuedSet = Set(queued)
        chats = chats.map { chat in
            var next = chat
            if !keep.contains(chat.id) {
                next.turns = next.turns.map { turn in
                    turn.running || turn.tools.contains(where: { $0.status == "running" })
                        ? turn.settled(status: turn.status ?? "cancelled")
                        : turn
                }
            }
            if queuedSet.contains(chat.id), !next.turns.contains(where: { $0.queued || $0.running }),
               let last = next.turns.lastIndex(where: { !$0.user.trimmingCharacters(in: .whitespaces).isEmpty })
            {
                next.turns[last].queued = true
            }
            return next
        }
    }

    private func merge(local: [ChatSession], remote: [ChatSession]) -> [ChatSession] {
        let localById = Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) })
        return remote.map { chat in
            guard let current = localById[chat.id] else { return chat }
            let localWeight = current.turns.reduce(0) { $0 + $1.user.count + $1.assistant.count }
            let remoteWeight = chat.turns.reduce(0) { $0 + $1.user.count + $1.assistant.count }
            if current.turns.contains(where: \.running) || localWeight > remoteWeight {
                var keep = current
                keep.agentId = current.agentId ?? chat.agentId
                keep.cwd = current.cwd ?? chat.cwd
                keep.draft = current.draft.isEmpty ? chat.draft : current.draft
                return keep
            }
            var next = chat
            next.cwd = current.cwd ?? chat.cwd
            next.draft = current.draft.isEmpty ? chat.draft : current.draft
            next.agentId = current.agentId ?? chat.agentId
            return next
        }
    }

    private func patch(_ id: String, _ update: (ChatSession) -> ChatSession) {
        guard let index = chats.firstIndex(where: { $0.id == id }) else { return }
        chats[index] = update(chats[index])
        scheduleSync()
    }

    private func patchRunning(_ id: String, _ update: (Turn) -> Turn) {
        patch(id) { chat in
            var next = chat
            if let index = next.turns.lastIndex(where: \.running) {
                next.turns[index] = update(next.turns[index])
            } else if let index = next.turns.indices.last {
                var turn = next.turns[index]
                turn.running = true
                next.turns[index] = update(turn)
            }
            return next
        }
    }

    private func patchOpen(_ id: String, _ update: (Turn) -> Turn) {
        patch(id) { chat in
            var next = chat
            if let index = next.turns.lastIndex(where: { $0.running || $0.tools.contains(where: { $0.status == "running" }) }) {
                next.turns[index] = update(next.turns[index])
            }
            return next
        }
    }

    private func markProgress(_ chatId: String) {
        lastProgress = Date()
        armStallWatch(chatId)
    }

    private func armStallWatch(_ chatId: String) {
        stallTask?.cancel()
        stallTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled else { return }
                let live = chats.first { $0.id == chatId }?.turns.contains(where: { $0.running || $0.tools.contains(where: { $0.status == "running" }) }) == true
                guard live else { return }
                if Date().timeIntervalSince(lastProgress) >= 90 {
                    notice = "这一轮没有新进展。如果一直转圈，点停止再发一次。"
                    return
                }
            }
        }
    }

    private func scheduleSync() {
        if chats.count == 1, chats[0].id == "boot" { return }
        syncTask?.cancel()
        syncTask = Task {
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled, unlocked else { return }
            stateRev += 1
            send(.syncState(chats: .array(chats.map { $0.json() }), rev: stateRev))
        }
    }

    private func rememberModel(_ id: String) {
        lastModel = id
        UserDefaults.standard.set(id, forKey: ModelCatalog.lastModelKey)
    }

    private func armVerifyTimeout() {
        verifyTask?.cancel()
        verifyTask = Task {
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled, !unlocked else { return }
            verifying = false
            authError = "验证超时，请再试一次。"
        }
    }

    private func flash(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(3.5))
            guard !Task.isCancelled, notice == text else { return }
            notice = ""
        }
    }
}

private func samePath(_ a: String, _ b: String) -> Bool {
    URL(fileURLWithPath: a).standardizedFileURL.path == URL(fileURLWithPath: b).standardizedFileURL.path
}

private func mergeOutput(_ result: JSONValue?, stream: String?, chunk: String?, stdout: String?, stderr: String?) -> JSONValue {
    var record = result?.object ?? [:]
    if record["stdout"] == nil { record["stdout"] = .string("") }
    if record["stderr"] == nil { record["stderr"] = .string("") }
    if let stdout { record["stdout"] = .string(stdout) }
    if let stderr { record["stderr"] = .string(stderr) }
    if let chunk, !chunk.isEmpty {
        let key = stream == "stderr" ? "stderr" : "stdout"
        record[key] = .string((record[key]?.string ?? "") + chunk)
    }
    return .object(record)
}
