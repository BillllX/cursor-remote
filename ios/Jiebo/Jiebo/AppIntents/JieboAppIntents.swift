import AppIntents
import Foundation

enum AssistantIntentChoice: String, AppEnum {
    case ask
    case summarize
    case remember
    case createTask
    case readLater
    case custom

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "处理意图")
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .ask: "问小驳",
        .summarize: "总结",
        .remember: "记住",
        .createTask: "建任务",
        .readLater: "稍后读",
        .custom: "自定义",
    ]

    var captureAction: AssistantCaptureBridge.Action {
        switch self {
        case .ask: return .ask
        case .summarize: return .summarize
        case .remember: return .remember
        case .createTask: return .createTask
        case .readLater: return .readLater
        case .custom: return .custom
        }
    }
}

struct AskJieboIntent: AppIntent {
    static let title: LocalizedStringResource = "问小驳"
    static let description = IntentDescription("把一段文字交给小驳处理。")
    static let openAppWhenRun = true

    @Parameter(title: "内容")
    var text: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let tenant = ImShareBridge.load()?.tenant,
              AssistantCaptureBridge.enqueue(tenant: tenant, kind: .text, text: text, action: .ask) != nil
        else {
            return .result(dialog: "请先打开接驳并完成登录。")
        }
        return .result(dialog: "已交给小驳。")
    }
}

struct CaptureForJieboIntent: AppIntent {
    static let title: LocalizedStringResource = "交给小驳"
    static let description = IntentDescription("保存文字，并选择总结、记住、建任务或稍后读。")
    static let openAppWhenRun = true

    @Parameter(title: "内容")
    var text: String

    @Parameter(title: "意图", default: .remember)
    var intent: AssistantIntentChoice

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let tenant = ImShareBridge.load()?.tenant,
              AssistantCaptureBridge.enqueue(
                  tenant: tenant, kind: .text, text: text, action: intent.captureAction
              ) != nil
        else {
            return .result(dialog: "请先打开接驳并完成登录。")
        }
        return .result(dialog: "已保存，正在打开小驳。")
    }
}

struct OpenJieboVoiceIntent: AppIntent {
    static let title: LocalizedStringResource = "打开小驳语音"
    static let description = IntentDescription("打开接驳的小驳页面，并聚焦语音入口。")
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let tenant = ImShareBridge.load()?.tenant,
              AssistantCaptureBridge.enqueue(tenant: tenant, kind: .action, action: .voice) != nil
        else {
            return .result(dialog: "请先打开接驳并完成登录。")
        }
        return .result(dialog: "正在打开小驳语音。")
    }
}

struct JieboAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskJieboIntent(),
            phrases: ["问\(.applicationName)", "让\(.applicationName)帮我看看"],
            shortTitle: "问小驳",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: CaptureForJieboIntent(),
            phrases: ["让\(.applicationName)记一下", "交给\(.applicationName)"],
            shortTitle: "交给小驳",
            systemImageName: "tray.and.arrow.down"
        )
        AppShortcut(
            intent: OpenJieboVoiceIntent(),
            phrases: ["打开\(.applicationName)语音", "用\(.applicationName)说话"],
            shortTitle: "小驳语音",
            systemImageName: "mic"
        )
    }
}
