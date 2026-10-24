import SwiftUI

struct PadSceneCommandDelivery {
    let sceneToken: String
}

extension Notification.Name {
    static let padSceneSearchRequested = Notification.Name("PadSceneSearchRequested")
    static let padSceneSidebarToggleRequested = Notification.Name("PadSceneSidebarToggleRequested")
    static let assistantComposerFocusRequested = Notification.Name("AssistantComposerFocusRequested")
}

/// 由当前前台场景通过 FocusedValue 提供，菜单动作不会广播到其它窗口。
struct PadCommandActions {
    let openDomain: (PadDomain) -> Void
    let openSection: (PadAssistantSection) -> Void
    let search: () -> Void
    let create: () -> Void
    let openFile: () -> Void
    let refresh: () -> Void
    let closeOverlay: () -> Void
    let previous: () -> Void
    let next: () -> Void
    let toggleSidebar: () -> Void
}

private struct PadCommandActionsKey: FocusedValueKey {
    typealias Value = PadCommandActions
}

extension FocusedValues {
    var padCommandActions: PadCommandActions? {
        get { self[PadCommandActionsKey.self] }
        set { self[PadCommandActionsKey.self] = newValue }
    }
}

/// iPad 键盘菜单。快捷键只登记在这里，页面按钮只显示功能，避免重复冲突。
struct PadAppCommands: Commands {
    @FocusedValue(\.padCommandActions) private var actions

    var body: some Commands {
        CommandMenu("空间") {
            domainButton(.assistant, key: "1")
            domainButton(.workbench, key: "2")
            domainButton(.messages, key: "3")
        }

        CommandMenu("小驳导航") {
            sectionButton(.today, key: "1")
            sectionButton(.inbox, key: "2")
            sectionButton(.tasks, key: "3")
            sectionButton(.artifacts, key: "4")
            sectionButton(.memory, key: "5")
            Divider()
            Button("上一处") { actions?.previous() }
                .keyboardShortcut("[", modifiers: .command)
            Button("下一处") { actions?.next() }
                .keyboardShortcut("]", modifiers: .command)
            Button("显示或隐藏侧栏") { actions?.toggleSidebar() }
                .keyboardShortcut("s", modifiers: [.command, .option])
        }

        CommandMenu("操作") {
            Button("搜索") { actions?.search() }
                .keyboardShortcut("f", modifiers: .command)
            Button("新建") { actions?.create() }
                .keyboardShortcut("n", modifiers: .command)
            Button("打开文件") { actions?.openFile() }
                .keyboardShortcut("o", modifiers: .command)
            Button("刷新") { actions?.refresh() }
                .keyboardShortcut("r", modifiers: .command)
            Divider()
            Button("关闭检查器或预览") { actions?.closeOverlay() }
                .keyboardShortcut(.escape, modifiers: [])
        }
    }

    private func domainButton(_ domain: PadDomain, key: Character) -> some View {
        Button("打开\(domain.title)") { actions?.openDomain(domain) }
            .keyboardShortcut(KeyEquivalent(key), modifiers: .command)
            .disabled(actions == nil)
    }

    private func sectionButton(_ section: PadAssistantSection, key: Character) -> some View {
        Button("打开\(section.title)") { actions?.openSection(section) }
            .keyboardShortcut(KeyEquivalent(key), modifiers: [.command, .option])
            .disabled(actions == nil)
    }
}
