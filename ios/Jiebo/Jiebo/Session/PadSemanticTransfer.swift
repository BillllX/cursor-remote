import CoreTransferable
import Foundation
import UniformTypeIdentifiers

extension UTType {
    static let jieboPadSemantic = UTType(exportedAs: "ai.jiebo.ipad.semantic")
}

/// 拖放只携带稳定身份，不复制可能过期的正文；落点必须回到当前投影验证实体。
struct PadSemanticTransfer: Codable, Hashable, Identifiable, Transferable {
    typealias Kind = PadSemanticKind

    let kind: Kind
    let stableID: String
    let title: String
    let version: Int

    var id: String { "\(kind.rawValue):\(stableID)" }

    init(kind: Kind, stableID: String, title: String, version: Int = 1) {
        self.kind = kind
        self.stableID = stableID
        self.title = title
        self.version = version
    }

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .jieboPadSemantic)
        // 外部 App 不认识 Jiebo 类型时仍可接收可读标题；回到 Jiebo 时始终优先使用稳定 typed payload。
        ProxyRepresentation(exporting: \.title)
    }

    var isValid: Bool {
        version == 1 && !stableID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
