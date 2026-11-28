import Contacts
import Foundation

actor AppleContactsService {
    private let store = CNContactStore()
    private let contactFormatter = CNContactFormatter()
    private let fetchKeys: [CNKeyDescriptor] = [
        CNContactIdentifierKey as CNKeyDescriptor,
        CNContactGivenNameKey as CNKeyDescriptor,
        CNContactFamilyNameKey as CNKeyDescriptor,
        CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
    ]

    func search(_ request: ContactsSearchRequest) async throws -> JSONValue {
        try await requireAccess()
        do {
            let contacts = try store.unifiedContacts(
                matching: CNContact.predicateForContacts(matchingName: request.query),
                keysToFetch: fetchKeys
            )
            var out: [JSONValue] = []
            out.reserveCapacity(min(contacts.count, request.limit))
            for contact in contacts.prefix(request.limit) {
                out.append(contactJSON(contact))
            }
            return .object(["contacts": .array(out)])
        } catch {
            throw DeviceRequestError.unavailable("搜索通讯录失败，再试一次。")
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
                throw DeviceRequestError.unavailable("请求通讯录权限失败，再试一次。")
            }
        case .limited:
            return
        @unknown default:
            throw DeviceRequestError.unavailable("无法识别通讯录权限状态。")
        }
    }

    private func contactJSON(_ contact: CNContact) -> JSONValue {
        let displayName: String
        if let formatted = contactFormatter.string(from: contact) {
            displayName = formatted
        } else if contact.familyName.isEmpty {
            displayName = contact.givenName
        } else if contact.givenName.isEmpty {
            displayName = contact.familyName
        } else {
            displayName = contact.familyName + contact.givenName
        }
        return .object([
            "identifier": .string(contact.identifier),
            "displayName": .string(displayName.isEmpty ? contact.organizationName : displayName),
            "emails": .array(contact.emailAddresses.map { .string($0.value as String) }),
            "phones": .array(contact.phoneNumbers.map { .string($0.value.stringValue) }),
        ])
    }
}
