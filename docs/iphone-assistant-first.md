# 接驳 iPhone 改版：助理优先，IDE 为辅

> 交给 Mac 上的 Agent 执行的实现规格。本文写于没有 Xcode 的环境，所有代码引用都基于当前仓库源码阅读，**行号仅供定位，以实际文件为准**。
>
> 工程：`ios/Jiebo/Jiebo.xcodeproj`，Target `Jiebo`，iOS 17.0，Swift 5，Observation（`@Observable`）。
> 工程**不是** Xcode 16 的文件夹同步组（pbxproj 里没有 `PBXFileSystemSynchronizedRootGroup`），**每新增一个 .swift 文件都必须加进 `project.pbxproj`**（PBXFileReference + PBXBuildFile + 所属 PBXGroup + Sources 阶段），否则编译不到。最稳的做法是用 Xcode 打开工程，把新文件拖进对应分组。

---

## 0. 一句话目标

iPad 和网页是「IDE + 对话」；iPhone 改成「**个人助理 App**」：打开就是助理（小驳），一眼看到今天要处理的事；工作区会话、文件、Git、终端、Loop 收进第二层，需要时再进。

**只改 iPhone。** iPad（含 iPad 上的窄窗 / Slide Over）保持现在的行为不变，不允许回归。

---

## 1. 现状（改动前必须理解的部分）

### 1.1 入口分流

`Views/RootView.swift` → `WorkbenchView`：

- `horizontalSizeClass == .compact` → `PhoneWorkbench()`（iPhone 和 iPad 窄窗共用）
- 否则 → `padWorkbench`（NavigationSplitView + `CollapsedSidebarRail` + `ToolLayerOverlay` + 右侧 `PreviewPanelView`）
- `FileBrowserCover` 以 `.fullScreenCover(isPresented: store.fileBrowserOpen)` 挂在 `WorkbenchView` 上，两端共用

### 1.2 iPhone 现在的结构（`Views/PhoneWorkbench.swift`）

```
ZStack
├─ ThreadView(phoneChrome: true)        ← 打开就是「当前对话」（上次活跃的那条）
│   └─ phoneHeader: ☰ | 标题+副标题 | [今日] [撤销] 📁 ＋
│      └─ Loop/正在回复 状态条
├─ ToolLayerOverlay(layer)              ← 终端 / Loop / 助理面板（窄屏=全宽单列）
├─ PhoneDrawer（左抽屉 300pt）
│   ├─ 品牌行 + 连接状态
│   ├─ AssistantEntryRow（助理入口）
│   ├─ 当前工作区卡片（点开 WorkspacePickerSheet）
│   ├─ 工具条：文件 搜索 Git 终端 Loop
│   ├─ 当前工作区会话列表 + 新对话
│   └─ 设置菜单：主题 / 统计 / 退出
└─ PreviewPanelView（全屏，从文件引用打开）
```

问题：

1. **助理是抽屉里的一行**，和工作区会话同权重；今日 / 收件箱 / 记忆要「切到助理会话 → 点标题栏『今日』→ 弹工具层」三步才能看到。
2. 打开 App 落在「上次的对话」，大多数时候是某个工作区会话，不是助理。
3. 抽屉里塞了 5 个 IDE 工具 + 会话列表 + 设置，层级平铺，小屏信息密度过高。
4. 待批（写文件确认、委派审批）散落在各自会话里，跨会话没有汇总。
5. 收件箱未读、待批数量只在抽屉入口上有个小点，几乎不可见。
6. 输入框为 IDE 设计：模式（Agent/Plan/Ask）、模型、策略层、确认写都在第一层，对和助理聊天来说太重。

### 1.3 可以直接复用的能力（不需要改网关）

| 能力 | 位置 |
|---|---|
| 助理会话 id、名字 | `store.assistantChatId`、`store.assistantName`、`store.isAssistantChat(_:)`、`store.assistantChatActive` |
| 助理状态（简报/待办/日程/委派/待批/收件箱/记忆/后台模型） | `store.assistantState: AssistantState?`，`store.requestAssistant(memory:)` |
| 助理操作 | `store.assistantOp(op, args:)`。网关支持：`inbox_read`(ids 或省略=全部)、`todo_add`、`todo_done`、`todo_undo`、`todo_remove`、`schedule_set`(id/title/cron/enabled/...)、`schedule_remove`、`memory_*`、`approval_answer` |
| 角标数 | `store.assistantBadgeCount`（未读收件箱 + 待批） |
| 委派审批 | `store.answerAssistantApproval(_:allow:)`、`store.assistantApprovals(forParent:)` |
| 打开助理会话 / 关联会话 | `store.openAssistantChat()`（会话没同步到时记 pending）、`store.openAssistantChat(_ chatId:)`、`store.openAssistantInboxItem(_:)` |
| 会话分组 | `store.workspaceGroups`、`store.sidebarChats`、`store.subWorkspaces`、`store.currentWorkspacePath` |
| 正在跑 | `store.runningChatIds`、`turn.running`、`store.loops[chatId]`（status `armed`/`running`） |
| 新建 / 切换 | `store.startChat(in:)`、`store.switchWorkspace(to:)`、`store.select(_:)`、`store.renameChat`、`store.deleteChat` |
| 工具层 | `store.toggleTool(_:)`、`store.toolSelected(_:)`、`ToolLayerOverlay`、`FileBrowserCover`、`ContentLayerView` |
| 预览 | `store.previewPanelOpen`、`store.activePreviewTab`、`PreviewPanelView`、`store.collapsePreview()` |

### 1.4 必须守住的不变量（改错会出隐蔽 bug）

1. **同一时刻只能挂载一个 `ComposerView`。** 它用本地 `@State text` 打字、350ms 后 `store.saveDraft(text)` 回写，并在 `onChange(of: store.activeId)` 时从 `store.draft` 重灌。两个同时挂载会互相覆盖草稿。⇒ **不能用系统 `TabView` 同时保活两个含 `ThreadView` 的页**（TabView 会保活所有 tab），必须自己做 tab 容器，只挂载选中的 tab。
2. **`store.activeId` 是唯一的「当前会话」。** `ThreadView` / `ComposerView` / 文件索引 / 搜索 / Git / 终端全都跟着 `active` 走。iPhone 上「现在显示哪条对话」必须和 `activeId` 一致；切 tab 时要 `select`。
3. `select(_:)` 可能**被拦下**：内容层有未保存修改且跨工作区时，会弹 `contentDiscardPrompt` 并直接 return。调用方不能假设 select 一定成功，要在调用后比对 `store.activeId`。
4. 改 `activeId` 的路径必须走 `select` / `startChat` / `switchWorkspace` 等现有方法（内部统一走 `swapActive`），**不要直接赋值 `store.activeId`**。
5. 助理会话不能删、不能改名、不能新开第二条；USER 根目录只承载助理会话（`isUserRoot`）。
6. 颜色只用 `JieboColor.*`（随 `JieboTheme` 主题和深浅色切换），字体用 `JieboFont.*`，圆角 `JieboRadius.*`，动画 `JieboMotion.*`（都尊重 `accessibilityReduceMotion`），按钮命中区 `.hitTarget()`，按压 `PressScaleButtonStyle()`。**不写死任何颜色值**。

