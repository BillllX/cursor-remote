import Foundation
import Security

enum KeychainStore {
    private static let service = "ai.jiebo.ipad"
    private static let account = "gateway-token"
    // Team ID 与 project.pbxproj 的 DEVELOPMENT_TEAM、entitlements 里的 $(AppIdentifierPrefix) 是同一个值；换签名主体时三处一起改。
    private static let legacyAccessGroup = "8M43BMB6J8.ai.jiebo.ipad"
    private static let sharedAccessGroup = "8M43BMB6J8.group.ai.jiebo.ipad"
    private static var isShareExtension: Bool {
        Bundle.main.bundleIdentifier == "ai.jiebo.ipad.share"
    }

    static func token() -> String? {
        if let shared = read(accessGroup: sharedAccessGroup) { return shared }
        // 扩展没有旧应用组权限；只有主 App 能读取旧项并执行迁移。
        guard !isShareExtension, let legacy = read(accessGroup: legacyAccessGroup) else { return nil }
        if upsert(legacy, accessGroup: sharedAccessGroup) == errSecSuccess {
            delete(accessGroup: legacyAccessGroup)
        }
        return legacy
    }

    private static func read(accessGroup: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8), !value.isEmpty else {
            return nil
        }
        return value
    }

    static func save(_ token: String) {
        let sharedStatus = upsert(token, accessGroup: sharedAccessGroup)
        if sharedStatus == errSecSuccess {
            if !isShareExtension { delete(accessGroup: legacyAccessGroup) }
            return
        }
        // 开发配置尚未带共享钥匙串 entitlement 时，主 App 仍保存到自己的旧应用组。
        // 扩展绝不回退写旧组，以免掩盖共享配置错误。
        if !isShareExtension {
            _ = upsert(token, accessGroup: legacyAccessGroup)
        }
    }

    @discardableResult
    private static func upsert(_ token: String, accessGroup: String) -> OSStatus {
        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        let payload = token.data(using: .utf8) ?? Data()
        let updated = SecItemUpdate(
            match as CFDictionary,
            [kSecValueData as String: payload] as CFDictionary
        )
        guard updated == errSecItemNotFound else { return updated }
        var item = match
        item[kSecValueData as String] = payload
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil)
    }

    static func delete() {
        delete(accessGroup: sharedAccessGroup)
        if !isShareExtension { delete(accessGroup: legacyAccessGroup) }
    }

    private static func delete(accessGroup: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
