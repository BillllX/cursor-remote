#if DEBUG
import SwiftUI
import UIKit
import WebKit

/// Opt-in, app-level simulator regressions. Not included in release builds.
@MainActor
enum NavigationRegression {
    /// Exercises real mounted views with a signed-in test account; never sends messages or edits files.
    @MainActor
    static func runPhone(store: ChatStore, router: PhoneRouter, sceneSession: SceneSessionState?,
                         sceneToken: String, switchSpace: (PhoneTab) -> Void) async {
        var checks: [String: Bool] = [:]
        func settle() async { try? await Task.sleep(for: .milliseconds(450)) }
        func oneEditor() -> Bool {
            PhoneNavigationDiagnostics.editors.values.filter { $0 == sceneToken }.count == 1
        }
        for _ in 0..<40 {
            if store.chats.filter({ store.isWorkspaceChat($0.id) }).count >= 2 { break }
            try? await Task.sleep(for: .milliseconds(250))
            if Task.isCancelled { return }
        }
        var fixturePath: String?
        if ProcessInfo.processInfo.arguments.contains("--phone-navigation-fixture"),
           store.chats.filter({ store.isWorkspaceChat($0.id) }).count < 2 {
            let name = "ios-navigation-check-" + UUID().uuidString.prefix(8)
            switchSpace(.workspace)
            await settle()
            store.newWorkspaceName = name
            store.createWorkspace()
            for _ in 0..<40 {
                if let item = store.workspaces.first(where: { $0.name == name }),
                   store.chats.contains(where: { sameCwd($0.cwd, item.path) }) {
                    fixturePath = item.path
                    break
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        let targets = Array(store.chats.filter { store.isWorkspaceChat($0.id) }.prefix(2).map(\.id))
        router.popToRoot()
        await settle()
        let assistantMount = PhoneNavigationDiagnostics.mounted.first { $0.value == store.assistantChatId }?.key
        checks["assistant mounted"] = assistantMount != nil
        checks["one assistant editor"] = oneEditor()
        router.go(.inbox)
        await settle()
        checks["inbox route"] = router.path == [.inbox]
        router.go(.memory)
        await settle()
        router.path.append(.memoryPage(.me))
        await settle()
        checks["memory shares one navigation stack"] = router.path.count == 2
        switchSpace(.workspace)
        await settle()
        switchSpace(.assistant)
        await settle()
        checks["space switch preserves navigation"] = router.path == [.memory, .memoryPage(.me)]
        router.popToRoot()
        await settle()
        checks["workspace test data available"] = !targets.isEmpty
        if let first = targets.first {
            switchSpace(.workspace)
            await settle()
            sceneSession?.workbenchChatId = first
            store.activateWorkspaceChat(first)
            await settle()
            let firstMount = PhoneNavigationDiagnostics.mounted.first { $0.value == first }?.key
            checks["one workspace editor"] = oneEditor()
            switchSpace(.assistant)
            await settle()
            checks["assistant does not switch active workspace"] = store.activeId == first
            checks["assistant view identity retained"] = assistantMount != nil && PhoneNavigationDiagnostics.mounted[assistantMount!] == store.assistantChatId
            checks["hidden workspace releases editing"] = oneEditor()
            switchSpace(.workspace)
            await settle()
            checks["workbench view identity retained"] = firstMount != nil && PhoneNavigationDiagnostics.mounted[firstMount!] == first
            if let second = targets.dropFirst().first {
                sceneSession?.workbenchChatId = second
                store.activateWorkspaceChat(second)
                await settle()
                sceneSession?.workbenchChatId = first
                store.activateWorkspaceChat(first)
                await settle()
                checks["workspace thread identity retained"] = firstMount != nil && PhoneNavigationDiagnostics.mounted[firstMount!] == first
                checks["one editor after workspace roundtrip"] = oneEditor()
            }
        }
        switchSpace(.assistant)
        router.go(.worklist(.todo))
        await settle()
        checks["schedule route"] = router.path == [.worklist(.todo)]
        router.go(.artifacts)
        await settle()
        checks["files route"] = router.path == [.artifacts]
        router.popToRoot()
        await settle()
        if let fixturePath {
            let fixtureChats = store.chats.filter { sameCwd($0.cwd, fixturePath) }
            // Only delete the empty fixture created by this invocation, never existing test-account content.
            if fixtureChats.allSatisfy({ $0.turns.isEmpty && !store.chatShowsRunning($0) }) {
                if let original = store.chats.first(where: { store.isWorkspaceChat($0.id) && !sameCwd($0.cwd, fixturePath) }) {
                    sceneSession?.workbenchChatId = original.id
                }
                for chat in fixtureChats { store.deleteChat(chat.id) }
                await settle()
                store.deleteWorkspace(fixturePath)
                for _ in 0..<40 {
                    if !store.workspaces.contains(where: { sameCwd($0.path, fixturePath) }) { break }
                    try? await Task.sleep(for: .milliseconds(250))
                }
                checks["temporary workspace cleaned up"] = !store.workspaces.contains { sameCwd($0.path, fixturePath) }
            } else {
                checks["temporary workspace cleaned up"] = false
            }
        }
        let report: [String: Any] = [
            "passed": checks.values.allSatisfy { $0 }, "checks": checks,
            "workspaceThreadsAvailable": targets.count,
            "skipped": targets.count < 2 ? ["workspace pair roundtrip: account has fewer than two workspace threads"] : []
        ]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            let url = URL.documentsDirectory.appending(path: "phone-navigation-smoke.json")
            try? data.write(to: url, options: .atomic)
        }
        if let arg = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--phone-smoke-final=") }) {
            switch String(arg.dropFirst("--phone-smoke-final=".count)) {
            case "workspace": switchSpace(.workspace)
            case "inbox": router.go(.inbox)
            case "schedule": router.go(.worklist(.todo))
            case "files": router.go(.artifacts)
            default: break
            }
        }
        AppLaunchMetrics.event("PhoneNavigationSmokeFinished")
    }

    static func runPad(store: ChatStore, router: PadRouter, sceneSession: SceneSessionState?, sceneToken: String) async {
        var checks: [String: Bool] = [:]
        var skipped: [String] = []
        let orientation = argument("--pad-test-orientation=")
        let suffix = argument("--pad-test-width=") ?? orientation ?? "full"
        let directory = URL.documentsDirectory.appending(path: "pad-regression-" + suffix)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        func settle() async { try? await Task.sleep(for: .milliseconds(800)) }
        func editorCount() -> Int {
            PhoneNavigationDiagnostics.editors.values.filter { $0 == sceneToken }.count
        }
        for _ in 0..<40 {
            if store.assistantState != nil, store.assistantChatId != nil { break }
            try? await Task.sleep(for: .milliseconds(250))
            if Task.isCancelled { return }
        }
        checks["authenticated data loaded"] = store.unlocked && store.assistantState != nil
        checks["iPad never locks workspace selection"] = !store.assistantOnly
        for section in PadAssistantSection.allCases {
            router.openAssistant(section: section, selection: section == .today ? .assistantChat : nil)
            await settle()
            checks["section " + section.rawValue] = router.assistantSection == section && router.domain == .assistant
            checks["editor ownership " + section.rawValue] = editorCount() == (section == .today ? 1 : 0)
            checks["render " + section.rawValue] = capture(section.rawValue, in: directory)
        }
        router.openAssistant(section: .inbox, selection: nil)
        if let item = store.assistantState?.inbox.first {
            router.select(.inboxItem(item.id))
            await settle()
            checks["inbox inspector"] = router.inspectorPresented && router.selection == .inboxItem(item.id)
            _ = capture("inbox-inspector", in: directory)
            router.openPreview(returningTo: .inboxItem(item.id))
            router.restoreAfterPreview()
            checks["inspector returns to source"] = router.selection == .inboxItem(item.id) && router.inspectorMode == .detail
            router.dismissInspector()
        } else { skipped.append("inbox detail: no inbox data") }
        let projection = PadAssistantProjection(state: store.assistantState)
        if let task = projection.personalTasks.first {
            router.openAssistant(section: .todos, selection: .task(task.id))
            await settle()
            checks["task inspector"] = router.inspectorPresented
            _ = capture("task-inspector", in: directory)
            router.dismissInspector()
        } else { skipped.append("task detail: no task data") }
        router.openAssistant()
        await settle()
        for sheet in ["settings", "skills"] {
            router.regressionSheet = sheet
            await settle()
            checks["render " + sheet] = capture(sheet, in: directory)
            router.regressionSheet = nil
            await settle()
        }
        router.presentSearch()
        await settle()
        checks["assistant search"] = router.searchPresented
        _ = capture("assistant-search", in: directory)
        router.searchPresented = false
        await settle()
        if let workspace = store.preferredWorkspaceChatId() {
            sceneSession?.workbenchChatId = workspace
            store.activateWorkspaceChat(workspace)
            router.openDomain(.workbench)
            await settle()
            checks["workbench editor"] = editorCount() == 1
            _ = capture("workbench", in: directory)
            for pane in [FileBrowserPane.files, .search, .git] {
                store.toggleFileBrowser(pane)
                await settle()
                checks["file browser " + String(describing: pane)] = store.fileBrowserOpen && store.fileBrowserPane == pane
                _ = capture("browser-" + String(describing: pane), in: directory)
                store.fileBrowserOpen = false
                await settle()
            }
            for tool in [ToolLayer.terminal, .loop] {
                store.toggleTool(tool)
                await settle()
                checks["tool " + tool.rawValue] = store.toolLayer == tool
                _ = capture(tool.rawValue, in: directory)
                store.toggleTool(tool)
                await settle()
            }
            store.openWorkspaceSwitcher()
            await settle()
            checks["workspace picker"] = store.workspaceSheetOpen
            _ = capture("workspace-picker", in: directory)
            store.workspaceSheetOpen = false
            await settle()
            if let path = store.fileIndex.first(where: { $0.hasSuffix(".md") || $0.hasSuffix(".txt") }) {
                store.openPreview(path, chatId: workspace)
                sceneSession?.presentPreview(from: store)
                await settle()
                checks["file preview"] = sceneSession?.previewKey != nil
                _ = capture("preview", in: directory)
                sceneSession?.dismissPreview()
            } else {
                // Exercise the real renderer with a local-only fixture; never write a test file to a user's workspace.
                let path = "ios-navigation-preview-\(UUID().uuidString).md"
                let previousPath = store.previewActivePath
                let previousExpanded = store.previewExpanded
                store.previewTabs.append(PreviewTab(
                    path: path, kind: .markdown, diff: false,
                    content: "# iPad 预览验证\n\n测试文件预览、全屏与返回。\n\n- 内容正常显示\n- 关闭后回到原页面", loading: false,
                    chatId: workspace, cwd: store.chatSession(workspace)?.cwd
                ))
                store.previewActivePath = path
                store.previewExpanded = true
                sceneSession?.presentPreview(from: store)
                await settle()
                checks["local markdown preview"] = sceneSession?.previewTab(in: store)?.content?.contains("iPad 预览验证") == true
                checks["markdown web content rendered"] = await captureWebContent(containing: "iPad 预览验证", in: directory)
                await settle()
                checks["render preview"] = capture("preview", in: directory)
                sceneSession?.setPreviewFullscreen(true)
                await settle()
                checks["fullscreen preview"] = sceneSession?.previewFullscreen == true
                _ = capture("preview-fullscreen", in: directory)
                sceneSession?.setPreviewFullscreen(false)
                sceneSession?.closePreview(path)
                store.previewTabs.removeAll { $0.path == path }
                store.previewActivePath = previousPath
                store.previewExpanded = previousExpanded
                await settle()
                checks["preview returns to workbench"] = router.domain == .workbench && sceneSession?.previewKey == nil
            }
            router.openAssistant()
            await settle()
            checks["return to assistant editor"] = editorCount() == 1
            checks["assistant preserves workbench context"] = sceneSession?.workbenchChatId == workspace
        } else { checks["workspace data available"] = false }
        let other = PadRouter()
        router.openAssistant(section: .memory, selection: nil)
        checks["independent scene navigation"] = other.assistantSection == .today && other.domain == .assistant
        for (kind, expected) in [("approval", PadAssistantSection.inbox), ("reminder", .todos)] {
            if let target = PushTarget(userInfo: ["cr": ["kind": kind, "itemId": "todo:regression"]]) {
                router.route(target)
                checks["push route " + kind] = router.assistantSection == expected
                router.dismissInspector()
            }
        }
        router.openAssistant()
        await settle()
        if let orientation, let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows).first(where: \.isKeyWindow) {
            // Rotate the simulator/device before launching; a geometry request alone can be ignored by iPadOS.
            checks[orientation + " geometry"] = orientation == "landscape"
                ? window.bounds.width > window.bounds.height
                : window.bounds.height > window.bounds.width
        }
        router.openAssistant()
        await settle()
        let report: [String: Any] = ["passed": checks.values.allSatisfy { $0 }, "checks": checks, "skipped": skipped]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: directory.appending(path: "report.json"), options: .atomic)
        }
        AppLaunchMetrics.event("PadNavigationSmokeFinished")
    }

    private static func argument(_ prefix: String) -> String? {
        ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(prefix) }).map { String($0.dropFirst(prefix.count)) }
    }

    private static func captureWebContent(containing text: String, in directory: URL) async -> Bool {
        func webViews(in view: UIView) -> [WKWebView] {
            if let web = view as? WKWebView { return [web] }
            return view.subviews.flatMap { webViews(in: $0) }
        }
        for _ in 0..<30 {
            let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
            for web in windows.flatMap({ webViews(in: $0) }) where web.window != nil && web.bounds.width > 0 {
                if let body = try? await web.evaluateJavaScript("document.body.innerText") as? String,
                   body.contains(text), let snapshot = try? await web.takeSnapshot(configuration: nil),
                   let png = snapshot.pngData() {
                    try? png.write(to: directory.appending(path: "preview-content.png"))
                    return true
                }
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return false
    }

    /// Captures the app's own rendered hierarchy, including its presented sheets.
    private static func capture(_ name: String, in directory: URL) -> Bool {
        guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows).first(where: \.isKeyWindow), window.bounds.width > 0 else { return false }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        guard let data = image.pngData() else { return false }
        do { try data.write(to: directory.appending(path: name + ".png")); return true }
        catch { return false }
    }

}
/// A deterministic narrow-window harness. Only explicit simulator regression arguments enable it.
struct NavigationRegressionFrame: ViewModifier {
    func body(content: Content) -> some View {
        if let arg = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--pad-test-width=") }),
           let width = Double(arg.dropFirst("--pad-test-width=".count)), width >= 320 {
            content
                .environment(\.horizontalSizeClass, width < 700 ? .compact : .regular)
                .frame(width: width)
                .frame(maxWidth: .infinity)
        } else {
            content
        }
    }
}
#endif
