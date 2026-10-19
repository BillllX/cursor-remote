import SwiftUI
#if os(iOS)
import UIKit
#endif

struct MemoryCenterImportPane: View {
    @Environment(ChatStore.self) private var store
    @State private var importPath = ""
    @State private var applyConfirm = false
    @State private var rollbackConfirm = false
    @State private var exportPersonal = true
    @State private var exportWorkPreference = true
    @State private var exportSettings = false
    @State private var exportWorkspaceIds: Set<String> = []

    private var extras: MemoryCenterExtrasDataState { store.memoryCenterExtrasStorage }
    private var workspaceScopeIds: [String] {
        (store.memoryCenterData.overview?.scopes ?? [])
            .filter { $0.kind == "workspace_memory" }
            .map(\.id)
            .sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("导入 / 导出").font(JieboFont.text(.subheadline, weight: .semibold))
            if let err = extras.importError, !err.isEmpty {
                Text(err).font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warn)
            }
            Group {
                Toggle("个人记忆", isOn: $exportPersonal)
                Toggle("工作偏好 (W0)", isOn: $exportWorkPreference)
                Toggle("个人设置", isOn: $exportSettings)
                ForEach(workspaceScopeIds, id: \.self) { scopeId in
                    Toggle("工作区 \(scopeId)", isOn: Binding(
                        get: { exportWorkspaceIds.contains(scopeId) },
                        set: { on in
                            if on { exportWorkspaceIds.insert(scopeId) } else { exportWorkspaceIds.remove(scopeId) }
                        }
                    ))
                }
            }
            .font(JieboFont.text(.caption))
            .onAppear {
                exportWorkspaceIds = Set(workspaceScopeIds)
            }
            .onChange(of: workspaceScopeIds) { _, ids in
                exportWorkspaceIds = Set(ids)
            }
            Button("导出记忆中心快照") {
                var scopes: [String] = []
                if exportPersonal { scopes.append("personal") }
                if exportWorkPreference { scopes.append("work_preference") }
                if exportSettings { scopes.append("personal_settings") }
                scopes.append(contentsOf: exportWorkspaceIds.sorted())
                store.memoryCenterExportSnapshot(scopes: scopes)
            }
                .disabled(extras.importBusyReqId != nil || (!exportPersonal && !exportWorkPreference && !exportSettings && exportWorkspaceIds.isEmpty))
            if let path = extras.importExportPath {
                Text("路径：\(path)").font(JieboFont.text(.caption)).textSelection(.enabled)
                if let sha = extras.importExportSha256, let bytes = extras.importExportBytes {
                    Text("SHA-256：\(String(sha.prefix(16)))… · \(bytes) 字节")
                        .font(JieboFont.text(.caption))
                        .textSelection(.enabled)
                }
                Button("复制路径") {
                    #if os(iOS)
                    UIPasteboard.general.string = path
                    #endif
                }
                .font(JieboFont.text(.caption))
            }
            TextField("导入 JSON 路径", text: $importPath)
                .textFieldStyle(.roundedBorder)
            Button("预演") { store.memoryCenterImportPreview(path: importPath) }
                .disabled(extras.importBusyReqId != nil || importPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            ForEach(extras.importWarnings, id: \.self) { w in
                Text("⚠ \(w)").font(JieboFont.text(.caption)).foregroundStyle(JieboColor.warn)
            }
            if let planId = extras.importPlanId {
                Text("计划：\(planId.prefix(12))… · \(extras.importChanges.count) 项")
                    .font(JieboFont.text(.caption))
                ForEach(extras.importChanges.prefix(30)) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("[\(row.layer)] \(row.action) \(row.scope ?? "") \(row.itemId ?? "")")
                            .font(JieboFont.text(.caption2))
                        if row.action == "conflict" {
                            Picker("冲突", selection: resolutionBinding(for: row.changeId, allowsDuplicate: row.allowsDuplicate)) {
                                Text("保留当前").tag(MemoryCenterImportResolution.keepCurrent)
                                Text("使用快照").tag(MemoryCenterImportResolution.useSnapshot)
                                if row.allowsDuplicate {
                                    Text("复制为新条目").tag(MemoryCenterImportResolution.duplicate)
                                }
                            }
                            .pickerStyle(.menu)
                        }
                    }
                }
                Button("应用导入") { applyConfirm = true }
                    .disabled(extras.importBusyReqId != nil)
                    .confirmationDialog("确认应用导入？", isPresented: $applyConfirm, titleVisibility: .visible) {
                        Button("应用", role: .destructive) { store.memoryCenterImportApply(planId: planId, resolutions: buildResolutions()) }
                        Button("取消", role: .cancel) {}
                    }
            }
            if let importId = extras.importLastImportId {
                Text("可回滚：\(importId)").font(JieboFont.text(.caption))
                Button("回滚") { rollbackConfirm = true }
                    .disabled(extras.importBusyReqId != nil)
                    .confirmationDialog("确认回滚？", isPresented: $rollbackConfirm, titleVisibility: .visible) {
                        Button("回滚", role: .destructive) { store.memoryCenterImportRollback(importId: importId) }
                        Button("取消", role: .cancel) {}
                    }
            }
        }
        .assistantCard()
    }

    private func resolutionBinding(for changeId: String, allowsDuplicate: Bool) -> Binding<MemoryCenterImportResolution> {
        Binding(
            get: { store.memoryCenterExtrasStorage.importResolutions[changeId] ?? .keepCurrent },
            set: { newValue in
                var next = store.memoryCenterExtrasStorage
                next.importResolutions[changeId] = newValue
                store.memoryCenterExtrasStorage = next
            }
        )
    }

    private func buildResolutions() -> [[String: JSONValue]] {
        var out: [[String: JSONValue]] = []
        for row in extras.importChanges {
            if row.action == "conflict", let pick = extras.importResolutions[row.changeId] {
                out.append(["changeId": .string(row.changeId), "resolution": .string(pick.rawValue)])
            } else if row.action == "add" {
                out.append(["changeId": .string(row.changeId), "resolution": .string(MemoryCenterImportResolution.useSnapshot.rawValue)])
            }
        }
        return out
    }
}
