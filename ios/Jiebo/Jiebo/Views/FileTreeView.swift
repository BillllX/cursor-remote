import SwiftUI

// MARK: - P7a 文件树（Finder 式浏览器左栏）
// 逐行移植 web FileTree.tsx 的核心算法：
// - toTree：扁平相对路径 → 树（8000 条硬顶，对齐 gateway slice(0, 8000)）
// - flatten：手动展开行——不用 OutlineGroup（控不了「depth<1 默认开 / 搜索时全展开」，大列表还整树刷新）
// - git 徽章：status key 与树路径同为相对 cwd 路径，直接查表（对齐 web dirtyLetter/dirDirty）

struct FileNode: Identifiable, Hashable {
    let name: String
    let path: String
    var children: [FileNode]? // nil = 文件

    var id: String { path }
    var isDir: Bool { children != nil }
}

enum FileTreeBuilder {
    /// 对齐 web toTree：按 "/" 分层，中间层自动补目录节点。
    /// 实现用「按首段分组递归」（字典分组，O(n×深度)），比 web 的 level.find（O(n²)）便宜；
    /// 语义等价（真实文件系统不会出现「同名既是文件又是目录」的歧义）。
    static func toTree(_ paths: [String]) -> [FileNode] {
        build(paths.prefix(8000).map { $0.split(separator: "/").map(String.init) }, prefix: "")
    }

    private static func build(_ partsList: [[String]], prefix: String) -> [FileNode] {
        var order: [String] = []
        var groups: [String: [[String]]] = [:]
        for parts in partsList {
            guard let first = parts.first else { continue }
            if groups[first] == nil {
                order.append(first)
                groups[first] = []
            }
            groups[first]?.append(Array(parts.dropFirst()))
        }
        return order.map { name in
            let path = prefix.isEmpty ? name : "\(prefix)/\(name)"
            let rest = (groups[name] ?? []).filter { !$0.isEmpty }
            if rest.isEmpty {
                return FileNode(name: name, path: path, children: nil)
            }
            return FileNode(name: name, path: path, children: build(rest, prefix: path))
        }
    }

    /// 展开行（对齐 web rows walk）：目录默认 depth<1 展开；openDirs 有显式值以显式为准
    struct Row: Identifiable {
        let node: FileNode
        let depth: Int
        var id: String { node.path }
    }

    static func flatten(_ tree: [FileNode], openDirs: [String: Bool], expandAll: Bool) -> [Row] {
        var rows: [Row] = []
        func walk(_ nodes: [FileNode], depth: Int) {
            for node in nodes {
                rows.append(Row(node: node, depth: depth))
                let opened = node.isDir && (expandAll || (openDirs[node.path] ?? (depth < 1)))
                if opened, let children = node.children { walk(children, depth: depth + 1) }
            }
        }
        walk(tree, depth: 0)
        return rows
    }

    /// 目录脏标记：任一后代在 gitStatus 里即脏。
    /// 实现是「沿 status key 标祖先」（O(改动数 × 深度)），与 web dirDirty（沿树节点递归）有个
    /// 有意的分叉：D/R 的旧路径不在树里，web 不会标其父目录，这里会——收起目录不吞删除改动，
    /// 与改动清单的兜底逻辑自洽（评审确认按增强处理）。
    static func dirtyDirs(status: [String: String]) -> Set<String> {
        var out = Set<String>()
        for path in status.keys {
            var p = path
            while let i = p.lastIndex(of: "/") {
                p = String(p[..<i])
                if !out.insert(p).inserted { break }
            }
        }
        return out
    }
}

// MARK: git 徽章

/// 对齐 web GIT_LABEL（M/A/D/U/R）
func gitLabel(_ letter: String) -> String {
    switch letter {
    case "M": return "已修改"
    case "A": return "新文件"
    case "D": return "已删除"
    case "U": return "未跟踪"
    case "R": return "已重命名"
    default: return letter
    }
}

/// 徽章配色：D 红、A/U 绿、M/R 铜（评审共识；色觉友好靠字母不只靠颜色）
func gitColor(_ letter: String) -> Color {
    switch letter {
    case "D": return JieboColor.danger
    case "A", "U": return JieboColor.ok
    case "M", "R": return JieboColor.brass
    default: return JieboColor.ink2
    }
}

// MARK: 文件 glyph（SF Symbols 版，对齐 web glyphKind 的类型集）

