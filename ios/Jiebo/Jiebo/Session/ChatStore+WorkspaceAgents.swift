import Foundation

extension ChatStore {
    func requestWorkspaceAgents(reset: Bool = true) {
        guard connected, unlocked, gatewayReady else { return }
        if reset {
            workspaceAgentsLoaded = false
            workspaceAgentsPendingCursor = nil
        }
        send(.workspaceAgentList(cursor: reset ? nil : workspaceAgentsPendingCursor))
    }

    func chatSession(_ chatId: String) -> ChatSession? {
        chats.first { $0.id == chatId }
    }

    func draft(for chatId: String) -> String {
        chatSession(chatId)?.draft ?? ""
    }

    func mode(for chatId: String) -> AgentMode {
        chatSession(chatId)?.mode ?? .agent
    }

    func model(for chatId: String) -> String {
        chatSession(chatId)?.sessionModel ?? model
    }

    func isBusy(_ chatId: String) -> Bool {
        guard let chat = chatSession(chatId) else { return false }
        return chatShowsRunning(chat)
    }

    func pendingImages(for chatId: String) -> [PendingImage] {
        chatId == activeId ? pendingImages : (imagesByChat[chatId] ?? [])
    }

    var workspaceUnreadCount: Int {
        workspaceAgents.reduce(0) { $0 + $1.unread }
    }

    func openWorkspaceAgent(_ item: WorkspaceAgentItem) {
        pendingWorkspacePath = item.path
        chatHomeDestination = .workspace(item.path)
        send(.workspaceAgentOpen(path: item.path))
    }

    /// 多窗口入口只请求规范化服务数据，不改任何窗口的导航选择。还没登录或没连上时不发，免得界面假装正在打开。
    func requestWorkspaceAgent(_ item: WorkspaceAgentItem) {
        guard unlocked, connected else { return }
        if let chatId = item.mainChatId {
            ensureTurnsLoaded(chatId)
        } else {
            send(.workspaceAgentOpen(path: item.path))
        }
    }

    func prepareWorkspaceThread(_ item: WorkspaceAgentItem, chatId: String) {
        ensureTurnsLoaded(chatId)
        send(.workspaceAgentViewing(chatId: chatId))
        send(.workspaceAgentRead(chatId: chatId, seq: item.finishedSeq))
    }

    func enterWorkspaceThread(path: String, chatId: String) {
        pendingWorkspacePath = nil
        chatHomeThreadChatId = chatId
        WorkspaceViewingBeacon.shared.set(chatId)
        chatHomeDestination = .workspace(path)
        ensureTurnsLoaded(chatId)
        send(.workspaceAgentViewing(chatId: chatId))
        if let item = workspaceAgents.first(where: { $0.path == path }) {
            send(.workspaceAgentRead(chatId: chatId, seq: item.finishedSeq))
        }
    }

    func leaveWorkspaceThread() {
        pendingWorkspacePath = nil
        chatHomeThreadChatId = nil
        WorkspaceViewingBeacon.shared.set(nil)
        send(.workspaceAgentViewing(chatId: nil))
    }

    func updateWorkspaceProfile(path: String, displayName: String?, avatar: String?) {
        send(.workspaceAgentProfile(path: path, displayName: displayName, avatar: avatar))
    }

    func workspaceAgent(chatId: String) -> WorkspaceAgentItem? {
        workspaceAgents.first { $0.mainChatId == chatId }
    }

    /// 会话 id 对不上主会话时，再按它所在目录认工作区。
    func workspaceAgentForWorkbench(chatId: String?) -> WorkspaceAgentItem? {
        guard let chatId, !chatId.isEmpty else { return nil }
        if let direct = workspaceAgents.first(where: { $0.mainChatId == chatId }) {
            return direct
        }
        guard let chatCwd = chats.first(where: { $0.id == chatId })?.cwd?.nilIfEmpty else {
            return nil
        }
        return workspaceAgents.first { sameCwd($0.path, chatCwd) }
    }

    /// 工作台在前台看着某个工作区会话时，同步 viewing 信标并消掉这个工作区的未读。
    func syncWorkbenchAgentViewing(chatId: String?, active: Bool = true) {
        guard active, unlocked, let chatId, !chatId.isEmpty, isWorkspaceChat(chatId) else {
            WorkspaceViewingBeacon.shared.set(nil)
            if connected { send(.workspaceAgentViewing(chatId: nil)) }
            return
        }
        WorkspaceViewingBeacon.shared.set(chatId)
        guard connected else { return }
        if let item = workspaceAgentForWorkbench(chatId: chatId) {
            let reportChatId = item.mainChatId ?? chatId
            send(.workspaceAgentViewing(chatId: reportChatId))
            if item.unread > 0 || item.readSeq < item.finishedSeq {
                if let idx = workspaceAgents.firstIndex(where: { $0.path == item.path }) {
                    workspaceAgents[idx].unread = 0
                    workspaceAgents[idx].readSeq = max(workspaceAgents[idx].readSeq, item.finishedSeq)
                }
                send(.workspaceAgentRead(chatId: reportChatId, seq: item.finishedSeq))
            }
        } else {
            send(.workspaceAgentViewing(chatId: nil))
        }
    }

    func workspaceAgent(path: String) -> WorkspaceAgentItem? {
        workspaceAgents.first { $0.path == path }
    }

    func openAssistantFromChatHome() {
        pendingWorkspacePath = nil
        chatHomeDestination = .assistant
        guard let chatId = assistantChatId else {
            chatHomeThreadChatId = nil
            return
        }
        chatHomeThreadChatId = chatId
        ensureTurnsLoaded(chatId)
        WorkspaceViewingBeacon.shared.set(nil)
        send(.workspaceAgentViewing(chatId: nil))
    }

    /// 为 scene-local 导航准备助理数据，不写 chatHomeDestination。
    func prepareAssistantThread() {
        guard let chatId = assistantChatId else { return }
        ensureTurnsLoaded(chatId)
        send(.workspaceAgentViewing(chatId: nil))
    }
}
