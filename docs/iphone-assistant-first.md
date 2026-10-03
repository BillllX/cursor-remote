# 接驳 iPhone 改版：纯个人助理

> 交给 Mac 上的 Agent 执行的实现规格。本文写于没有 Xcode 的环境，所有代码引用都基于当前仓库源码阅读，**行号仅供定位，以实际文件为准**。
>
> 工程：`ios/Jiebo/Jiebo.xcodeproj`，Target `Jiebo`，iOS 17.0，Swift 5，Observation（`@Observable`）。
> 工程**不是** Xcode 16 的文件夹同步组（pbxproj 里没有 `PBXFileSystemSynchronizedRootGroup`），**每新增一个 .swift 文件都必须加进 `project.pbxproj`**（PBXFileReference + PBXBuildFile + 所属 PBXGroup + Sources 阶段），否则编译不到。最稳的做法是用 Xcode 打开工程，把新文件拖进对应分组。
>
> 本版取代此前「四个 Tab、工作 tab、会话页」以及「三个 Tab」的方案。方向已定：**iPhone 是一个纯粹的个人助理 App，不进工作区，没有底栏。**

---

## 0. 目标与已定的决定

iPad 和网页是「IDE + 对话」；iPhone 是「**个人助理**」：

1. **iPhone 上只有一条对话：助理。** 不显示工作区、不显示工作区里的历史会话、不提供文件树 / 搜索 / Git / 终端 / Loop 入口，用户也不能「进入」任何工作区会话。
2. **要在工作区干活，就跟助理说。** 助理用已有的 `delegate` 工具把任务交给对应工作区的子会话，子会话要写文件或跑命令时，批准请求回到助理这里，用户在手机上批准或拒绝，结果回到助理对话和待处理。
3. **助理可以自己判断需要新工作区，但必须经用户确认。** 助理调用新增的 `create_workspace` 工具，手机上弹出确认卡，同意才建，拒绝或不回应都不会建。
4. **不做「插话」。** 子会话跑起来之后，用户不能直接给它发消息；想调整就停掉，再跟助理说，由助理重新委派。
5. **iPhone 上不看，其它端保留。** 网页和 iPad 照旧可以看到所有工作区会话（包括助理委派出去的子会话）。网关数据不改，只是 iPhone 不展示。
6. **记忆是沉默的。** 记忆由后台持续总结、更新，前端不强提示：首页、今日面板、菜单第一层都不出现记忆，也不显示条目数；对话里不显示记忆工具的工具卡。要查看或修改，走 ☰ → 设置 → 记忆（§4.3.1）。用户明确说「记住…」时，助理用一句自然的话回应即可，不额外弹提示。

**只改 iPhone。** iPad（含 iPad 窄窗 / Slide Over）保持现有行为，不允许回归。

---

## 1. 现状（改动前必须理解的部分）

### 1.1 入口分流

`Views/RootView.swift` → `WorkbenchView`：

- `horizontalSizeClass == .compact` → `PhoneWorkbench()`（iPhone 和 iPad 窄窗共用）
- 否则 → `padWorkbench`
- `FileBrowserCover` 以 `.fullScreenCover` 挂在 `WorkbenchView` 上，两端共用

改后：`UIDevice.current.userInterfaceIdiom == .phone` → `PhoneShell()`；iPad 的两个分支不变。

### 1.2 iPhone 现在的问题

1. 助理只是抽屉里的一行，和工作区会话同权重。
2. 打开 App 落在「上次的对话」，多数时候是某个工作区会话。
3. 抽屉里塞了 5 个 IDE 工具 + 会话列表 + 设置，小屏信息密度过高。
4. 待批散落在各自会话里。
5. 输入框为 IDE 设计，对和助理聊天太重。

### 1.3 可以直接复用的能力

| 能力 | 位置 |
|---|---|
| 助理会话 id、名字 | `store.assistantChatId`、`store.assistantName`、`store.isAssistantChat(_:)`、`store.assistantChatActive` |
| 助理状态（简报/待办/日程/委派/待批/收件箱/记忆/后台模型） | `store.assistantState: AssistantState?`，`store.requestAssistant(memory:)` |
| 助理操作 | `store.assistantOp(op, args:)`：`inbox_read`、`todo_add/done/undo/remove`、`schedule_set/remove`、`memory_*`、`approval_answer`，以及本版新增的 `delegation_cancel`（§7） |
| 角标数 | `store.assistantBadgeCount`（未读收件箱 + 待批） |
| 审批 | `store.answerAssistantApproval(_:allow:)`、`store.assistantApprovals(forParent:)` |
| 打开助理会话 | `store.openAssistantChat()`（会话没同步到时记 pending） |
| 按需加载会话正文（不切换会话） | `store.ensureTurnsLoaded(_ chatId:)` |
| 预览 | `store.previewPanelOpen`、`store.activePreviewTab`、`PreviewPanelView` |
| 语音 | `Session/VoiceDictation.swift`：`start` / `finish` / `cancel` |

### 1.4 必须守住的不变量

1. **同一时刻只能挂载一个 `ComposerView`。** 它用本地 `@State text` 打字、350ms 后 `store.saveDraft` 回写，并在 `onChange(of: store.activeId)` 时重灌。⇒ 助理页是唯一的根页，只有它里面有 `ComposerView`；push 出去的页面（待处理、待办与日程、委派记录、设置、记忆）都不放输入框。不用系统 `TabView`。
2. **iPhone 上 `store.activeId` 永远是助理会话**（或启动前的 `"boot"`）。这是本版最大的简化，也是最需要守住的一条：`ThreadView`、`ComposerView`、预览、文件索引全都跟着 `activeId` 走，一旦它指向工作区会话，iPhone 就会「掉进」一个没有入口的会话里。守法见 §5.3 的 `assistantOnly` 守卫。
3. 不要直接赋值 `store.activeId`；改动一律走 `swapActive`（`select` / `startChat` / `deleteChat` / `applyStoredState` 都会汇到它）。
4. 助理会话不能删、不能改名、不能新开第二条；USER 根目录只承载助理会话。
5. 颜色只用 `JieboColor.*`，字体 `JieboFont.*`，圆角 `JieboRadius.*`，动画 `JieboMotion.*`（尊重 `accessibilityReduceMotion`），按钮命中区 `.hitTarget()`，按压 `PressScaleButtonStyle()`。**不写死任何颜色值**。
6. 读取子会话内容**不能用 `select`**。需要看子会话的过程时，从 `store.chats` 里按 id 取出 `ChatSession`，先 `store.ensureTurnsLoaded(id)`，然后只读渲染（§4.4）。

---

## 2. 目标信息架构

### 2.1 一个页面，两个顶栏入口

**没有底栏，没有 Tab。** 助理页是唯一的根页，一切都从它出发：

| 入口 | 位置 | 去向 |
|---|---|---|
| ☰ 菜单 | 导航栏左侧，有待处理时带提示 | 左侧滑出的菜单抽屉：待处理 + 原来「我」里的内容（§4.3） |
| 今日 | 导航栏右侧 | 半屏今日面板：简报、待办、日程（§4.1.5） |