---

## 2. 目标信息架构

### 2.1 四个 Tab（自绘底栏）

| Tab | 图标（SF Symbol） | 内容 | 角标 |
|---|---|---|---|
| **助理**（默认） | `sparkles` | 助理会话 + 今日条 | 助理会话在跑时显示小点 |
| **待处理** | `tray` | 所有待批 + 收件箱 | 数字：待批 + 未读收件箱 + 待确认写入 |
| **工作** | `square.stack.3d.up` | 正在进行 + 按工作区分组的会话；进入会话后才有 IDE 工具 | 有会话或 Loop 在跑时显示小点 |
| **我** | `person.crop.circle` | 记忆、待办与日程管理、主题、用量、账号 | 无 |

Tab 名用「助理」时可以替换为 `store.assistantName`（默认「小驳」）—— 建议 Tab 文案固定「助理」，页内标题用名字。

### 2.2 层级图

```
PhoneShell
├─ [tab 内容，只挂载选中的一个]
│   ├─ AssistantHome（NavigationStack 根）
│   │    ├─ 系统导航栏：小驳 / 状态   右：[今日]
│   │    ├─ TodayStrip（横滑芯片）
│   │    ├─ ThreadView(chrome: .embedded) —— 助理会话
│   │    └─ sheet: AssistantHubSheet（今日 / 记忆，detents medium+large）
│   ├─ InboxHome（NavigationStack）
│   │    ├─ 待批（委派审批可直接批；写入确认点进会话）
│   │    └─ 收件箱（点开 → 详情或跳到关联会话）
│   ├─ WorkHome（NavigationStack(path: router.workPath)）
│   │    ├─ 搜索框（.searchable，按标题过滤）
│   │    ├─ 正在进行（跑着的会话 / Loop / 委派）
│   │    ├─ 工作区分组（可折叠，组头带「新对话」）
│   │    └─ push → ChatScreen(chatId)
│   │          ├─ 系统导航栏：‹ 工作 | 标题+工作区·模式 | [工具 ▾] [＋]
│   │          ├─ ChatStatusStrip（Loop / 正在回复）
│   │          ├─ ThreadView(chrome: .embedded)
│   │          └─ ToolLayerOverlay（终端 / Loop），FileBrowserCover（文件 / 搜索 / Git）
│   └─ MeHome（NavigationStack，insetGrouped List）
├─ PhoneTabBar（键盘弹起或 workPath 非空时隐藏）
├─ PreviewPanelView 全屏层（store.previewPanelOpen）
└─ 全局 sheet：WorkspacePickerSheet、ThemeSettingsSheet、AdminStatsView
```

### 2.3 关键交互规则

1. **冷启动**落在「助理」tab，并选中助理会话。上次活跃的工作区会话不丢：放进 `router.workPath = [.chat(id)]`，用户点「工作」tab 时直接回到它。
2. **从后台回来**保持原 tab 和原页面，不重置。
3. 切到「助理」tab → `store.select(assistantChatId)`；切到「工作」tab 且 `workPath` 里有会话 → `store.select(那个 id)`；切到「待处理」「我」不改 `activeId`。
4. 在 ChatScreen 里**隐藏底栏**（全屏对话，键盘区域最大化）；返回 WorkHome 底栏回来。
5. 键盘弹起时**隐藏底栏**，输入框贴着键盘。
6. 任何地方触发了「打开某个工作区会话」（收件箱条目、委派卡片、待批跳转、助理在线程里的链接）→ 切到「工作」tab 并 push 该会话；触发「打开助理会话」→ 切到「助理」tab。
7. IDE 工具只能在 ChatScreen 里打开（它们依赖当前会话的工作区）。工具层打开时隐藏 ChatScreen 的系统导航栏，由工具层自己的「‹ 对话」返回。

---

## 3. 状态与路由（新增 `Session/PhoneRouter.swift`）

```swift
import SwiftUI

enum PhoneTab: String, CaseIterable, Identifiable {
    case assistant, inbox, work, me
    var id: String { rawValue }
    var title: String {
        switch self {
        case .assistant: return "助理"
        case .inbox: return "待处理"
        case .work: return "工作"
        case .me: return "我"
        }
    }
    var symbol: String {
        switch self {
        case .assistant: return "sparkles"
        case .inbox: return "tray"
        case .work: return "square.stack.3d.up"
        case .me: return "person.crop.circle"
        }
    }
}

enum WorkRoute: Hashable {
    case chat(String)
}

enum AssistantHubSection: String, CaseIterable, Identifiable {
    case today, memory
    var id: String { rawValue }
}

@Observable
@MainActor
final class PhoneRouter {
    var tab: PhoneTab = .assistant
    var workPath: [WorkRoute] = []
    var hubOpen = false
    var hubSection: AssistantHubSection = .today
    var keyboardVisible = false
    /// 冷启动对齐完成前，不响应 activeId 变化（restoreLastActiveIfNeeded 会先落到上次会话）
    var bootstrapped = false
    /// 删除当前会话时，store 会自己回落到 chats.first（可能是助理会话，也可能是别的工作区会话）。
    /// 这次回落不是用户的跳转意图，follow 要吞掉一次
    var swallowNextFollow = false

    var workChatId: String? {
        if case .chat(let id)? = workPath.last { return id }
        return nil
    }

    var tabBarHidden: Bool { keyboardVisible || !workPath.isEmpty && tab == .work }
}
```

`PhoneRouter` 只在 `PhoneShell` 里用 `@State private var router = PhoneRouter()` 创建，通过 `.environment(router)` 下发。**不要放进 `ChatStore`**，iPad 不需要它。

### 3.1 路由动作（写成 `PhoneRouter` 的方法，参数传 `store`）

