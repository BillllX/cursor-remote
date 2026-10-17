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
                                lineRow(line)
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
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        return trimmed.split(separator: "|", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
    }

    private func lineRow(_ line: String) -> some View {
        let expanded = line.replacingOccurrences(of: "\t", with: "    ")
        let indent = expanded.prefix { $0 == " " }.count
        let body = String(expanded.dropFirst(indent))
        let heading = headingLevel(of: body)
        let item = listItem(of: body)
        let headingInfo = heading
        let display = item?.rest ?? headingInfo?.rest ?? body
        let inlineKind: ProseInline.Kind = {
            if let level = headingInfo?.level { return .heading(level: level) }
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
                // 不逐行开 textSelection：整条消息已有长按菜单（复制/重新生成/分享），一行一个会抢掉它
                .multilineTextAlignment(.leading)
                // 竖向只按自己的折行高度占位；字重已写进 AttributedString，勿再套 .font()
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

/// 对话里的 Markdown 表。表头比单元格更淡，文件名用等宽，行与行之间只留发丝线。
private struct HairlineTable: View {
    @Environment(\.sizeCategory) private var sizeCategory
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        Group {
            if headers.count > 3 {
                ScrollView(.horizontal, showsIndicators: true) {
                    tableBody
                }
            } else {
                tableBody
            }
        }
        .padding(.top, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var tableBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            row(headers, header: true, last: rows.isEmpty)
            ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                row(fit(cells), header: false, last: index == rows.count - 1)
            }
        }
    }

    private func fit(_ cells: [String]) -> [String] {
        let count = headers.count
        if cells.count == count { return cells }
        if cells.count > count { return Array(cells.prefix(count)) }
        return cells + Array(repeating: "", count: count - cells.count)
    }

    private func row(_ cells: [String], header: Bool, last: Bool) -> some View {
        HStack(alignment: .top, spacing: 18) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                let kind: ProseInline.Kind = header
                    ? .tableHeader
                    : (index == 0 ? .tableMono : .tableBody)
                Text(ProseInline.attributed(cell, sizeCategory: sizeCategory, kind: kind))
                    .foregroundStyle(color(index: index, header: header))
                    .tracking(header ? 0.4 : 0)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
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

    private func color(index: Int, header: Bool) -> Color {
        if header { return JieboColor.dim }
        if index == 0 { return JieboColor.ink2 }
        return JieboColor.ink
    }
}
