import SwiftUI
import UIKit

struct LoopSheet: View {
    @Environment(ChatStore.self) private var store
    @State private var goal = ""
    @State private var interval = "900"
    @State private var maxTicks = ""

    private var row: LoopSnapshot? { store.loops[store.activeId] }

    private var live: Bool {
        guard let row else { return false }
        return row.status == "armed" || row.status == "running"
    }

    var body: some View {
        Form {
            Section {
                TextField("每拍要做的事。做完时让它在最后一行写 LOOP_DONE", text: $goal, axis: .vertical)
                    .lineLimit(3...6)
                TextField("间隔（秒）", text: $interval)
                    .keyboardType(.numbersAndPunctuation)
                TextField("最多拍数，可空", text: $maxTicks)
                    .keyboardType(.numbersAndPunctuation)
            }
            Section {
                if !store.loopError.isEmpty {
                    Text(store.loopError)
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.clay)
                }
                if let row {
                    Text(statusLine(row))
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.ink2)
                } else {
                    Text("还没开始。关掉 App 也会继续，重新打开后状态还在。")
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.dim)
                }
            }
            Section {
                Button("开始") { start() }
                    .disabled(live)
                Button("停止", role: .destructive) { store.stopActiveLoop() }
                    .disabled(!live)
            }
        }
        .onAppear { refill() }
        .onChange(of: store.activeId) { _, _ in refill() }
    }

    private func refill() {
        if let row, row.status != "stopped", row.status != "idle" {
            goal = row.goal
            interval = String(row.intervalSec)
            maxTicks = row.maxTicks.map(String.init) ?? ""
        } else {
            goal = ""
            interval = "900"
            maxTicks = ""
        }
    }

    private func start() {
        let cap = maxTicks.trimmingCharacters(in: .whitespacesAndNewlines)
        let parsed = cap.isEmpty ? nil : Int(cap)
        if !cap.isEmpty, parsed == nil {
            store.loopError = "最多拍数要是整数"
            return
        }
        let secondsText = interval.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let seconds = Int(secondsText) else {
            store.loopError = "间隔要是整数"
            return
        }
        store.startActiveLoop(goal: goal, intervalSec: seconds, maxTicks: parsed)
    }

    private func statusLine(_ row: LoopSnapshot) -> String {
        let state: String
        switch row.status {
        case "running": state = "正在跑"
        case "armed": state = "等待下一拍"
        case "stopped": state = "已停止"
        default: state = "空闲"
        }
        var line = "\(state) · 第 \(row.tick) 拍"
        if let max = row.maxTicks { line += " / \(max)" }
        if let summary = row.lastSummary, !summary.isEmpty { line += " · \(summary)" }
        return line
    }
}
