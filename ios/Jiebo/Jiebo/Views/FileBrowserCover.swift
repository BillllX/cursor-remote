import SwiftUI
import UIKit

/// P7a：Finder 式工作区文件浏览器（浏览导向入口，从侧栏「文件」进入；
/// 引用导向仍走 Composer 的扁平 FileBrowserSheet——入口分流，各自语义单一）。
///
/// 形态（评审共识）：
/// - fullScreenCover + 自定义 HStack 双栏——不嵌 NavigationSplitView
///  （Workbench 已是 NSV，modal 里再套会列宽塌缩/toolbar 跑错栏）
/// - 右栏复用 P5 预览管线：单击文件走 store.openPreview（写 previewTabs），
///   关掉 cover 后工作台 overlay 停在最后浏览的文件——有意的连续性，与 FileBrowserSheet 眼睛按钮一致
/// - compact 宽度（Stage Manager 窄窗/Slide Over）退化单栏：点文件 dismiss + 预览面板接管
struct FileBrowserCover: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var filter = ""

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            Group {
                if sizeClass == .compact {
                    treeColumn
                } else {
                    HStack(spacing: 0) {
                        treeColumn
                            .frame(width: 340)
                        Divider().overlay(JieboColor.line)
                        rightPane
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                        .hitTarget()
                }
            }
            // cover 自己画一条通知条——store.notice 的横幅在 ThreadView，cover 背后用户看不见
            .overlay(alignment: .top) {
                if !store.notice.isEmpty {
                    Text(store.notice)
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.ink)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(JieboColor.white)
                        .clipShape(Capsule())
                        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
                        .padding(.top, 8)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .animation(.easeInOut(duration: 0.2), value: store.notice.isEmpty)
                        .allowsHitTesting(false) // 纯提示，别挡搜索框（Grok R2 MINOR）
                }
            }
        }
        .onAppear { store.requestFileIndex() } // 打开时刷新（web 只在空时才拉；这里每次拉，更新鲜，成本一次 list_files）
        // Quick Look 挂在 cover 自己身上——ThreadView 的 sheet 在 cover 背后，弹不出来
        // （ThreadView 侧已用绑定守卫在 cover 期间不抢 present，故这里无需 onDisappear 兜底清理——
        //   无条件清理反而会误杀进 cover 前已开的 QL，Grok R2 MINOR）
        .sheet(item: $store.previewFile, onDismiss: store.closePreview) { file in
            QuickLookView(file: file, onClose: { store.dismissPreviewFile() })
                .ignoresSafeArea()
        }
    }

    /// 标题给当前工作区名，防迷失（sheet 期间切不了会话，文件一定是这个工作区的）。
    /// 用 active?.cwd 与 requestFileIndex 的 activeId 口径对齐（store.cwd 同步可能慢一拍）
    private var title: String {
        browserBase.isEmpty ? "工作区文件" : workspaceLabel(browserBase, root: store.workspaceRoot)
    }

    /// 浏览目标工作区的统一口径：active.cwd（空串归 nil）→ store.cwd → workspaceRoot。
    /// title 与树视图的 .id 隔离键共用，避免两处兜底不一致（Kimi R2 MINOR）
    private var browserBase: String {
        store.active?.cwd?.nilIfEmpty ?? store.cwd.nilIfEmpty ?? store.workspaceRoot
    }

    // MARK: 左栏（搜索 + 树）

    private var treeColumn: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13))
                    .foregroundStyle(JieboColor.dim)
                TextField("搜文件名或路径", text: $filter)
                    .font(JieboFont.ui(14))
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if !filter.isEmpty {
                    Button {
                        filter = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(JieboColor.dim)
                            .hitTarget(30)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(JieboColor.mist)
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.sm, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider().overlay(JieboColor.line)

            FileTreeView(
                paths: store.fileIndex,
                status: store.gitStatus,
                truncated: store.treeTruncated,
                filter: filter,
                selectedPath: store.previewActivePath,
                onOpen: openFile,
                onOpenDiff: openDiff,
                onPick: pickFile,
                onCopyPath: copyPath,
                onQuickLook: { store.openMention($0) } // 二进制/系统导出逃生门
            )
            // 工作区身份隔离：cwd 变了（热替换/重建）openDirs 等 @State 不跨工作区残留
            //（与 title 共用 browserBase 口径——Kimi R2 MINOR）
            .id(normPath(browserBase))
        }
    }

    // MARK: 右栏（P5 预览内容区）

    @ViewBuilder
    private var rightPane: some View {
        if let tab = store.activePreviewTab {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: fileGlyph(tab.path, isDir: false, open: false))
                        .font(.system(size: 13))
                        .foregroundStyle(JieboColor.ink2)
                    Text(tab.filename)
                        .font(JieboFont.ui(14, weight: .semibold))
                        .foregroundStyle(JieboColor.ink)
                        .lineLimit(1)
                    Text(tab.path)
                        .font(JieboFont.mono(11))
                        .foregroundStyle(JieboColor.dim)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                Divider().overlay(JieboColor.line)
                PreviewContentView(tab: tab)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(JieboColor.white)
        } else {
            VStack(spacing: 12) {
                Image(systemName: "doc.text.magnifyingglass")
                    .font(.system(size: 30))
                    .foregroundStyle(JieboColor.dim)
                Text("点左侧文件在这里预览")
                    .font(JieboFont.ui(14))
                    .foregroundStyle(JieboColor.dim)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(JieboColor.white)
        }
    }

    // MARK: 动作

    private func openFile(_ path: String) {
        if sizeClass == .compact {
            // 单栏退化：预览面板（overlay）接管。先 dismiss 再延迟一拍打开——
            // binary 走 openMention 异步下载，若快于 dismiss 动画，previewFile 置位时
            // cover 正在消失，cover/ThreadView 双 sheet 绑定会 present 失败
            let chatId = store.activeId
            dismiss()
            // 可取消性守卫（Grok R2 MINOR）：0.35s 内用户若已切会话/重开浏览器，丢弃这次打开
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                guard !store.fileBrowserOpen, store.activeId == chatId else { return }
                store.openPreview(path) // 守卫 + 二进制路由 Quick Look 都在里面
            }
        } else {
            store.openPreview(path)
        }
    }

    /// 改动清单点按：开 diff 页签（对齐网页改动清单看 diff 的语义；U 文件无 diff 会自动降级原文）
    private func openDiff(_ path: String) {
        // 面板渲染不了的类型走 Quick Look/系统导出。注意 previewKind 纯按扩展名分类，
        // 未知扩展一律落 .text——本地判不出真二进制（.binary 只能由服务端 fileContent 回填），
        // 所以 zip 等实际仍会发 read_file(diff:)，由网关回 "Binary files differ" 或错误页：与 web 一致
        guard previewKind(of: path).panelRenderable else {
            store.openMention(path)
            return
        }
        if sizeClass == .compact {
            let chatId = store.activeId
            dismiss()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                guard !store.fileBrowserOpen, store.activeId == chatId else { return }
                store.openPreviewTab(path: path, diff: true)
            }
        } else {
            store.openPreviewTab(path: path, diff: true)
        }
    }

    private func pickFile(_ path: String) {
        // 用 appendMentionToDraft（带去重），不是 insertMention——后者只替换草稿尾部的
        // @查询，浏览场景草稿通常没有尾查询，会静默空操作还谎报成功（评审 Kimi/Grok M1）
        store.appendMentionToDraft(path)
        store.flash("已把 @\(path) 加进草稿")
    }

    private func copyPath(_ path: String) {
        UIPasteboard.general.string = path // 复制相对路径（与 @引用 一致，不拼绝对路径）
        store.flash("已复制路径")
    }
}
