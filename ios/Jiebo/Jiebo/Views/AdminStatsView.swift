import SwiftUI

/// P9：管理员使用统计。上面是当前 API Key 的 Cursor 官方账单（与 CLI /usage 同一口径），
/// 下面各账号仍是网关按字符估算的相对消耗。
struct AdminStatsView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if store.adminStats.isEmpty && store.cursorBill == nil {
                    ContentUnavailableView(
                        "暂无数据",
                        systemImage: "chart.bar",
                        description: Text("连上服务器后自动拉取。")
                    )
                } else {
                    cursorSection
                    summarySection
                    ForEach(store.adminStats) { row in
                        tenantSection(row)
                    }
                    footer
                }
            }
            .navigationTitle("使用统计")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        store.requestAdminStats()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("刷新")
                }
            }
            .onAppear { store.requestAdminStats() }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: 当前 API Key 的官方账单

    private var cursorSection: some View {
        let bill = store.cursorBill
        let start = (bill?.cycleStart ?? 0) > 0 ? Self.fmtCycle(bill?.cycleStart ?? 0) : ""
        let end = (bill?.cycleEnd ?? 0) > 0 ? Self.fmtCycle(bill?.cycleEnd ?? 0) : ""
        let span = [start, end].filter { !$0.isEmpty }.joined(separator: " – ")
        let cycleText = (bill?.cycleEnd ?? 0) > 0 ? "\(span) 重置" : span
        let stamp: String = {
            guard let bill, bill.fetchedAt > 0 else { return "" }
            let date = Date(timeIntervalSince1970: bill.fetchedAt / 1000)
            return " · " + date.formatted(date: .omitted, time: .shortened)
        }()
        return Section {
            if let bill {
                if let plan = bill.plan, !plan.isEmpty {
                    statRow("方案", plan)
                }
                if bill.cycleStart > 0 || bill.cycleEnd > 0 {
                    statRow("账期", cycleText)
                }
                if let spend = bill.spendCents {
                    statRow("本 Key 花费", Self.fmtUsd(spend))
                }
                if let included = bill.includedPercent {
                    statRow("套餐内 / Auto / API", "\(Self.fmtPct(included)) / \(Self.fmtPct(bill.autoPercent ?? 0)) / \(Self.fmtPct(bill.apiPercent ?? 0))")
                }
                if let demand = bill.onDemand, demand.kind != "unavailable" {
                    statRow("按需", Self.fmtOnDemand(demand))
                }
                if let input = bill.inputTokens {
                    statRow("输入 / 输出", "\(Self.fmtCount(Int(input))) / \(Self.fmtCount(Int(bill.outputTokens ?? 0))) token")
                }
                ForEach(bill.models) { row in
                    statRow(row.name, Self.fmtUsd(row.spendCents))
                }
                if let error = bill.error, !error.isEmpty {
                    Text(error)
                        .font(JieboFont.ui(11))
                        .foregroundStyle(JieboColor.dim)
                }
            } else {
                Text(store.adminStatsAt == nil ? "正在查询…" : "这台网关还没有账单数据。")
                    .font(JieboFont.ui(13))
                    .foregroundStyle(JieboColor.dim)
            }
        } header: {
            Text("Cursor 账单" + stamp)
        }
    }

    // MARK: 汇总（各租户合计，字符估算）

    private var summarySection: some View {
        let rows = store.adminStats
        return Section {
            VStack(spacing: 10) {
                HStack(spacing: 0) {
                    summaryCell("估算 token", Self.fmtTokens(rows.reduce(0) { $0 + $1.estTokens }))
                    summaryCell("消息", Self.fmtCount(rows.reduce(0) { $0 + $1.turns }))
                }
                HStack(spacing: 0) {
                    summaryCell("运行", Self.fmtCount(rows.reduce(0) { $0 + $1.runs }))
                    summaryCell("运行时长", Self.fmtDuration(rows.reduce(0) { $0 + $1.runMs }))
                }
            }
            .padding(.vertical, 6)
        } header: {
            Text("各账号估算消耗" + (store.adminStatsAt.map { " · \($0.formatted(date: .omitted, time: .shortened)) 更新" } ?? ""))
        }
    }

    private func summaryCell(_ label: String, _ value: String) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(JieboFont.display(22))
                .foregroundStyle(JieboColor.ink)
            Text(label)
                .font(JieboFont.ui(12))
                .foregroundStyle(JieboColor.dim)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    // MARK: 每租户明细

    private func tenantSection(_ row: AdminTenantStats) -> some View {
        Section {
            statRow("会话", "\(row.chats)")
            statRow("消息 / 运行 / 工具", "\(Self.fmtCount(row.turns)) / \(Self.fmtCount(row.runs)) / \(Self.fmtCount(row.toolCalls))")
            statRow("运行时长", Self.fmtDuration(row.runMs))
            statRow("输入 / 输出", "\(Self.fmtCount(row.inChars)) / \(Self.fmtCount(row.outChars)) 字符")
            statRow("估算 token", Self.fmtTokens(row.estTokens))
            statRow("最后活跃", Self.fmtRelative(row.lastActiveAt))
        } header: {
            HStack(spacing: 6) {
                Circle()
                    .fill(row.online > 0 ? JieboColor.ok : JieboColor.dim.opacity(0.4))
                    .frame(width: 7, height: 7)
                Text(row.name)
                if row.admin {
                    Text("管理员")
                        .font(JieboFont.ui(10, weight: .semibold))
                        .foregroundStyle(JieboColor.brass)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(JieboColor.brass.opacity(0.12))
                        .clipShape(Capsule())
                }
                if row.online > 0 {
                    Text("\(row.online) 在线")
                        .foregroundStyle(JieboColor.dim)
                }
            }
        }
    }

    private func statRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(JieboFont.ui(13))
                .foregroundStyle(JieboColor.ink2)
            Spacer()
            Text(value)
                .font(JieboFont.ui(13, weight: .medium))
                .foregroundStyle(JieboColor.ink)
        }
    }

    private var footer: some View {
        Section {
            Text("上面是这台服务器 API Key 的官方账单，和 Cursor CLI 的 /usage 同一口径。下面各账号的 token 仍是按字符估算（英文 ≈4 字符/token；中文实际更高），只用来看相对消耗。")
                .font(JieboFont.ui(11))
                .foregroundStyle(JieboColor.dim)
        }
    }

    // MARK: 格式化

    static func fmtUsd(_ cents: Double) -> String {
        (cents / 100).formatted(.currency(code: "USD"))
    }

    static func fmtPct(_ value: Double) -> String {
        let n = min(100, max(0, value))
        if n > 0 && n < 1 { return "1%" }
        return "\(Int(n.rounded()))%"
    }

    static func fmtCycle(_ epochMs: Double) -> String {
        let date = Date(timeIntervalSince1970: epochMs / 1000)
        return date.formatted(.dateTime.month(.numeric).day(.numeric).timeZone(.gmt))
    }

    static func fmtOnDemand(_ row: CursorOnDemand) -> String {
        let used = fmtUsd(row.usedCents)
        if row.kind == "fixed", let limit = row.limitCents { return "\(used) / \(fmtUsd(limit))" }
        if row.kind == "unlimited" { return "\(used) · 无上限" }
        if row.kind == "disabled" { return "已关闭" }
        return "—"
    }

    static func fmtTokens(_ value: Int) -> String {
        if value >= 10_000 { return String(format: "%.1f 万", Double(value) / 10_000) }
        return "\(value)"
    }

    static func fmtCount(_ value: Int) -> String {
        if value >= 10_000 { return String(format: "%.1f 万", Double(value) / 10_000) }
        return value.formatted(.number.grouping(.automatic))
    }

    static func fmtDuration(_ ms: Double) -> String {
        let total = Int(ms / 1000)
        if total < 60 { return "\(total) 秒" }
        let minutes = total / 60
        if minutes < 60 { return "\(minutes) 分 \(total % 60) 秒" }
        let hours = minutes / 60
        return "\(hours) 小时 \(minutes % 60) 分"
    }

    static func fmtRelative(_ epochMs: Double) -> String {
        guard epochMs > 0 else { return "—" }
        let date = Date(timeIntervalSince1970: epochMs / 1000)
        let seconds = Date().timeIntervalSince(date)
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) 小时前" }
        return "\(Int(seconds / 86_400)) 天前"
    }
}