- **待处理**（待批 + 收件箱）只在 ☰ 菜单里进入（§4.2），导航栏不再单独放消息图标。
- **☰ 上的提示**：`store.assistantBadgeCount`（未读收件箱 + 待批）> 0 时，在菜单按钮右上角显示数字角标（> 99 显示 `99+`）；为 0 时不显示。`accessibilityLabel` 写成「菜单，3 项待处理」或「菜单」。
- 抽屉内第一组「助理」里「待处理」行右侧同样显示该数字（与 ☰ 角标一致），方便打开菜单后一眼看到。
- 助理在回复时，导航栏副标题显示「正在回复」，不需要底栏上的小点。

### 2.2 层级图

```
PhoneShell
├─ NavigationStack(path: router.path)           ← 根永远是 AssistantHome
│   ├─ AssistantHome
│   │    ├─ 导航栏：☰³ | 小驳 / 状态 | [今日]
│   │    ├─ TodayStrip（横滑芯片）
│   │    ├─ ThreadView(chrome: .embedded) —— 助理会话
│   │    ├─ ActionDock（输入框正上方：确认卡 + 进行中的委派）
│   │    └─ ComposerView(style: .assistant)
│   └─ push 的页面（都没有输入框）
│        ├─ InboxHome（待处理）→ InboxDetailView
│        ├─ AssistantTodayScreen（待办与日程）
│        ├─ DelegationListScreen（委派记录）
│        └─ PhoneSettingsScreen（设置）→ AssistantMemoryScreen（记忆）
├─ MenuDrawer（从左侧滑出的抽屉，覆盖在 NavigationStack 之上）
├─ PreviewPanelView 全屏层（store.previewPanelOpen）
└─ sheet：AssistantHubSheet、DelegationDetailSheet、ThemeSettingsSheet、AdminStatsView
```

### 2.3 关键交互规则

1. **冷启动**落在助理页并选中助理会话（§3.2）。
2. **从后台回来**保持原页面（可能停在待处理或某个 push 页上）。
3. 所有 push 页和 sheet 都**不改 `activeId`**（它一直是助理）。
4. 进入任何 push 页之前先收起键盘（`UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)`）；回到助理页时不自动弹键盘。
5. 打开菜单抽屉之前同样收起键盘。
6. 任何「打开某条会话」的触发（收件箱条目、委派卡、推送点击、线程里的链接）统一走 `router.open(...)`（§3.1）：
   - 目标是助理会话 → 回到助理页（pop 到根）；
   - 目标是委派子会话 → 打开 `DelegationDetailSheet`；
   - 其它会话 → **不跳转**，只 `store.flash("这个会话在电脑或 iPad 上查看")`。
7. 助理回复里的文件链接 → 沿用现有机制打开 `PreviewPanelView` 全屏预览（只读）。
8. 侧滑返回是系统导航栈的；**菜单抽屉的「左缘右滑打开」手势只在 `router.path.isEmpty` 时启用**，避免和 push 页的侧滑返回冲突。

---

## 3. 状态与路由（新增 `Session/PhoneRouter.swift`）

没有 tab、没有工作区栈，路由只剩一个 push 栈和几个弹层。

```swift
import SwiftUI

/// 从助理页 push 出去的页面
enum PhoneRoute: Hashable {
    case inbox
    case inboxItem(String)      // AssistantInboxItem.id
    case todayManage
    case delegations
    case settings
    case memory                 // 只从设置页 push 进来，不直接挂在菜单上
}

struct DelegationRef: Identifiable, Hashable {
    let id: String   // AssistantDelegation.id
}

@Observable
@MainActor
final class PhoneRouter {
    var path: [PhoneRoute] = []
    var menuOpen = false
    var hubOpen = false
    /// 打开今日面板后滚到的锚点："todos" / "schedules"，nil 不滚
    var hubAnchor: String?
    /// 正在看的委派详情。sheet 挂在 PhoneShell 上，在任何 push 页上都能弹
    var delegationDetail: DelegationRef?
    var bootstrapped = false
}
```

`PhoneRouter` 只在 `PhoneShell` 里 `@State private var router = PhoneRouter()` 创建，`.environment(router)` 下发。**不要放进 `ChatStore`**。

### 3.1 路由动作

```swift
extension PhoneRouter {
    private func dismissKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// 菜单里的条目（含「待处理」）：先收菜单和键盘，再 push（替换整个栈，不叠层）
    func go(_ route: PhoneRoute) {
        dismissKeyboard()
        menuOpen = false
        hubOpen = false
        path = [route]
    }

    func openMenu() {
        dismissKeyboard()
        hubOpen = false
        menuOpen = true
    }

    func popToRoot() {
        path = []
        menuOpen = false
    }

    /// 收件箱条目 / 推送 / 委派卡等「要打开某个会话」的统一入口
    func open(chatId: String?, delegationId: String?, store: ChatStore) {
        if let delegationId, store.assistantState?.delegations.contains(where: { $0.id == delegationId }) == true {
            delegationDetail = DelegationRef(id: delegationId)
            return
        }
        if let chatId, store.isAssistantChat(chatId) {
            popToRoot()
            store.openAssistantChat()
            return
        }
        if let chatId, let row = store.assistantState?.delegations.first(where: { $0.childChatId == chatId }) {
            delegationDetail = DelegationRef(id: row.id)
            return
        }
        store.flash("这个会话在电脑或 iPad 上查看")
    }
}
```

> 在 push 页上弹出 `DelegationDetailSheet` 时，sheet 盖在当前页之上，不改变 `path`，关闭后用户回到原来的页面。

### 3.2 冷启动对齐（`PhoneShell.task`）

```
1. 打开 PhoneShell 时 store.assistantOnly = true（§5.3）；onDisappear 置回 false
2. 等 store.unlocked && store.assistantChatId != nil
   （onChange 即可；给 8 秒上限，超时也置 bootstrapped = true）
3. store.openAssistantChat()
4. router.bootstrapped = true
```

- `restoreLastActiveIfNeeded` 会先恢复「上次活跃会话」（可能是工作区会话，来自旧版本或 iPad 上的操作）。有了 `assistantOnly` 守卫，这次恢复会被重定向到助理会话，不需要额外处理。
- 旧网关没有 `assistantChatId`：超时后 `bootstrapped = true`，助理页显示降级页（§4.1.6）。

---

## 4. 各页面规格

### 4.0 `PhoneShell`（新文件 `Views/Phone/PhoneShell.swift`）

替代 iPhone 上的 `PhoneWorkbench`。

