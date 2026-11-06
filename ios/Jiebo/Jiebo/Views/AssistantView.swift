import SwiftUI
import UIKit

extension AssistantDelegation {
    var statusLabel: String {
        switch status {
        case "running": return "进行中"
        case "awaiting": return "待批"
        case "done": return "完成"
        case "failed": return "失败"
        default: return status
        }
    }

    var statusColors: (fg: Color, bg: Color) {
        switch status {
        case "running": return (JieboColor.run, JieboColor.runBg)
        case "awaiting": return (JieboColor.warnFg, JieboColor.warnBg)
        case "done": return (JieboColor.ok, JieboColor.okBg)
        case "failed": return (JieboColor.danger, JieboColor.dangerBg)
        default: return (JieboColor.dim, JieboColor.mist)
        }
    }
}

