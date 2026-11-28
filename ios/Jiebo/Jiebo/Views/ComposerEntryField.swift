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
        buffer.activeTextView = view
        configure(view, context: context)
        return view
    }

    func updateUIView(_ view: ComposerTextView, context: Context) {
        context.coordinator.parent = self
        if buffer.activeTextView !== view {
            buffer.activeTextView = view
        }
        configure(view, context: context)
    }

    private func configure(_ view: ComposerTextView, context: Context) {
        if view.placeholder != placeholder { view.placeholder = placeholder }
        if view.accessibilityLabel != placeholder { view.accessibilityLabel = placeholder }
        if view.submitOnReturn != submitOnReturn { view.submitOnReturn = submitOnReturn }
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
        view.delegate = nil
        view.onSubmit = nil
        view.onCommittedChange = nil
        if view.markedTextRange != nil {
            view.unmarkText()
            coordinator.parent.buffer.text = view.text ?? ""
        }
        if coordinator.parent.buffer.activeTextView === view {
            coordinator.parent.buffer.activeTextView = nil
        }
        view.desiredFocus = false
        view.resignFirstResponder()
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerEntryField
        var appliedRevision = -1
        var appliedPalette: JieboPalette?
        var appliedStyle: UIUserInterfaceStyle?
        init(_ parent: ComposerEntryField) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            guard let view = textView as? ComposerTextView else { return }
            view.scheduleLayoutRefresh(mayShrink: view.textStorage.length < view.lastMeasuredLength)
            // 组字期间不把整段 NSString 桥接拷贝成 Swift String，也不扫 @ 补全或落库。
            guard view.markedTextRange == nil else { return }
            let value = view.text ?? ""
            if view.shouldSuppressDuplicatePublish(for: value, currentBuffer: parent.buffer.text) {
                return
            }
            parent.buffer.text = value
            parent.onEdit(value)
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
    var placeholder = "" {
        didSet {
            guard oldValue != placeholder else { return }
            placeholderLabel.text = placeholder
        }
    }
    private(set) var inTextChange = false
    private(set) var lastMeasuredLength = 0
    /// 显式强持有 TextKit 1 底层 NSTextStorage，避免依赖 UIKit 内部引用策略。
    private let backingTextStorage: NSTextStorage
    private let placeholderLabel = UILabel()
    private var lastHeight: CGFloat = 0
    private var focusUpdatePending = false
    private var replacingDraft = false
    private var committedInCurrentEvent = false
    private var compositionGeneration = 0
    private var layoutRefreshPending = false
    private var layoutRefreshMayShrink = false
    private var layoutGeneration = 0
    private var heightCache: (generation: Int, width: CGFloat, height: CGFloat, lines: Int, scrolls: Bool)?
    private var lastLineCount = 0
    private var keyCommandCache: (submit: Bool, commands: [UIKeyCommand])?
    private var publishedInCurrentEvent = false
    private var publishGeneration = 0

    init() {
        // 显式构建 TextKit 1 栈：外接蓝牙键盘高速击键与中文 IME setMarkedText 期间，
        // TextKit 1 的同步 sizeThatFits 远比 TextKit 2 稳定且无重排尖峰。
        let storage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        storage.addLayoutManager(layoutManager)
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layoutManager.addTextContainer(container)
        self.backingTextStorage = storage
        super.init(frame: .zero, textContainer: container)
        backgroundColor = .clear
        textContainerInset = .zero
        textContainer.lineFragmentPadding = 0
        contentInsetAdjustmentBehavior = .never
        contentInset = .zero
        verticalScrollIndicatorInsets = .zero
        keyboardDismissMode = .interactive
        returnKeyType = .default
        // 关闭硬件键盘内联预测，避免中英混输时向文本布局注入虚拟预测字形引发逐键顿挫。
        inlinePredictionType = .no
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
            let enter = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(handleHardwareReturn(_:)))
            enter.wantsPriorityOverSystemBehavior = false
            commands.append(enter)
        }
        let cmdEnter = UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(handleHardwareReturn(_:)))
        cmdEnter.wantsPriorityOverSystemBehavior = false
        commands.append(cmdEnter)
        let shiftEnter = UIKeyCommand(input: "\r", modifierFlags: .shift, action: #selector(insertHardwareNewline(_:)))
        shiftEnter.wantsPriorityOverSystemBehavior = false
        commands.append(shiftEnter)
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
            scheduleLayoutRefresh(mayShrink: true)
        }
    }

    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        let wasComposing = markedTextRange != nil
        let hadSelection = self.selectedRange.length > 0
        let beforeLength = textStorage.length
        performTextChange { super.setMarkedText(markedText, selectedRange: selectedRange) }
        if wasComposing, markedTextRange == nil, !replacingDraft { markCompositionCommitted() }
        scheduleLayoutRefresh(mayShrink: hadSelection || textStorage.length < beforeLength)
    }

    override func insertText(_ text: String) {
        let wasComposing = markedTextRange != nil
        let hadSelection = selectedRange.length > 0
        let beforeLength = textStorage.length
        performTextChange { super.insertText(text) } // Software Return and multiline paste retain native newline behavior.
        if wasComposing, markedTextRange == nil { markCompositionCommitted() }
        scheduleLayoutRefresh(mayShrink: hadSelection || textStorage.length < beforeLength)
    }

    override func deleteBackward() {
        performTextChange { super.deleteBackward() }
        scheduleLayoutRefresh(mayShrink: true)
    }

    override func paste(_ sender: Any?) {
        performTextChange { super.paste(sender) }
        scheduleLayoutRefresh(mayShrink: true)
    }

    override func cut(_ sender: Any?) {
        performTextChange { super.cut(sender) }
        scheduleLayoutRefresh(mayShrink: true)
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
            MainActor.assumeIsolated {
                guard let self, self.compositionGeneration == generation else { return }
                self.committedInCurrentEvent = false
            }
        }
    }

    /// 同一事件循环内若已由 unmarkText() / handleHardwareReturn() 推送过相同文本，跳过重复 onEdit。
    func shouldSuppressDuplicatePublish(for value: String, currentBuffer: String) -> Bool {
        if publishedInCurrentEvent, currentBuffer == value {
            return true
        }
        publishedInCurrentEvent = true
        publishGeneration &+= 1
        let generation = publishGeneration
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.publishGeneration == generation else { return }
                self.publishedInCurrentEvent = false
            }
        }
        return false
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
        publishedInCurrentEvent = false
        invalidateHeightCache()
        refreshLayout(mayShrink: true)
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
            MainActor.assumeIsolated {
                guard let self else { return }
                self.focusUpdatePending = false
                if self.desiredFocus, self.window != nil { self.becomeFirstResponder() }
                else if !self.desiredFocus { self.resignFirstResponder() }
            }
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
        lastMeasuredLength = textStorage.length
        lastHeight = height
        lastLineCount = lines
        return height
    }

    func scheduleLayoutRefresh(mayShrink: Bool = true) {
        placeholderLabel.isHidden = hasText
        layoutRefreshMayShrink = layoutRefreshMayShrink || mayShrink
        guard !layoutRefreshPending else { return }
        layoutRefreshPending = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                let shrink = self.layoutRefreshMayShrink
                self.layoutRefreshPending = false
                self.layoutRefreshMayShrink = false
                self.refreshLayout(mayShrink: shrink)
            }
        }
    }

    /// 避免每次硬件击键都触发全量 sizeThatFits：
    /// 1) 已经触顶进入滚动（≥lineLimit.upperBound 且 isScrollEnabled 已同步）且本次只增不删，高度必然仍封顶；
    /// 2) 单行极短且不含任何换行/制表符的文本，宽度仍有明显余量时必然仍是 1 行。
    private func canSkipHeightRemeasure(width: CGFloat, mayShrink: Bool) -> Bool {
        guard let cache = heightCache,
              abs(cache.width - ((width * 2).rounded() / 2)) < 0.5
        else { return false }
        let currentLength = textStorage.length
        if cache.scrolls, isScrollEnabled == cache.scrolls, !mayShrink, currentLength >= lastMeasuredLength {
            lastMeasuredLength = currentLength
            return true
        }
        if !cache.scrolls,
           lineLimit.lowerBound == 1,
           cache.lines == 1,
           !isScrollEnabled {
            let maxGlyphWidth = max((font?.pointSize ?? 17) * 1.15, 14)
            let safeCharBudget = Int((width * 0.72) / maxGlyphWidth)
            if currentLength <= safeCharBudget {
                let ns = textStorage.string as NSString
                if ns.rangeOfCharacter(from: .newlines).location == NSNotFound
                    && ns.range(of: "\t").location == NSNotFound {
                    lastMeasuredLength = currentLength
                    return true
                }
            }
        }
        return false
    }

    func refreshLayout(mayShrink: Bool = true) {
        placeholderLabel.isHidden = hasText
        guard bounds.width > 0 else { return }
        if canSkipHeightRemeasure(width: bounds.width, mayShrink: mayShrink) {
            return
        }
        let previousLines = lastLineCount
        layoutGeneration &+= 1
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
        if placeholderLabel.font != font { placeholderLabel.font = font }
        let line = font?.lineHeight ?? 22
        if placeholderLabel.bounds.width != bounds.width || placeholderLabel.bounds.height != line {
            placeholderLabel.frame = CGRect(x: 0, y: 0, width: bounds.width, height: line)
        }
        placeholderLabel.isHidden = hasText
        // 初次以长草稿挂载或切回输入框时，sizeThatFits 已算出 scrolls == true 但尚未同步给 isScrollEnabled。
        if bounds.width > 0, let scrolls = heightCache?.scrolls, isScrollEnabled != scrolls {
            isScrollEnabled = scrolls
        }
    }
}