```swift
struct PhoneShell: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var router = PhoneRouter()

    var body: some View {
        @Bindable var router = router
        ZStack {
            NavigationStack(path: $router.path) {
                AssistantHome()
                    .navigationDestination(for: PhoneRoute.self) { route in
                        switch route {
                        case .inbox: InboxHome()
                        case .inboxItem(let id): InboxDetailView(itemId: id)
                        case .todayManage: AssistantTodayScreen()
                        case .delegations: DelegationListScreen()
                        case .settings: PhoneSettingsScreen()
                        case .memory: AssistantMemoryScreen()
                        }
                    }
            }
            if router.menuOpen {
                MenuDrawer()                 // 遮罩 + 左侧 300pt 面板，zIndex 2
            }
            if store.previewPanelOpen, let tab = store.activePreviewTab {
                // 与 PhoneWorkbench 现有写法一致：遮罩 + 全屏 PreviewPanelView，zIndex 3
            }
        }
        .environment(router)
        .animation(JieboMotion.panel(reduceMotion), value: router.menuOpen)
        .animation(JieboMotion.panel(reduceMotion), value: store.previewPanelOpen)
        .sheet(item: $router.delegationDetail) { ref in DelegationDetailSheet(delegationId: ref.id) }
        .onAppear { store.assistantOnly = true }
        .onDisappear { store.assistantOnly = false }
        .task { await bootstrap() }
    }
}
```

要求：

- 助理页永远是根，**只有一个 `ComposerView`**（不变量 1）；push 页里没有输入框。
- push / pop 用系统默认动画。
- `WorkbenchView` 改为：

```swift
if UIDevice.current.userInterfaceIdiom == .phone {
    PhoneShell()
} else if sizeClass == .compact {
    PhoneWorkbench()        // iPad 窄窗保持原样
} else {
    padWorkbench
}
```

- `FileBrowserCover` 的 `.fullScreenCover` 留在 `WorkbenchView`，iPhone 没有入口会触发它，不用动。

### 4.0.1 `MenuDrawer`（新文件 `Views/Phone/MenuDrawer.swift`）

左侧抽屉，内容见 §4.3。写法沿用 `PhoneWorkbench` 里现有的 `PhoneDrawer`：

- 宽 300pt（小屏取 `min(300, 屏宽 × 0.82)`）；面板背景 `JieboColor.sidebar`，右缘 1px `JieboColor.line`；内容不穿过安全区（顶部留状态栏、底部留 home indicator）。
- 遮罩 `Color.black.opacity(0.28)`（与现有抽屉一致，不是新增颜色常量；如果现有写法用了 token 就跟现有）；点遮罩关闭。
- 手势：面板上向左拖 > 60pt 或速度够快 → 关闭；**左缘 16pt 内向右拖 → 打开，仅当 `router.path.isEmpty` 且没有键盘**。
- 打开 / 关闭动画 `JieboMotion.panel(reduceMotion)`；打开时 `UISelectionFeedbackGenerator().selectionChanged()`。
- 无障碍：打开后焦点移到抽屉首项，遮罩 `accessibilityLabel("关闭菜单")`。

### 4.1 助理页 `AssistantHome`（新文件 `Views/Phone/AssistantHome.swift`）

```
┌──────────────────────────────────┐
│ ☰³  小驳                    [今日•] │  ← 导航栏 inline；☰ 角标 = 待处理数；副标题：就绪 / 正在回复 / 正在重连…
├──────────────────────────────────┤
│ [简报] [待办 3] [09:00 晨报] [进行中 2] → │  ← TodayStrip，横滑，空则整条隐藏
├──────────────────────────────────┤
│                                  │
│   助理会话线程（ThreadView）         │
│                                  │
├──────────────────────────────────┤
│ ┌ 助理想新建工作区「讲稿」 ────────┐ │  ← ActionDock：确认卡在最上
│ │ 原因：…          [拒绝] [同意]  │ │
│ └────────────────────────────────┘ │
│ ┌ ● 整理周报 · notes · 进行中 › ──┐ │  ← 进行中的委派（最多 2 条，其余折叠成「还有 N 项」）
│ └────────────────────────────────┘ │
│ ┌ 跟小驳说点什么 · 点话筒说话 ────┐ │
│ │ ＋                    🎤   ⬆    │ │  ← ComposerView(style: .assistant)
│ └────────────────────────────────┘ │
└──────────────────────────────────┘
```

> 没有底栏，输入框直接贴着屏幕底部（含安全区）。

#### 4.1.1 导航栏

- 导航栈由 `PhoneShell` 提供（`NavigationStack(path:)`），`AssistantHome` 自己不再包一层。`.navigationBarTitleDisplayMode(.inline)`，`.toolbarBackground(JieboColor.paper, for: .navigationBar)` + `.toolbarBackground(.visible, for: .navigationBar)`。
- `ToolbarItem(placement: .principal)`：VStack —— `store.assistantName`（`JieboFont.display(17)`）+ 副标题（`JieboFont.ui(11, weight: .medium)`, `JieboColor.dim`）。优先级：未连接「正在重连…」> 未配 key「服务器还没配 API Key」（`JieboColor.danger`）> 助理在跑「正在回复」> 后台状态 `assistantState.background.ok ? "就绪" : reason`。
- **左侧：☰ 菜单按钮**（`line.3.horizontal`，`hitTarget()`）→ `router.openMenu()`。当 `store.assistantBadgeCount > 0` 时，在图标容器右上角叠数字角标（与下文菜单行同款：`JieboColor.danger` 底、`JieboColor.fillFg` 字、`JieboFont.ui(10, weight: .semibold)`，> 99 为 `99+`）；为 0 不叠角标。无障碍：`accessibilityLabel` 有待处理时写「菜单，N 项待处理」，否则「菜单」。
- **右侧**：「今日」按钮 —— 沿用 `ThreadView.assistantTodayButton` 外观（抽成可复用的 `AssistantTodayButton(on:marked:action:)`），点击 `router.hubAnchor = nil; router.hubOpen = true`。
- `store.canUndo` 时在今日按钮左边多一个撤销按钮；导航栏过挤时（小屏、大字号）撤销收进 `ellipsis` `Menu` 里，不要挤掉「今日」。

#### 4.1.2 TodayStrip（新文件 `Views/Phone/TodayStrip.swift`）

横向 `ScrollView(.horizontal, showsIndicators: false)`，`HStack(spacing: 8)`，左右内边距 16，高度 44（芯片 32 高，`hitTarget()` 保证 44 命中）。芯片：`JieboColor.white` 底、`JieboColor.line` 描边、`JieboRadius.sm`、`JieboFont.ui(13, weight: .medium)`。**为空的芯片不显示**；全部为空或 `assistantState == nil` 时整条隐藏。

| 芯片 | 条件 | 文案 | 点击 |
|---|---|---|---|
| 简报 | `state.brief?.text` 非空 | `doc.text` +「今日简报」 | 打开今日面板 |
| 待办 | 未完成 todo 数 > 0 | 「待办 N」 | 打开今日面板，`hubAnchor = "todos"` |
| 下一个日程 | 启用的日程里 `nextAt` 最近的 | 「HH:mm 标题」（跨天显示「明天 HH:mm」/「M月d日」） | 打开今日面板，`hubAnchor = "schedules"` |
| 进行中 | `delegations` 里 running/awaiting 数 > 0 | 「进行中 N」，`JieboColor.run`/`runBg` | 滚动到行动区；仅 1 项时直接打开其详情 |

