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
    enum Kind {
        case body
        case heading(level: Int)
        case tableHeader
        case tableMono
        case tableBody
    }

    static func attributed(_ text: String, sizeCategory: ContentSizeCategory, kind: Kind) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        guard var result = try? AttributedString(markdown: text, options: options) else {
            var plain = AttributedString(text)
            applyFonts(to: &plain, sizeCategory: sizeCategory, kind: kind)
            return plain
        }
        applyFonts(to: &result, sizeCategory: sizeCategory, kind: kind)
        return result
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
        case .body: return 16
        case .heading(let level): return headingSize(level)
        case .tableHeader, .tableMono: return 12
        case .tableBody: return 16
        }
    }

    private static func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return 22
        case 2: return 19
        case 3: return 16
        case 4: return 15
        default: return 15
        }
    }

    private static func scaledPoint(_ base: CGFloat, sizeCategory: ContentSizeCategory) -> CGFloat {
        let metrics = UIFontMetrics(forTextStyle: .body)
        let trait = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(sizeCategory))
        return metrics.scaledValue(for: base, compatibleWith: trait)
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
        case .heading(let level):
            if level <= 2 {
                return UIFont(name: "Songti SC Bold", size: pointSize)
                    ?? .systemFont(ofSize: pointSize, weight: .bold)
            }
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
        case .heading(let level) where level <= 2:
            return UIFont(name: "Songti SC Bold", size: pointSize)
                ?? .systemFont(ofSize: pointSize, weight: .bold)
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
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .lines(let lines):
                    VStack(alignment: .leading, spacing: 5) {
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
                    HairlineTable(headers: headers, rows: rows)
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
        let lines = text.components(separatedBy: "\n")
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
        let heading = headingLevel(of: body)
        let item = listItem(of: body)
        let display = item?.rest ?? heading?.rest ?? body
        let inlineKind: ProseInline.Kind = {
            if let level = heading?.level { return .heading(level: level) }
            return .body
        }()
        return HStack(alignment: .top, spacing: 0) {
            if indent > 0 {
                Color.clear.frame(width: CGFloat(indent) * 8)
            }
            if let item {
                Text(item.marker)
                    .font(JieboFont.text(.footnote, weight: .medium))
                    .foregroundStyle(JieboColor.dim)
                    .frame(width: 22, alignment: .leading)
                    .padding(.top, 2)
            }
            Text(ProseInline.attributed(display, sizeCategory: sizeCategory, kind: inlineKind))
                .foregroundStyle(JieboColor.ink)
                .tint(JieboColor.pine)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
private struct HairlineTable: View {
    @Environment(\.sizeCategory) private var sizeCategory
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let headers: [String]
    let rows: [[String]]

    private static let lineBreak = try! NSRegularExpression(
        pattern: "<br\\s*/?>",
        options: [.caseInsensitive]
    )
    private static let markdownLink = try! NSRegularExpression(
        pattern: #"!?\[([^\]]*)\]\([^)]*\)"#
    )

    var body: some View {
        Group {
            if unfolds {
                unfolded
            } else if headers.count > 3 {
                ScrollView(.horizontal, showsIndicators: true) {
                    tableBody(widths: columnWidths())
                        .fixedSize(horizontal: true, vertical: true)
                }
                .fixedSize(horizontal: false, vertical: true)
            } else {
                tableBody(widths: nil)
            }
        }
        .tint(JieboColor.pine)
        .padding(.top, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 五列以上、无障碍超大字号，或任一格长到需要换行：并排会把内容推出屏幕。
    private var unfolds: Bool {
        if headers.count >= 5 || dynamicTypeSize.isAccessibilitySize { return true }
        return rows.contains { row in row.contains { Self.unfoldsCell($0) } }
    }

    /// 展开态左侧表头列宽：按除首列外的表头实际可见宽度自适应（56~116pt），避免 2 字表头硬占 148pt 挤压窄屏正文
    private var unfoldedHeaderWidth: CGFloat {
        let widest = headers.dropFirst()
            .map { Self.estimatedWidth(Self.visibleText($0), font: 12) }
            .max() ?? 56
        return min(max(widest + 8, 56), 116)
    }

    private var unfolded: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let caption = headers.first, !caption.isEmpty {
                Text(inline(caption, kind: .tableHeader))
                    .foregroundStyle(JieboColor.dim)
                    .tracking(0.4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 6)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(JieboColor.line).frame(height: 1)
                    }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                VStack(alignment: .leading, spacing: 8) {
                    let title = Self.displayText(cell(cells, 0))
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !title.isEmpty {
                        Text(inline(title, kind: .tableBody))
                            .foregroundStyle(JieboColor.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ForEach(Array(headers.dropFirst().enumerated()), id: \.offset) { offset, header in
                        unfoldedField(header: header, value: cell(cells, offset + 1))
                    }
                }
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) {
                    if index != rows.count - 1 {
                        Rectangle().fill(JieboColor.line).frame(height: 0.5)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func unfoldedField(header: String, value: String) -> some View {
        let shown = Self.displayText(value).trimmingCharacters(in: .whitespacesAndNewlines)
        if !shown.isEmpty {
            if Self.unfoldsCell(shown) || dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 3) {
                    Text(inline(header, kind: .tableHeader))
                        .foregroundStyle(JieboColor.dim)
                        .tracking(0.4)
                    Text(inline(shown, kind: .tableBody))
                        .foregroundStyle(JieboColor.ink)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(inline(header, kind: .tableHeader))
                        .foregroundStyle(JieboColor.dim)
                        .tracking(0.4)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: unfoldedHeaderWidth, alignment: .leading)
                    Text(inline(shown, kind: .tableBody))
                        .foregroundStyle(JieboColor.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func tableBody(widths: [CGFloat]?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            row(headers, header: true, last: rows.isEmpty, widths: widths)
            ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                row(fit(cells), header: false, last: index == rows.count - 1, widths: widths)
            }
        }
    }

    /// 横滑里的列必须有确定宽度。无限宽会让整表高度失真，文字挤在左上角。
    private func columnWidths() -> [CGFloat] {
        (0..<headers.count).map { index in
            let font: CGFloat = index == 0 ? 12 : 16
            let samples = [headers[index]] + rows.map { cell($0, index) }
            let widest = samples
                .flatMap { Self.visibleText($0).components(separatedBy: .newlines) }
                .map { Self.estimatedWidth($0, font: font) }
                .max() ?? 0
            return min(max(widest + 2, 64), 168)
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
        Text(inline(text, kind: kind))
            .foregroundStyle(color(index: index, header: header))
            .tracking(header ? 0.4 : 0)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func inline(_ text: String, kind: ProseInline.Kind) -> AttributedString {
        ProseInline.attributed(Self.displayText(text), sizeCategory: sizeCategory, kind: kind)
    }

    /// 单元格里的 br 是换行。并排时这一格会把整行撑得很高，旁边几列又看不见。
    /// 注意：先剥离 [label](url) 的隐藏 URL，避免 @文件 链接把普通短表误判成超宽而强行展开。
    private static func unfoldsCell(_ raw: String) -> Bool {
        let shown = visibleText(raw)
        if shown.contains(where: { $0.isNewline }) { return true }
        return estimatedWidth(shown, font: 16) > 240
    }

    /// 剥掉 Markdown 链接的隐藏 URL，只保留用户肉眼可见的文字用于测宽
    static func visibleText(_ raw: String) -> String {
        let text = displayText(raw)
        guard text.contains("](") else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return markdownLink.stringByReplacingMatches(in: text, range: range, withTemplate: "$1")
    }

    static func displayText(_ raw: String) -> String {
        let range = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        let text = lineBreak.stringByReplacingMatches(in: raw, range: range, withTemplate: "\n")
        guard text.contains("&") else { return text }
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