func fileGlyph(_ path: String, isDir: Bool, open: Bool) -> String {
    if isDir { return open ? "folder.fill" : "folder" }
    let base = path.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? path
    if base.lowercased().hasSuffix(".canvas.tsx") { return "square.grid.2x2" }
    let ext = base.contains(".") ? (base.split(separator: ".").last.map(String.init) ?? "").lowercased() : ""
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

/// Finder 式文件树：改动清单 + 展开行 + git 徽章 + 长按菜单。
/// 单击文件 = 预览（onOpen）；@引用 在长按菜单（浏览导向入口；引用导向走 Composer 的扁平 sheet——入口分流）。
struct FileTreeView: View {
    let paths: [String]
    let status: [String: String]
    let truncated: Bool
    let filter: String
    /// 当前右栏预览中的路径（高亮选中行）
    let selectedPath: String?
    let onOpen: (String) -> Void
    /// 改动清单点按：开 diff 页签（D 文件看删除 diff；U 文件无 diff 时网关回「没有未提交的改动」自动降级原文）
    let onOpenDiff: (String) -> Void
    let onPick: (String) -> Void
    let onCopyPath: (String) -> Void
    let onQuickLook: (String) -> Void

    @State private var openDirs: [String: Bool] = [:]
    /// 树缓存：paths 变才重建（toTree 是 O(n×深度)，不在 body 里每次算）
    @State private var tree: [FileNode] = []

    var body: some View {
        // rows/dirty 一次 body 只求值一遍（flatten 是 O(全树)，选中行高亮等高频重建不该翻倍）
        let rows = self.rows
        let dirty = FileTreeBuilder.dirtyDirs(status: status)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                changesList
                if rows.isEmpty {
                    Text(filter.trimmingCharacters(in: .whitespaces).isEmpty ? "没有文件列表" : "没有匹配的文件")
                        .font(JieboFont.ui(13))
                        .foregroundStyle(JieboColor.dim)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 40)
                } else {
                    ForEach(rows) { row in
                        rowView(row, dirtyDirs: dirty)
                    }
                }
                if (truncated || paths.count > 8000) && filter.trimmingCharacters(in: .whitespaces).isEmpty {
                    // 网关会报 truncated；客户端 toTree 还有 8000 硬顶，旧网关多发时也要提示。
                    // 搜索时隐藏——用户已经在「缩小范围」，再提示「用搜索缩小范围」自相矛盾（GLM R2 MINOR）
                    Text("工作区文件太多，清单被截断了，用搜索缩小范围。")
                        .font(JieboFont.ui(12))
                        .foregroundStyle(JieboColor.dim)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                }
            }
            .padding(.vertical, 6)
        }
        .background(JieboColor.paper)
        // initial: true——onAppear 才 rebuild 会首帧闪「没有文件列表」
        .onChange(of: paths, initial: true) { _, _ in rebuild() }
        .onChange(of: filter) { _, _ in rebuild() }
    }

    // MARK: 数据

    private var expandAll: Bool { !filter.trimmingCharacters(in: .whitespaces).isEmpty }

    private var rows: [FileTreeBuilder.Row] {
        FileTreeBuilder.flatten(tree, openDirs: openDirs, expandAll: expandAll)
    }

    private func rebuild() {
        // 搜索对齐 web：substring 过滤 → 建树 → 全展开（不用 rankMentions——打分排序会打乱树序）
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = q.isEmpty ? paths : paths.filter { $0.lowercased().contains(q) }
        tree = FileTreeBuilder.toTree(filtered)
    }

    // MARK: 改动清单（对齐 web files-browser 的「改动 · N」：D 文件不在树里，这里兜底可见；
    // 搜索时不隐藏——D 文件搜不到，清单是唯一入口，按 query 过滤即可）

    @ViewBuilder
    private var changesList: some View {
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let entries = status.filter { q.isEmpty || $0.key.lowercased().contains(q) }
            .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending } // 对齐 web localeCompare（大写/中文路径顺序一致）
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text("改动 · \(entries.count)")
                    .font(JieboFont.ui(11, weight: .semibold))
                    .foregroundStyle(JieboColor.dim)
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                ForEach(entries, id: \.key) { path, letter in
                    Button {
                        onOpenDiff(path)
                    } label: {
                        HStack(spacing: 8) {
                            gitMark(letter)
                            Text(path)
                                .font(JieboFont.mono(12))
                                .foregroundStyle(JieboColor.ink2)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 5)
                        .frame(minHeight: 32)
                        .background(selectedPath == path ? JieboColor.userBubble : Color.clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Divider().overlay(JieboColor.line).padding(.vertical, 6)
            }
        }
    }

    // MARK: 行

    @ViewBuilder
    private func rowView(_ row: FileTreeBuilder.Row, dirtyDirs: Set<String>) -> some View {
        let node = row.node
        let isOpen = node.isDir && (expandAll || (openDirs[node.path] ?? (row.depth < 1)))
        Button {
            if node.isDir {
                openDirs[node.path] = !isOpen
            } else {
                onOpen(node.path)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: fileGlyph(node.path, isDir: node.isDir, open: isOpen))
                    .font(.system(size: 13))
                    .foregroundStyle(node.isDir ? JieboColor.brass : JieboColor.ink2)
                    .frame(width: 18)
                Text(node.name)
                    .font(JieboFont.ui(13, weight: node.isDir ? .medium : .regular))
                    .foregroundStyle(node.isDir ? JieboColor.ink : JieboColor.ink2)
                    .lineLimit(1)
                if let letter = status[node.path] {
                    gitMark(letter)
                } else if node.isDir, dirtyDirs.contains(node.path) {
                    // 目录脏点：收起状态下改动不被吞（对齐 web dirDirty）
                    Circle().fill(JieboColor.brass).frame(width: 5, height: 5)
                }
                Spacer(minLength: 0)
                if node.isDir {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(JieboColor.dim)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                }
            }
            .padding(.leading, 14 + CGFloat(row.depth) * 16)
            .padding(.trailing, 12)
            .padding(.vertical, 5)
            .frame(minHeight: 32)
            .background(selectedPath == node.path ? JieboColor.userBubble : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if node.isDir {
                Button { onCopyPath(node.path) } label: { Label("复制路径", systemImage: "doc.on.doc") }
            } else {
                Button { onPick(node.path) } label: { Label("引用到草稿", systemImage: "at") }
                Button { onCopyPath(node.path) } label: { Label("复制路径", systemImage: "doc.on.doc") }
                Button { onQuickLook(node.path) } label: { Label("用系统打开", systemImage: "arrow.up.forward.app") }
            }
        }
    }

    private func gitMark(_ letter: String) -> some View {
        Text(letter)
            .font(JieboFont.mono(10))
            .foregroundStyle(gitColor(letter))
            .accessibilityLabel(gitLabel(letter))
    }
}
