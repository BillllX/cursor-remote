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
        if view.lineLimit != lineLimit {
            view.lineLimit = lineLimit
            view.invalidateHeightCache()
        }
        view.onSubmit = onSubmit
        // 组字或按键回调里重设字色、焦点会拆掉正在进行的候选会话。
        guard !view.inTextChange, view.markedTextRange == nil else { return }
        let palette = JieboTheme.shared.palette
        let style = view.traitCollection.userInterfaceStyle
        if context.coordinator.appliedPalette != palette || context.coordinator.appliedStyle != style {
            context.coordinator.appliedPalette = palette
            context.coordinator.appliedStyle = style
            view.textColor = UIColor(JieboColor.ink)
            view.tintColor = UIColor(JieboColor.pine)
        }
        let font = UIFont.preferredFont(forTextStyle: .body)
        if view.font != font {
            view.font = font
            view.invalidateHeightCache()
        }
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
        var appliedPalette: JieboPalette?
        var appliedStyle: UIUserInterfaceStyle?
        init(_ parent: ComposerEntryField) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            guard let view = textView as? ComposerTextView else { return }
            view.scheduleLayoutRefresh()
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
    private(set) var inTextChange = false
    private let placeholderLabel = UILabel()
    private var lastHeight: CGFloat = 0
    private var focusUpdatePending = false
    private var replacingDraft = false
    private var committedInCurrentEvent = false
    private var compositionGeneration = 0
    private var layoutRefreshPending = false
    private var layoutGeneration = 0
    private var heightCache: (generation: Int, width: CGFloat, height: CGFloat, lines: Int, scrolls: Bool)?
    private var lastLineCount = 0
    private var keyCommandCache: (submit: Bool, commands: [UIKeyCommand])?

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
        isScrollEnabled = false
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.numberOfLines = 1
        placeholderLabel.isUserInteractionEnabled = false
        placeholderLabel.isAccessibilityElement = false
        addSubview(placeholderLabel)
    }

    required init?(coder: NSCoder) { nil }

    override var keyCommands: [UIKeyCommand]? {
        if let keyCommandCache, keyCommandCache.submit == submitOnReturn {
            return keyCommandCache.commands
        }
        var commands = super.keyCommands ?? []
        // No priority over system behavior: the input method gets the first chance
        // to accept candidates. The action also guards composition for IMEs which
        // dispatch confirmation and the key command in the same event.
        if submitOnReturn {
            commands.append(UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(handleHardwareReturn(_:))))
        }
        commands.append(UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(handleHardwareReturn(_:))))
        commands.append(UIKeyCommand(input: "\r", modifierFlags: .shift, action: #selector(insertHardwareNewline(_:))))
        keyCommandCache = (submitOnReturn, commands)
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
        performTextChange { super.unmarkText() }
        if wasComposing, !replacingDraft {
            markCompositionCommitted()
            onCommittedChange?(self)
            scheduleLayoutRefresh()
        }
    }

    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        let wasComposing = markedTextRange != nil
        performTextChange { super.setMarkedText(markedText, selectedRange: selectedRange) }
        if wasComposing, markedTextRange == nil, !replacingDraft { markCompositionCommitted() }
        scheduleLayoutRefresh()
    }

    override func insertText(_ text: String) {
        let wasComposing = markedTextRange != nil
        performTextChange { super.insertText(text) } // Software Return and multiline paste retain native newline behavior.
        if wasComposing, markedTextRange == nil { markCompositionCommitted() }
        scheduleLayoutRefresh()
    }

    override func deleteBackward() {
        performTextChange { super.deleteBackward() }
        scheduleLayoutRefresh()
    }

    /// 键盘还在推候选时不要量文字、也不要改焦点。测量留到这次按键返回之后。
    private func performTextChange(_ change: () -> Void) {
        inTextChange = true
        change()
        inTextChange = false
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
        performTextChange {
            text = value
            selectedRange = NSRange(location: (value as NSString).length, length: 0)
        }
        replacingDraft = false
        committedInCurrentEvent = false
        invalidateHeightCache()
        refreshLayout()
    }

    func invalidateHeightCache() {
        layoutGeneration &+= 1
        heightCache = nil
    }

    func scheduleFocusUpdate() {
        guard !inTextChange, markedTextRange == nil else { return }
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
        if inTextChange, lastHeight > 0 { return lastHeight }
        let widthKey = (width * 2).rounded() / 2
        if let heightCache, heightCache.generation == layoutGeneration, abs(heightCache.width - widthKey) < 0.5 {
            lastHeight = heightCache.height
            lastLineCount = heightCache.lines
            return heightCache.height
        }
        let line = max(font?.lineHeight ?? 22, 1)
        let measured = super.sizeThatFits(CGSize(width: max(width, 1), height: .greatestFiniteMagnitude)).height
        let height = ceil(min(max(measured, line * CGFloat(lineLimit.lowerBound)), line * CGFloat(lineLimit.upperBound)))
        let ratio = measured / line
        var lines = Int(ratio.rounded(.down))
        if ratio - CGFloat(lines) > 0.35 { lines += 1 }
        if lines < lineLimit.lowerBound { lines = lineLimit.lowerBound }
        if lines > lineLimit.upperBound { lines = lineLimit.upperBound }
        let scrolls = measured > line * CGFloat(lineLimit.upperBound) + line * 0.4
        heightCache = (layoutGeneration, widthKey, height, lines, scrolls)
        lastHeight = height
        lastLineCount = lines
        return height
    }

    func scheduleLayoutRefresh() {
        placeholderLabel.isHidden = !(text ?? "").isEmpty
        guard !layoutRefreshPending else { return }
        layoutRefreshPending = true
        layoutGeneration &+= 1
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.layoutRefreshPending = false
            self.refreshLayout()
        }
    }

    func refreshLayout() {
        placeholderLabel.isHidden = !(text ?? "").isEmpty
        guard bounds.width > 0 else { return }
        let previousLines = lastLineCount
        _ = editorHeight(for: bounds.width)
        let scrolls = heightCache?.scrolls == true
        if isScrollEnabled != scrolls { isScrollEnabled = scrolls }
        // 同一行里的亚像素抖动不通知 SwiftUI，否则每个字母都会重排整条输入栏。
        guard lastLineCount != previousLines else { return }
        invalidateIntrinsicContentSize()
    }

    override var intrinsicContentSize: CGSize {
        let height = lastHeight > 0 ? lastHeight : editorHeight(for: max(bounds.width, 1))
        return CGSize(width: UIView.noIntrinsicMetric, height: height)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeholderLabel.font = font
        let line = font?.lineHeight ?? 22
        if placeholderLabel.bounds.width != bounds.width || placeholderLabel.bounds.height != line {
            placeholderLabel.frame = CGRect(x: 0, y: 0, width: bounds.width, height: line)
        }
        placeholderLabel.isHidden = !(text ?? "").isEmpty
    }
}
