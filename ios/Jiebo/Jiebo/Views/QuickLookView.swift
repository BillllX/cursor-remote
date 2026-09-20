import QuickLook
import SwiftUI
import UIKit

/// 已下载到本地的待预览文件（temp 目录，dismiss 后删除）
struct PreviewFile: Identifiable {
    let id = UUID()
    let url: URL
    let name: String
}

/// QLPreviewController 的 SwiftUI 封装：预览从 /media 下载的工作区文件
struct QuickLookView: UIViewControllerRepresentable {
    let file: PreviewFile

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: QLPreviewController, context: Context) {}

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
