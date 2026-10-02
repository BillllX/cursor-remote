import Foundation

// MARK: - 工作区路径工具（P7b，逐行移植 web ChatApp.tsx 的 normPath/workspaceLabel 族）
// 注意：全部是【字符串级】归一，不用 URL.standardizedFileURL——服务端路径可能是 Windows 风格，
// URL 标准化会改写字符串导致分组 key 不匹配（评审共识）。

/// 反斜杠→斜杠、去尾部斜杠（对齐 web normPath）
func normPath(_ path: String) -> String {
    var p = path.replacingOccurrences(of: "\\", with: "/")
    while p.hasSuffix("/") { p.removeLast() }
    return p
}

func sameCwd(_ a: String?, _ b: String?) -> Bool {
    normPath(a ?? "") == normPath(b ?? "")
}

/// 工作区显示名：root 下的子工作区显示相对子路径；用户根目录用助理名字。
func workspaceLabel(_ path: String, root: String, rootName: String = AssistantDefaults.name) -> String {
    let abs = normPath(path)
    let base = normPath(root)
    if abs.isEmpty { return base.isEmpty ? "工作区" : rootName }
    if base.isEmpty { return abs.split(separator: "/").last.map(String.init) ?? abs }
    if abs == base { return rootName }
    if abs.hasPrefix(base + "/") { return String(abs.dropFirst(base.count + 1)) }
    return abs.split(separator: "/").last.map(String.init) ?? abs
}

// MARK: - 侧栏分组模型

struct WorkspaceGroup: Identifiable {
    /// 分组 key（normPath 后的路径）
    let key: String
    let path: String
    let name: String
    let user: Bool
    let chats: [ChatSession]

    var id: String { key }
}

extension ChatStore {
    /// 分组的 root 口径：workspaceRoot 为空时回退 cwd（sidebarChats 与 workspaceGroups 共用，避免两处 fallback 不一致；
    /// startChat 的空会话复用也用同一口径——Grok R2 MINOR）
    var groupRoot: String {
        workspaceRoot.nilIfEmpty ?? cwd
    }

    /// 侧栏会话清单：每个工作区只保留一个空「新对话」（活跃的优先），对齐 web sidebarChats。
    /// 不分组时一堆空「新对话」只是碍眼，分组后会堆在同组顶上，必须去重。
    /// 注意 cwd 是 String? 且可能留下空串——必须 nilIfEmpty（对齐 web 的 `chat.cwd || root` 语义），
    /// 否则 cwd==nil 与 cwd=="" 会拆出两个幽灵组。
    var sidebarChats: [ChatSession] {
        // 两遍：先标出「活跃空会话所在组」——同组里活跃空会话优先于先出现的非活跃空会话
        //（单遍写法在 [非活跃空, 活跃空] 顺序下同组会留两条，GLM R2 MINOR）
        let activeEmptyKeys: Set<String> = chats
            .filter { $0.id == activeId && $0.title == "新对话" && $0.turnsComplete && $0.turns.isEmpty }
            .map { normPath($0.cwd?.nilIfEmpty ?? groupRoot) }
            .reduce(into: []) { $0.insert($1) }
        var keep = Set<String>()
        var seenEmpty = Set<String>()
        for chat in chats {
            // P8 slim：turnsComplete=false 的是「未加载」不是「真空」，不能参与空会话去重
            let empty = chat.title == "新对话" && chat.turnsComplete && chat.turns.isEmpty
            if !empty {
                keep.insert(chat.id)
                continue
            }
            let key = normPath(chat.cwd?.nilIfEmpty ?? groupRoot)
            if activeEmptyKeys.contains(key) {
                if chat.id == activeId { keep.insert(chat.id) }
            } else if !seenEmpty.contains(key) {
                keep.insert(chat.id)
                seenEmpty.insert(key)
            }
        }
        return chats.filter { keep.contains($0.id) }
    }

    /// 会话按工作区分组（对齐 web workspaceGroups）：
    /// - 已知 workspaces 优先成组（目录序），无会话的非 root 工作区也保留（空组可直达新建）
    /// - 会话按 chat.cwd ?? root 归组；未命中已知组的追加为派生组（首次出现序）
    /// - 组序稳定：不置顶活跃组（无 updatedAt 数据源，置顶会让组头跳动、破坏空间记忆）
    var workspaceGroups: [WorkspaceGroup] {
        let root = groupRoot
        let known: [WorkspaceItem] = workspaces.isEmpty
            ? (root.nilIfEmpty.map { [WorkspaceItem(path: $0, name: assistantName, user: true)] } ?? [])
            : workspaces
        var order: [String] = []
        var byKey: [String: (path: String, name: String, user: Bool, chats: [ChatSession])] = [:]
        for item in known {
            let key = normPath(item.path)
            // 同 key 重复项：后写覆盖（对齐 web Map 语义），但组序保首次位置不跳动
            if byKey[key] == nil { order.append(key) }
            let user = item.user || sameCwd(item.path, root)
            byKey[key] = (item.path, user ? assistantName : item.name, user, byKey[key]?.chats ?? [])
        }
        for chat in sidebarChats {
            let path = chat.cwd?.nilIfEmpty ?? root
            let key = normPath(path)
            if byKey[key] != nil {
                byKey[key]?.chats.append(chat)
            } else {
                let user = sameCwd(path, root)
                byKey[key] = (path, user ? assistantName : workspaceLabel(path, root: root, rootName: assistantName), user, [chat])
                order.append(key)
            }
        }
        let groups = order.compactMap { key -> WorkspaceGroup? in
            guard let entry = byKey[key] else { return nil }
            return WorkspaceGroup(key: key, path: entry.path, name: entry.name, user: entry.user, chats: entry.chats)
        }
        return groups.sorted { $0.user && !$1.user }
    }

    /// 侧栏当前看着的工作区：活跃会话的目录，否则退回连接上的 cwd / 根目录。
    var currentWorkspacePath: String {
        active?.cwd?.nilIfEmpty ?? cwd.nilIfEmpty ?? workspaceRoot
    }

    var currentWorkspaceName: String {
        let path = currentWorkspacePath
        if path.isEmpty { return "工作区" }
        let name = workspaceLabel(path, root: groupRoot)
        let leaf = workspaceName(path)
        let duplicated = workspaces.filter { workspaceName($0.path) == leaf }.count > 1
        guard duplicated else { return name }
        let parent = workspaceName((path as NSString).deletingLastPathComponent)
        if parent.isEmpty || parent == leaf { return name }
        return "\(parent)/\(name)"
    }

    /// 只含当前工作区的会话。侧栏不再把所有工作区叠在一张列表里。
    var currentWorkspaceChats: [ChatSession] {
        let key = normPath(currentWorkspacePath.nilIfEmpty ?? groupRoot)
        return sidebarChats.filter { normPath($0.cwd?.nilIfEmpty ?? groupRoot) == key }
    }
}
