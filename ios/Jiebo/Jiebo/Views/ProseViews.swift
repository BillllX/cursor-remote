import SwiftUI
import UIKit
import ImageIO

private struct CodeHeader: View {
    var lang: String
    var code: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            Text(lang.isEmpty ? "代码" : lang)
                .font(JieboFont.monoText(.caption2))
                .foregroundStyle(JieboColor.dim)
                .tracking(0.4)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button {
                UIPasteboard.general.string = code
                JieboHaptic.notification(.success)
                copied = true
            } label: {
                Label(copied ? "已复制" : "复制", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .font(JieboFont.text(.caption, weight: .medium))
                    .foregroundStyle(JieboColor.ink2)
                    .padding(.horizontal, 4)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(copied ? "已复制代码" : "复制代码")
            .task(id: copied) {
                guard copied else { return }
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .overlay(alignment: .bottom) {
            Rectangle().fill(JieboColor.line).frame(height: 0.5)
        }
    }
}

/// 代码块：字号跟 Dynamic Type。单独成视图，字号档变化只重画它，不受外层 equatable 拦截
struct CodeBlockView: View {
    @Environment(\.sizeCategory) private var sizeCategory
    let code: String
    let lang: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CodeHeader(lang: lang, code: code)
            ScrollView(.horizontal, showsIndicators: true) {
                Text((code.isEmpty ? " " : code).replacingOccurrences(of: "\t", with: "    "))
                    .font(JieboFont.monoScaled(12, sizeCategory: sizeCategory))
                    .foregroundStyle(JieboColor.ink)
                    .textSelection(.enabled)
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
        }
        .background(JieboColor.well.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
    }
}

/// 行内 **加粗** 用 AttributedString。若再套 SwiftUI `.font()`，混排字重时行高会算矮，下一行叠上来。
private enum ProseInline {
    enum Kind: Hashable {
        case body
        case heading(level: Int)
        case tableHeader
        case tableMono
        case tableBody
    }

    private struct CacheKey: Hashable {
        var text: String
        var sizeCategory: ContentSizeCategory
        var kind: Kind
    }

    private static let lock = NSLock()
    private static var cache: [CacheKey: AttributedString] = [:]
    private static var order: [CacheKey] = []
    private static let maxCacheEntries = 512

    static func attributed(_ text: String, sizeCategory: ContentSizeCategory, kind: Kind) -> AttributedString {
        let key = CacheKey(text: text, sizeCategory: sizeCategory, kind: kind)
        lock.lock()
        if let hit = cache[key] {
            lock.unlock()
            return hit
        }
        lock.unlock()

        let built: AttributedString
        if !hasMarkdownSyntax(text) {
            var plain = AttributedString(text)
            let point = scaledPoint(baseSize(for: kind), sizeCategory: sizeCategory)
            var container = AttributeContainer()
            container.font = baseFont(pointSize: point, kind: kind)
            plain.mergeAttributes(container)
            built = plain
        } else {
            let options = AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
            if var result = try? AttributedString(markdown: text, options: options) {
                applyFonts(to: &result, sizeCategory: sizeCategory, kind: kind)
                built = result
            } else {
                var plain = AttributedString(text)
                applyFonts(to: &plain, sizeCategory: sizeCategory, kind: kind)
                built = plain
            }
        }

        if text.utf8.count <= 2048 {
            lock.lock()
            if cache[key] == nil {
                if order.count >= maxCacheEntries {
                    let evicted = order.removeFirst()
                    cache.removeValue(forKey: evicted)
                }
                order.append(key)
                cache[key] = built
            }
            lock.unlock()
        }
        return built
    }

    private static func hasMarkdownSyntax(_ text: String) -> Bool {
        for byte in text.utf8 {
            switch byte {
            case UInt8(ascii: "*"),
                 UInt8(ascii: "_"),
                 UInt8(ascii: "`"),
                 UInt8(ascii: "["),
                 UInt8(ascii: "~"),
                 UInt8(ascii: "\\"),
                 UInt8(ascii: "<"),
                 UInt8(ascii: "&"):
                return true
            default:
                continue
            }
        }
        return false
    }

    private static func applyFonts(
        to attr: inout AttributedString,
        sizeCategory: ContentSizeCategory,
        kind: Kind
    ) {
        let point = scaledPoint(baseSize(for: kind), sizeCategory: sizeCategory)
        for run in attr.runs {
            var container = AttributeContainer()
            container.font = font(for: run, pointSize: point, kind: kind)
            attr[run.range].mergeAttributes(container)
        }
        if attr.runs.isEmpty, !String(attr.characters).isEmpty {
            var container = AttributeContainer()
            container.font = baseFont(pointSize: point, kind: kind)
            attr.mergeAttributes(container)
        }
    }

    private static func baseSize(for kind: Kind) -> CGFloat {
        switch kind {
        case .body: return JieboReading.body
        case .heading(let level): return JieboReading.headingSize(level)
        case .tableHeader, .tableMono: return 12
        case .tableBody: return 17
        }
    }

    private static func scaledPoint(_ base: CGFloat, sizeCategory: ContentSizeCategory) -> CGFloat {
        JieboFont.scaledPoint(base, sizeCategory: sizeCategory)
    }

    private static func font(for run: AttributedString.Runs.Element, pointSize: CGFloat, kind: Kind) -> UIFont {
        let intent = run.inlinePresentationIntent
        if intent?.contains(.code) == true {
            return .monospacedSystemFont(ofSize: pointSize * 0.94, weight: .regular)
        }
        if intent?.contains(.stronglyEmphasized) == true {
            return emphasisFont(pointSize: pointSize, kind: kind)
        }
        if intent?.contains(.emphasized) == true {
            let base = baseFont(pointSize: pointSize, kind: kind)
            var traits = base.fontDescriptor.symbolicTraits
            traits.insert(.traitItalic)
            if let desc = base.fontDescriptor.withSymbolicTraits(traits) {
                return UIFont(descriptor: desc, size: pointSize)
            }
            return base
        }
        return baseFont(pointSize: pointSize, kind: kind)
    }

    private static func baseFont(pointSize: CGFloat, kind: Kind) -> UIFont {
        switch kind {
        case .body, .tableBody:
            return .systemFont(ofSize: pointSize, weight: .regular)
        case .heading:
            return .systemFont(ofSize: pointSize, weight: .semibold)
        case .tableHeader:
            return .systemFont(ofSize: pointSize, weight: .medium)
        case .tableMono:
            return .monospacedSystemFont(ofSize: pointSize, weight: .regular)
        }
    }

    private static func emphasisFont(pointSize: CGFloat, kind: Kind) -> UIFont {
        switch kind {
        case .body, .tableBody:
            return .systemFont(ofSize: pointSize, weight: .semibold)
        case .heading:
            return .systemFont(ofSize: pointSize, weight: .bold)
        case .tableHeader:
            return .systemFont(ofSize: pointSize, weight: .semibold)
        case .tableMono:
            return .monospacedSystemFont(ofSize: pointSize, weight: .semibold)
        }
    }
}

/// 按原文逐行排。整段 Markdown 会把单个换行和行首空格吃掉。
struct ProseLines: View {
    @Environment(\.sizeCategory) private var sizeCategory
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let text: String
    @ScaledMetric(relativeTo: .body) private var sourceLineSpacing = JieboReading.sourceLineSpacing
    @ScaledMetric(relativeTo: .body) private var blockSpacing = JieboReading.paragraphSpacing

    var body: some View {
        VStack(alignment: .leading, spacing: blockSpacing) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .lines(let lines):
                    VStack(alignment: .leading, spacing: sourceLineSpacing) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            if line.allSatisfy({ $0 == " " || $0 == "\t" }) {
                                Color.clear.frame(height: 12)
                            } else {
                                // 已排好的行文字没变就跳过。流式只重做最后一行的 AttributedString。
                                ProseLineRow(line: line, sizeCategory: sizeCategory)
                                    .equatable()
                            }
                        }
                    }
                case .table(let headers, let rows):
                    HairlineTable(
                        headers: headers,
                        rows: rows,
                        sizeCategory: sizeCategory,
                        dynamicTypeSize: dynamicTypeSize
                    )
                    .equatable()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private enum Segment {
        case lines([String])
        case table(headers: [String], rows: [[String]])
    }

    private var segments: [Segment] {
        let lines = text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" }).map(String.init)
        var result: [Segment] = []
        var prose: [String] = []
        var index = 0
        func flush() {
            if !prose.isEmpty {
                result.append(.lines(prose))
                prose = []
            }
        }
        while index < lines.count {
            if let parsed = Self.parseTable(lines, from: index) {
                flush()
                result.append(.table(headers: parsed.headers, rows: parsed.rows))
                index = parsed.next
            } else {
                prose.append(lines[index])
                index += 1
            }
        }
        flush()
        if result.isEmpty { result.append(.lines(lines)) }
        return result
    }

    private static func parseTable(_ lines: [String], from start: Int) -> (headers: [String], rows: [[String]], next: Int)? {
        guard start + 1 < lines.count, isRow(lines[start]), isSeparator(lines[start + 1]) else { return nil }
        let headers = cells(lines[start])
        guard headers.count >= 2 else { return nil }
        var rows: [[String]] = []
        var index = start + 2
        while index < lines.count, isRow(lines[index]), !isSeparator(lines[index]) {
            rows.append(cells(lines[index]))
            index += 1
        }
        return (headers, rows, index)
    }

    private static func isRow(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("|") && trimmed.dropFirst().contains("|")
    }

    private static func isSeparator(_ line: String) -> Bool {
        let parts = cells(line)
        guard parts.count >= 2 else { return false }
        return parts.allSatisfy { part in
            let marks = part.filter { !$0.isWhitespace }
            return !marks.isEmpty && marks.allSatisfy { $0 == "-" || $0 == ":" }
        }
    }

    private static func cells(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") {
            let withoutPipe = trimmed.dropLast()
            let trailingSlashes = withoutPipe.reversed().prefix(while: { $0 == "\\" }).count
            if trailingSlashes % 2 == 0 {
                trimmed.removeLast()
            }
        }
        var out: [String] = []
        var current = ""
        var inCode = false
        var iterator = trimmed.makeIterator()
        while let ch = iterator.next() {
            if ch == "\\" {
                if let next = iterator.next() {
                    if next == "|" && !inCode {
                        current.append("|")
                    } else {
                        current.append("\\")
                        current.append(next)
                    }
                } else {
                    current.append("\\")
                }
                continue
            }
            if ch == "`" {
                inCode.toggle()
                current.append(ch)
                continue
            }
            if ch == "|" && !inCode {
                out.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(ch)
            }
        }
        out.append(current.trimmingCharacters(in: .whitespaces))
        return out
    }

}