- 待批**不在**这里：它会出现在行动区（要立刻答复）和待处理页（☰ 角标与菜单里「待处理」行上的数字）。
- `AssistantHome.task { store.requestAssistant() }`；`scenePhase` 回到 `.active` 时再拉一次。

#### 4.1.3 线程

- `ThreadView(chrome: .embedded)`（§5.1）。
- 助理空状态：
  - 标题：「\(assistantName) 在这儿」
  - 说明：「记事、提醒、查东西，或者让它去某个项目里干活，不用你自己打开任何东西。」
  - 快捷句（点了填进输入框并聚焦）：「今天有什么安排？」「帮我记一下：」「明早 9 点提醒我」「让 acrabat 里的讲稿再顺一遍」
- `ThreadView` 里现有的 `delegatedApprovalBanner`、写入确认条、pendingDiff pill：`.embedded` 下**隐藏**，由 ActionDock 接管，避免两处出现同一张确认卡。
- 线程里助理调用 `delegate` / `create_workspace` / `delegation_status` 的工具卡：沿用 `ThreadView` 现有通用工具卡即可；可选优化是把 `delegate` 显示成「交给 acrabat：<title>」、`create_workspace` 显示成「申请新建工作区：<name>」，而不是原始工具名与 JSON（放在 P5）。
- **记忆工具不出卡片**（决定 6）：`.embedded` 下，工具名以 `memory_` 开头的（`memory_search`、`memory_save`、`memory_supplement`、`memory_forget`、`memory_invalidate`）和 `chat_search`，在线程里**整张不渲染**，也不计入「N 个步骤」之类的折叠计数。助理回复正文照常显示。iPad 和网页不变。

#### 4.1.4 ActionDock（新文件 `Views/Phone/ActionDock.swift`）

放在 `ThreadView` 与 `ComposerView` 之间，随内容自适应高度，无内容时不占位。内容按顺序：

**A. 确认卡**：`store.assistantState.approvals` 里所有项，倒序，最多展开 2 张，其余合并成「还有 N 项待批，去待处理」一行（点击 `router.go(.inbox)`）。

| `approval.tool` | 标题 | 正文 | 按钮 |
|---|---|---|---|
| `create_workspace` | 「新建工作区」 | `summary` 的格式是 `名字 · 原因`：名字用 `JieboFont.mono(13)` 强调，原因用 `JieboFont.ui(13)` | 「拒绝」「同意」 |
| `shell` | 「<委派标题> 想跑命令」 | `summary`（mono 12，最多 3 行） | 「拒绝」「批准」 |
| 其它（改文件等） | 「<委派标题> 想改文件」 | `summary`（mono 12，最多 3 行） | 「拒绝」「批准」 |

- 委派标题：`state.delegations.first { $0.id == approval.delegationId }?.title`；`create_workspace` 没有 `delegationId`（它属于助理自己的会话，`approval.chatId == assistantChatId`）。
- 按钮调用 `store.answerAssistantApproval(approval, allow:)`（内部发 `approval_answer {chatId, callId, allow}`）。触觉：同意 `.success`，拒绝 `.warning`。
- `create_workspace` 同意后助理那一轮会**自动继续**（网关里工具调用就是停在这张确认卡上等答复，答复后接着往下走），**不要**在客户端再发一条「已同意」的消息。
- 卡片会在答复、超时（30 分钟）或网关重启后消失，由 `assistantState` 的更新驱动，客户端不用自己计时；但卡片上要显示「N 分钟后失效」的静态提示（`expiresAt` 减当前时间，每分钟刷新一次即可），免得用户不知道它会失效。
- 视觉：`JieboColor.warnBg` 底 + `JieboColor.warnFg` 标题；圆角 `JieboRadius.md`；左右各 12pt 外边距。

**B. 进行中的委派**：`delegations` 里 `status == running || awaiting`，按 `createdAt` 倒序，最多 2 条，其余合并成「还有 N 项」（点击打开最新一项的详情）。

- 一行：状态点（running = `JieboColor.run`，awaiting = `JieboColor.warnFg`）+ 标题 + 「工作区 · 已 N 分钟」+ 右侧 `chevron.right`。
- `awaiting` 的状态文案改成「等你批准」。
- 点击 → `router.delegationDetail = DelegationRef(id: id)`。
- 行高 ≥ 44pt，`hitTarget()`。

**C. 刚结束的委派**（可选，P5）：`done` / `failed` 且 `endedAt` 在 10 分钟内、用户还没看过 → 显示一行「✓ 整理周报 已完成」/「✗ … 失败」，点击打开详情，滑走或 10 分钟后消失。这样用户盯着助理页时不用切到待处理就能看到结果。不做也行，结果在待处理里一定有。

#### 4.1.5 今日面板 AssistantHubSheet（新文件 `Views/Phone/AssistantHubSheet.swift`）

`.sheet(isPresented: $router.hubOpen)`，`.presentationDetents([.medium, .large])`，`.presentationDragIndicator(.visible)`，`.presentationBackground(JieboColor.paper)`。

- 只有「今日」一页，**没有分段控件，没有记忆**（决定 6）。顶部标题「今日」，右上「完成」。
- 内容复用 `AssistantTodayPane`（§5.4）。需要补两项：
  - 待办行**左滑**「删除」→ `todo_remove`；已完成的折叠在「已完成 (N)」里，可「撤销」→ `todo_undo`。
  - 日程行右侧 `Toggle` → `assistantOp("schedule_set", args: ["id": .string(id), "enabled": .bool(on)])`（网关对已有 id 做部分更新，cron/prompt 沿用原值，已核实 `schedules.ts setSchedule`）。
- 打开时 `router.hubAnchor` 非空就用 `ScrollViewReader` 滚到锚点（`"todos"`、`"schedules"`）。
- 今日 pane 里的「待批」「委派」「收件箱」三块在 iPhone 上**不显示**（它们在行动区和待处理里）；用 `AssistantTodayPane(showsApprovals: false, showsDelegations: false)` 之类的开关控制，iPad 默认全开。

#### 4.1.6 降级

`store.assistantChatId == nil`（旧网关）且 `bootstrapped`：页面主体显示一张说明卡「这个服务器还没有助理功能，请先升级服务器」，不放输入框。iPhone 此时没有任何别的可用功能，这是有意为之。

### 4.2 待处理页 `InboxHome`（新文件 `Views/Phone/InboxHome.swift`）

从 ☰ 菜单里点「待处理」push 进来（`router.go(.inbox)`），不是独立 Tab。用系统导航栏返回。

`List` + `.listStyle(.insetGrouped)` + `.scrollContentBackground(.hidden)` + `JieboColor.paper`，`.navigationTitle("待处理")`，inline 标题。`.refreshable { store.requestAssistant() }`。

右上菜单：「全部标为已读」→ `assistantOp("inbox_read")`（不带 ids = 全部；本地同步把 `inbox[i].read = true`）。

#### Section「待批」

