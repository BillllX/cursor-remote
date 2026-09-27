import QuickLook
import SwiftUI
import UIKit

/// 已下载到本地的待预览文件（temp 目录，dismiss 后删除）
struct PreviewFile: Identifiable {
    let id = UUID()
    let url: URL
    let name: String
}

/// QLPreviewController 的 SwiftUI 封装：预览从 /media 下载的工作区文件。
/// 包一层 UINavigationController 并显式挂「完成」——QLPreviewController 直接做 sheet 根视图时
/// 经常不装自己的 Done 按钮，用户从分享/存文件界面回来后会困在 sheet 里找不到出口。
/// 注意 QL 会在 viewWillAppear 重排 navigationItem，所以按钮必须在 super 之后装（子类化），
/// 在 representable 的 make/update 里装会被它顶掉。
struct QuickLookView: UIViewControllerRepresentable {
    let file: PreviewFile
    let onClose: () -> Void

    func makeUIViewController(context: Context) -> UINavigationController {
        let controller = CloseableQLPreviewController(onClose: onClose)
        controller.dataSource = context.coordinator
        return UINavigationController(rootViewController: controller)
    }

    func updateUIViewController(_ uiViewController: UINavigationController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(file: file)
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let file: PreviewFile

        init(file: PreviewFile) {
            self.file = file
        }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            file.url as NSURL
        }
    }
}

/// P10：系统分享 sheet（UIActivityViewController）的 SwiftUI 封装——
/// 存文件/存相册/隔空投送/发送全交给系统。以 .sheet 呈现（formSheet），iPad 上无需 popover 源。
struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

private final class CloseableQLPreviewController: QLPreviewController {
    private let onClose: () -> Void

    init(onClose: @escaping () -> Void) {
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated) // QL 在这里装自己的按钮，我们的「完成」必须后装
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done,
            target: self,
            action: #selector(closeTapped)
        )
    }

    @objc private func closeTapped() { onClose() }
}
