import SwiftUI
import UIKit

/// 行动区：放在助理线程与输入框之间，随内容自适应高度，无内容时不占位（规格 §4.1.4）。
/// A. 待批确认卡（最多展开 2 张，其余合并成一行去待处理）
/// B. 进行中的委派（最多 2 条，其余合并成「还有 N 项」）
/// C. 刚结束的委派（10 分钟内、没点开过也没滑走过的最近一条）
struct ActionDock: View {
    @Environment(ChatStore.self) private var store
    @Environment(PhoneRouter.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// C 行：点开过或滑走的委派 id，只存内存，不持久化
    @State private var dismissedFinished: Set<String> = []

    init() {}

    /// C 行出现的时间窗（秒）
    private static let finishedWindow: TimeInterval = 10 * 60

    /// 小屏（iPhone SE 一类，高度 < 700pt）上行动区会把消息列表挤没：确认卡只展开 1 张，进行中只列 1 条，其余折叠
    /// 大字号（xxLarge 起）时同理：每张卡都更高，也只展开 1 张
    @Environment(\.dynamicTypeSize) private var typeSize

    @MainActor private static var shortScreen: Bool {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        return (scene?.screen.bounds.height ?? 800) < 700
    }
    private var compact: Bool { Self.shortScreen || typeSize >= .xxLarge }
    private var approvalLimit: Int { compact ? 1 : 2 }
    private var runningLimit: Int { compact ? 1 : 2 }

    var body: some View {
        // 每 30 秒重算一次：「已 N 分钟」往前走，超过 10 分钟的结束行自己消失
        TimelineView(.periodic(from: .now, by: 30)) { context in
            dock(now: context.date)
        }
    }

    @ViewBuilder
    private func dock(now: Date) -> some View {
        let approvals = (store.assistantState?.approvals ?? []).sorted { $0.createdAt > $1.createdAt }
        let running = store.runningDelegations
        let finished = recentFinished(now: now)
        if approvals.isEmpty && running.isEmpty && finished == nil {
            EmptyView()
        } else {
            VStack(spacing: 6) {
                approvalsBlock(approvals)
                runningBlock(running, now: now)
                if let finished {
                    finishedRow(finished)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 4)
            .animation(
                JieboMotion.fade(reduceMotion),
                value: approvals.count * 100 + running.count * 10 + (finished == nil ? 0 : 1)
            )
        }
    }

    // MARK: A 确认卡

    @ViewBuilder
    private func approvalsBlock(_ approvals: [AssistantApproval]) -> some View {
        ForEach(approvals.prefix(approvalLimit)) { approval in
            ApprovalCard(approval: approval)
        }
        if approvals.count > approvalLimit {
            moreRow("还有 \(approvals.count - approvalLimit) 项待批，去待处理") {
                router.go(.inbox)
            }
        }
    }

    // MARK: B 进行中

    @ViewBuilder
    private func runningBlock(_ running: [AssistantDelegation], now: Date) -> some View {
        ForEach(running.prefix(runningLimit)) { row in
            runningRow(row, now: now)
        }
        if running.count > runningLimit {
            // 折叠掉的那几项只在委派列表里看得到
            moreRow("还有 \(running.count - runningLimit) 项进行中，看全部") {
                router.go(.delegations)
            }
        }
    }

    private func runningRow(_ row: AssistantDelegation, now: Date) -> some View {
        let awaiting = row.status == "awaiting"
        let minutes = assistantElapsedMinutes(from: row.createdAt, to: now)
        let workspace = workspaceName(row.workspace)
        let tail = awaiting ? "等你批准" : (minutes < 1 ? "刚开始" : "已 \(minutes) 分钟")
        let subtitle = workspace.isEmpty ? tail : "\(workspace) · \(tail)"
        let title = row.title.nilIfEmpty ?? "委派"
        return Button {
            router.delegationDetail = DelegationRef(id: row.id)
        } label: {
            HStack(spacing: 10) {
                Circle()
                    .fill(awaiting ? JieboColor.warnFg : JieboColor.run)
                    .frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(JieboFont.text(.subheadline, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .dockRow()
        }
        .buttonStyle(PressScaleButtonStyle())
        .accessibilityLabel("\(title)，\(subtitle)")
        .accessibilityHint("打开委派详情")
    }

    // MARK: C 刚结束

    private func recentFinished(now: Date) -> AssistantDelegation? {
        let nowMillis = now.timeIntervalSince1970 * 1000
        let windowMillis = Self.finishedWindow * 1000
        let candidates = (store.assistantState?.delegations ?? []).filter { row in
            guard row.status == "done" || row.status == "failed", let ended = row.endedAt else { return false }
            return nowMillis - ended < windowMillis && !dismissedFinished.contains(row.id)
        }
        return candidates.max { ($0.endedAt ?? 0) < ($1.endedAt ?? 0) }
    }

    private func finishedRow(_ row: AssistantDelegation) -> some View {
        let failed = row.status == "failed"
        let title = row.title.nilIfEmpty ?? "委派"
        let text = "\(title) \(failed ? "失败" : "已完成")"
        return HStack(spacing: 0) {
            Button {
                dismissFinished(row.id)
                router.delegationDetail = DelegationRef(id: row.id)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: failed ? "xmark.circle.fill" : "checkmark.circle.fill")
                        .font(JieboFont.text(.subheadline))
                        .foregroundStyle(failed ? JieboColor.danger : JieboColor.ok)
                    Text(text)
                        .font(JieboFont.text(.subheadline, weight: .medium))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(text)
            .accessibilityHint("打开委派详情")

            Button {
                dismissFinished(row.id)
            } label: {
                Image(systemName: "xmark")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("忽略")
        }
        .dockRow(trailing: 0)
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    if abs(value.translation.width) > 60, abs(value.translation.width) > abs(value.translation.height) {
                        dismissFinished(row.id)
                    }
                }
        )
        .accessibilityAction(named: "忽略") { dismissFinished(row.id) }
    }

    private func dismissFinished(_ id: String) {
        withAnimation(JieboMotion.fade(reduceMotion)) {
            dismissedFinished.formUnion([id])
        }
    }

    // MARK: 共用

    private func moreRow(_ text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(text)
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(JieboFont.text(.caption2, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
            }
            .dockRow()
        }
        .buttonStyle(PressScaleButtonStyle())
    }
}

private extension View {
    /// 行动区里一行的外观：白底、描边、圆角 md，高度不小于 44
    func dockRow(trailing: CGFloat = 12) -> some View {
        padding(.leading, 12)
            .padding(.trailing, trailing)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(JieboColor.white)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous)
                    .stroke(JieboColor.line, lineWidth: 1)
            )
    }
}