```swift
extension PhoneRouter {
    /// 切 tab。返回 false 表示被拦下（例如有未保存的文件修改）
    @discardableResult
    func switchTab(_ next: PhoneTab, store: ChatStore) -> Bool {
        if store.contentDirty {
            store.flash("先保存或放弃这个文件的修改")
            return false
        }
        if store.toolLayer != nil { store.toolLayer = nil; store.loopError = "" }
        if next != .assistant { hubOpen = false }   // Hub sheet 挂在 AssistantHome 上，离开时一并收起，否则回来会自己再弹
        // 先改 tab 再 select：select 会触发 onChange(activeId) → follow()，follow 要看到新 tab
        tab = next
        switch next {
        case .assistant:
            store.openAssistantChat()          // 未同步时内部记 pending，到了再切
        case .work:
            if let id = workChatId {
                if store.chats.contains(where: { $0.id == id }) {
                    store.select(id)
                } else {
                    workPath = []              // 会话已删
                }
            }
        case .inbox, .me:
            break
        }
        return true
    }

    /// 打开工作区会话：切到「工作」并 push
    func openWorkChat(_ id: String, store: ChatStore) {
        guard !store.isAssistantChat(id) else { switchTab(.assistant, store: store); return }
        store.select(id)
        guard store.activeId == id else { return }   // 被 discard 提示拦下
        tab = .work
        workPath = [.chat(id)]
    }

    /// 在某个工作区开新对话并 push
    func startChat(in path: String, store: ChatStore) {
        store.startChat(in: path)
        let id = store.activeId
        guard !store.isAssistantChat(id), id != "boot" else { return }
        tab = .work
        workPath = [.chat(id)]
    }

    /// store.activeId 被别处改了（收件箱跳转、委派卡、删除会话回落、startChat……）时对齐 UI
    func follow(activeId id: String, store: ChatStore) {
        guard bootstrapped, id != "boot" else { return }
        if swallowNextFollow { swallowNextFollow = false; return }
        if !store.isAssistantChat(id) { hubOpen = false }
        if store.isAssistantChat(id) {
            if tab == .work { workPath = [] }       // 工作 tab 里不显示助理会话
            if tab != .assistant { tab = .assistant }
            return
        }
        if tab == .assistant || tab == .inbox || tab == .me || workChatId != id {
            tab = .work
            workPath = [.chat(id)]
        }
    }

    /// 删会话统一走这里（列表左滑、ChatScreen 菜单都用）。删完留在工作列表根，不跟着回落跳走
    func deleteChat(_ id: String, store: ChatStore) {
        let wasActive = id == store.activeId
        store.deleteChat(id)
        // deleteChat 可能因为未保存的文件修改被拦下（弹 discard 提示后 return），这时会话还在
        guard !store.chats.contains(where: { $0.id == id }) else { return }
        // 只有删的是当前会话，activeId 才会变；否则别置标记，免得吞掉下一次真正的跳转
        if wasActive, store.activeId != id { swallowNextFollow = true }
        if workChatId == id || wasActive { workPath = [] }
    }
}
```

> 已核实：`ChatStore.deleteChat` 删的是当前会话时会 `swapActive(to: rest.first)`，`rest.first` 取决于 `chats` 顺序，经常就是助理会话。不走 `router.deleteChat` 的话，在工作列表左滑删掉当前会话会被 `follow` 直接甩到助理 tab，或者 push 一条不相干的会话。

> `follow` 和 `switchTab` 的配合：`switchTab(.assistant)` 先把 `tab` 设成 `.assistant`，再 `openAssistantChat()` → `activeId` 变成助理 → `follow` 看到 tab 已经对了，什么都不做。`switchTab(.work)` 同理，`follow` 看到 `workChatId == id` 不动栈。每种跳转都要手测（见 §9）。
>
> `openWorkChat` 里 `select` 发生在改 `tab` 之前，`follow` 会先一步把 tab 和栈设好，后面两行再赋同样的值，结果一致。
>
> `switchTab(.inbox/.me)` 不改 `activeId`，所以 `follow` 在这两个 tab 只会被外部跳转触发，这正是想要的。

### 3.2 冷启动对齐（`PhoneShell.task`）

```
1. 等 store.unlocked && store.assistantChatId != nil && store.activeId != "boot"
   （轮询或 onChange 都可以；给 8 秒上限，超时也置 bootstrapped = true）
2. let restored = store.activeId
3. 若 restored 不是助理会话：router.workPath = [.chat(restored)]
4. store.openAssistantChat()；router.tab = .assistant
5. router.bootstrapped = true
```

- 旧网关没有 `assistantChatId`：超时后 `bootstrapped = true`，助理 tab 显示降级页（§4.1.6），工作 tab 照常。
- 删掉 `PhoneWorkbench.preferRunningChat()` 的逻辑在 iPhone 上的等价物：**不再自动切到正在跑的会话**，改成在 WorkHome「正在进行」里置顶展示。

### 3.3 键盘可见性

在 `PhoneShell` 上：

```swift
.onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
    router.keyboardVisible = true
}
.onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
    router.keyboardVisible = false
}
```

