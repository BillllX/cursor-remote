import SwiftUI

// MARK: - P7a 文件树（Finder 式浏览器左栏）
// 逐行移植 web FileTree.tsx 的核心算法：
// - toTree：扁平相对路径 → 树（8000 条硬顶，对齐 gateway slice(0, 8000)）
// - flatten：手动展开行——不用 OutlineGroup（控不了「depth<1 默认开 / 搜索时全展开」，大列表还整树刷新）
// （P7 曾移植 git 徽章/改动清单，后按产品决定撤掉——只展示文件本身）

extension View {
    /// 文件行、预览页签可拖：带出「@相对路径」，拖进输入框变引用，拖进别的 App 就是这段文字。
    /// 引用按 @\S+ 解析，路径带空白的拖进去会被截断，干脆不让拖
    @ViewBuilder
    func draggableMention(_ path: String?) -> some View {
        if let path, !path.isEmpty, !path.contains(where: \.isWhitespace) {
            draggable("@\(path)")
        } else {
            self
        }
    }
}

struct FileNode: Identifiable, Hashable, Sendable {
    let name: String
    let path: String
    var children: [FileNode]? // nil = 文件

    var id: String { path }
    var isDir: Bool { children != nil }
}

enum FileTreeBuilder {
    /// 对齐 web toTree：按 "/" 分层，中间层自动补目录节点；末尾带 "/" 的项显式标记为目录节点。
    /// 实现用「按首段分组递归」（字典分组，O(n×深度)），比 web 的 level.find（O(n²)）便宜；
    /// 语义等价（真实文件系统不会出现「同名既是文件又是目录」的歧义）。
    static func toTree(_ paths: [String]) -> [FileNode] {
        let slice = paths.prefix(8000)
        var items: [(parts: [Substring], explicitDir: Bool)] = []
        items.reserveCapacity(slice.count)
        for raw in slice {
            let explicitDir = raw.hasSuffix("/")
            let parts = raw.split(separator: "/")
            items.append((parts, explicitDir))
        }
        return build(items, depth: 0, prefix: "")
    }

    private static func build(_ items: [(parts: [Substring], explicitDir: Bool)], depth: Int, prefix: String) -> [FileNode] {
        var order: [String] = []
        var groups: [String: [(parts: [Substring], explicitDir: Bool)]] = [:]
        var isDirSet: Set<String> = []
        for item in items {
            guard depth < item.parts.count else { continue }
            let first = String(item.parts[depth])
            if groups[first] == nil {
                order.append(first)
                groups[first] = []
            }
            let hasTail = depth + 1 < item.parts.count
            if hasTail || item.explicitDir {
                isDirSet.insert(first)
            }
            if hasTail {
                groups[first]?.append(item)
            }
        }
        return order.map { name in
            let path = prefix.isEmpty ? name : "\(prefix)/\(name)"
            let rest = groups[name] ?? []
            if rest.isEmpty && !isDirSet.contains(name) {
                return FileNode(name: name, path: path, children: nil)
            }
            return FileNode(name: name, path: path, children: build(rest, depth: depth + 1, prefix: path))
        }
    }

    /// 展开行（对齐 web rows walk）：目录默认折叠（expandAll 时全展开）；openDirs 有显式值以显式为准
    struct Row: Identifiable, Equatable, Sendable {
        let node: FileNode
        let depth: Int
        var id: String { node.path }
    }

    static func flatten(_ tree: [FileNode], openDirs: [String: Bool], expandAll: Bool, defaultOpenDepth0: Bool = false) -> [Row] {
        var rows: [Row] = []
        rows.reserveCapacity(tree.count)
        func walk(_ nodes: [FileNode], depth: Int) {
            for node in nodes {
                rows.append(Row(node: node, depth: depth))
                let opened = node.isDir && (expandAll || (openDirs[node.path] ?? (defaultOpenDepth0 && depth < 1)))
                if opened, let children = node.children { walk(children, depth: depth + 1) }
            }
        }
        walk(tree, depth: 0)
        return rows
    }
}

// MARK: 文件 glyph（SF Symbols 版，对齐 web glyphKind 的类型集）