数据 `store.assistantState?.approvals`（`create_workspace` 与委派审批同样处理），行内容和按钮与 ActionDock 的确认卡一致（抽成共享的 `ApprovalCard`，Dock 和这里共用）。委派审批行右侧再放「看委派」→ `router.delegationDetail`。为空时 Section 不显示。

#### Section「收件箱」

- 数据：`store.assistantState?.inbox`（按 `createdAt` 倒序）。
- 行：未读圆点（`JieboColor.pine`）、标题（未读 semibold）、相对时间、正文前两行。`kind` 小标签（`StatusTag`）：approval「待批」、delegation「委派」、reminder「提醒」、brief「简报」。
- 点击：
  1. 先 `markInboxRead(item)`（只发 `inbox_read` 并本地置已读，不跳转，见 §5.3）。
  2. 有 `delegationId` 或 `chatId` → `router.open(chatId:delegationId:store:)`（§3.1）。目标是助理会话时会 pop 回助理页。
  3. 都没有 → push `.inboxItem(item.id)` → `InboxDetailView`（标题、时间、完整正文 `textSelection(.enabled)`）。
  - **不要**调 `store.openAssistantInboxItem(item)`：它会 `select` 目标会话，而目标可能是工作区子会话，会破坏「`activeId` 永远是助理」的不变量。
- 左滑：未读时「已读」。
- 空状态：`ContentUnavailableView("没有待处理的事", systemImage: "tray", description: Text("\(assistantName) 有新消息会放在这里。"))`。

### 4.3 菜单抽屉内容（原「我」）

`MenuDrawer` 里是一个自绘的竖向列表（不是 `List`，抽屉不需要 inset 分组），分组之间用 `JieboColor.line` 分隔线，行高 ≥ 48pt，`hitTarget()`：

1. **头部**：`JieboMark(size: 36)` + `store.tenantName`（空则「接驳」）+ `ConnectionDot` + 「已连接 / 正在重连…」。
2. **助理**
   - **「待处理」** → `router.go(.inbox)`，push `InboxHome`（§4.2）。右侧数字角标 = `store.assistantBadgeCount`（与 ☰ 上角标同一数据源），为 0 不显示数字。行首图标 `tray` / 有未读时 `tray.full`。
   - 「待办与日程」→ `router.go(.todayManage)`，push `AssistantTodayScreen`（包 `AssistantTodayPane`，含 §4.1.5 的补充操作）。
   - 「委派记录」→ `router.go(.delegations)`，push `DelegationListScreen`（`assistantState.delegations`，倒序，行：标题 + 工作区 + 状态 + 相对时间）；点行 → `router.delegationDetail`。
3. **设置**：一行「设置」（`gearshape`）→ `router.go(.settings)`，push `PhoneSettingsScreen`（§4.3.1）。主题、后台模型、记忆、使用统计都收在里面。
4. **账号**：「退出登录」（destructive）→ `confirmationDialog`，文案沿用 `PhoneWorkbench`。
5. **关于**（抽屉底部，小字）：版本号 `CFBundleShortVersionString` + build。

> 「今日」不放抽屉（导航栏有按钮）。「待处理」放在抽屉「助理」组**第一行**，与 ☰ 角标联动；行动区里紧急的确认卡仍可直接批，不必先进菜单。记忆不在抽屉第一层出现（决定 6）。

#### 4.3.1 设置页 `PhoneSettingsScreen`（放在 `Views/Phone/MenuScreens.swift`）

`List` + `.listStyle(.insetGrouped)` + `.scrollContentBackground(.hidden)` + `JieboColor.paper`，`.navigationTitle("设置")`。

1. **外观**：「主题 · \(JieboTheme.shared.palette.title)」→ 弹 `ThemeSettingsSheet`。
2. **助理**
   - 「后台模型」只读行：`background.model` + 就绪/原因。
   - 「记忆」→ `NavigationLink(value: PhoneRoute.memory)`（在当前栈上追加，返回回到设置页；**不要**用 `router.go`，它会替换整个栈）。push `AssistantMemoryScreen`（包 `AssistantMemoryPane`，`onAppear { store.requestAssistant(memory: true) }`）。行上**不显示条目数、不显示红点**，副标题固定一行小字「\(assistantName) 会在后台自己整理」。
3. **用量**（`store.isAdmin`）：「使用统计」→ 弹 `AdminStatsView`（sheet）。

记忆页本身的功能（核心档案、暂停记忆、新增、编辑、标失效、遗忘、彻底删除）沿用 `AssistantMemoryPane`，不删减，只是入口变深。

### 4.4 委派详情 `DelegationDetailSheet`（新文件 `Views/Phone/DelegationDetailSheet.swift`）

`.presentationDetents([.medium, .large])`，只读。**没有输入框，没有「继续聊」，没有文件入口。**

```
┌──────────────────────────────────┐
│ 整理周报                    完成   │  ← 标题 + 完成按钮
│ notes · 后台 · 已用时 3 分钟        │
│ ● 进行中                           │  ← 状态胶囊（AssistantDelegation.statusLabel/statusColors）
├──────────────────────────────────┤
│ 汇报                               │  ← done/failed 时：delegation.result，textSelection
│  做了什么…                          │
├──────────────────────────────────┤
│ 过程                               │  ← 子会话的工具步骤，只读
│  ✓ 读 周报/本周.md                  │
│  ✓ 改 周报/汇总.md                  │
│  … 正在跑 npm test                  │
├──────────────────────────────────┤
│ [停止这项委派]                      │  ← 仅 foreground 且 running/awaiting
└──────────────────────────────────┘
```

- 数据：`delegation = store.assistantState?.delegations.first { $0.id == delegationId }`；删除或找不到 → 显示「这项委派已不存在」。
- **过程**：`store.chats.first { $0.id == delegation.childChatId }` 取子会话。出现时调 `store.ensureTurnsLoaded(childChatId)`（它不切换会话，已核实只依赖传入的 chatId）。过程区取该会话**最后一个 assistant turn** 的 `tools`，每个一行：状态图标 + 动作文字 + 目标路径（`mono 12`），用与 `ThreadView` 工具卡相同的文案函数。最多 30 行，更多折叠成「还有 N 步」。**不渲染对话气泡，不渲染 diff。** 子会话尚未同步到本机（`chats` 里没有）→ 过程区显示「过程在电脑上查看」，不影响其它区块。
- **汇报**：`delegation.result`（`done`/`failed` 时）。进行中不显示。
- **等你批准**：`awaiting` 时顶部放该委派的 `ApprovalCard`（`approvals` 里 `delegationId == delegation.id`）。
- **停止**：`assistantOp("delegation_cancel", args: ["delegationId": .string(id)])`；先弹 `confirmationDialog`「停掉后已经改过的文件不会自动还原」，确认后按钮变「正在停止…」，等 `assistantState` 里状态变化；返回 `ok:false` 时用 `store.flash(error)` 显示网关给的原因。
  - `mode == "background"`（定时任务发起的只读委派）不显示「停止」按钮，改显示一行说明「后台任务只读，会自己结束」。