底栏显隐动画用 `JieboMotion.fade(reduceMotion)`，**不要**让输入框跟着做位移动画（ThreadView 里已经对 ComposerView 用了 `.transaction { $0.animation = nil }`，保持）。

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
        @Bindable var store = store
        ZStack {
            VStack(spacing: 0) {
                content                                  // 只挂载选中 tab
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                if !router.tabBarHidden {
                    PhoneTabBar()
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            if store.previewPanelOpen, let tab = store.activePreviewTab {
                // 与 PhoneWorkbench 现有写法一致：遮罩 + 全屏 PreviewPanelView，zIndex 3
            }
        }
        .environment(router)
        .animation(JieboMotion.fade(reduceMotion), value: router.tabBarHidden)
        .animation(JieboMotion.panel(reduceMotion), value: store.previewPanelOpen)
        .sheet(isPresented: $store.workspaceSheetOpen) { WorkspacePickerSheet(onPick: …) }
        .onChange(of: store.activeId) { _, id in router.follow(activeId: id, store: store) }
        .task { await bootstrap() }
        // 键盘监听见 §3.3
    }

    @ViewBuilder private var content: some View {
        switch router.tab {
        case .assistant: AssistantHome()
        case .inbox: InboxHome()
        case .work: WorkHome()
        case .me: MeHome()
        }
    }
}
```

要求：

- `content` 用 `switch`，**不能**用 `opacity`/`ZStack` 叠放保活（不变量 1）。
- 切 tab 不做整页滑动动画，只做 0.15s 淡入（`JieboMotion.fade`），reduceMotion 时无动画。
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

- `FileBrowserCover` 的 `.fullScreenCover` 仍然留在 `WorkbenchView`，iPhone 继续用它做文件 / 搜索 / Git。

### 4.0.1 `PhoneTabBar`（新文件 `Views/Phone/PhoneTabBar.swift`）

- 高度 49pt + 底部安全区；背景 `JieboColor.sidebar`（或 `.paper` + 顶部 1px `JieboColor.line` 分隔线，二选一，和现有侧栏风格对齐即可），`ignoresSafeArea(edges: .bottom)` 只作用在背景上。
- 四等分按钮：图标 18pt semibold + 文字 `JieboFont.ui(10, weight: .medium)`；选中 `JieboColor.ink`，未选中 `JieboColor.dim`；选中态图标用 `.fill` 变体（`sparkles` 无 fill 变体则保持原样，`tray.fill`、`square.stack.3d.up.fill`、`person.crop.circle.fill`）。
- 角标：
  - 待处理：数字胶囊（`JieboColor.danger` 底，`JieboColor.fillFg` 字，`JieboFont.ui(10, weight: .semibold)`），> 99 显示 `99+`。数 = `store.assistantBadgeCount + pendingWriteCount`（§4.2.1）。
  - 助理：助理会话在跑时 6pt 圆点 `JieboColor.run`。
  - 工作：任一非助理会话在跑或任一 Loop 为 armed/running 时 6pt 圆点 `JieboColor.ok`。
- 点击当前 tab 再点一次：
  - 工作 tab → `workPath = []`（回到列表根）
  - 助理 tab → 线程滚到底（发一个 `router.scrollToBottomNonce += 1`，ThreadView 可选支持；不做也行）
- 点击调用 `router.switchTab(_:store:)`；成功时 `UISelectionFeedbackGenerator().selectionChanged()`。
- 无障碍：每个按钮 `.accessibilityLabel(title)`，角标写进 label（「待处理，3 项」），选中加 `.isSelected` trait。

### 4.1 助理页 `AssistantHome`（新文件 `Views/Phone/AssistantHome.swift`）

```
┌──────────────────────────────────┐
│  ◆ 小驳                   [今日•] │  ← 系统导航栏 inline；副标题：已连接 / 正在回复 / 正在重连…
│    正在回复                        │
├──────────────────────────────────┤
│ [简报] [待批 2] [待办 3] [09:00 晨报] [委派 1 进行中] → │  ← TodayStrip，横滑
├──────────────────────────────────┤
│                                  │
│   助理会话线程（ThreadView）         │
│                                  │
├──────────────────────────────────┤
│ ┌ 跟小驳说点什么 · 长按说话 ───────┐ │
│ │ ＋                    🎤   ⬆    │ │  ← ComposerView(style: .assistant)
│ └────────────────────────────────┘ │
├──────────────────────────────────┤
│  助理   待处理³   工作•    我        │
└──────────────────────────────────┘
```

#### 4.1.1 导航栏

- `NavigationStack { … }` 包住页面，`.navigationBarTitleDisplayMode(.inline)`，`.toolbarBackground(JieboColor.paper, for: .navigationBar)` + `.toolbarBackground(.visible, for: .navigationBar)`。
- `ToolbarItem(placement: .principal)`：VStack —— `store.assistantName`（`JieboFont.display(17)`）+ 副标题（`JieboFont.ui(11, weight: .medium)`, `JieboColor.dim`）。副标题优先级：未连接「正在重连…」> 未配 key「服务器还没配 API Key」（`JieboColor.danger`）> 助理会话在跑「正在回复」> 后台状态 `assistantState.background.ok ? "就绪" : reason`。
- 左侧：`JieboMark(size: 22)`（纯装饰，`accessibilityHidden`）。
- 右侧：「今日」按钮 —— 沿用 `ThreadView.assistantTodayButton` 的外观（抽出来变成可复用 `AssistantTodayButton(on:marked:action:)`），点击 `router.hubSection = .today; router.hubOpen = true`。
- 如果 `store.canUndo`：右侧多一个撤销按钮（同现在 phoneHeader）。

#### 4.1.2 TodayStrip（新文件 `Views/Phone/TodayStrip.swift`）

横向 `ScrollView(.horizontal, showsIndicators: false)`，`HStack(spacing: 8)`，左右内边距 16，高度 44（芯片本身 32 高，`hitTarget()` 保证 44 命中）。芯片样式：`JieboColor.white` 底、`JieboColor.line` 描边、`JieboRadius.sm` 圆角、`JieboFont.ui(13, weight: .medium)`。

按顺序，**为空的芯片不显示**；全部为空或 `assistantState == nil` 时整条隐藏（不占高度）。

| 芯片 | 条件 | 文案 | 点击 |
|---|---|---|---|
| 简报 | `state.brief?.text` 非空 | `doc.text` 图标 +「今日简报」 | 打开 Hub（今日） |
| 待批 | `state.approvals.count > 0` | 「待批 N」，`JieboColor.warnFg` / `warnBg` | `router.switchTab(.inbox)` |
| 待办 | 未完成 todo 数 > 0 | 「待办 N」 | 打开 Hub（今日，滚到待办） |
| 下一个日程 | `schedules.filter(\.enabled).min(by: nextAt)` 存在且 `nextAt` 非空 | 「HH:mm 标题」（今天以外显示「明天 HH:mm」/「M月d日」） | 打开 Hub（今日，滚到日程） |
| 委派 | `delegations` 里 status 为 running/awaiting 的数 > 0 | 「委派 N 进行中」，`JieboColor.run`/`runBg` | `router.switchTab(.work)` 且 `workPath = []`（WorkHome 的「正在进行」会列出它们） |

- `AssistantHome.task { store.requestAssistant() }`；并在 `scenePhase` 回到 `.active` 时再拉一次。
- 收件箱未读**不放**在这里（底栏已有角标）。

#### 4.1.3 线程

- `ThreadView(chrome: .embedded)`（§5.1）。
- 助理会话专用空状态（`emptyState` 根据 `store.assistantChatActive` 分支）：
  - 标题：「\(assistantName) 在这儿」
  - 说明：「记事、提醒、查东西，或者让它去某个工作区干活。」
  - 快捷句（点了填进输入框并聚焦，沿用 `starterRow` 机制）：「今天有什么安排？」「帮我记一下：」「明早 9 点提醒我」「让某个工作区跑一遍测试」
  - 底部提示：「长按输入框说话」
- 现有的委派审批横幅（`delegatedApprovalBanner`）、写入确认条、pendingDiff pill 都保留。

#### 4.1.4 AssistantHubSheet（新文件 `Views/Phone/AssistantHubSheet.swift`）

`.sheet(isPresented: $router.hubOpen)`，`.presentationDetents([.medium, .large])`，`.presentationDragIndicator(.visible)`，`.presentationBackground(JieboColor.paper)`。

- 顶部：分段控件「今日 / 记忆」（沿用 `AssistantView.tabBar` 的描边+滑块样式），右上「完成」。
- 今日：复用 `AssistantTodayPane`（§5.3 从 `AssistantView` 抽出），并补两项：
  - 待办行**左滑**：「删除」→ `todo_remove`；已完成的待办折叠在「已完成 (N)」里，可「撤销」→ `todo_undo`。
  - 日程行右侧加 `Toggle` → `assistantOp("schedule_set", args: ["id": .string(id), "enabled": .bool(on)])`（网关对已有 id 做部分更新，cron/prompt 沿用原值，已核实 `schedules.ts setSchedule`）。
- 记忆：复用 `AssistantMemoryPane`。
- **收件箱不在 Hub 里**（它在「待处理」tab）。
- `hubSection` 变化时用 `ScrollViewReader` 滚到对应锚点（`"todos"`、`"schedules"`）。

#### 4.1.5 输入框（助理风格）

见 §5.2：`ComposerView(style: .assistant)`。

#### 4.1.6 降级

`store.assistantChatId == nil`（旧网关）且 `bootstrapped`：页面主体显示 `AssistantTodayPane`（只读）+ 一句「这个网关还没有助理会话，先去『工作』里聊。」，不放输入框。

### 4.2 待处理页 `InboxHome`（新文件 `Views/Phone/InboxHome.swift`）

`NavigationStack`，`.navigationTitle("待处理")`，large title；`List` + `.listStyle(.insetGrouped)` + `.scrollContentBackground(.hidden)` + `JieboColor.paper` 背景（同 `WorkspacePickerSheet` 写法）。`.refreshable { store.requestAssistant() }`。

右上菜单：「全部标为已读」→ `assistantOp("inbox_read")`（不带 ids = 全部；本地同步把 `assistantState.inbox[i].read = true`）。

#### 4.2.1 Section「待批」

两类来源，合并后按时间倒序：

1. **委派审批**：`store.assistantState?.approvals`。行内容：工具名（semibold）、summary（mono 12，最多 3 行）、来源（`delegation` 对应的 `workspace` 名）。行内两个按钮「批准」「拒绝」→ `store.answerAssistantApproval`。按钮样式复用 `AssistantView.ActionButton`（抽成共享组件，§5.3）。
2. **写入确认**：遍历 `store.chats`（排除助理会话），取 `turns.last(where: { $0.pendingTool != nil })`。新增计算属性：

```swift
extension ChatStore {
    /// 已加载到本机的会话里，停在「确认写」上的那些。未加载 turns 的会话看不到（slim 加载的限制）
    var pendingWriteChats: [(chat: ChatSession, tool: PendingTool)] { … }
}
```

   行内容：会话标题 + 「要改文件：path」。**不在这里直接允许/拒绝**（`replyToApproval` 只作用于 activeId），点行 → `router.openWorkChat(chat.id)`，进入会话后输入框上方已有确认条。

- 为空时 Section 不显示。
- 底栏「待处理」角标 = `assistantBadgeCount + pendingWriteChats.count`。

#### 4.2.2 Section「收件箱」

- 数据：`store.assistantState?.inbox`（已按时间排序，否则按 `createdAt` 倒序）。
- 行：未读圆点（`JieboColor.pine`）、标题（未读 semibold）、相对时间（`Date.formatted(.relative(presentation: .named))`）、正文前两行。`kind` 映射小标签：approval「待批」、delegation「委派」、reminder「提醒」、brief「简报」，用 `StatusTag`。
- 点击：
  - 有 `chatId` → 先标已读，再：助理会话 → `router.switchTab(.assistant)`；本机有这个会话 → `router.openWorkChat(chatId)`；本机没有 → `store.flash("这个会话还没同步到本机")`。
  - **不要**在 iPhone 上调 `store.openAssistantInboxItem(item)` 再指望 `follow` 跟上：目标会话恰好就是当前 `activeId` 时（比如刚从这条会话返回列表再来点收件箱），`select` 直接 return，`activeId` 不变、`onChange` 不触发，页面会停在待处理 tab 不动。另外它在没有 `chatId` 时会切去助理会话，和这里「进详情」的要求冲突。
  - 标已读抽一个小方法放进 `ChatStore+Phone.swift`：`func markInboxRead(_ item: AssistantInboxItem)`，内容就是 `openAssistantInboxItem` 前半段（发 `inbox_read` + 本地置 `read = true`）。
  - 无 `chatId` → push `InboxDetailView(item)`（标题、时间、完整正文 `textSelection(.enabled)`），出现时 `inbox_read`。
- 左滑：未读时「已读」。
- 空状态：`ContentUnavailableView("没有待处理的事", systemImage: "tray", description: Text("\(assistantName) 有新消息会放在这里。"))`，颜色用默认（随主题）。

### 4.3 工作页 `WorkHome`（新文件 `Views/Phone/WorkHome.swift`）

```
┌──────────────────────────────────┐
│ 工作                         ＋   │  ← large title；＋ 是 Menu：各子工作区 / 新建工作区…
│ 🔍 搜索对话                        │
├──────────────────────────────────┤
│ 正在进行                           │
│  ● 载人航天        acrabat · 跑     │
│  ↻ 讲稿同步        acrabat · Loop 第2拍│
│  ⇢ 整理周报        notes · 委派待批  │
├──────────────────────────────────┤
│ ▾ acrabat                  ＋ 新对话│
│   载人航天                    刚刚  │
│   继续                             │
│ ▸ notes (4)                       │
│ ▸ cursor-remote (12)              │
└──────────────────────────────────┘
```

`NavigationStack(path: $router.workPath)` + `.navigationDestination(for: WorkRoute.self) { route in switch route { case .chat(let id): ChatScreen(chatId: id) } }`。

#### 4.3.1 「正在进行」Section

合并去重（同一会话只出现一次，优先级 委派待批 > Loop > 跑）：

- 非助理会话中 `runningChatIds.contains(id) || turns.contains(\.running)` → 标签「跑」（`run`/`runBg`）。
- `store.loops` 里 status 为 armed/running 的 → 「Loop 第 N 拍」（`ok`/`okBg`）。
- `assistantState.delegations` 里 running/awaiting 且 `childChatId` 在本机 → 用 `AssistantDelegation.statusLabel/statusColors`。
- 行副标题：工作区名（`workspaceLabel(chat.cwd, root: store.groupRoot)`）。
- 点击 → `router.openWorkChat(id)`。
- 为空时整个 Section 不显示。

#### 4.3.2 工作区分组

- 数据：`store.workspaceGroups`（已排除 USER 根目录）。
- 每组一个 `Section`，组头是自绘 `Button`：▸/▾ + 名字 + （折叠时）会话数 + 右侧「＋」（`router.startChat(in: group.path, store:)`）。
- 展开状态：`@AppStorage("jiebo.phone.expandedGroups")` 存 JSON 数组字符串（路径里可能有逗号，不要用逗号拼接）；**默认展开**：`store.currentWorkspacePath` 所在组 + 有会话在跑的组。
- 行：`ChatRow`（新组件）—— 标题（未读 semibold）、一行摘要（`chat.preview` 或 `serverPreview`，`JieboColor.dim`）、右侧状态（跑 / 未读点 / Loop 点）。最小高度 56。
- 行左滑：「删除」（destructive，弹确认，沿用 `SidebarView` 的 alert 文案，确认后调 `router.deleteChat(id, store:)`）；右滑：「重命名」（沿用 `SidebarView` 的 rename alert）。`contextMenu` 同时提供这两项。
- 空组：显示一行「还没有对话」+「新对话」。

#### 4.3.3 搜索

`.searchable(text: $query, prompt: "搜索对话")`：非空时隐藏分组，改为平铺 `store.sidebarChats` 中标题或摘要包含 query 的会话（大小写不敏感），每行带工作区名。

#### 4.3.4 右上「＋」菜单

`Menu`：

- 每个 `store.subWorkspaces`：「在 X 开新对话」→ `router.startChat(in:)`
- Divider
- 「切换 / 管理工作区…」→ `store.openWorkspaceSwitcher()`（全局 sheet）
- 「新建工作区…」→ 打开 `WorkspacePickerSheet` 并直接置 `store.creatingWorkspace = true`

`WorkspacePickerSheet` 加一个可选参数 `onPick: ((String) -> Void)? = nil`：iPhone 传 `{ path in store.switchWorkspace(to: path); router.openWorkChat(store.activeId, store: store) }`；iPad 不传，行为不变。新建工作区成功后网关会切过去，`router.follow` 会把它 push 出来。

`.onAppear { store.refreshWorkspaces() }`。

### 4.4 会话页 `ChatScreen`（新文件 `Views/Phone/ChatScreen.swift`）

```
┌──────────────────────────────────┐
│ ‹ 工作     载人航天        [⌘] [＋] │  ← principal：标题 + 「acrabat · 代理」
├──────────────────────────────────┤
│ ● Loop · 第 2 拍 · 三页已渲染       │  ← ChatStatusStrip（可点 → Loop 工具层）
├──────────────────────────────────┤
│ ThreadView(chrome: .embedded)     │
│ ComposerView(style: .full)        │
└──────────────────────────────────┘
（底栏隐藏）
```

```swift
struct ChatScreen: View {
    let chatId: String
    // …
    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                ChatStatusStrip()
                ThreadView(chrome: .embedded)
            }
            if let layer = store.toolLayer {
                ToolLayerOverlay(layer: layer).id(layer)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(JieboMotion.panel(reduceMotion), value: store.toolLayer)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(store.toolLayer == nil ? .visible : .hidden, for: .navigationBar)
        .toolbar { … }
        .onAppear { if store.activeId != chatId { store.select(chatId) } }
        .onDisappear { if store.toolLayer != nil { store.toolLayer = nil } }
    }
}
```

- **principal**：标题（`store.active?.title ?? "新对话"`，`JieboFont.display(17)`）+ 副标题「工作区名 · 模式」（同现在 `phoneSubtitle`）。点标题 → 弹重命名 alert。
- **工具按钮**（`Menu`，图标 `wrench.and.screwdriver`；有 Loop 在跑或有 Git 改动时右上角 6pt 点）：
  - 文件 → `store.toggleTool(.files)`（走 `FileBrowserCover`）
  - 搜索 → `.search`
  - Git（N 处改动）→ `.git`，N = `store.gitStatus.count`
  - 终端 → `.terminal`（`ToolLayerOverlay`）
  - Loop（在跑时文案「Loop · 在跑」）→ `.loop`
  - Divider
  - 撤销上一轮（`store.canUndo` 时可用）→ `store.undoLast()`
  - 重命名…、删除会话（destructive，确认后 `router.deleteChat(id, store:)`，见 §3.1；不要直接调 `store.deleteChat`）
- **＋**：在当前会话所在工作区开新对话 → `router.startChat(in: chat.cwd ?? store.currentWorkspacePath)`（替换栈顶，不叠两层）。
- `ToolLayerOverlay` 在窄屏已是全宽单列 + 「‹ 对话」+ 左缘右滑关闭 + discard/revert alert，**直接复用不改**。
- 删除会话后若 `activeId` 回落到别的会话，`router.follow` 会处理；ChatScreen 要在 `chatId` 不再存在时自动 pop（`onChange(of: store.chats.map(\.id))`）。
- 有未保存修改时系统返回按钮不会出现（工具层打开时导航栏是隐藏的），无需额外拦截。

#### 4.4.1 `ChatStatusStrip`（从 `ThreadView.phoneHeader` 抽出，放 `Views/Phone/ChatStatusStrip.swift`）

逻辑完全照搬 `ThreadView.phoneStatus` 和下方按钮：Loop 在跑显示「Loop · 第 N 拍 · 摘要」，否则 `store.busy` 显示「正在回复」，否则不显示。点击（有 loop 时）→ `store.toggleTool(.loop)`。

### 4.5 我 `MeHome`（新文件 `Views/Phone/MeHome.swift`）

`NavigationStack` + `List(.insetGrouped)`：

1. **头部**（无标题 Section）：`JieboMark(size: 36)` + `store.tenantName`（空则「接驳」）+ `ConnectionDot` + 「已连接 / 正在重连…」。
2. **助理**
   - 「记忆」→ push `AssistantMemoryScreen`（包 `AssistantMemoryPane`，`onAppear { store.requestAssistant(memory: true) }`），右侧 detail 显示有效条目数。
   - 「待办与日程」→ push `AssistantTodayScreen`（包 `AssistantTodayPane`，含 §4.1.4 的补充操作）。
   - 「委派记录」→ push 列表（`assistantState.delegations`，复用 `delegationCard`；点可打开的 → `router.openWorkChat(childChatId)`）。
   - 「后台模型」只读行：`background.model` + 就绪/原因。
3. **外观**：「主题 · \(JieboTheme.shared.palette.title)」→ `ThemeSettingsSheet`（sheet）。
4. **用量**（`store.isAdmin`）：「使用统计」→ `AdminStatsView`（sheet）。
5. **账号**：「退出登录」（destructive）→ `confirmationDialog`，文案沿用 `PhoneWorkbench`。
6. **关于**：版本号 `Bundle.main.infoDictionary?["CFBundleShortVersionString"]` + build。

---

## 5. 需要改的现有文件

### 5.1 `Views/ThreadView.swift`

把 `phoneChrome: Bool` 换成枚举（保留旧初始化参数的兼容入口，避免一次改太多调用点）：

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
- `.toolbar(.hidden, for: .navigationBar)` **只在 `.pad`/`.phoneLegacy` 时应用**。`.embedded` 由宿主管理导航栏（否则 ChatScreen 的返回按钮和侧滑返回都没了）。用 `ViewModifier` 条件包一下。
- `.frame(maxWidth: JieboMeasure.thread)` 保留。
- `emptyState`：`store.assistantChatActive` 时用助理版文案和快捷句（§4.1.3）；工作区会话在 `.embedded` 下把「点左上角打开对话列表」改成「点右上角工具打开文件、Git、终端」，「打开工作区文件」快捷按钮保留。
- 把 `assistantTodayButton` 抽成 `AssistantTodayButton`（`Views/Phone/` 或 `SidebarView.swift` 旁边都可），ThreadView 内部改为调用它，外观不变。
- 右上角「xxx · 预览」浮动胶囊：iPhone `.embedded` 下保留（它打开 `PreviewPanelView`，由 `PhoneShell` 绘制）。

### 5.2 `Views/ComposerView.swift`

新增 `enum ComposerStyle { case full, assistant }`，`var style: ComposerStyle = .full`。`.full` 行为**完全不变**。

`.assistant`：

- placeholder：未连接「正在连服务器…」；忙「正在回复，发送会排队」；否则「跟\(store.assistantName)说点什么 · 长按说话」。
- `controls`：`attachMenu`（去掉「工作区文件…」项，助理在 USER 根目录，引用工作区文件意义不大）+ `Spacer` + **麦克风按钮** + `sendCluster`。
  - 麦克风按钮：32pt 圆，`mic` / 录音中 `mic.fill` + `JieboColor.pine`。**点按**切换开始/结束录音：开始走现有 `beginVoice()`（内部调 `dictation.start()`，含权限申请）；再点一次 `let spoken = await dictation.finish()` 后 `insertTranscript(spoken)`；录音中想放弃用 `dictation.cancel()`。这几个方法已核实存在于 `Session/VoiceDictation.swift`。长按手势和点按共用同一个 `dictation`，录音中两种入口互斥（`dictation.active` 时不响应另一种开始）。长按输入框说话的现有手势保留。
  - 模式、模型、策略层、确认写、检查点**全部收进 `moreMenu`**（`ellipsis`），菜单里加「模式」「模型」两个子 `Menu`（`Picker` inline 风格）。助理会话默认就是 Agent 模式，用户很少改。
- `@` 补全条在助理风格下仍可用（不删能力）。
- 由调用方决定 style：`ThreadView` 里 `ComposerView(focusNonce:, style: store.assistantChatActive && chrome == .embedded ? .assistant : .full)`。iPad 永远 `.full`。

### 5.3 `Views/AssistantView.swift`（拆分，iPad 外观不变）

把三个 pane 抽成独立的 `struct`，`AssistantView` 只负责状态行 + 分段 + 组合：

- `AssistantTodayPane`（简报、待批、待办、日程、委派）——内部 `@State todoDraft` 随之迁移。
- `AssistantInboxList`（收件箱）——iPhone 的 InboxHome 可以不用它（用 List 重写），但 iPad 继续用。
- `AssistantMemoryPane`（核心档案、暂停、新增、有效/失效条目、彻底删除确认）——相关 `@State` 随之迁移。
- `AssistantSection`、`StatusTag`、`ActionButton`、`View.assistantCard(highlight:)` 从 `private` 改为 internal，挪到新文件 `Views/AssistantComponents.swift`，供 iPhone 页面复用。
- 新增的「左滑删除待办 / 已完成可撤销 / 日程开关」只加在 `AssistantTodayPane` 上；iPad 一并获得这些能力可以接受（纯增量），若想严格不动 iPad，用参数 `var editable = false` 控制，iPhone 传 true。

### 5.4 `Views/RootView.swift`

- `WorkbenchView.body` 按 §4.0 分流。
- `CollapsedSidebarRail`、`ToolLayerOverlay`、`ContentLayerView`、`SearchToolView`、`GitToolView`、`TerminalToolView` **不改**。

### 5.5 `Views/SidebarView.swift`

- `WorkspacePickerSheet` 加 `onPick` 可选参数（§4.3.4）。
- 把 `SidebarView` 里的 rename / delete alert 逻辑抽成 `ChatRowActions` 修饰符（`.chatRowActions(renameTarget:deleteTarget:)`），iPhone WorkHome 和 ChatScreen 复用。可选；不抽就复制一份，保证文案一致。

### 5.6 `Session/ChatStore.swift` / `Session/WorkspaceGroups.swift`

只加计算属性 / 小方法，不改现有方法语义：

```swift
extension ChatStore {
    var pendingWriteChats: [(chat: ChatSession, tool: PendingTool)]   // §4.2.1
    var phoneInboxBadge: Int { assistantBadgeCount + pendingWriteChats.count }
    var anyWorkRunning: Bool                                            // 非助理会话在跑 || 有 Loop armed/running
    var assistantRunning: Bool                                          // 助理会话在跑
    func chatIsLive(_ chat: ChatSession) -> Bool                        // 抽出 PhoneDrawer.chatRow 里的 live 判断
    func markInboxRead(_ item: AssistantInboxItem)                      // §4.2.2，只标已读不跳转
}
```

放进新文件 `Session/ChatStore+Phone.swift`（记得加进 pbxproj）。

### 5.7 `Views/PhoneWorkbench.swift`

**保留**，只给 iPad 窄窗用。文件头注释更新为「iPad 窄窗（compact）」。iPhone 不再进入这里。

### 5.8 `docs/iphone-ux.html`

旧的八帧设计稿已被本方案替代，在页面顶部 lede 里加一句「已被 iphone-assistant-first.md 取代」即可，不删文件。

---

## 6. 新增文件清单

全部放在 `ios/Jiebo/Jiebo/` 下，并逐个加进 `project.pbxproj` 的 Jiebo target：

| 文件 | 内容 |
|---|---|
| `Session/PhoneRouter.swift` | `PhoneTab`、`WorkRoute`、`AssistantHubSection`、`PhoneRouter` 及路由方法 |
| `Session/ChatStore+Phone.swift` | §5.6 计算属性 |
| `Views/Phone/PhoneShell.swift` | 容器、键盘监听、冷启动对齐、全局 sheet、预览层 |
| `Views/Phone/PhoneTabBar.swift` | 底栏 |
| `Views/Phone/AssistantHome.swift` | 助理页 |
| `Views/Phone/TodayStrip.swift` | 今日条 |
| `Views/Phone/AssistantHubSheet.swift` | 今日 / 记忆面板 |
| `Views/Phone/InboxHome.swift` | 待处理页 + `InboxDetailView` |
| `Views/Phone/WorkHome.swift` | 工作页 + `ChatRow` |
| `Views/Phone/ChatScreen.swift` | 会话页 |
| `Views/Phone/ChatStatusStrip.swift` | Loop / 正在回复状态条 |
| `Views/Phone/MeHome.swift` | 我 + 记忆/待办/委派子页 |
| `Views/AssistantComponents.swift` | 从 AssistantView 抽出的共享组件 |

在 Xcode 里给 `Views/Phone` 建一个 Group（带文件夹）。

---

## 7. 视觉与交互细则

- **颜色**：只用 `JieboColor`。背景层级：页面 `paper`，卡片 `white`，底栏/分组 `sidebar`，分隔 `line`。强调 `pine`；运行 `run/runBg`；完成 `ok/okBg`；警告 `warnFg/warnBg`；危险 `danger/dangerBg`。不新增颜色常量；如确需新语义色，加进 `Tokens.swift` 并同时给浅/深两套值。
- **字体**：标题 `JieboFont.display`，正文 `JieboFont.ui`，代码 `JieboFont.mono`。所有文字支持 Dynamic Type（`JieboFont.ui` 若是固定字号，至少保证 `.dynamicTypeSize(...DynamicTypeSize.accessibility2)` 下布局不崩：芯片条可横滑、行高自适应）。
- **触控**：所有可点元素命中区 ≥ 44pt（`.hitTarget()`）。
- **动画**：tab 切换淡入；push 用系统默认；Hub sheet 系统默认；工具层沿用 `JieboMotion.panel`。所有自定义动画在 `accessibilityReduceMotion` 时为 nil。
- **触觉**：切 tab `selectionChanged`；批准/拒绝 `UINotificationFeedbackGenerator().notificationOccurred(.success/.warning)`；删除确认 `.warning`。
- **深色模式 / 主题切换**：所有新页面在 `ThemeSettingsSheet` 切换配色后即时生效（因为只用 token）。手测至少切两套配色 × 浅/深。
- **横屏**：iPhone 横屏可用即可，不专门设计；底栏在横屏照常显示。
- **无障碍**：TodayStrip 芯片 `accessibilityLabel` 写全（「待批 2 项，打开待处理」）；行状态（跑 / 未读 / Loop）进 label；底栏角标进 label。

---

## 8. 实施顺序（每一刀可独立编译、可回退）

每一刀做完都要：`xcodebuild` 通过 → iPhone 模拟器手测该刀的验收项 → iPad 模拟器确认无回归。

### P0 骨架

- [ ] 新建 `PhoneRouter.swift`、`PhoneShell.swift`、`PhoneTabBar.swift`；四个 tab 先放占位页（助理 tab 直接放 `ThreadView(chrome: .embedded)` 包在 NavigationStack 里）。
- [ ] `ThreadView` 改 `ThreadChrome`（§5.1），旧 `phoneChrome:` 初始化器保留。
- [ ] `WorkbenchView` 按 idiom 分流。
- [ ] 冷启动对齐 + 键盘隐藏底栏。
- **验收**：iPhone 启动落在助理会话；底栏四个 tab 能切；键盘弹起底栏消失；iPad 全尺寸 + 窄窗行为与改前一致。

### P1 工作 tab

- [ ] `WorkHome`（正在进行、分组、搜索、＋菜单）、`ChatRow`、左右滑操作。
- [ ] `ChatScreen`（导航栏、工具菜单、ChatStatusStrip、ToolLayerOverlay、自动 pop）。
- [ ] `WorkspacePickerSheet.onPick`。
- **验收**：能进任意会话聊天；文件/搜索/Git 打开 FileBrowserCover，终端/Loop 打开工具层且「‹ 对话」能回；编辑文件未保存时无法直接返回列表；新建对话、重命名、删除可用；返回列表后底栏出现；切到助理再切回工作，回到刚才那条会话并且草稿还在。

### P2 助理 tab

- [ ] `AssistantHome` 导航栏、`TodayStrip`、助理空状态。
- [ ] 拆 `AssistantView`（§5.3）+ `AssistantComponents.swift`；`AssistantHubSheet`。
- **验收**：今日条在有数据时出现、为空时不占位；点芯片跳转正确；Hub 两个分段可用，记忆的编辑/标失效/遗忘/彻底删除与 iPad 行为一致；iPad 上助理面板外观不变。

### P3 待处理 tab

- [ ] `pendingWriteChats`、`phoneInboxBadge`。
- [ ] `InboxHome`（待批、收件箱、详情、全部已读、下拉刷新）。
- **验收**：委派审批能在列表里直接批/拒；写入确认点进对应会话；收件箱条目点开跳转到关联会话（助理会话 → 助理 tab，工作会话 → 工作 tab 并 push）；底栏角标数与内容一致，标已读后减少。

### P4 我 tab

- [ ] `MeHome` 及记忆、待办与日程、委派记录子页；主题、统计、退出。
- [ ] 待办删除/撤销、日程开关（`schedule_set enabled`）。
- **验收**：所有入口可达；退出登录回到 LoginView；切主题全 App 生效。

### P5 输入框助理风格

- [ ] `ComposerStyle.assistant`（placeholder、麦克风按钮、模式/模型收进更多菜单）。
- **验收**：助理会话输入栏只有 ＋ / 🎤 / ⬆（以及 ⋯）；点麦克风录音再点结束后文字进输入框；工作区会话和 iPad 输入框与改前一致。

### P6 收尾

- [ ] 触觉、无障碍 label、Dynamic Type 检查、深浅色 × 两套主题截图。
- [ ] DEBUG 启动参数：`--phone-tab=assistant|inbox|work|me`、`--phone-open-chat=<id>`，方便截图和回归（仿照现有 `--open-file-browser` 写在 `#if DEBUG` 里）。
- [ ] `PhoneWorkbench.swift` 注释更新；`docs/iphone-ux.html` 加「已取代」说明；`docs/IDE.md` 的「### iPad」节后补一句「iPhone 见 iphone-assistant-first.md」。

