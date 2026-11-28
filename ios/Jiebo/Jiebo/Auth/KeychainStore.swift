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
    /// 进程内令牌内存缓存：避免图片下载、录音分片与分享上传等高频路径每次都走 securityd 跨进程 IPC。
    /// 语义约束：仅主 App 会写/删令牌，Share Extension 短命只读；cacheVersion 与 writeLock 共同防止并发 delete/save 导致的旧令牌脏回填。
    private static let cacheLock = NSLock()
    private static let writeLock = NSLock()
    private static var cachedToken: String?
    private static var cacheVersion: UInt64 = 0

    static func token() -> String? {
        cacheLock.lock()
        if let hit = cachedToken {
            cacheLock.unlock()
            return hit
        }
        let readVersion = cacheVersion
        cacheLock.unlock()

        if let shared = read(accessGroup: sharedAccessGroup) {
            cacheLock.lock()
            if cacheVersion == readVersion {
                cachedToken = shared
            }
            cacheLock.unlock()
            return shared
        }
        // 扩展没有旧应用组权限；只有主 App 能读取旧项并执行迁移。
        guard !isShareExtension, let legacy = read(accessGroup: legacyAccessGroup) else { return nil }
        writeLock.lock()
        if upsert(legacy, accessGroup: sharedAccessGroup) == errSecSuccess {
            delete(accessGroup: legacyAccessGroup)
        }
        writeLock.unlock()
        cacheLock.lock()
        if cacheVersion == readVersion {
            cachedToken = legacy
        }
        cacheLock.unlock()
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
        writeLock.lock()
        defer { writeLock.unlock() }
        cacheLock.lock()
        cacheVersion &+= 1
        cachedToken = nil
        cacheLock.unlock()

        let sharedStatus = upsert(token, accessGroup: sharedAccessGroup)
        if sharedStatus == errSecSuccess {
            if !isShareExtension { delete(accessGroup: legacyAccessGroup) }
            cacheLock.lock()
            cacheVersion &+= 1
            cachedToken = token.isEmpty ? nil : token
            cacheLock.unlock()
            return
        }
        // 开发配置尚未带共享钥匙串 entitlement 时，主 App 仍保存到自己的旧应用组。
        // 扩展绝不回退写旧组，以免掩盖共享配置错误。
        if !isShareExtension {
            let legacyStatus = upsert(token, accessGroup: legacyAccessGroup)
            cacheLock.lock()
            cacheVersion &+= 1
            cachedToken = (legacyStatus == errSecSuccess && !token.isEmpty) ? token : nil
            cacheLock.unlock()
        } else {
            cacheLock.lock()
            cacheVersion &+= 1
            cachedToken = nil
            cacheLock.unlock()
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
        writeLock.lock()
        defer { writeLock.unlock() }
        // 双重版本屏障：删除前清空防读穿透缓存，删除后再递增版本防删除窗口内的并发读回填旧令牌。
        cacheLock.lock()
        cacheVersion &+= 1
        cachedToken = nil
        cacheLock.unlock()
        delete(accessGroup: sharedAccessGroup)
        if !isShareExtension { delete(accessGroup: legacyAccessGroup) }
        cacheLock.lock()
        cacheVersion &+= 1
        cachedToken = nil
        cacheLock.unlock()
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