- 不做：文件预览、查看 diff、还原、继续对话。想看细节 → 说明文字「完整过程在电脑或 iPad 上查看」。

---

## 5. 需要改的现有文件

### 5.1 `Views/ThreadView.swift`

把 `phoneChrome: Bool` 换成枚举（保留旧初始化器兼容，避免一次改太多调用点）：

```swift
enum ThreadChrome { case pad, phoneLegacy, embedded }

struct ThreadView: View {
    var chrome: ThreadChrome = .pad
    var openDrawer: () -> Void = {}
    init(chrome: ThreadChrome = .pad, openDrawer: @escaping () -> Void = {}) { … }
    init(phoneChrome: Bool, openDrawer: @escaping () -> Void = {}) {
        self.init(chrome: phoneChrome ? .phoneLegacy : .pad, openDrawer: openDrawer)
    }
}
```

- `header`：`.pad` → `padHeader`；`.phoneLegacy` → `phoneHeader`；`.embedded` → `EmptyView()`。
- `.toolbar(.hidden, for: .navigationBar)` 只在 `.pad` / `.phoneLegacy` 时应用。`.embedded` 由宿主管理导航栏。
- `emptyState` 在 `.embedded` 下用助理文案（§4.1.3）。
- `.embedded` 下隐藏 `delegatedApprovalBanner`、写入确认条、pendingDiff pill（§4.1.3）。
- 「xxx · 预览」浮动胶囊：`.embedded` 下保留（打开 `PreviewPanelView`，由 `PhoneShell` 绘制）。
- 把 `assistantTodayButton` 抽成 `AssistantTodayButton`，ThreadView 内部改为调用它，外观不变。

### 5.2 `Views/ComposerView.swift`

新增 `enum ComposerStyle { case full, assistant }`，`var style: ComposerStyle = .full`。`.full` 行为**完全不变**。

`.assistant`：

- placeholder：未连接「正在连服务器…」；忙「正在回复，发送会排队」；否则「跟\(store.assistantName)说点什么」。
- `controls`：`attachMenu`（去掉「工作区文件…」项）+ `Spacer` + **麦克风按钮** + `sendCluster`。
  - 麦克风按钮：32pt 圆，`mic` / 录音中 `mic.fill` + `JieboColor.pine`。**点按**切换开始/结束：开始走现有 `beginVoice()`（内部 `dictation.start()`，含权限申请）；再点一次 `let spoken = await dictation.finish()` 后 `insertTranscript(spoken)`；放弃用 `dictation.cancel()`。长按输入框说话的现有手势保留，两种入口共用同一个 `dictation`，`dictation.active` 时互斥。
  - 模式、模型、策略层、确认写、检查点**全部收进 `moreMenu`**（`ellipsis`），菜单里加「模式」「模型」两个子 `Menu`。
- `@` 补全条仍可用。
- 由调用方决定 style：`ThreadView` 里 `ComposerView(focusNonce:, style: store.assistantChatActive && chrome == .embedded ? .assistant : .full)`。iPad 永远 `.full`。

### 5.3 `Session/ChatStore.swift`（只加，不改既有方法语义）

**① `assistantOnly` 守卫**（不变量 2 的落实点）：

```swift
/// iPhone 的 PhoneShell 出现时置 true：activeId 只允许是助理会话。iPad / 网页永远 false
var assistantOnly = false
```

在 `swapActive(to:)` 的**最开头**（`guard newId != activeId` 之前）加：

```swift
var newId = newId
if assistantOnly, let assistantId = assistantChatId, newId != assistantId {
    // 任何路径（恢复上次会话、删除回落、收件箱跳转、网关 workspace_created、旧代码里的 startChat……）
    // 想切到工作区会话，都改成助理会话。助理会话还没同步到时不切，留在当前页
    guard chats.contains(where: { $0.id == assistantId }) else { return }
    newId = assistantId
}
```

> 因为 `swapActive` 是 `private`，这段直接写在方法里。`select` 在调用 `swapActive` 之后还会 `patch(id)` 标已读、`applySession(chats.first { $0.id == id })`，这里的 `id` 是原始参数，不是重定向后的助理 id —— **要把这两处也换成 `activeId`**，或者在 `select` 开头同样重定向。改完后通读 `select`、`startChat`、`deleteChat`、`applyStoredState`、`restoreLastActiveIfNeeded` 五个方法，确认没有地方在 `swapActive` 之后还用原始 id 操作。
>
> 注意 `.workspaceCreated` 分支会 `startChat(in: path)`，守卫会把它重定向回助理会话，不会跳走。iPhone 本身不会发 `create_workspace` 请求；网关在助理建好工作区后给所有端广播的是 `workspaces`（不是 `workspace_created`），也不会触发这条。

**② 辅助方法**，放进新文件 `Session/ChatStore+Phone.swift`：

```swift
extension ChatStore {
    /// 只标已读，不跳转（InboxHome 用；openAssistantInboxItem 的前半段）
    func markInboxRead(_ item: AssistantInboxItem)
    var assistantRunning: Bool        // 助理会话在跑
    var runningDelegations: [AssistantDelegation]   // status running / awaiting，createdAt 倒序
    func approvalDelegationTitle(_ approval: AssistantApproval) -> String
}
```

**③ 避免多余的正文拉取（可选的省流优化）**：`assistantOnly` 时，除助理会话和 `DelegationDetailSheet` 主动请求的子会话外，不对其它会话调用 `ensureTurnsLoaded` / 预取 `load_chats`（`ChatStore.swift` 约 3600 行的 `send(.loadChats(ids:))` 是预取入口）。会话元数据仍然要同步（网关的摘要和 digest 机制不变）。

### 5.4 `Views/AssistantView.swift`（拆分，iPad 外观不变）

把三个 pane 抽成独立 `struct`，`AssistantView` 只负责状态行 + 分段 + 组合：

- `AssistantTodayPane`（简报、待批、待办、日程、委派）——`@State todoDraft` 随之迁移。加 `showsApprovals` / `showsDelegations` 开关（默认 true，iPad 不变；iPhone 传 false）。
- `AssistantInboxList`（iPad 继续用；iPhone 的 `InboxHome` 用 `List` 重写）。
- `AssistantMemoryPane`（核心档案、暂停、新增、有效/失效条目、彻底删除确认）。
- `AssistantSection`、`StatusTag`、`ActionButton`、`View.assistantCard(highlight:)` 从 `private` 改为 internal，挪到新文件 `Views/AssistantComponents.swift`。
- `approvalCard` 同时挪出，作为 `ApprovalCard`（§4.1.4 / §4.2 共用），并**按 `approval.tool` 区分文案**：`create_workspace` 显示「新建工作区」+ 名字与原因，按钮「拒绝 / 同意」；其它沿用「批准 / 拒绝」。iPad 的助理面板同样要获得这个区分，否则 `create_workspace` 会显示成一个叫 `create_workspace` 的「工具调用」。
- 新增的「左滑删除待办 / 已完成可撤销 / 日程开关」只加在 `AssistantTodayPane` 上；iPad 一并获得可以接受（纯增量）。

