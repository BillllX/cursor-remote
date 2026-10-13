import Foundation

extension ChatStore: ImTransport {
    var imTenantId: String { tenantId }

    var imToken: String {
        tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? KeychainStore.token() ?? ""
    }

    var imLinkOpen: Bool { unlocked && client.isOpen }

    /// 断线时 GatewayClient 会把消息塞进发件箱；ImStore 只在 online 时调，im_send 另外先看 imLinkOpen
    func imSend(_ message: ClientMessage) {
        guard unlocked else { return }
        client.send(message)
    }
}
