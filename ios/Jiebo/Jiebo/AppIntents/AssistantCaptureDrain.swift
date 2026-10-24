import Foundation

@MainActor
enum AssistantCaptureDrain {
    private static var running = false

    static func run(store: ChatStore) async {
        guard !running, !store.tenantId.isEmpty else { return }
        running = true
        defer { running = false }

        let tenant = store.tenantId
        let captures = AssistantCaptureBridge.pending(tenant: tenant)
        guard !captures.isEmpty else { return }
        NotificationCenter.default.post(name: .assistantCaptureOpenRequested, object: nil)
        store.openAssistantChat()

        var waited = 0
        while (!store.unlocked || store.assistantChatId == nil), waited < 100, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(100))
            waited += 1
        }
        guard !Task.isCancelled, let chatId = store.assistantChatId else { return }

        for capture in captures {
            guard capture.tenant == tenant else { continue }
            if capture.action == .voice {
                // 走现有 VoiceDictation，仍由系统权限弹窗把关，不绕过麦克风授权。
                try? await Task.sleep(for: .milliseconds(250))
                NotificationCenter.default.post(name: .assistantVoiceRequested, object: capture)
                break
            }
            let prompt = AssistantCaptureBridge.prompt(for: capture)
            guard !prompt.isEmpty else { continue }
            let before = store.chatSession(chatId)?.turns.count ?? 0
            store.submit(chatId: chatId, text: prompt)
            let after = store.chatSession(chatId)?.turns.count ?? 0
            if after > before {
                AssistantCaptureBridge.remove(id: capture.id, tenant: tenant)
            } else {
                break
            }
        }
    }
}