### P7（可选，需要改网关，不在本轮必做范围）

- APNs 推送：网关 `assistant/push.ts` 目前只有 Web Push（VAPID）。要在 iPhone 上收到「待批 / 委派有结果 / 提醒 / 简报」需要：新增 `push_subscribe` 的 `kind: "apns"` + device token 存储、网关用 p8 key 发 APNs、App 端 `UNUserNotificationCenter` 授权 + `registerForRemoteNotifications` + 点击通知按 `chatId` 路由（复用 `router.openWorkChat` / `switchTab(.assistant)`）。
- 主屏小组件（今日待办 / 待批数）、锁屏 Live Activity（会话在跑）、App Intents（「问小驳」快捷指令）。这些都依赖后台数据通道，放到 APNs 之后。

---

## 9. 手测清单（P0–P6 全部完成后整体再走一遍）

在 iPhone 16 / iPhone SE（第 3 代，小屏）两台模拟器上：

1. 冷启动：落在助理 tab，显示助理会话，副标题正确；上次打开的工作区会话在「工作」tab 里能直接回到。
2. 断网再连：副标题「正在重连…」→ 恢复；今日条重新拉取。
3. 助理 tab 发一条消息，回复流式显示；底栏「助理」出现运行点；切到「工作」再切回，回复仍在继续，草稿不串。
4. 在助理里让它委派一个工作区任务 → 今日条出现「委派 1 进行中」→ 点它到工作 tab「正在进行」→ 点进子会话。
5. 委派停在审批 → 底栏待处理角标 +1 → 待处理 tab 里直接批准 → 角标 -1。
6. 工作区会话开「确认写」，让 Agent 改文件 → 待处理里出现写入确认 → 点进会话 → 输入框上方确认条允许。
7. 会话里打开文件、改一行、不保存直接点「‹ 对话」→ 弹放弃提示；保存后再回。
8. Git → 点一个改动看 diff → 保留 / 还原。
9. 开一个 30 秒、最多 2 拍的 Loop → ChatStatusStrip 显示拍数 → 返回工作列表「正在进行」里能看到 → 停止后消失。
10. 线程里点 `@文件` 链接 → 全屏预览 → 关掉回到原处（助理 tab 和会话页都试）。
11. 收件箱条目：有 chatId 的跳会话，无 chatId 的进详情；全部已读后角标清零。再测一次「目标会话就是当前 activeId」：先进会话 A、返回列表、去待处理点指向 A 的条目，必须进到 A。
11a. 工作列表左滑删掉当前会话（刚从它返回）：留在工作列表根，不跳到助理 tab，也不 push 别的会话。删一条非当前会话后，再点收件箱跳转仍正常（标记没被误吞）。
11b. Hub 里点一张委派卡跳到工作 tab，再切回助理 tab：Hub 不会自己再弹出来。
12. 我 → 记忆：新增、编辑、标失效、恢复、彻底删除；暂停记忆开关。
13. 我 → 待办与日程：添加、完成、撤销、删除待办；关掉一个日程再打开。
14. 主题切换两套 × 浅深色，逐页看有没有写死的颜色。
15. 系统设置把文字调到最大，助理页、待处理、工作列表不截断关键信息、不重叠。
16. iPad（全屏、分屏 1/2、Slide Over）：侧栏、图标栏、工具层、助理面板与改前一致。

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

- 不改 iPad 和网页的布局。
- 不改 WebSocket 协议、不改网关（P7 除外，且 P7 本轮不做）。
- 不在 iPhone 上做常驻编辑器、分栏、底部终端栏。
- 不允许在助理会话里新开会话、改名、删除。
- 不用系统 `TabView`（不变量 1）。
- 不写死任何颜色值，不另做一套深浅色。
