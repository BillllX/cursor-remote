import Foundation

extension ChatStore {
    func requestWorkspaceAgents(reset: Bool = true) {
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
        chatSession(chatId)?.turns.contains(where: \.running) == true
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
}
