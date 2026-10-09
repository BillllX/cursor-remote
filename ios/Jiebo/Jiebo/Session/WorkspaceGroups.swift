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

/// 侧栏里的短相对时间：刚刚 / 5 分 / 3 时 / 2 天 / 10月3日；long 版写成「5 分钟前」
func agoText(_ epochMs: Double?, long: Bool = false) -> String {
    guard let epochMs, epochMs > 0 else { return "" }
    let seconds = max(0, Date().timeIntervalSince1970 - epochMs / 1000)
    if seconds < 60 { return "刚刚" }
    if seconds < 3600 { return "\(Int(seconds / 60)) \(long ? "分钟前" : "分")" }
    if seconds < 86_400 { return "\(Int(seconds / 3600)) \(long ? "小时前" : "时")" }
    if seconds < 86_400 * 7 { return "\(Int(seconds / 86_400)) \(long ? "天前" : "天")" }
    let parts = Calendar.current.dateComponents([.month, .day], from: Date(timeIntervalSince1970: epochMs / 1000))
    return "\(parts.month ?? 1)月\(parts.day ?? 1)日"
}

/// 一个工作区里的对话数和最近活动时间（毫秒）
struct WorkspaceStat {
    var chats = 0
    var touched = 0.0
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
        // 助理会话单独置顶，不进工作区分组
        for chat in chats where !isAssistantChat(chat.id) {
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
        // USER 根目录只承载助理会话，由置顶入口代替，不进工作区分组
        return order.compactMap { key -> WorkspaceGroup? in
            guard let entry = byKey[key], !isUserRoot(entry.path) else { return nil }
            return WorkspaceGroup(key: key, path: entry.path, name: entry.name, user: entry.user, chats: entry.chats)
        }
    }

    /// USER 根目录：只承载助理会话。ready 前 workspaceRoot 为空，一律不算
    func isUserRoot(_ path: String?) -> Bool {
        !workspaceRoot.isEmpty && sameCwd(path, workspaceRoot)
    }

    /// 可以开新对话的子工作区（不含 USER 根目录）
    var subWorkspaces: [WorkspaceItem] {
        workspaces.filter { !$0.user && !isUserRoot($0.path) }
    }

    /// 每个工作区的对话数、最近活动时间，key 是 normPath 后的目录（和网页端分组口径一致）
    var workspaceStatsByKey: [String: WorkspaceStat] {
        var out: [String: WorkspaceStat] = [:]
        for chat in sidebarChats {
            let key = normPath(chat.cwd?.nilIfEmpty ?? groupRoot)
            var stat = out[key] ?? WorkspaceStat()
            stat.chats += 1
            stat.touched = max(stat.touched, chat.touchedAt ?? 0)
            out[key] = stat
        }
        return out
    }

    /// 子工作区按最近活动排序；没有时间的保持网关给的顺序
    var recentSubWorkspaces: [WorkspaceItem] {
        let stats = workspaceStatsByKey
        return subWorkspaces.enumerated()
            .sorted { lhs, rhs in
                let a = stats[normPath(lhs.element.path)]?.touched ?? 0
                let b = stats[normPath(rhs.element.path)]?.touched ?? 0
                if a != b { return a > b }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    /// 对话的目录是不是在 path 里面（含自身和子目录）。和网关删除工作区时数对话的口径一致
    func isChatUnder(_ chat: ChatSession, _ path: String) -> Bool {
        let dir = normPath(path)
        let cwd = normPath(chat.cwd?.nilIfEmpty ?? groupRoot)
        return cwd == dir || cwd.hasPrefix(dir + "/")
    }

    /// path 里（含子目录）有多少个对话
    func chatCountUnder(_ path: String) -> Int {
        sidebarChats.filter { isChatUnder($0, path) }.count
    }

    /// 是不是根目录下的一级工作区：只有这些能改名、删除
    func isTopLevelWorkspace(_ path: String) -> Bool {
        let root = normPath(workspaceRoot)
        let abs = normPath(path)
        guard !root.isEmpty, abs.hasPrefix(root + "/") else { return false }
        let rel = String(abs.dropFirst(root.count + 1))
        return !rel.isEmpty && !rel.contains("/") && !rel.hasPrefix(".")
    }

    /// 侧栏当前看着的工作区：活跃会话的目录，否则退回连接上的 cwd。
    /// 落在 USER 根目录（助理会话）时退回最近用过的子工作区，没有子工作区才返回根目录。
    var currentWorkspacePath: String {
        let path = active?.cwd?.nilIfEmpty ?? cwd.nilIfEmpty ?? workspaceRoot
        guard isUserRoot(path) else { return path }
        let recent = sidebarChats.lazy.compactMap { $0.cwd?.nilIfEmpty }.first { !self.isUserRoot($0) }
        return recent ?? subWorkspaces.first?.path ?? path
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
        let path = currentWorkspacePath.nilIfEmpty ?? groupRoot
        if isUserRoot(path) { return [] }
        let key = normPath(path)
        return sidebarChats.filter { normPath($0.cwd?.nilIfEmpty ?? groupRoot) == key }
    }
}
