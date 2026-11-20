import SwiftUI
import UIKit

/// UIKit owns text, selection and IME composition. SwiftUI updates only when the
/// draft is replaced externally, focus changes, or the editor grows by a line.
struct ComposerEntryField: UIViewRepresentable {
    var placeholder: String
    var lineLimit: ClosedRange<Int>
    var buffer: ComposerDraftBuffer
    var revision: Int
    var focused: Binding<Bool>
    var submitOnReturn: Bool
    var onEdit: (String) -> Void
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.onCommittedChange = { [weak coordinator = context.coordinator] view in
            coordinator?.textViewDidChange(view)
        }
        configure(view, context: context)
        return view
    }

    func updateUIView(_ view: ComposerTextView, context: Context) {
        context.coordinator.parent = self
        configure(view, context: context)
    }

    private func configure(_ view: ComposerTextView, context: Context) {
        view.placeholder = placeholder
        view.accessibilityLabel = placeholder
        view.submitOnReturn = submitOnReturn
        view.lineLimit = lineLimit
        view.onSubmit = onSubmit
        view.textColor = UIColor(JieboColor.ink)
        view.tintColor = UIColor(JieboColor.pine)
        let font = UIFont.preferredFont(forTextStyle: .body)
        if view.font != font, view.markedTextRange == nil { view.font = font }
        if context.coordinator.appliedRevision != revision {
            context.coordinator.appliedRevision = revision
            view.replaceDraft(buffer.text)
        }
        view.desiredFocus = focused.wrappedValue
        view.scheduleFocusUpdate()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        return CGSize(width: width, height: uiView.editorHeight(for: width))
    }

    static func dismantleUIView(_ view: ComposerTextView, coordinator: Coordinator) {
        view.desiredFocus = false
        view.resignFirstResponder()
        view.delegate = nil
        view.onSubmit = nil
        view.onCommittedChange = nil
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerEntryField
        var appliedRevision = -1
        init(_ parent: ComposerEntryField) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            guard let view = textView as? ComposerTextView else { return }
            view.refreshLayout()
            let value = view.text ?? ""
            parent.buffer.text = value
            // Do not scan mentions or persist provisional Pinyin on every composition update.
            if view.markedTextRange == nil { parent.onEdit(value) }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.focused.wrappedValue { parent.focused.wrappedValue = true }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            textViewDidChange(textView)
            if parent.focused.wrappedValue { parent.focused.wrappedValue = false }
        }
    }
}

final class ComposerTextView: UITextView {
    var submitOnReturn = false
    var desiredFocus = false
    var lineLimit = 1 ... 6
    var onSubmit: (() -> Void)?
    var onCommittedChange: ((ComposerTextView) -> Void)?
    var placeholder = "" { didSet { placeholderLabel.text = placeholder } }
    private let placeholderLabel = UILabel()
    private var lastHeight: CGFloat = 0
    private var focusUpdatePending = false
    private var replacingDraft = false
    private var committedInCurrentEvent = false
    private var compositionGeneration = 0

    init() {
        super.init(frame: .zero, textContainer: nil)
        backgroundColor = .clear
        textContainerInset = .zero
        textContainer.lineFragmentPadding = 0
        contentInsetAdjustmentBehavior = .never
        contentInset = .zero
        verticalScrollIndicatorInsets = .zero
        keyboardDismissMode = .interactive
        returnKeyType = .default
        adjustsFontForContentSizeCategory = true
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.numberOfLines = 0
        placeholderLabel.isUserInteractionEnabled = false
        placeholderLabel.isAccessibilityElement = false
        addSubview(placeholderLabel)
    }

    required init?(coder: NSCoder) { nil }

    override var keyCommands: [UIKeyCommand]? {
        var commands = super.keyCommands ?? []
        // No priority over system behavior: the input method gets the first chance
        // to accept candidates. The action also guards composition for IMEs which
        // dispatch confirmation and the key command in the same event.
        if submitOnReturn {
            commands.append(UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(handleHardwareReturn(_:))))
        }
        commands.append(UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(handleHardwareReturn(_:))))
        commands.append(UIKeyCommand(input: "\r", modifierFlags: .shift, action: #selector(insertHardwareNewline(_:))))
        return commands
    }

    @objc func handleHardwareReturn(_ command: UIKeyCommand) {
        if confirmComposition() { return }
        onCommittedChange?(self) // Publish the latest committed characters before submitting.
        onSubmit?()
    }

    @objc func insertHardwareNewline(_ command: UIKeyCommand) {
        if confirmComposition() { return }
        insertText("\n")
    }

    private func confirmComposition() -> Bool {
        if markedTextRange != nil {
            unmarkText()
            onCommittedChange?(self)
            return true
        }
        return committedInCurrentEvent
    }

    override func unmarkText() {
        let wasComposing = markedTextRange != nil
        super.unmarkText()
        if wasComposing, !replacingDraft {
            markCompositionCommitted()
            onCommittedChange?(self)
        }
    }

    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        let wasComposing = markedTextRange != nil
        super.setMarkedText(markedText, selectedRange: selectedRange)
        if wasComposing, markedTextRange == nil, !replacingDraft { markCompositionCommitted() }
        refreshLayout()
    }

    override func insertText(_ text: String) {
        let wasComposing = markedTextRange != nil
        super.insertText(text) // Software Return and multiline paste retain native newline behavior.
        if wasComposing, markedTextRange == nil { markCompositionCommitted() }
        refreshLayout()
    }

    private func markCompositionCommitted() {
        committedInCurrentEvent = true
        compositionGeneration += 1
        let generation = compositionGeneration
        // An event boundary, not a time debounce: a fast second Return is still a new action.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.compositionGeneration == generation else { return }
            self.committedInCurrentEvent = false
        }
    }

    func replaceDraft(_ value: String) {
        guard text != value else { return }
        replacingDraft = true
        unmarkText()
        text = value
        selectedRange = NSRange(location: (value as NSString).length, length: 0)
        replacingDraft = false
        committedInCurrentEvent = false
        refreshLayout()
    }

    func scheduleFocusUpdate() {
        guard !focusUpdatePending, desiredFocus != isFirstResponder else { return }
        focusUpdatePending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.focusUpdatePending = false
            if self.desiredFocus, self.window != nil { self.becomeFirstResponder() }
            else if !self.desiredFocus { self.resignFirstResponder() }
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        scheduleFocusUpdate()
    }

    func editorHeight(for width: CGFloat) -> CGFloat {
        let line = font?.lineHeight ?? 22
        let measured = super.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return ceil(min(max(measured, line * CGFloat(lineLimit.lowerBound)), line * CGFloat(lineLimit.upperBound)))
    }

    func refreshLayout() {
        placeholderLabel.isHidden = !(text ?? "").isEmpty
        guard bounds.width > 0 else { return }
        let height = editorHeight(for: bounds.width)
        if abs(lastHeight - height) > 0.5 {
            lastHeight = height
            invalidateIntrinsicContentSize()
        }
        setNeedsLayout()
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: editorHeight(for: max(bounds.width, 1)))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeholderLabel.font = font
        placeholderLabel.frame = CGRect(origin: .zero, size: CGSize(width: bounds.width, height: max(font?.lineHeight ?? 22, placeholderLabel.sizeThatFits(bounds.size).height)))
        placeholderLabel.isHidden = !(text ?? "").isEmpty
    }
}