func fileGlyph(_ path: String, isDir: Bool, open: Bool) -> String {
    if isDir { return open ? "folder.fill" : "folder" }
    // 纯 Substring 倒序定位路径分隔符与扩展名，避免 8000 行大树滚动时每行分配临时数组与整串拷贝。
    var trimmed = path[...]
    while trimmed.count > 1, let last = trimmed.last, last == "/" || last == "\\" {
        trimmed = trimmed.dropLast()
    }
    let base: Substring
    if let sep = trimmed.lastIndex(where: { $0 == "/" || $0 == "\\" }) {
        base = trimmed[trimmed.index(after: sep)...]
    } else {
        base = trimmed
    }
    if base.count >= 11, base.suffix(11).caseInsensitiveCompare(".canvas.tsx") == .orderedSame {
        return "square.grid.2x2"
    }
    let ext: String
    if let dot = base.lastIndex(of: ".") {
        ext = base[base.index(after: dot)...].lowercased()
    } else {
        ext = ""
    }
    switch ext {
    case "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
         "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "cc", "rb", "php", "py", "pyi":
        return "chevron.left.forwardslash.chevron.right"
    case "json", "jsonc": return "curlybraces"
    case "md", "mdx", "markdown": return "text.document"
    case "css", "scss", "sass", "less": return "paintbrush"
    case "html", "htm": return "globe"
    case "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico": return "photo"
    case "pdf": return "doc.richtext"
    case "mp3", "wav", "ogg", "m4a", "aac", "flac": return "waveform"
    case "mp4", "webm", "mov": return "film"
    case "yml", "yaml", "toml", "ini", "env": return "gearshape"
    case "sh", "bash", "zsh": return "terminal"
    default: return base.hasPrefix(".env") ? "gearshape" : "doc"
    }
}

// MARK: - 树视图

