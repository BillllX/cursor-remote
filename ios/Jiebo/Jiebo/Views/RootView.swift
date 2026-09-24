import SwiftUI

struct RootView: View {
    @Environment(ChatStore.self) private var store

    var body: some View {
        Group {
            if store.unlocked {
                WorkbenchView()
            } else {
                LoginView()
            }
        }
        .background(JieboColor.paper.ignoresSafeArea())
        .tint(JieboColor.pine)
    }
}

struct WorkbenchView: View {
    @Environment(ChatStore.self) private var store
    /// P6：预览面板宽度（左缘拖拽可调，320 ~ 90% 窗口宽）
    @State private var panelWidth: CGFloat = 540
    @GestureState private var panelDrag: CGFloat = 0

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 380)
        } detail: {
            ThreadView()
        }
        .navigationSplitViewStyle(.balanced)
        .background(JieboColor.paper)
        // P7a：文件浏览器 cover 挂在工作台根（NSV 之外）——从侧栏列弹 fullScreenCover 会继承
        // 侧栏的 compact sizeClass，双栏永远出不来；QL sheet 同理盖在 cover 之上
        .fullScreenCover(isPresented: $store.fileBrowserOpen) {
            FileBrowserCover()
        }
        #if DEBUG
        // UI 冒烟钩子：simctl launch ... --open-file-browser 直接打开文件浏览器（截图验证用）
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--open-file-browser") {
                store.fileBrowserOpen = true
            }
        }
        #endif
        // P5 预览面板：右侧 overlay，点外部收起。P6 从 ThreadView 上移到这里——
        // 遮罩盖住侧栏 + detail，面板从整个工作台右缘滑出，不再把对话列挤断。
        // ZStack 常驻、两个孩子各挂 transition——插入/删除的是谁，transition 就得挂在谁身上
        .overlay(alignment: .trailing) {
            GeometryReader { geo in
                ZStack(alignment: .trailing) {
                    if store.previewPanelOpen {
                        Color.black.opacity(0.3)
                            .ignoresSafeArea()
                            .onTapGesture { store.dismissPreviewPanel() }
                            .transition(.opacity)
                    }
                    if let tab = store.activePreviewTab {
                        PreviewPanelView(tab: tab)
                            // 始终留 10% 外部点击带（极窄 Stage Manager 窗口也不顶满）
                            .frame(width: clampedWidth(geo))
                            .transition(.move(edge: .trailing))
                            .overlay(alignment: .leading) { dragHandle(geo) }
                    }
                }
                .animation(.easeInOut(duration: 0.2), value: store.previewPanelOpen)
            }
            // 面板关着时整个 overlay 不吞手势（常驻 GeometryReader 盖着侧栏+detail）
            .allowsHitTesting(store.previewPanelOpen)
        }
    }

    private func clampedWidth(_ geo: GeometryProxy) -> CGFloat {
        let maxW = geo.size.width * 0.9
        // 极窄窗口（maxW < 320）时下限自动让位，保证 10% 点击带还在
        return min(max(panelWidth - panelDrag, min(320, maxW)), maxW)
    }

    /// 面板左缘的拖拽手柄：16pt 隐形热区（半移到面板外，不压内容左缘）+ 3pt 抓柄指示
    private func dragHandle(_ geo: GeometryProxy) -> some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(JieboColor.line)
            .frame(width: 3, height: 36)
            .frame(width: 16, height: 160, alignment: .leading)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 2)
                    .updating($panelDrag) { value, state, _ in state = value.translation.width }
                    .onEnded { value in
                        let maxW = geo.size.width * 0.9
                        panelWidth = min(max(panelWidth - value.translation.width, min(320, maxW)), maxW)
                    }
            )
            .frame(maxHeight: .infinity, alignment: .center)
            .offset(x: -8) // 热区半移出面板，避免盖住内容左缘（代码行号列）的滚动/选择起点
            .accessibilityLabel("拖拽调整预览面板宽度")
            .accessibilityAdjustableAction { direction in
                let maxW = geo.size.width * 0.9
                switch direction {
                case .increment: panelWidth = min(panelWidth + 40, maxW)
                case .decrement: panelWidth = max(panelWidth - 40, min(320, maxW))
                @unknown default: break
                }
            }
    }
}
