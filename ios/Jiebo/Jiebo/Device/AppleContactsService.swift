import Contacts
import Foundation

actor AppleContactsService {
    private let store = CNContactStore()

    func search(_ request: ContactsSearchRequest) async throws -> JSONValue {
        try await requireAccess()
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
        ]
        do {
            let contacts = try store.unifiedContacts(
                matching: CNContact.predicateForContacts(matchingName: request.query),
                keysToFetch: keys
            )
            return .object([
                "contacts": .array(contacts.prefix(request.limit).map(Self.contactJSON)),
            ])
        } catch {
            throw DeviceRequestError.unavailable("搜索通讯录失败：\(error.localizedDescription)")
        }
    }

    private func requireAccess() async throws {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized:
            return
        case .denied, .restricted:
            throw DeviceRequestError.permissionDenied("没有通讯录访问权限。")
        case .notDetermined:
            do {
                guard try await store.requestAccess(for: .contacts) else {
                    throw DeviceRequestError.permissionDenied("用户拒绝了通讯录访问权限。")
                }
            } catch let error as DeviceRequestError {
                throw error
            } catch {
                let updated = CNContactStore.authorizationStatus(for: .contacts)
                if updated == .denied || updated == .restricted {
                    throw DeviceRequestError.permissionDenied("通讯录权限已被拒绝。")
                }
                throw DeviceRequestError.unavailable("请求通讯录权限失败：\(error.localizedDescription)")
            }
        case .limited:
            return
        @unknown default:
            throw DeviceRequestError.unavailable("无法识别通讯录权限状态。")
        }
    }

    private static func contactJSON(_ contact: CNContact) -> JSONValue {
        let formatter = CNContactFormatter()
        let displayName = formatter.string(from: contact)
            ?? [contact.familyName, contact.givenName].filter { !$0.isEmpty }.joined()
        return .object([
            "identifier": .string(contact.identifier),
            "displayName": .string(displayName.isEmpty ? contact.organizationName : displayName),
            "emails": .array(contact.emailAddresses.map { .string($0.value as String) }),
            "phones": .array(contact.phoneNumbers.map { .string($0.value.stringValue) }),
        ])
    }
}
