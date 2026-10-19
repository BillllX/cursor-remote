import Foundation

/// 记忆中心布局断点（与 ToolLayer ~420pt 等窄容器对齐；勿仅用 size class）。
enum MemoryCenterLayoutTier: Equatable, Sendable {
    case triple
    case double
    case single
}

enum MemoryCenterLayoutMetrics {
    /// 三栏：导航 / 列表 / 详情
    static let tripleColumnMinWidth: Double = 900
    /// 两栏：导航 / 列表（详情在右栏内 drill）
    static let doubleColumnMinWidth: Double = 560

    static func tier(containerWidth: Double) -> MemoryCenterLayoutTier {
        if containerWidth >= tripleColumnMinWidth { return .triple }
        if containerWidth >= doubleColumnMinWidth { return .double }
        return .single
    }
}

/// 560–899pt 双栏右 pane 逻辑（供 UI 与契约测试共用）
enum MemoryCenterDoubleColumnRightPane: Equatable, Sendable {
    case embeddedMiddle
    case searchList
    case searchDetail
    case scopeItemDetail
}

enum MemoryCenterUILayoutLogic {
    static func doubleColumnRightPane(
        searchActive: Bool,
        selectedKey: String?,
        navId: String
    ) -> MemoryCenterDoubleColumnRightPane {
        if searchActive, selectedKey != nil { return .searchDetail }
        if searchActive { return .searchList }
        if selectedKey != nil,
           let scope = MemoryCenterReducer.scopeIdForNav(navId),
           scope != "personal"
        {
            return .scopeItemDetail
        }
        return .embeddedMiddle
    }

    /// 切换左侧导航：退出搜索模式并清选中（详情 / 搜索详情回到列表或 scope 内容）
    static func applyNavSelection(
        selectedKey: inout String?,
        searchText: inout String,
        searchActive: inout Bool,
        navId: inout String,
        targetNavId: String
    ) {
        guard targetNavId != navId || searchActive || selectedKey != nil else { return }
        selectedKey = nil
        if searchActive {
            searchActive = false
            searchText = ""
        }
        navId = targetNavId
    }
}

#if canImport(CoreGraphics)
import CoreGraphics

extension MemoryCenterLayoutMetrics {
    static func tier(containerWidth: CGFloat) -> MemoryCenterLayoutTier {
        tier(containerWidth: Double(containerWidth))
    }
}
#endif
