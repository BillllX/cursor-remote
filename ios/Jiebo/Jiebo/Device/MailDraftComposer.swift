import MessageUI
import SwiftUI

/// 系统邮件编辑器是唯一发送界面；这里只预填草稿，应用没有任何后台发送路径。
struct MailDraftComposer: UIViewControllerRepresentable {
    let draft: MailDraftRequest
    let onFinish: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let controller = MFMailComposeViewController()
        controller.mailComposeDelegate = context.coordinator
        controller.setToRecipients(draft.to)
        controller.setCcRecipients(draft.cc)
        controller.setBccRecipients(draft.bcc)
        controller.setSubject(draft.subject)
        controller.setMessageBody(draft.body, isHTML: false)
        return controller
    }

    func updateUIViewController(_ uiViewController: MFMailComposeViewController, context: Context) {}

    final class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        private let onFinish: () -> Void

        init(onFinish: @escaping () -> Void) {
            self.onFinish = onFinish
        }

        func mailComposeController(
            _ controller: MFMailComposeViewController,
            didFinishWith result: MFMailComposeResult,
            error: Error?
        ) {
            // sent 也只可能来自用户在系统 UI 的明确操作；网关只得到“已打开”而不是发送结果。
            onFinish()
        }
    }
}