/// Finder 式文件树：展开行 + 长按菜单。
/// 单击文件 = 预览（onOpen）；@引用 在长按菜单（浏览导向入口；引用导向走 Composer 的扁平 sheet——入口分流）。
struct FileTreeView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// 所属会话/工作区身份，供 FileTreeRowView.Equatable 感知回调闭包目标会话变化。
    var scopeId: String = ""
    let paths: [String]
    let truncated: Bool
    let filter: String
    /// 当前右栏预览中的路径（高亮选中行）
    let selectedPath: String?
    var loadingDirs: Set<String> = []
    var truncatedDirs: Set<String> = []
    var onExpandDir: ((String) -> Void)? = nil
    let onOpen: (String) -> Void
    let onPick: (String) -> Void
    let onCopyPath: (String) -> Void
    let onQuickLook: (String) -> Void
    /// 列表还没读到时的原因。nil 表示服务器已经给过空清单。
    var emptyDetail: String? = nil

    @State private var openDirs: [String: Bool] = [:]
    /// 树与展开行缓存：paths/filter 变才重建树，openDirs/tree 变才重算 flatten（选中高亮等零重算）
    @State private var tree: [FileNode] = []
    @State private var rows: [FileTreeBuilder.Row] = []
    @State private var debouncedFilter = ""
    @State private var filterTask: Task<Void, Never>?
    @State private var rebuildTask: Task<Void, Never>?
    @State private var rebuildGeneration: UInt64 = 0

    var body: some View {
        let palette = JieboTheme.shared.palette
        let appearance = JieboTheme.shared.appearance
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if rows.isEmpty {
                    Text(paths.isEmpty ? (emptyDetail ?? "没有文件列表") : (debouncedFilter.isEmpty ? "没有文件列表" : "没有匹配的文件"))
                        .font(JieboFont.text(.footnote))
                        .foregroundStyle(JieboColor.dim)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 40)
                } else {
                    ForEach(rows) { row in
                        let node = row.node
                        let isOpen = node.isDir && (expandAll || (openDirs[node.path] ?? false))
                        let isLoading = node.isDir && isOpen && loadingDirs.contains(node.path) && (node.children?.isEmpty ?? true)
                        let isDirTruncated = node.isDir && isOpen && truncatedDirs.contains(node.path)
                        FileTreeRowView(
                            scopeId: scopeId,
                            name: node.name,
                            path: node.path,
                            isDir: node.isDir,
                            depth: row.depth,
                            isOpen: isOpen,
                            isSelected: selectedPath == node.path,
                            showFullPath: !debouncedFilter.isEmpty && node.path != node.name,
                            isLoading: isLoading,
                            isDirTruncated: isDirTruncated,
                            dynamicTypeSize: dynamicTypeSize,
                            reduceMotion: reduceMotion,
                            palette: palette,
                            appearance: appearance,
                            onTap: {
                                if node.isDir {
                                    let willOpen = !isOpen
                                    if willOpen { onExpandDir?(node.path) }
                                    openDirs[node.path] = willOpen
                                } else {
                                    onOpen(node.path)
                                }
                            },
                            onPick: { onPick(node.path) },
                            onCopyPath: { onCopyPath(node.path) },
                            onQuickLook: { onQuickLook(node.path) }
                        )
                        .equatable()
                    }
                }
                if (truncated || truncatedDirs.contains("") || paths.count > 8000) && debouncedFilter.isEmpty {
                    // 网关会报 truncated；客户端 toTree 还有 8000 硬顶，旧网关多发时也要提示。
                    // 搜索时隐藏——用户已经在「缩小范围」，再提示「用搜索缩小范围」自相矛盾（GLM R2 MINOR）
                    Text("文件太多，清单被截断了，用搜索缩小范围。")
                        .font(JieboFont.text(.caption))
                        .foregroundStyle(JieboColor.dim)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                }
            }
            .padding(.vertical, 6)
        }
        .background(JieboColor.paper)
        // initial: true——onAppear 才 rebuild 会首帧闪「没有文件列表」，同时兼容父视图切回时已带非空 filter
        .onChange(of: filter, initial: true) { old, next in
            let trimmed = next.trimmingCharacters(in: .whitespacesAndNewlines)
            if old == next {
                if debouncedFilter != trimmed { debouncedFilter = trimmed }
            } else {
                scheduleFilterRebuild(next)
            }
        }
        .onChange(of: paths, initial: true) { _, _ in rebuild() }
        .onChange(of: debouncedFilter) { _, _ in rebuild() }
        .onChange(of: openDirs) { _, _ in refreshRows() }
        .onDisappear {
            filterTask?.cancel()
            filterTask = nil
            rebuildTask?.cancel()
            rebuildTask = nil
        }
    }

    // MARK: 数据

    private var expandAll: Bool { !debouncedFilter.isEmpty }

    private func scheduleFilterRebuild(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        filterTask?.cancel()
        if trimmed.isEmpty {
            filterTask = nil
            if !debouncedFilter.isEmpty {
                debouncedFilter = ""
            }
            return
        }
        filterTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            // 只写 @State debouncedFilter，由 .onChange(of: debouncedFilter) 读取最新 self.paths 执行 rebuild。
            if debouncedFilter != trimmed {
                debouncedFilter = trimmed
            }
        }
    }

    private func rebuild() {
        rebuildTask?.cancel()
        rebuildTask = nil
        rebuildGeneration &+= 1
        let generation = rebuildGeneration
        let currentPaths = paths
        let q = debouncedFilter
        let expand = expandAll
        let snapshotOpenDirs = openDirs
        // 大仓库（> 800 路径）将过滤 + 建树 + 展开移至后台线程，避免搜索与刷新索引阻塞主线程。
        if currentPaths.count > 800 {
            rebuildTask = Task { @MainActor in
                let worker = Task.detached(priority: .userInitiated) { () -> ([FileNode], [FileTreeBuilder.Row])? in
                    let filtered: [String]
                    if q.isEmpty {
                        filtered = currentPaths
                    } else {
                        var matches: [String] = []
                        for (idx, path) in currentPaths.enumerated() {
                            if (idx & 255) == 0 && Task.isCancelled { return nil }
                            if !path.hasSuffix("/") && path.range(of: q, options: .caseInsensitive) != nil {
                                matches.append(path)
                            }
                        }
                        filtered = matches
                    }
                    if Task.isCancelled { return nil }
                    let built = FileTreeBuilder.toTree(filtered)
                    if Task.isCancelled { return nil }
                    let flattened = FileTreeBuilder.flatten(built, openDirs: snapshotOpenDirs, expandAll: expand)
                    return (built, flattened)
                }
                let result = await withTaskCancellationHandler {
                    await worker.value
                } onCancel: {
                    worker.cancel()
                }
                guard let result, !Task.isCancelled, rebuildGeneration == generation else { return }
                tree = result.0
                if openDirs == snapshotOpenDirs && expandAll == expand {
                    rows = result.1
                } else {
                    refreshRows()
                }
                rebuildTask = nil
            }
            return
        }
        // 搜索对齐 web：substring 过滤 → 建树 → 全展开（不用 rankMentions——打分排序会打乱树序）
        let filtered = q.isEmpty
            ? currentPaths
            : currentPaths.filter { !$0.hasSuffix("/") && $0.range(of: q, options: .caseInsensitive) != nil }
        tree = FileTreeBuilder.toTree(filtered)
        refreshRows()
    }

    private func refreshRows() {
        rows = FileTreeBuilder.flatten(tree, openDirs: openDirs, expandAll: expandAll)
    }
}

