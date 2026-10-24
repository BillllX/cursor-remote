import SwiftUI
import UIKit

struct DeviceWriteConfirmationSheet: View {
    @Environment(DeviceBridgeCoordinator.self) private var coordinator
    let draft: DeviceWriteConfirmation

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Label(draft.action, systemImage: "checkmark.shield")
                        .font(JieboFont.text(.headline, weight: .semibold))
                        .foregroundStyle(JieboColor.pine)
                    Text(draft.title)
                        .font(JieboFont.text(.title2, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .textSelection(.enabled)
                    VStack(alignment: .leading, spacing: 10) {
                        if let time = draft.time { detail("calendar", time) }
                        detail("calendar.badge.clock", draft.calendar)
                        ForEach(Array(draft.details.enumerated()), id: \.offset) { _, text in
                            detail("text.alignleft", text)
                        }
                    }
                    .padding(16)
                    .background(JieboColor.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    Text(draft.consequence)
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(20)
            }
            .background(JieboColor.paper)
            .navigationTitle("确认设备写入")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaBar(edge: .bottom) {
                HStack(spacing: 12) {
                    Button("拒绝", role: .cancel) { coordinator.resolveConfirmation(allowed: false) }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                    Button("允许并写入") { coordinator.resolveConfirmation(allowed: true) }
                        .buttonStyle(.borderedProminent)
                        .tint(JieboColor.pine)
                        .frame(maxWidth: .infinity)
                }
                .controlSize(.large)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
            }
        }
        .interactiveDismissDisabled()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(draft.accessibilitySummary)
        .accessibilityAction(.escape) { coordinator.resolveConfirmation(allowed: false) }
    }

    private func detail(_ symbol: String, _ text: String) -> some View {
        Label {
            Text(text)
                .foregroundStyle(JieboColor.ink)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(JieboColor.ink2)
        }
        .font(JieboFont.text(.subheadline))
    }
}

struct DeviceConnectionsScreen: View {
    @Environment(DeviceBridgeCoordinator.self) private var coordinator
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    private var permissions: DevicePermissionStore { coordinator.permissionStore }

    var body: some View {
        List {
            Section("设备权限") {
                ForEach(permissions.permissions) { permission in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(permission.title)
                                .font(JieboFont.text(.subheadline, weight: .semibold))
                                .foregroundStyle(JieboColor.ink)
                            Spacer()
                            Text(permission.statusLabel)
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(statusColor(permission.status))
                        }
                        Text(permission.purpose)
                            .font(JieboFont.text(.caption))
                            .foregroundStyle(JieboColor.dim)
                        Text("更新于 \(permission.updatedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(JieboFont.text(.caption2))
                            .foregroundStyle(JieboColor.dim)
                    }
                    .padding(.vertical, 4)
                    .listRowBackground(JieboColor.white)
                    .accessibilityElement(children: .combine)
                }
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                } label: {
                    Label("打开系统设置", systemImage: "gear")
                }
                .listRowBackground(JieboColor.white)
            }

            Section {
                if permissions.audit.isEmpty {
                    Text("暂无设备操作")
                        .foregroundStyle(JieboColor.dim)
                } else {
                    ForEach(permissions.audit) { entry in
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(Self.operationLabel(entry.op))
                                    .foregroundStyle(JieboColor.ink)
                                Text(entry.at.formatted(date: .abbreviated, time: .shortened))
                                    .font(JieboFont.text(.caption))
                                    .foregroundStyle(JieboColor.dim)
                            }
                            Spacer()
                            Text(Self.statusLabel(entry.status))
                                .font(JieboFont.text(.caption))
                                .foregroundStyle(entry.status == "ok" ? JieboColor.pine : JieboColor.danger)
                        }
                        .listRowBackground(JieboColor.white)
                        .accessibilityElement(children: .combine)
                    }
                }
            } header: {
                Text("最近设备操作")
            } footer: {
                Text("仅保存在本机，只记录操作类型、状态和时间；不记录标题、联系人、地点或备注。")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(JieboColor.paper)
        .navigationTitle("连接与权限")
        .navigationBarTitleDisplayMode(.inline)
        .task { permissions.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { permissions.refresh() }
        }
    }

    private func statusColor(_ status: String) -> Color {
        status == "authorized" || status == "limited" ? JieboColor.pine
            : (status == "not_determined" ? JieboColor.dim : JieboColor.danger)
    }

    private static func operationLabel(_ op: String) -> String {
        switch op {
        case "calendar_events_list": return "读取日历"
        case "calendar_event_upsert": return "写入日历"
        case "reminders_list": return "读取提醒事项"
        case "reminders_upsert": return "写入提醒事项"
        case "contacts_search": return "搜索通讯录"
        default: return op
        }
    }

    private static func statusLabel(_ status: String) -> String {
        switch status {
        case "ok": return "成功"
        case "denied": return "权限拒绝"
        case "cancelled": return "已拒绝"
        case "busy": return "确认繁忙"
        case "unavailable": return "不可用"
        default: return "失败"
        }
    }
}
