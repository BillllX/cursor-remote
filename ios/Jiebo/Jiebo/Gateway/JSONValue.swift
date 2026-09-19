import Foundation
import CoreFoundation

/// JSON bag used by `shared/protocol.ts` `unknown` fields.
enum JSONValue: Sendable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var int: Int? {
        guard let number else { return nil }
        return Int(number)
    }

    var object: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var array: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    subscript(key: String) -> JSONValue? {
        object?[key]
    }

    init(_ any: Any) {
        switch any {
        case let value as String:
            self = .string(value)
        case let value as Bool:
            self = .bool(value)
        case let value as NSNumber:
            if CFGetTypeID(value) == CFBooleanGetTypeID() {
                self = .bool(value.boolValue)
            } else {
                self = .number(value.doubleValue)
            }
        case let value as [String: Any]:
            self = .object(value.mapValues(JSONValue.init))
        case let value as [Any]:
            self = .array(value.map(JSONValue.init))
        case is NSNull:
            self = .null
        default:
            self = .null
        }
    }

    func jsonObject() -> Any {
        switch self {
        case .string(let value): return value
        case .number(let value):
            if value.rounded() == value, let int = Int(exactly: value) {
                return int
            }
            return value
        case .bool(let value): return value
        case .object(let value): return value.mapValues { $0.jsonObject() }
        case .array(let value): return value.map { $0.jsonObject() }
        case .null: return NSNull()
        }
    }

    func data() throws -> Data {
        try JSONSerialization.data(withJSONObject: jsonObject(), options: [])
    }

    static func parse(_ data: Data) throws -> JSONValue {
        let object = try JSONSerialization.jsonObject(with: data)
        return JSONValue(object)
    }

    func pretty(_ limit: Int = 400) -> String {
        switch self {
        case .string(let value):
            return String(value.prefix(limit))
        case .null:
            return ""
        default:
            guard let data = try? JSONSerialization.data(withJSONObject: jsonObject(), options: [.prettyPrinted, .sortedKeys]),
                  let text = String(data: data, encoding: .utf8)
            else { return "" }
            return String(text.prefix(limit))
        }
    }

    func string(in keys: String...) -> String {
        guard let object else { return "" }
        for key in keys {
            if let value = object[key]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }
        return ""
    }
}