/// 文件树单行 Equatable 隔离：选中切换或展开单个目录时，其余可见行零重绘。
private struct FileTreeRowView: View, Equatable {
    let scopeId: String
    let name: String
    let path: String
    let isDir: Bool
    let depth: Int
    let isOpen: Bool
    let isSelected: Bool
    let showFullPath: Bool
    let isLoading: Bool
    let isDirTruncated: Bool
    let dynamicTypeSize: DynamicTypeSize
    let reduceMotion: Bool
    /// 供 Equatable 感知主题色盘与明暗外观切换，确保 JieboColor 及时重绘。
    let palette: JieboPalette
    let appearance: JieboAppearance
    let onTap: () -> Void
    let onPick: () -> Void
    let onCopyPath: () -> Void
    let onQuickLook: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.scopeId == rhs.scopeId
            && lhs.name == rhs.name
            && lhs.path == rhs.path
            && lhs.isDir == rhs.isDir
            && lhs.depth == rhs.depth
            && lhs.isOpen == rhs.isOpen
            && lhs.isSelected == rhs.isSelected
            && lhs.showFullPath == rhs.showFullPath
            && lhs.isLoading == rhs.isLoading
            && lhs.isDirTruncated == rhs.isDirTruncated
            && lhs.dynamicTypeSize == rhs.dynamicTypeSize
            && lhs.reduceMotion == rhs.reduceMotion
            && lhs.palette == rhs.palette
            && lhs.appearance == rhs.appearance
    }

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: fileGlyph(path, isDir: isDir, open: isOpen))
                    .font(JieboFont.text(.subheadline, weight: isDir ? .medium : .regular))
                    .foregroundStyle(isDir ? JieboColor.brass : JieboColor.ink2)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(JieboFont.text(.subheadline, weight: isDir ? .medium : .regular))
                        .foregroundStyle(isDir ? JieboColor.ink : JieboColor.ink2)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    if showFullPath {
                        Text(path)
                            .font(JieboFont.monoText(.caption2))
                            .foregroundStyle(JieboColor.dim)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
                if isDir {
                    Image(systemName: "chevron.right")
                        .font(JieboFont.text(.caption2, weight: .semibold))
                        .foregroundStyle(JieboColor.dim)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                        .animation(JieboMotion.snappy(reduceMotion), value: isOpen)
                }
            }
            .padding(.leading, 10 + CGFloat(depth) * (dynamicTypeSize.isAccessibilitySize ? 10 : 16))
            .padding(.trailing, 10)
            .padding(.vertical, 6)
            .frame(minHeight: 44)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isSelected ? JieboColor.userBubble : Color.clear)
            )
            .overlay(alignment: .leading) {
                if isSelected {
                    Capsule()
                        .fill(JieboColor.pine)
                        .frame(width: 3, height: 18)
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .animation(JieboMotion.fade(reduceMotion), value: isSelected)
            .contentShape(Rectangle())
            .hoverEffect(.highlight)
        }
        .buttonStyle(.plain)
        .draggableMention(isDir ? nil : path)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isDir ? "文件夹 \(name)" : "文件 \(name)")
        .accessibilityValue(isDir ? (isOpen ? "已展开" : "已收起") : "")
        .accessibilityHint(isDir ? "轻点展开或收起" : "轻点预览")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .contextMenu {
            if isDir {
                Button(action: onCopyPath) { Label("复制路径", systemImage: "doc.on.doc") }
            } else {
                Button(action: onPick) { Label("引用到草稿", systemImage: "at") }
                Button(action: onCopyPath) { Label("复制路径", systemImage: "doc.on.doc") }
                Button(action: onQuickLook) { Label("用系统打开", systemImage: "arrow.up.forward.app") }
            }
        }
        if isLoading {
            Text("正在加载…")
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
                .padding(.leading, 14 + CGFloat(depth + 1) * (dynamicTypeSize.isAccessibilitySize ? 10 : 16))
                .padding(.vertical, 6)
        }
        if isDirTruncated {
            Text("此目录文件较多，仅显示前 1000 项，请用搜索缩小范围。")
                .font(JieboFont.text(.caption))
                .foregroundStyle(JieboColor.dim)
                .padding(.leading, 14 + CGFloat(depth + 1) * (dynamicTypeSize.isAccessibilitySize ? 10 : 16))
                .padding(.vertical, 6)
        }
    }
}