/// 一行正文。相等时不重做行内 Markdown。字号档与主题写进相等判断，动态字号和切主题仍会重排。
private struct ProseLineRow: View, Equatable {
    let line: String
    let sizeCategory: ContentSizeCategory
    @ScaledMetric(relativeTo: .body) private var bodyLineSpacing = JieboReading.lineSpacing
    @ScaledMetric(relativeTo: .headline) private var headingLineSpacing = JieboReading.headingLineSpacing
    @ScaledMetric(relativeTo: .body) private var markerWidth: CGFloat = 24
    @ScaledMetric(relativeTo: .body) private var quoteInset: CGFloat = 16
    var palette: JieboPalette = JieboTheme.shared.palette
    var appearance: JieboAppearance = JieboTheme.shared.appearance

    static func == (lhs: ProseLineRow, rhs: ProseLineRow) -> Bool {
        lhs.line == rhs.line
            && lhs.sizeCategory == rhs.sizeCategory
            && lhs.palette == rhs.palette
            && lhs.appearance == rhs.appearance
    }

    var body: some View {
        let expanded = line.replacingOccurrences(of: "\t", with: "    ")
        let indent = expanded.prefix { $0 == " " }.count
        let body = String(expanded.dropFirst(indent))
        if isHorizontalRule(body) {
            Rectangle()
                .fill(JieboColor.line)
                .frame(height: 1)
                .padding(.vertical, 10)
        } else if let quote = blockquote(of: body) {
            Text(ProseInline.attributed(quote, sizeCategory: sizeCategory, kind: .body))
                .foregroundStyle(JieboColor.ink)
                .tint(JieboColor.pine)
                .lineSpacing(bodyLineSpacing)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, quoteInset)
                .overlay(alignment: .leading) {
                    Capsule().fill(JieboColor.line).frame(width: 3)
                }
        } else {
            let heading = headingLevel(of: body)
            let item = listItem(of: body)
            let display = item?.rest ?? heading?.rest ?? body
            let inlineKind: ProseInline.Kind = {
                if let level = heading?.level { return .heading(level: level) }
                return .body
            }()
            // 多行富文本按顶部排版，避免首行基线参与整行高度计算时产生错位。
            HStack(alignment: .top, spacing: 0) {
                if let item {
                    Text(item.marker)
                        .font(JieboFont.uiScaled(JieboReading.body, sizeCategory: sizeCategory))
                        .foregroundStyle(JieboColor.ink2)
                        .fixedSize()
                        .frame(minWidth: markerWidth, alignment: .leading)
                }
                Text(ProseInline.attributed(display, sizeCategory: sizeCategory, kind: inlineKind))
                    .lineSpacing(heading == nil ? bodyLineSpacing : headingLineSpacing)
                    .foregroundStyle(JieboColor.ink)
                    .tint(JieboColor.pine)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // 缩进只占水平空间，不能用可伸展的透明视图撑高一行。
            .padding(.leading, min(CGFloat(indent) * markerWidth / 4, markerWidth * 2))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func isHorizontalRule(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 3 else { return false }
        return trimmed.allSatisfy({ $0 == "-" }) || trimmed.allSatisfy({ $0 == "*" })
    }

    private func blockquote(of line: String) -> String? {
        guard line.hasPrefix(">") else { return nil }
        let rest = line.dropFirst()
        if rest.first == " " { return String(rest.dropFirst()) }
        return String(rest)
    }

    private func listItem(of line: String) -> (marker: String, rest: String)? {
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
            return ("•", String(line.dropFirst(2)))
        }
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty else { return nil }
        let after = line.dropFirst(digits.count)
        guard after.hasPrefix(". ") else { return nil }
        return ("\(digits).", String(after.dropFirst(2)))
    }

    private func headingLevel(of line: String) -> (level: Int, rest: String)? {
        guard line.hasPrefix("#") else { return nil }
        let marks = line.prefix { $0 == "#" }.count
        guard (1...6).contains(marks) else { return nil }
        let rest = line.dropFirst(marks)
        guard rest.first == " " else { return nil }
        return (marks, String(rest.dropFirst()))
    }
}

/// 对话里的 Markdown 表。窄表按列并排；列多或格子里有换行时改成逐行展开。
/// 横滑再配无限宽，后几列会甩到屏幕外，行高却被那边的长文撑出一片空白。
private struct HairlineTable: View, Equatable {
    let headers: [String]
    let rows: [[String]]
    var sizeCategory: ContentSizeCategory = .large
    var dynamicTypeSize: DynamicTypeSize = .large
    var palette: JieboPalette = JieboTheme.shared.palette
    var appearance: JieboAppearance = JieboTheme.shared.appearance

