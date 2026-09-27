import SwiftUI

/// P9：管理员使用统计面板。数据来自网关自计量（usage.ts）——Cursor 官方未暴露
/// API key 用量端点，estTokens 是按字符的粗估（≈4 字符/token），只看相对消耗。
struct AdminStatsView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if store.adminStats.isEmpty {
                    ContentUnavailableView(
                        "暂无数据",
                        systemImage: "chart.bar",
                        description: Text("连上服务器后自动拉取。")
                    )
                } else {
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

    // MARK: 汇总（全部租户合计 ≈ 这个 API key 的总消耗）

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
            Text("API Key 估算消耗" + (store.adminStatsAt.map { " · \($0.formatted(date: .omitted, time: .shortened))} 更新" } ?? ""))
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
            Text("token 为按字符估算（英文 ≈4 字符/token；中文 1 字符 ≈1-2 token，中文场景实际消耗约为估算值的 2-4 倍），反映各账号的相对消耗；Cursor 官方未提供 API key 账单查询。")
                .font(JieboFont.ui(11))
                .foregroundStyle(JieboColor.dim)
        }
    }

    // MARK: 格式化

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