### 5.5 `Views/RootView.swift`

`WorkbenchView.body` 按 §4.0 分流。`CollapsedSidebarRail`、`ToolLayerOverlay`、`ContentLayerView`、`SearchToolView`、`GitToolView`、`TerminalToolView` **不改**。

### 5.6 `Views/PhoneWorkbench.swift`、`Views/SidebarView.swift`

- `PhoneWorkbench` **保留**，只给 iPad 窄窗用；文件头注释更新为「iPad 窄窗（compact）」。iPhone 不再进入。
- `SidebarView` / `WorkspacePickerSheet` **不用改**（上一版为 iPhone 工作 tab 设计的 `onPick` 参数不再需要）。

### 5.7 `docs/iphone-ux.html`

旧的八帧设计稿在页面顶部 lede 里加一句「已被 iphone-assistant-first.md 取代」，不删文件。

---

## 6. 新增文件清单

全部放在 `ios/Jiebo/Jiebo/` 下，并逐个加进 `project.pbxproj` 的 Jiebo target：

| 文件 | 内容 |
|---|---|
| `Session/PhoneRouter.swift` | `PhoneRoute`、`PhoneRouter`、`DelegationRef` 及路由方法 |
| `Session/ChatStore+Phone.swift` | §5.3② 辅助方法 |
| `Views/Phone/PhoneShell.swift` | 容器、键盘监听、冷启动对齐、全局 sheet、预览层 |
| `Views/Phone/MenuDrawer.swift` | 左侧菜单抽屉（原「我」的内容） |
| `Views/Phone/AssistantHome.swift` | 助理页 |
| `Views/Phone/TodayStrip.swift` | 今日条 |
| `Views/Phone/ActionDock.swift` | 确认卡 + 进行中的委派 |
| `Views/Phone/AssistantHubSheet.swift` | 今日面板（只有今日，没有记忆） |
| `Views/Phone/DelegationDetailSheet.swift` | 委派详情 |
| `Views/Phone/InboxHome.swift` | 待处理页 + `InboxDetailView` |
| `Views/Phone/MenuScreens.swift` | 抽屉里 push 出去的页面：`AssistantTodayScreen`、`DelegationListScreen`、`PhoneSettingsScreen`，以及从设置页再进一层的 `AssistantMemoryScreen` |
| `Views/AssistantComponents.swift` | 从 AssistantView 抽出的共享组件（含 `ApprovalCard`） |

在 Xcode 里给 `Views/Phone` 建一个带文件夹的 Group。

---

## 7. 网关侧（已完成，不需要 Mac 上再改）

本版配套的网关改动已在仓库里，iOS 只需要按下面的协议对接。

| 项 | 说明 |
|---|---|
| `create_workspace` 工具 | 仅助理前台对话可用（定时任务、后台、Loop 没有）。参数 `name`、`reason`。名字会校验（不能含 `..`、不能以点开头、不能出根目录）；工作区已存在就直接返回 `ok:true, existed:true`，不打扰用户 |
| 确认流程 | 工具调用**停住等答复**：网关落一条 `AssistantApproval{tool:"create_workspace", chatId:<助理会话>, callId, summary:"名字 · 原因", delegationId:nil}`，同时往收件箱放一条 `kind:"approval"`（会触发 Web Push），并推 `assistant_state`。答复走原有 `assistant_op approval_answer {chatId, callId, allow}`。同意 → 网关建目录、向所有端广播 `workspaces`、工具返回 `ok:true`，助理那一轮继续（通常紧接着 `delegate`）；拒绝 → 返回「用户拒绝了」，工具说明里要求助理不要再问同一个名字；30 分钟没答复 → 取消，同样返回给助理 |
| `delegation_cancel` | 新的 `assistant_op`，`args: {delegationId}`。只对前台委派且 `running`/`awaiting` 的有效；后台委派（定时任务发起、只读）返回 `ok:false` 和原因。停止后委派变 `failed`，`result` 为「你停掉了这项委派。」，收件箱会有一条「委派失败」 |
| 同工作区并发 | 同一个工作区同时只允许一项委派在跑，第二个会被网关拒绝并把原因返回给助理，由助理告诉用户 |
| 助理的提示 | `userRootPreamble` 增加了三句：干活用 `delegate`、没有工作区先 `create_workspace`、完成后简短汇报 |
| 老客户端 | 网页的「待批」面板已区分 `create_workspace`。**iOS 的 `AssistantView.approvalCard` 还没有**，按 §5.4 改 |

**协议字段确认**（`shared/protocol.ts`）：`AssistantApproval` 没变，只是 `tool` 多了取值 `"create_workspace"`；`AssistantOp` 多了 `"delegation_cancel"`。iOS 的 `AssistantApproval.from` 对 `delegationId` 本来就是可选，不需要改解析。

---

## 8. 实施顺序（每一刀可独立编译、可回退）

每一刀做完都要：`xcodebuild` 通过 → iPhone 模拟器手测该刀验收项 → iPad 模拟器确认无回归。

### P0 骨架与守卫

- [ ] `PhoneRouter.swift`、`PhoneShell.swift`（`NavigationStack(path:)` + 根页 `AssistantHome` 占位，先放 `ThreadView(chrome: .embedded)`）、`MenuDrawer.swift` 空壳（能开能关）。导航栏放 ☰（带待处理角标占位）和「今日」。
- [ ] `ThreadView` 改 `ThreadChrome`（§5.1），旧 `phoneChrome:` 初始化器保留。
- [ ] `ChatStore.assistantOnly` + `swapActive` 守卫 + `select` 里原始 id 的修正（§5.3①）。
- [ ] `WorkbenchView` 按 idiom 分流；冷启动对齐。
- **验收**：iPhone 启动一定落在助理会话（先在 iPad 上切到某个工作区会话再退出，再开 iPhone，也必须落在助理）；☰ 能打开 / 关闭抽屉（遮罩点击、向左拖、左缘右滑打开都可用，push 页上左缘右滑是返回而不是开抽屉）；菜单里「待处理」能 push 占位页并返回；iPad 全尺寸 + 窄窗行为与改前一致。

### P1 助理页

- [ ] 导航栏、`TodayStrip`、助理空状态。
- [ ] 拆 `AssistantView`（§5.4）+ `AssistantComponents.swift`；`AssistantHubSheet`。
- [ ] `ComposerStyle.assistant`（placeholder、麦克风按钮、模式/模型收进更多菜单）。
- **验收**：今日条有数据时出现、为空时不占位；今日面板只有今日、没有记忆分段；线程里看不到任何 `memory_*` / `chat_search` 工具卡；输入栏只有 ＋ / 🎤 / ⬆ / ⋯；点话筒录音再点结束，文字进输入框；iPad 助理面板外观不变。

### P2 行动区与确认卡