    static func == (lhs: HairlineTable, rhs: HairlineTable) -> Bool {
        lhs.headers == rhs.headers && lhs.rows == rhs.rows
            && lhs.sizeCategory == rhs.sizeCategory
            && lhs.dynamicTypeSize == rhs.dynamicTypeSize
            && lhs.palette == rhs.palette && lhs.appearance == rhs.appearance
    }

    private static let lineBreak = try! NSRegularExpression(
        pattern: "<br\\s*/?>",
        options: [.caseInsensitive]
    )
    private static let markdownLink = try! NSRegularExpression(
        pattern: #"!?\[([^\]]*)\]\([^)]*\)"#
    )

    /// 单次渲染内汇总表头/单元格的归一化文本与列宽判定，避免 unfolds / columnWidths / cellText 重复跑 3 遍正则。
    private struct TableLayout {
        let displayHeaders: [String]
        let displayRows: [[String]]
        let unfolds: Bool
        let unfoldedHeaderWidth: CGFloat
        let columnWidths: [CGFloat]?
    }

    private func computeLayout() -> TableLayout {
        let displayHeaders = headers.map(Self.displayText)
        let displayRows = rows.map { row in row.map(Self.displayText) }
        var unfolds = headers.count >= 5 || dynamicTypeSize.isAccessibilitySize
        var visibleRows: [[String]] = []
        if !unfolds {
            let needVisibleRows = headers.count > 3
            if needVisibleRows { visibleRows.reserveCapacity(displayRows.count) }
            scanRows: for row in displayRows {
                var vRow: [String] = []
                if needVisibleRows { vRow.reserveCapacity(row.count) }
                for cell in row {
                    let shown = Self.stripMarkdownLinks(cell)
                    if Self.unfoldsVisible(shown) {
                        unfolds = true
                        break scanRows
                    }
                    if needVisibleRows { vRow.append(shown) }
                }
                if needVisibleRows { visibleRows.append(vRow) }
            }
        }
        let visibleHeaders: [String] = (unfolds || headers.count > 3)
            ? displayHeaders.map(Self.stripMarkdownLinks)
            : []
        let unfoldedHeaderWidth: CGFloat
        if unfolds {
            let widest = visibleHeaders.dropFirst()
                .map { Self.estimatedWidth($0, font: 12) }
                .max() ?? 56
            unfoldedHeaderWidth = min(max(widest + 8, 56), 116)
        } else {
            unfoldedHeaderWidth = 56
        }
        let widths: [CGFloat]?
        if !unfolds && headers.count > 3 {
            widths = (0..<headers.count).map { index in
                let font: CGFloat = index == 0 ? 12 : 16
                var widest: CGFloat = 0
                for line in visibleHeaders[index].split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
                    widest = max(widest, Self.estimatedWidth(String(line), font: font))
                }
                for vRow in visibleRows {
                    guard index < vRow.count else { continue }
                    for line in vRow[index].split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
                        widest = max(widest, Self.estimatedWidth(String(line), font: font))
                    }
                }
                return min(max(widest + 2, 64), 168)
            }
        } else {
            widths = nil
        }
        return TableLayout(
            displayHeaders: displayHeaders,
            displayRows: displayRows,
            unfolds: unfolds,
            unfoldedHeaderWidth: unfoldedHeaderWidth,
            columnWidths: widths
        )
    }

    var body: some View {
        let layout = computeLayout()
        Group {
            if layout.unfolds {
                unfolded(layout: layout)
            } else if let widths = layout.columnWidths {
                ScrollView(.horizontal, showsIndicators: true) {
                    tableBody(layout: layout, widths: widths)
                        .fixedSize(horizontal: true, vertical: true)
                }
                .fixedSize(horizontal: false, vertical: true)
            } else {
                tableBody(layout: layout, widths: nil)
            }
        }
        .tint(JieboColor.pine)
        .padding(.top, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func unfolded(layout: TableLayout) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let caption = layout.displayHeaders.first, !caption.isEmpty {
                Text(inlineDisplay(caption, kind: .tableHeader))
                    .foregroundStyle(JieboColor.dim)
                    .tracking(0.4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 6)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(JieboColor.line).frame(height: 1)
                    }
            }
            ForEach(Array(layout.displayRows.enumerated()), id: \.offset) { index, cells in
                VStack(alignment: .leading, spacing: 8) {
                    let title = cell(cells, 0)
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !title.isEmpty {
                        Text(inlineDisplay(title, kind: .tableBody))
                            .foregroundStyle(JieboColor.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ForEach(Array(layout.displayHeaders.dropFirst().enumerated()), id: \.offset) { offset, header in
                        unfoldedField(
                            header: header,
                            value: cell(cells, offset + 1),
                            headerWidth: layout.unfoldedHeaderWidth
                        )
                    }
                }
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) {
                    if index != layout.displayRows.count - 1 {
                        Rectangle().fill(JieboColor.line).frame(height: 0.5)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func unfoldedField(header: String, value: String, headerWidth: CGFloat) -> some View {
        let shown = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !shown.isEmpty {
            if Self.unfoldsVisible(Self.stripMarkdownLinks(shown)) || dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 3) {
                    Text(inlineDisplay(header, kind: .tableHeader))
                        .foregroundStyle(JieboColor.dim)
                        .tracking(0.4)
                    Text(inlineDisplay(shown, kind: .tableBody))
                        .foregroundStyle(JieboColor.ink)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(inlineDisplay(header, kind: .tableHeader))
                        .foregroundStyle(JieboColor.dim)
                        .tracking(0.4)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: headerWidth, alignment: .leading)
                    Text(inlineDisplay(shown, kind: .tableBody))
                        .foregroundStyle(JieboColor.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func tableBody(layout: TableLayout, widths: [CGFloat]?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            row(layout.displayHeaders, header: true, last: layout.displayRows.isEmpty, widths: widths)
            ForEach(Array(layout.displayRows.enumerated()), id: \.offset) { index, cells in
                row(fit(cells), header: false, last: index == layout.displayRows.count - 1, widths: widths)
            }
        }
    }

    private func fit(_ cells: [String]) -> [String] {
        let count = headers.count
        if cells.count == count { return cells }
        if cells.count > count { return Array(cells.prefix(count)) }
        return cells + Array(repeating: "", count: count - cells.count)
    }

    private func cell(_ cells: [String], _ index: Int) -> String {
        index < cells.count ? cells[index] : ""
    }

    private func row(_ cells: [String], header: Bool, last: Bool, widths: [CGFloat]?) -> some View {
        HStack(alignment: .top, spacing: 18) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                let kind: ProseInline.Kind = header
                    ? .tableHeader
                    : (index == 0 ? .tableMono : .tableBody)
                sized(cellText(cell, kind: kind, index: index, header: header), width: widths.flatMap { index < $0.count ? $0[index] : nil })
            }
        }
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) {
            if !last {
                Rectangle()
                    .fill(JieboColor.line)
                    .frame(height: header ? 1 : 0.5)
            }
        }
    }

    @ViewBuilder
    private func sized<V: View>(_ text: V, width: CGFloat?) -> some View {
        if let width {
            text.frame(width: width, alignment: .leading)
        } else {
            text.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func cellText(_ text: String, kind: ProseInline.Kind, index: Int, header: Bool) -> some View {
        Text(inlineDisplay(text, kind: kind))
            .foregroundStyle(color(index: index, header: header))
            .tracking(header ? 0.4 : 0)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func inlineDisplay(_ display: String, kind: ProseInline.Kind) -> AttributedString {
        ProseInline.attributed(display, sizeCategory: sizeCategory, kind: kind)
    }

    /// 单元格里的 br 是换行。并排时这一格会把整行撑得很高，旁边几列又看不见。
    /// 注意：先剥离 [label](url) 的隐藏 URL，避免 @文件 链接把普通短表误判成超宽而强行展开。
    private static func unfoldsVisible(_ shown: String) -> Bool {
        if shown.contains(where: { $0.isNewline }) { return true }
        return estimatedWidth(shown, font: 16) > 240
    }

    /// 剥掉 Markdown 链接的隐藏 URL（输入已做 displayText），只保留用户肉眼可见的文字用于测宽
    private static func stripMarkdownLinks(_ text: String) -> String {
        guard text.contains("](") else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return markdownLink.stringByReplacingMatches(in: text, range: range, withTemplate: "$1")
    }

    /// 剥掉 Markdown 链接的隐藏 URL，只保留用户肉眼可见的文字用于测宽
    static func visibleText(_ raw: String) -> String {
        stripMarkdownLinks(displayText(raw))
    }

    static func displayText(_ raw: String) -> String {
        let hasTag = raw.contains("<")
        let hasEntity = raw.contains("&")
        if !hasTag, !hasEntity { return raw }
        let text: String
        if hasTag {
            let range = NSRange(raw.startIndex..<raw.endIndex, in: raw)
            text = lineBreak.stringByReplacingMatches(in: raw, range: range, withTemplate: "\n")
        } else {
            text = raw
        }
        guard hasEntity else { return text }
        return text
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
    }

    private static func estimatedWidth(_ text: String, font: CGFloat) -> CGFloat {
        var width: CGFloat = 0
        for scalar in text.unicodeScalars {
            if scalar == "*" || scalar == "`" || scalar == "~" { continue }
            width += scalar.value > 0xFF ? font : font * 0.56
        }
        return width
    }

    private func color(index: Int, header: Bool) -> Color {
        if header { return JieboColor.dim }
        if index == 0 { return JieboColor.ink2 }
        return JieboColor.ink
    }
}

#if DEBUG
/// 用同一段混排检查长句、列表续行、引用和中英数字，不依赖登录或业务数据。
private struct ChatReadingPreview: View {
    var body: some View {
        ScrollView {
            ChunkedAssistantMessage(text: """
            ## 净水器怎么选，先看住多久

            长期居住可以把机器和滤芯一起算进总账。短期租住则先看搬家是否方便，再决定要不要安装厨下 RO。

            ### 安装前确认两件事
            - 厨下要有电源和下水空间；租房如果不方便改装，可以考虑台式净饮机。
            - 看清滤芯价格、额定总净水量和更换周期，别只比较机器的促销价。

            > 真算 5 年总账：把机器钱、滤芯钱和日常用水一起计算，才更接近真实花费。

            **例如：**机器 ¥1,999，滤芯每年 ¥360。把数字列清楚，再决定是否值得。

            1. 先确认厨房条件。
            2. 再核对近 12 个月的用水需求；长条目换行后，文字应当继续对齐正文。

            ---

            最后记一句：挑适合自己家使用方式的就好。
            """)
            .padding(.horizontal, 22)
            .padding(.vertical, 24)
            .frame(maxWidth: JieboMeasure.thread)
            .frame(maxWidth: .infinity)
        }
        .background(JieboColor.paper)
    }
}

#Preview("聊天排版 · 浅色") {
    ChatReadingPreview().preferredColorScheme(.light)
}

#Preview("聊天排版 · 深色") {
    ChatReadingPreview().preferredColorScheme(.dark)
}

#Preview("聊天排版 · 系统大字体") {
    ChatReadingPreview().dynamicTypeSize(.accessibility2)
}
/// 复现编号加粗标题后接缩进长段落，检查每段的实际高度及换行。
private struct ChatListReadingPreview: View {
    var body: some View {
        ScrollView {
            ChunkedAssistantMessage(text: """
            2. **串起完整流程**

               先分段拉取五张投诉子表，校验分页、行列数和哈希。通过后再刷新投诉看板及相关牌照摘要。读取时使用已配置的企微授权。

            3. **补齐成功条件**

               只有本次在线核验完整、看板刷新成功，任务才算成功。授权过期、拉取截断或刷新报错，都要返回失败原因。源表无变化时，也应留下本次核验时间。

            4. **整理旧版本干扰**

               修正刷新脚本选择源文件的规则，确保使用**完整核验通过的版本**，避免误选之前自动同步产生的截断快照。

            5. **从定时任务入口立即试跑**

               修改后手动触发同一个任务，核对运行日志、数据核验时间和看板结果，确认整条流程跑通。

            这样能直接验证定时任务本身是否具备执行能力。**上面是修改方案，目前还没有更改配置。**
            """)
            .padding(24)
        }
        .background(JieboColor.paper)
        .preferredColorScheme(.dark)
    }
}

#Preview("编号长文 · 窄屏", traits: .fixedLayout(width: 320, height: 740)) {
    ChatListReadingPreview()
}

#Preview("编号长文 · 系统大字体") {
    ChatListReadingPreview().dynamicTypeSize(.accessibility2)
}
#endif
