import Foundation

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        FileHandle.standardError.write(Data("❌ Widget Swift 契约：\(message)\n".utf8))
        exit(1)
    }
}

let now = Date(timeIntervalSince1970: 1_700_000_000)
let snapshot = WidgetSnapshot(
    loginState: .loggedIn,
    assistantStatus: .needsAttention,
    statusText: "有 2 项待处理",
    unreadCount: 2,
    todoCount: 1,
    highlight: .init(
        kind: .todo,
        id: "todo-1?bad=value",
        summary: "联系 test@example.com 查看 https://example.com/private 编号 12345678"
    ),
    updatedAt: now,
    staleAfter: now.addingTimeInterval(WidgetSnapshot.staleInterval),
    privacyMode: false
)

require(snapshot.highlight?.id == "todo-1badvalue", "实体 id 必须去掉 URL/query 控制字符")
require(snapshot.highlight?.summary.contains("example.com") == false, "摘要必须去掉邮箱和 URL")
require(snapshot.highlight?.summary.contains("12345678") == false, "摘要必须去掉长数字")
require(snapshot.contentFingerprint.contains("1700000000") == false, "内容指纹不得包含更新时间")

let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("jiebo-widget-contract-\(UUID().uuidString)", isDirectory: true)
defer { try? FileManager.default.removeItem(at: root) }

do {
    try WidgetSnapshotStore.save(snapshot, to: root)
    let first = WidgetSnapshotStore.load(from: root)
    require(first?.highlight?.summary == snapshot.highlight?.summary, "原子写入后必须可解码")

    var changed = snapshot
    changed.todoCount = 4
    try WidgetSnapshotStore.save(changed, to: root)
    require(WidgetSnapshotStore.load(from: root)?.todoCount == 4, "已有快照必须原子替换")

    let leftovers = try FileManager.default.contentsOfDirectory(atPath: root.path)
        .filter { $0.hasSuffix(".tmp") }
    require(leftovers.isEmpty, "写入后不得残留临时文件")
} catch {
    require(false, "原子写入失败：\(error)")
}

do {
    let compatible = Data(#"{"schema":1,"loginState":"loggedIn","assistantStatus":"available","statusText":"正常"}"#.utf8)
    try compatible.write(to: WidgetSnapshotStore.fileURL(in: root))
    let decoded = WidgetSnapshotStore.load(from: root)
    require(decoded?.privacyMode == true, "缺字段旧快照必须安全降级并默认隐藏隐私摘要")
    require(decoded?.unreadCount == 0, "缺少计数字段时必须回落为 0")

    let incompatible = Data(#"{"schema":999}"#.utf8)
    try incompatible.write(to: WidgetSnapshotStore.fileURL(in: root))
    require(WidgetSnapshotStore.load(from: root) == nil, "未来 schema 必须解码失败而非误读")

    try Data("{not-json".utf8).write(to: WidgetSnapshotStore.fileURL(in: root))
    require(WidgetSnapshotStore.load(from: root) == nil, "损坏快照必须返回 nil")
} catch {
    require(false, "兼容解码测试失败：\(error)")
}

print("Widget Swift 契约：最小模型、去敏、原子替换与失败降级通过")