- [ ] `ApprovalCard`（`create_workspace` / `shell` / 改文件三种文案）、`ActionDock`。
- [ ] `ThreadView` `.embedded` 下隐藏旧的确认横幅。
- **验收**：让助理「在 acrabat 里建一个新项目」→ 手机上出现「新建工作区」确认卡 → 点同意 → 助理继续并发起委派；拒绝 → 助理告知用户不会再问；不理它 → 30 分钟后卡片消失；卡片上有失效倒计时；委派要写文件时出现「批准 / 拒绝」卡；iPad 的助理面板也正确显示 `create_workspace`。

### P3 委派详情

- [ ] `DelegationDetailSheet`（汇报、过程、停止），`ensureTurnsLoaded` 接入。
- [ ] ActionDock 的进行中行 → 打开详情。
- **验收**：进行中的委派点开能看到过程在更新；完成后能看到汇报；停止后状态变失败且收件箱有记录；后台委派没有停止按钮；子会话未同步到本机时过程区有占位；整个过程中 `activeId` 一直是助理（用 DEBUG 日志确认）。

### P4 待处理页

- [ ] `InboxHome`（待批、收件箱、详情、全部已读、下拉刷新）、`router.open`。
- **验收**：待批能直接批 / 拒；收件箱点条目：委派 → 详情 sheet，助理 → pop 回助理页，其它会话 → 提示「在电脑或 iPad 上查看」且不跳转；☰ 角标与菜单里「待处理」行数字与内容一致，标已读后减少。

### P5 菜单内容与收尾

- [ ] `MenuDrawer` 的完整内容与 push 页（待办与日程、委派记录、设置 → 记忆）；设置页里的主题、后台模型、统计；退出。
- [ ] 触觉、无障碍 label、Dynamic Type 检查、深浅色 × 两套主题截图。
- [ ] 线程里 `delegate` / `create_workspace` 工具卡的友好文案（§4.1.3）；可选的「刚结束的委派」行（§4.1.4 C）。
- [ ] DEBUG 启动参数：`--phone-route=root|inbox|today|delegations|settings|memory`（`memory` 要压成 `[.settings, .memory]` 两层）、`--phone-menu=open`、`--phone-delegation=<id>`，方便截图和回归。
- [ ] `PhoneWorkbench.swift` 注释更新；`docs/iphone-ux.html` 加「已取代」说明；`docs/IDE.md` 的「iPad」节后补一句「iPhone 见 iphone-assistant-first.md」。

### P6（建议尽早做，需要改网关，不在本轮必做范围）

- **APNs 推送。** 去掉了工作区入口之后，用户几乎全靠通知得知「委派做完了 / 要你批准 / 提醒到了」，App 在后台时 WebSocket 会断，没有推送就等于看不到。网关 `assistant/push.ts` 目前只有 Web Push：需要新增 `push_subscribe` 的 `kind:"apns"` + device token 存储、网关用 p8 key 发 APNs、App 端 `UNUserNotificationCenter` 授权 + `registerForRemoteNotifications`，点通知按 `chatId` / `delegationId` 调 `router.open`。
- 主屏小组件（今日待办 / 待批数）、Live Activity（委派进行中）、App Intents（「问小驳」）、分享扩展（把网页 / 文字 / 图片丢给助理）。

---

## 9. 手测清单（P0–P5 全部完成后整体再走一遍）

在 iPhone 16 / iPhone SE（第 3 代，小屏）两台模拟器上：

1. 冷启动：落在助理页，副标题正确；在 iPad / 网页上把当前会话切到某个工作区会话后，iPhone 重新启动仍然落在助理。
2. 全 App 找不到任何进入工作区会话的入口：没有会话列表、没有文件 / Git / 终端 / Loop；收件箱、委派记录里点指向工作区会话的条目不会跳走。
3. 断网再连：副标题「正在重连…」→ 恢复；今日条重新拉取。
4. 发一条消息，回复流式显示；导航栏副标题显示「正在回复」；☰ → 待处理再返回，回复仍在，草稿不串；点 ☰ 开关抽屉，草稿不丢。
5. 说「在 notes 里把周报整理一下」→ 助理发起委派 → 行动区出现进行中行 → 点开详情看到过程在更新 → 完成后汇报出现，收件箱多一条。
6. 说「给我的讲稿建一个单独的工作区」→ 确认卡 → 同意后助理接着委派；再来一次点拒绝 → 助理说不建了，不再追问；再来一次不理它，退到后台再回来，卡片和倒计时仍然正确。
7. 委派要写文件 → ☰ 角标 +1、行动区出现批准卡 → 在行动区批准 → 角标 -1。
8. 在进行中的委派详情点「停止」→ 确认 → 状态变失败；对只读的后台委派没有停止按钮。
9. 两个并发委派指向同一工作区：助理告诉你前一个还在跑，不会假装成功。
10. 线程里点 `@文件` 链接 → 全屏预览 → 关掉回到原处。
11. 待处理（☰ → 菜单）：委派条目 → 详情 sheet；助理条目 → 回到助理页；全部已读后 ☰ 角标与菜单行数字清零。
12. ☰ → 设置 → 记忆：新增、编辑、标失效、恢复、彻底删除；暂停记忆开关；返回回到设置页而不是助理页。首页、今日面板、抽屉第一层都找不到记忆，也没有记忆条目数。说「记住我周三不开会」，线程里只有助理一句回应，没有工具卡。
13. ☰ → 待办与日程：添加、完成、撤销、删除待办；关掉一个日程再打开。
14. 主题切换两套 × 浅深色，逐页看有没有写死的颜色。
15. 系统设置把文字调到最大，助理页、行动区、待处理不截断关键信息、不重叠。
16. iPad（全屏、分屏 1/2、Slide Over）：侧栏、图标栏、工具层、助理面板与改前一致；iPad 助理面板里 `create_workspace` 确认卡文案正确。
16a. 菜单抽屉：☰ 打开时键盘收起；有待处理时 ☰ 与「待处理」行角标一致；点「设置」会先关抽屉再 push 设置页；在待处理页（push 页）上左缘右滑是返回，不会拉出抽屉。
17. 网页 / iPad 上仍能看到助理委派出去的子会话，并能继续在里面聊（iPhone 不显示，其它端保留）。

---

## 10. 编译与运行

```bash
cd ios/Jiebo
xcodebuild -project Jiebo.xcodeproj -scheme Jiebo \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -configuration Debug build

# iPad 回归
xcodebuild -project Jiebo.xcodeproj -scheme Jiebo \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' \
  -configuration Debug build
```

模拟器名以本机 `xcrun simctl list devices available` 为准。

---

## 11. 明确不做

- 不改 iPad 和网页的布局与能力。
- 不做「插话」：子会话运行中，用户不能直接给它发消息。
- iPhone 不显示工作区、历史会话、子会话对话，不提供文件 / 搜索 / Git / 终端 / Loop 入口，不做 diff 查看与还原。
- 不用系统 `TabView`，也没有任何形式的底栏（不变量 1）。
- 不允许在助理会话里新开会话、改名、删除。
- 不写死任何颜色值，不另做一套深浅色。
- APNs、小组件、分享扩展本轮不做（P6）。
